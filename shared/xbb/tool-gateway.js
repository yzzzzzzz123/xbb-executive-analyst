"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const util = require("node:util");
const { enforceCompany } = require("../security/access-control.js");
const { assertNoSensitiveFactValues } = require("../security/fact-privacy.js");
const { MAX_AGGREGATE_BYTES } = require("./aggregate-multi-period.js");
const { MAX_QUERY_MONTHS, PERFORMANCE_DATA_START_MONTH, validateRequestedMonths } = require("./fast-query-plan.js");
const { normalizeRunnerProgressEvent } = require("./query-progress.js");
const {
  RUNNER_ISOLATION_ERROR_CODE,
  createRunnerIsolationMarker,
  isFullyQualifiedWindowsPath,
  recoverRunnerIsolation,
  waitForRunnerIsolationBinding
} = require("./runner-isolation.js");

const execFile = util.promisify(childProcess.execFile);
const ALLOWED_DOMAINS = new Set(["all", "performance", "product-sales", "courses", "delivery", "opportunities"]);
const MIN_RUNNER_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_RUNNER_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_MAX_CONCURRENT_QUERIES = 1;
const DEFAULT_MAX_QUEUED_QUERIES = 32;
// 排队窗口必须能覆盖前一个 runner 的最长单次执行，同时给 Agent 的 20 分钟绝对截止留出取消窗口。
const DEFAULT_QUERY_QUEUE_TTL_MS = 16 * 60 * 1000;
const DEFAULT_PROCESS_TREE_TERMINATION_DEADLINE_MS = 10 * 1000;
const PROCESS_TREE_UNCONFIRMED_CODE = "XBB_RUNNER_TERMINATION_UNCONFIRMED";
const GATEWAY_FAIL_CLOSED_CODE = "XBB_QUERY_GATEWAY_FAIL_CLOSED";
const RUNNER_EXECUTION_ERROR_CODE = "XBB_RUNNER_EXECUTION_FAILED";
const TEST_ONLY_PLATFORM_CAPABILITY = Symbol("xbb-test-only-platform-capability");

function abortError(message = "销帮帮查询已取消。") {
  const error = new Error(message);
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

function isAbortError(error, signal) {
  return signal?.aborted === true || error?.name === "AbortError" || error?.code === "ABORT_ERR";
}

function processTreeUnconfirmedError(cause) {
  const error = new Error("Windows 销帮帮 runner 进程树未能确认完全终止；查询网关已安全关闭，等待服务重启恢复。", { cause });
  error.code = PROCESS_TREE_UNCONFIRMED_CODE;
  return error;
}

function gatewayFailClosedError(cause) {
  const error = new Error("销帮帮查询网关已安全关闭，等待服务重启后自动恢复。", { cause });
  error.code = GATEWAY_FAIL_CLOSED_CODE;
  return error;
}

function runnerIsolationStateError(message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = RUNNER_ISOLATION_ERROR_CODE;
  return error;
}

function runnerExecutionError(cause) {
  const error = new Error("实时销帮帮查询执行失败；未向模型返回底层命令、查询范围或隔离标识。", { cause });
  error.code = RUNNER_EXECUTION_ERROR_CODE;
  return error;
}

function writeRunnerStdin(child, payload, injectedWriter) {
  if (typeof payload !== "string") return Promise.resolve();
  if (typeof injectedWriter === "function") return Promise.resolve().then(() => injectedWriter(child, payload));
  const stream = child?.stdin;
  if (!stream || typeof stream.end !== "function") return Promise.reject(new Error("runner stdin is unavailable"));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      stream.removeListener?.("error", onError);
      if (error) reject(error);
      else resolve();
    };
    const onError = (error) => finish(error);
    stream.once?.("error", onError);
    try { stream.end(payload, "utf8", () => finish()); } catch (error) { finish(error); }
  });
}

function settleWithin(promise, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => finish({ status: "deadline" }), timeoutMs);
    Promise.resolve(promise).then(
      (value) => finish({ status: "fulfilled", value }),
      (error) => finish({ status: "rejected", error })
    );
  });
}

function terminateWindowsProcessTree(pid) {
  // A bare PID is never sufficient authority to terminate a Windows process:
  // it may have been reused after the snapshot. Production gateway calls are
  // fenced by a marker and replace this fallback with token recovery, whose
  // PowerShell recovery holds a creation/executable-verified native handle for
  // every process it terminates and rescans for late children. Standalone
  // callers therefore fail closed unless they inject an equally verified
  // terminator.
  void pid;
  return Promise.resolve(false);
}

function runRunnerProcess(run, command, args, options = {}) {
  const {
    signal,
    timeoutMs,
    platform = process.platform,
    enforceWindowsProcessTree = false,
    processTreeTerminator = terminateWindowsProcessTree,
    processTreeTerminationDeadlineMs = DEFAULT_PROCESS_TREE_TERMINATION_DEADLINE_MS,
    onWindowsProcessStarted,
    stdinText,
    stdinWriter,
    ...execOptions
  } = options;
  if (signal?.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : abortError());

  const useWindowsProcessTree = platform === "win32" && enforceWindowsProcessTree;
  const runOptions = { ...execOptions, timeout: useWindowsProcessTree ? undefined : timeoutMs, signal: useWindowsProcessTree ? undefined : signal };
  // Test doubles can inspect stdinText without putting it on argv. Native
  // child_process ignores unknown option keys; production data is written to
  // the already-created child's stdin immediately below.
  if (stdinText !== undefined) runOptions.stdinText = stdinText;
  if (runOptions.timeout === undefined) delete runOptions.timeout;
  if (runOptions.signal === undefined) delete runOptions.signal;
  const execution = run(command, args, runOptions);
  const child = execution?.child;
  const stdinWritten = writeRunnerStdin(child, stdinText, stdinWriter);
  if (!useWindowsProcessTree) {
    return stdinWritten.then(() => execution);
  }

  const pid = Number(child?.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    Promise.resolve(execution).catch(() => {});
    return Promise.reject(processTreeUnconfirmedError(new Error("Windows 销帮帮 runner 未暴露可验证、可回收的进程 ID。")));
  }

  const terminationDeadlineMs = Number.isInteger(processTreeTerminationDeadlineMs) && processTreeTerminationDeadlineMs > 0
    ? Math.min(processTreeTerminationDeadlineMs, 60 * 1000)
    : DEFAULT_PROCESS_TREE_TERMINATION_DEADLINE_MS;
  let terminationReason = null;
  let requestTermination;
  const terminationRequested = new Promise((resolve) => { requestTermination = resolve; });
  const terminate = (reason) => {
    if (terminationReason) return;
    terminationReason = reason;
    requestTermination({ type: "termination", reason });
  };
  const onAbort = () => terminate(signal.reason instanceof Error ? signal.reason : abortError());
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
  const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? setTimeout(() => {
        const error = new Error(`销帮帮 runner 超过 ${timeoutMs}ms 未完成。`);
        error.code = "ETIMEDOUT";
        terminate(error);
      }, timeoutMs)
    : null;
  timer?.unref?.();

  const executionOutcome = Promise.resolve(execution).then(
    (value) => ({ type: "execution", ok: true, value }),
    (error) => ({ type: "execution", ok: false, error })
  );

  async function confirmTermination(reason) {
    let termination;
    try {
      termination = await settleWithin(
        Promise.resolve().then(() => processTreeTerminator(pid)),
        terminationDeadlineMs
      );
    } catch (error) {
      throw processTreeUnconfirmedError(error);
    }
    if (termination.status !== "fulfilled" || termination.value !== true) {
      const cause = termination.status === "rejected" ? termination.error
        : termination.status === "deadline" ? new Error("进程树回收超过硬截止。")
          : new Error("进程树回收器未确认成功。");
      throw processTreeUnconfirmedError(cause);
    }
    throw reason;
  }

  const rootBinding = typeof onWindowsProcessStarted === "function"
    ? Promise.resolve().then(() => onWindowsProcessStarted(pid))
    : Promise.resolve();

  return Promise.all([rootBinding, stdinWritten]).catch((error) => confirmTermination(error)).then(() => Promise.race([executionOutcome, terminationRequested])).then(async (outcome) => {
    if (outcome.type === "execution") {
      if (outcome.ok) return outcome.value;
      throw outcome.error;
    }

    return confirmTermination(outcome.reason);
  }).finally(() => {
    if (timer) clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  });
}

function runnerTimeoutMs(monthCount) {
  const count = Number.isInteger(monthCount) && monthCount > 0 ? monthCount : 1;
  return Math.min(MAX_RUNNER_TIMEOUT_MS, Math.max(MIN_RUNNER_TIMEOUT_MS, count * 60 * 1000));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function emitProgress(callback, rawEvent) {
  if (typeof callback !== "function") return;
  const event = normalizeRunnerProgressEvent(rawEvent);
  if (!event) return;
  try { await callback(event); } catch { /* 进度发送失败不能中断真实查询 */ }
}

async function drainProgressFile(progressPath, state, callback) {
  if (!progressPath || !fs.existsSync(progressPath)) return;
  let lines;
  try {
    lines = fs.readFileSync(progressPath, "utf8").split(/\r?\n/).filter(Boolean);
  } catch {
    return;
  }
  for (let index = state.lines; index < lines.length; index += 1) {
    try { await emitProgress(callback, JSON.parse(lines[index])); } catch { /* 忽略单条损坏进度，事实查询继续 */ }
  }
  state.lines = lines.length;
}

async function runWithProgress(runFactory, { progressPath, callback, pollMs = 250 }) {
  let settled = false;
  let outcome;
  const execution = Promise.resolve().then(runFactory).then(
    (value) => { settled = true; outcome = { ok: true, value }; },
    (error) => { settled = true; outcome = { ok: false, error }; }
  );
  const state = { lines: 0 };
  while (!settled) {
    await Promise.race([execution, delay(pollMs)]);
    await drainProgressFile(progressPath, state, callback);
  }
  await execution;
  await drainProgressFile(progressPath, state, callback);
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

function normalizeList(value, label, max) {
  const list = (Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [])
    .map((item) => String(item).trim()).filter(Boolean);
  const unique = [...new Set(list)];
  if (!unique.length) throw new Error(`${label}不能为空。`);
  if (unique.length > max) throw new Error(`${label}最多允许 ${max} 项。`);
  return unique;
}

function validateRequest(input, now = new Date()) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("查询参数必须是对象。");
  const extra = Object.keys(input).filter((key) => !["months", "domains", "company", "person", "forceRefresh"].includes(key));
  if (extra.length) throw new Error(`查询包含不支持的参数：${extra.join(", ")}`);
  const months = validateRequestedMonths(normalizeList(input.months, "月份", MAX_QUERY_MONTHS), now);
  const domains = normalizeList(input.domains, "数据域", 5);
  if (domains.some((domain) => !ALLOWED_DOMAINS.has(domain))) throw new Error("查询包含不支持的数据域。");
  if (domains.includes("all") && domains.length !== 1) throw new Error("all 不能与其他数据域同时使用。");
  if ((domains.includes("all") || domains.some((domain) => domain === "performance" || domain === "product-sales"))
      && months.some((month) => month < PERFORMANCE_DATA_START_MONTH)) {
    throw new Error(`业绩订单和 OPP 订单的已确认数据范围从 ${PERFORMANCE_DATA_START_MONTH} 开始，不能混入更早月份。`);
  }
  const company = typeof input.company === "string" ? input.company.trim() : "";
  const person = typeof input.person === "string" ? input.person.trim() : "";
  if (Buffer.byteLength(company, "utf8") > 360 || Buffer.byteLength(person, "utf8") > 360) throw new Error("公司或人员名称过长。");
  return { months, domains, company: company || undefined, person: person || undefined, forceRefresh: input.forceRefresh === true };
}

function hashCanonical(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function assertSinglePack(pack) {
  if (!pack || typeof pack !== "object" || !["ready", "needs_disambiguation"].includes(pack.status)) throw new Error("事实包状态无效。");
  if (pack.provenance?.live !== true || pack.provenance?.readOnly !== true || pack.provenance?.telephoneFieldsExported !== false || pack.provenance?.credentialFieldsExported !== false) {
    throw new Error("事实包来源或隐私边界无效。");
  }
  const canonical = {
    scope: pack.scope,
    entityResolution: pack.entityResolution,
    provenance: pack.provenance,
    facts: pack.facts,
    limitations: pack.limitations
  };
  if (pack.compaction) canonical.compaction = pack.compaction;
  if (pack.integrity?.algorithm !== "sha256" || pack.integrity.factPackSha256 !== hashCanonical(canonical)) {
    throw new Error("事实包完整性校验失败。");
  }
}

function assertSafeFactPack(pack) {
  if (Array.isArray(pack?.periods)) {
    if (!pack.periods.length || pack.periods.length > MAX_QUERY_MONTHS) throw new Error("多期事实包数量无效。");
    for (const period of pack.periods) assertSinglePack(period);
    if (pack.integrity?.algorithm !== "sha256" || typeof pack.integrity.factPackSha256 !== "string") throw new Error("多期事实包缺少完整性信息。");
  } else {
    assertSinglePack(pack);
  }
  if (pack?.mode === "xbb-live-readonly-multi-period-aggregate") {
    const bytes = Buffer.byteLength(JSON.stringify(pack), "utf8");
    if (bytes > MAX_AGGREGATE_BYTES
        || pack.compaction?.budgetBytes !== MAX_AGGREGATE_BYTES
        || pack.compaction?.finalBytes !== bytes) {
      throw new Error("跨月事实包大小或压缩元数据无效。");
    }
  }
  assertNoSensitiveFactValues(pack);
  return pack;
}

function createToolGateway(options = {}, testOnlyCapability) {
  const projectRoot = options.projectRoot || path.resolve(__dirname, "..", "..");
  const runner = options.runner || path.join(projectRoot, "skills", "xbb-executive-analyst", "scripts", "query-xbb.ps1");
  const powershell = options.powershell || "powershell.exe";
  const run = options.execFile || execFile;
  if (Object.hasOwn(options, "platform")) {
    throw new Error("platform 覆盖已禁用；测试必须使用显式 testOnlyPlatform 注入。");
  }
  const testOnlyPlatform = options.testOnlyPlatform;
  if (testOnlyPlatform !== undefined
      && (testOnlyCapability !== TEST_ONLY_PLATFORM_CAPABILITY
        || !new Set(["win32", "linux", "darwin"]).has(testOnlyPlatform)
        || typeof options.execFile !== "function")) {
    throw new Error("testOnlyPlatform 只能通过测试专用 gateway 工厂与 execFile 替身注入。");
  }
  const platform = testOnlyPlatform || process.platform;
  const runnerStdinWriter = options.runnerStdinWriter
    || (testOnlyPlatform !== undefined ? (() => {}) : undefined);
  const enforceWindowsProcessTree = platform === "win32";
  const processTreeTerminator = options.processTreeTerminator || terminateWindowsProcessTree;
  const processTreeTerminationDeadlineMs = Number.isInteger(options.processTreeTerminationDeadlineMs) && options.processTreeTerminationDeadlineMs > 0
    ? options.processTreeTerminationDeadlineMs
    : DEFAULT_PROCESS_TREE_TERMINATION_DEADLINE_MS;
  if (platform === "win32" && !isFullyQualifiedWindowsPath(options.serviceLeasePath)) {
    throw new Error("Windows 销帮帮查询网关必须提供 fully-qualified serviceLeasePath，不能关闭跨代 runner 隔离。");
  }
  const serviceLeasePath = platform === "win32" ? path.resolve(options.serviceLeasePath) : null;
  const isolationEnabled = platform === "win32";
  const runnerRunRoot = path.join(os.tmpdir(), "Codex", "xbb-executive-analyst", "runs");
  const isolationMarkerFactory = options.isolationMarkerFactory || createRunnerIsolationMarker;
  const isolationRootBinder = options.isolationRootBinder || waitForRunnerIsolationBinding;
  const isolationMarkerRecoverer = options.isolationMarkerRecoverer || ((marker, recoveryOptions = {}) => recoverRunnerIsolation({
    serviceLeasePath,
    projectRoot,
    isolationToken: marker.token,
    confirmationOnly: recoveryOptions.confirmationOnly === true,
    powershell,
    execFile: options.isolationRecoveryExecFile
  }));
  const onIsolationFailure = typeof options.onIsolationFailure === "function" ? options.onIsolationFailure : null;
  const progressPollMs = Number.isInteger(options.progressPollMs) && options.progressPollMs >= 10 ? options.progressPollMs : 250;
  const inFlight = new Map();

  if (!fs.existsSync(runner)) throw new Error(`销帮帮唯一 runner 不存在：${runner}`);

  function removeUntrackedGatewayWorkDirectory(runDirectory) {
    try {
      fs.rmSync(runDirectory, { recursive: true, force: true });
      if (fs.existsSync(runDirectory)) throw new Error("gateway work directory still exists");
    } catch (error) {
      throw runnerIsolationStateError("runner gateway 临时目录无法确认清理，查询网关已安全关闭。", error);
    }
  }

  function assertFullRecovery(marker, runDirectory) {
    if (fs.existsSync(marker.markerPath) || fs.existsSync(runDirectory)) {
      throw runnerIsolationStateError("runner 隔离恢复器未清理 marker 或 gateway 临时目录。");
    }
  }

  function assertConfirmationOnly(marker, runDirectory) {
    if (!fs.existsSync(marker.markerPath) || !fs.existsSync(runDirectory)) {
      throw runnerIsolationStateError("runner 零候选确认阶段提前清理了受保护状态。");
    }
  }

  async function invokeIsolationRecovery(marker, recoveryOptions) {
    try {
      return await isolationMarkerRecoverer(marker, recoveryOptions);
    } catch (error) {
      throw runnerIsolationStateError("runner 隔离恢复未能确认安全状态。", error);
    }
  }

  async function executeQuery(input, company, progressCallback, signal) {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : abortError();
    const tempParent = path.join(os.tmpdir(), "Codex", "xbb-executive-analyst", "bot-runs");
    fs.mkdirSync(tempParent, { recursive: true });

    try {
      let completedPack = null;
      let lastError;
      for (let attempt = 0; attempt < 2 && !completedPack; attempt += 1) {
        if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : abortError();
        const runDir = fs.mkdtempSync(path.join(tempParent, "request-"));
        const outputPath = path.join(runDir, "fact-pack.json");
        const progressPath = progressCallback ? path.join(runDir, "progress.jsonl") : null;
        const baseArgs = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", runner,
          "-OutputPath", outputPath, "-RequestFromStdin"];
        if (progressPath) baseArgs.push("-ProgressPath", progressPath);
        const requestStdin = `${JSON.stringify({
          months: input.months,
          domains: input.domains,
          company: company || null,
          person: input.person || null,
          forceRefresh: input.forceRefresh === true
        })}\n`;
        let isolationMarker = null;
        let preserveIsolationMarker = false;
        let isolationMarkerRecovered = false;
        let attemptPack = null;
        let shouldRetry = false;
        try {
          if (isolationEnabled) {
            try {
              isolationMarker = isolationMarkerFactory({
                serviceLeasePath,
                projectRoot,
                runner,
                runRoot: runnerRunRoot,
                gatewayWorkDirectory: runDir
              });
            } catch (error) {
              throw runnerIsolationStateError("runner 隔离标记无法在 spawn 前建立。", error);
            }
          }
          const attemptArgs = isolationMarker
            ? [...baseArgs, "-IsolationToken", isolationMarker.token, "-IsolationMarkerPath", isolationMarker.markerPath]
            : baseArgs;
          const terminateIsolatedTree = isolationMarker
            ? async () => {
                await invokeIsolationRecovery(isolationMarker, { terminationRequested: true });
                assertFullRecovery(isolationMarker, runDir);
                isolationMarkerRecovered = true;
                return true;
              }
            : processTreeTerminator;
          await runWithProgress(() => runRunnerProcess(run, powershell, attemptArgs, {
            windowsHide: true,
            encoding: "utf8",
            timeoutMs: runnerTimeoutMs(input.months.length),
            maxBuffer: 2 * 1024 * 1024,
            signal,
            platform,
            enforceWindowsProcessTree,
            processTreeTerminator: terminateIsolatedTree,
            processTreeTerminationDeadlineMs,
            stdinText: requestStdin,
            stdinWriter: runnerStdinWriter,
            onWindowsProcessStarted: isolationMarker
              ? (pid) => isolationRootBinder(isolationMarker, pid)
              : undefined
          }), { progressPath, callback: progressCallback, pollMs: progressPollMs });
          if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : abortError();
          // 正常返回也不能假定 Node 后代同步退出：先只做双健康零候选确认，
          // marker 与事实文件保持受保护，读取并校验后再执行完整清理。
          if (isolationMarker) {
            await invokeIsolationRecovery(isolationMarker, { confirmationOnly: true, terminationRequested: false });
            assertConfirmationOnly(isolationMarker, runDir);
          }
          if (!fs.existsSync(outputPath)) throw new Error("销帮帮 runner 未生成事实包。");
          const pack = JSON.parse(fs.readFileSync(outputPath, "utf8"));
          await emitProgress(progressCallback, { stage: "validating", completed: input.months.length, total: input.months.length });
          attemptPack = assertSafeFactPack(pack);
        } catch (error) {
          preserveIsolationMarker = error?.code === PROCESS_TREE_UNCONFIRMED_CODE || error?.code === RUNNER_ISOLATION_ERROR_CODE;
          if (error?.code === PROCESS_TREE_UNCONFIRMED_CODE || error?.code === RUNNER_ISOLATION_ERROR_CODE) throw error;
          if (isAbortError(error, signal)) throw signal?.reason instanceof Error ? signal.reason : abortError();
          lastError = error;
          const message = String(error?.message || "");
          const permanent = /事实包|查询参数|月份|数据域|公司|人员|授权|隐私|完整性|哈希|不支持|安全上限/.test(message);
          if (attempt > 0 || permanent) throw error;
          shouldRetry = true;
        } finally {
          if (isolationMarker && !preserveIsolationMarker && !isolationMarkerRecovered) {
            await invokeIsolationRecovery(isolationMarker, { terminationRequested: false });
            assertFullRecovery(isolationMarker, runDir);
            isolationMarkerRecovered = true;
          } else if (!isolationMarker) {
            removeUntrackedGatewayWorkDirectory(runDir);
          }
        }
        if (attemptPack) completedPack = attemptPack;
        if (shouldRetry) await emitProgress(progressCallback, { stage: "run_started", completed: 0, total: input.months.length });
      }
      if (!completedPack) throw lastError || new Error("销帮帮 runner 未完成。");
      await emitProgress(progressCallback, { stage: "query_ready", completed: input.months.length, total: input.months.length });
      return completedPack;
    } catch (error) {
      if (error?.code === PROCESS_TREE_UNCONFIRMED_CODE || error?.code === RUNNER_ISOLATION_ERROR_CODE) throw error;
      if (isAbortError(error, signal)) throw signal?.reason instanceof Error ? signal.reason : abortError();
      throw runnerExecutionError(error);
    }
  }

  const maxConcurrentQueries = Number.isInteger(options.maxConcurrentQueries) && options.maxConcurrentQueries > 0
    ? Math.min(options.maxConcurrentQueries, 16)
    : DEFAULT_MAX_CONCURRENT_QUERIES;
  const maxQueuedQueries = Number.isInteger(options.maxQueuedQueries) && options.maxQueuedQueries >= 0
    ? Math.min(options.maxQueuedQueries, 256)
    : DEFAULT_MAX_QUEUED_QUERIES;
  const queueTtlMs = Number.isInteger(options.queueTtlMs) && options.queueTtlMs > 0
    ? options.queueTtlMs
    : DEFAULT_QUERY_QUEUE_TTL_MS;
  const queue = [];
  let runningQueries = 0;
  let nextSubscriberId = 1;
  let failClosedCause = null;
  let isolationFailureNotified = false;

  function notifyIsolationFailure(error) {
    if (!onIsolationFailure || isolationFailureNotified) return;
    isolationFailureNotified = true;
    try {
      Promise.resolve(onIsolationFailure(error)).catch(() => {});
    } catch {
      // 生命周期回调失败不能掩盖进程隔离失败，也不能重新开放查询网关。
    }
  }

  function removeFromQueue(entry) {
    const index = queue.indexOf(entry);
    if (index >= 0) queue.splice(index, 1);
  }

  function settleSubscriber(entry, subscriber, error, value) {
    if (!subscriber || subscriber.settled) return;
    subscriber.settled = true;
    entry.subscribers.delete(subscriber.id);
    if (subscriber.signal && subscriber.onAbort) subscriber.signal.removeEventListener("abort", subscriber.onAbort);
    if (error) subscriber.reject(error);
    else subscriber.resolve(value);
  }

  function abortEntryWithoutSubscribers(entry) {
    if (entry.subscribers.size || entry.state === "settled" || entry.state === "cancelled") return;
    if (entry.state === "queued") {
      entry.state = "cancelled";
      removeFromQueue(entry);
      if (entry.queueTimer) clearTimeout(entry.queueTimer);
      if (inFlight.get(entry.key) === entry) inFlight.delete(entry.key);
      entry.controller.abort(abortError("销帮帮查询在排队期间已取消。"));
      pumpQueue();
      return;
    }
    if (entry.state === "running" && !entry.controller.signal.aborted) {
      entry.controller.abort(abortError());
    }
  }

  function addSubscriber(entry, invocation) {
    const signal = invocation?.signal;
    if (signal?.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : abortError());
    return new Promise((resolve, reject) => {
      const subscriber = {
        id: nextSubscriberId++,
        resolve,
        reject,
        settled: false,
        signal,
        onAbort: null,
        progressCallback: typeof invocation?.onProgress === "function" ? invocation.onProgress : null
      };
      if (signal) {
        subscriber.onAbort = () => {
          settleSubscriber(entry, subscriber, signal.reason instanceof Error ? signal.reason : abortError());
          abortEntryWithoutSubscribers(entry);
        };
        signal.addEventListener("abort", subscriber.onAbort, { once: true });
      }
      entry.subscribers.set(subscriber.id, subscriber);
    });
  }

  async function broadcastProgress(entry, event) {
    await Promise.all([...entry.subscribers.values()].map((subscriber) => emitProgress(subscriber.progressCallback, event)));
  }

  function finishEntry(entry, error, value) {
    if (entry.state === "settled" || entry.state === "cancelled") return;
    if (entry.queueTimer) clearTimeout(entry.queueTimer);
    if (entry.state === "running") runningQueries = Math.max(0, runningQueries - 1);
    else removeFromQueue(entry);
    entry.state = "settled";
    if (inFlight.get(entry.key) === entry) inFlight.delete(entry.key);
    for (const subscriber of [...entry.subscribers.values()]) settleSubscriber(entry, subscriber, error, value);
    if (error?.code === PROCESS_TREE_UNCONFIRMED_CODE || error?.code === RUNNER_ISOLATION_ERROR_CODE) {
      failClosedCause = error;
      notifyIsolationFailure(error);
      const closedError = gatewayFailClosedError(error);
      for (const queuedEntry of queue.splice(0)) {
        if (queuedEntry.queueTimer) clearTimeout(queuedEntry.queueTimer);
        queuedEntry.state = "settled";
        if (inFlight.get(queuedEntry.key) === queuedEntry) inFlight.delete(queuedEntry.key);
        for (const subscriber of [...queuedEntry.subscribers.values()]) {
          settleSubscriber(queuedEntry, subscriber, closedError);
        }
        queuedEntry.controller.abort(abortError(closedError.message));
      }
      for (const runningEntry of new Set(inFlight.values())) {
        if (runningEntry === entry || runningEntry.state !== "running") continue;
        for (const subscriber of [...runningEntry.subscribers.values()]) {
          settleSubscriber(runningEntry, subscriber, closedError);
        }
        if (!runningEntry.controller.signal.aborted) runningEntry.controller.abort(abortError(closedError.message));
      }
      return;
    }
    pumpQueue();
  }

  function startEntry(entry) {
    if (entry.state === "cancelled" || entry.state === "settled" || !entry.subscribers.size) {
      abortEntryWithoutSubscribers(entry);
      return;
    }
    if (entry.queueTimer) clearTimeout(entry.queueTimer);
    entry.queueTimer = null;
    entry.state = "running";
    runningQueries += 1;
    Promise.resolve(executeQuery(entry.input, entry.company, (event) => broadcastProgress(entry, event), entry.controller.signal)).then(
      (value) => finishEntry(entry, null, value),
      (error) => finishEntry(entry, error)
    );
  }

  function pumpQueue() {
    if (failClosedCause) return;
    while (runningQueries < maxConcurrentQueries && queue.length) {
      const entry = queue.shift();
      if (entry.state !== "queued" || !entry.subscribers.size) {
        abortEntryWithoutSubscribers(entry);
        continue;
      }
      startEntry(entry);
    }
  }

  function enqueueEntry(entry) {
    if (runningQueries < maxConcurrentQueries) {
      startEntry(entry);
      return;
    }
    entry.state = "queued";
    entry.queueTimer = setTimeout(() => {
      if (entry.state !== "queued") return;
      removeFromQueue(entry);
      entry.state = "settled";
      if (inFlight.get(entry.key) === entry) inFlight.delete(entry.key);
      const error = new Error("销帮帮查询排队超过安全时限，已取消本次排队任务。");
      error.code = "XBB_QUERY_QUEUE_TIMEOUT";
      for (const subscriber of [...entry.subscribers.values()]) settleSubscriber(entry, subscriber, error);
      entry.controller.abort(abortError(error.message));
      pumpQueue();
    }, queueTtlMs);
    entry.queueTimer.unref?.();
    queue.push(entry);
  }

  return async function queryXbb(rawInput, access, invocation = {}) {
    if (invocation?.signal?.aborted) {
      throw invocation.signal.reason instanceof Error ? invocation.signal.reason : abortError();
    }
    const input = validateRequest(rawInput);
    const company = enforceCompany(access, input.company);
    if (failClosedCause) throw gatewayFailClosedError(failClosedCause);
    const key = hashCanonical({
      input: { ...input, company: company || null },
      access: {
        scope: access?.scope || null,
        companies: Array.isArray(access?.companies) ? [...access.companies].sort() : []
      }
    });
    const existing = inFlight.get(key);
    if (existing) {
      if (existing.state === "queued" || (existing.state === "running" && !existing.controller.signal.aborted)) {
        return addSubscriber(existing, invocation);
      }
      throw abortError("相同范围的销帮帮查询正在取消，请等待最新请求接替。");
    }
    if (runningQueries >= maxConcurrentQueries && queue.length >= maxQueuedQueries) {
      const error = new Error(`销帮帮查询排队已达到安全上限（${maxQueuedQueries}）。`);
      error.code = "XBB_QUERY_QUEUE_FULL";
      throw error;
    }
    const entry = {
      key,
      input,
      company,
      controller: new AbortController(),
      subscribers: new Map(),
      state: "new",
      queueTimer: null
    };
    inFlight.set(key, entry);
    const result = addSubscriber(entry, invocation);
    enqueueEntry(entry);
    return result;
  };
}

function createToolGatewayForTest(options = {}) {
  return createToolGateway(options, TEST_ONLY_PLATFORM_CAPABILITY);
}

module.exports = {
  ALLOWED_DOMAINS,
  DEFAULT_MAX_CONCURRENT_QUERIES,
  DEFAULT_MAX_QUEUED_QUERIES,
  DEFAULT_PROCESS_TREE_TERMINATION_DEADLINE_MS,
  DEFAULT_QUERY_QUEUE_TTL_MS,
  GATEWAY_FAIL_CLOSED_CODE,
  PROCESS_TREE_UNCONFIRMED_CODE,
  RUNNER_ISOLATION_ERROR_CODE,
  RUNNER_EXECUTION_ERROR_CODE,
  assertSafeFactPack,
  createToolGateway,
  createToolGatewayForTest,
  drainProgressFile,
  emitProgress,
  runWithProgress,
  runRunnerProcess,
  runnerTimeoutMs,
  terminateWindowsProcessTree,
  validateRequest
};
