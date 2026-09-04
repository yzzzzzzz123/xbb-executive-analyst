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

const execFile = util.promisify(childProcess.execFile);
const ALLOWED_DOMAINS = new Set(["all", "performance", "product-sales", "courses", "delivery", "opportunities"]);
const MIN_RUNNER_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_RUNNER_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_MAX_CONCURRENT_QUERIES = 1;
const DEFAULT_MAX_QUEUED_QUERIES = 32;
const DEFAULT_QUERY_QUEUE_TTL_MS = 12 * 60 * 1000;

function abortError(message = "销帮帮查询已取消。") {
  const error = new Error(message);
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

function isAbortError(error, signal) {
  return signal?.aborted === true || error?.name === "AbortError" || error?.code === "ABORT_ERR";
}

function terminateWindowsProcessTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      childProcess.execFile(
        "taskkill.exe",
        ["/PID", String(pid), "/T", "/F"],
        { windowsHide: true, timeout: 5000 },
        (error) => resolve(!error)
      );
    } catch {
      resolve(false);
    }
  });
}

function runRunnerProcess(run, command, args, options = {}) {
  const {
    signal,
    timeoutMs,
    platform = process.platform,
    enforceWindowsProcessTree = false,
    processTreeTerminator = terminateWindowsProcessTree,
    ...execOptions
  } = options;
  if (signal?.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : abortError());

  const useWindowsProcessTree = platform === "win32" && enforceWindowsProcessTree;
  if (!useWindowsProcessTree) {
    return run(command, args, { ...execOptions, timeout: timeoutMs, signal });
  }

  const execution = run(command, args, execOptions);
  const child = execution?.child;
  const pid = Number(child?.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    try { child?.kill?.(); } catch {}
    Promise.resolve(execution).catch(() => {});
    return Promise.reject(new Error("Windows 销帮帮 runner 未暴露可回收的进程 ID。"));
  }

  let terminationReason = null;
  let terminationPromise = null;
  let rejectCancellation;
  const cancellation = new Promise((_resolve, reject) => { rejectCancellation = reject; });
  const terminate = (reason) => {
    if (terminationPromise) return;
    terminationReason = reason;
    terminationPromise = Promise.resolve().then(() => processTreeTerminator(pid)).then(
      () => {
        rejectCancellation(reason);
        try { child.kill?.(); } catch {}
      },
      () => {
        rejectCancellation(reason);
        try { child.kill?.(); } catch {}
      }
    );
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

  return Promise.race([execution, cancellation]).then((value) => {
    if (terminationReason) throw terminationReason;
    return value;
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

function createToolGateway(options = {}) {
  const projectRoot = options.projectRoot || path.resolve(__dirname, "..", "..");
  const runner = options.runner || path.join(projectRoot, "skills", "xbb-executive-analyst", "scripts", "query-xbb.ps1");
  const powershell = options.powershell || "powershell.exe";
  const run = options.execFile || execFile;
  const platform = options.platform || process.platform;
  const enforceWindowsProcessTree = platform === "win32" && (!options.execFile || options.enforceWindowsProcessTree === true);
  const processTreeTerminator = options.processTreeTerminator || terminateWindowsProcessTree;
  const progressPollMs = Number.isInteger(options.progressPollMs) && options.progressPollMs >= 10 ? options.progressPollMs : 250;
  const inFlight = new Map();

  if (!fs.existsSync(runner)) throw new Error(`销帮帮唯一 runner 不存在：${runner}`);

  async function executeQuery(input, company, progressCallback, signal) {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : abortError();
    const tempParent = path.join(os.tmpdir(), "Codex", "xbb-executive-analyst", "bot-runs");
    fs.mkdirSync(tempParent, { recursive: true });
    const runDir = fs.mkdtempSync(path.join(tempParent, "request-"));
    const outputPath = path.join(runDir, "fact-pack.json");
    const progressPath = progressCallback ? path.join(runDir, "progress.jsonl") : null;
    const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", runner,
      "-Month", input.months.join(","), "-Domains", input.domains.join(","), "-OutputPath", outputPath];
    if (progressPath) args.push("-ProgressPath", progressPath);
    if (company) args.push("-Company", company);
    if (input.person) args.push("-Person", input.person);
    if (input.forceRefresh) args.push("-ForceRefresh");

    try {
      let completed = false;
      let lastError;
      for (let attempt = 0; attempt < 2 && !completed; attempt += 1) {
        if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : abortError();
        try {
          await runWithProgress(() => runRunnerProcess(run, powershell, args, {
            windowsHide: true,
            encoding: "utf8",
            timeoutMs: runnerTimeoutMs(input.months.length),
            maxBuffer: 2 * 1024 * 1024,
            signal,
            platform,
            enforceWindowsProcessTree,
            processTreeTerminator
          }), { progressPath, callback: progressCallback, pollMs: progressPollMs });
          if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : abortError();
          completed = true;
        } catch (error) {
          if (isAbortError(error, signal)) throw signal?.reason instanceof Error ? signal.reason : abortError();
          lastError = error;
          const message = String(error?.message || "");
          const permanent = /事实包|查询参数|月份|数据域|公司|人员|授权|隐私|完整性|哈希|不支持|安全上限/.test(message);
          if (attempt > 0 || permanent) throw error;
          await emitProgress(progressCallback, { stage: "run_started", completed: 0, total: input.months.length });
        }
      }
      if (!completed) throw lastError || new Error("销帮帮 runner 未完成。");
      if (!fs.existsSync(outputPath)) throw new Error("销帮帮 runner 未生成事实包。");
      const pack = JSON.parse(fs.readFileSync(outputPath, "utf8"));
      await emitProgress(progressCallback, { stage: "validating", completed: input.months.length, total: input.months.length });
      const safePack = assertSafeFactPack(pack);
      await emitProgress(progressCallback, { stage: "query_ready", completed: input.months.length, total: input.months.length });
      return safePack;
    } catch (error) {
      if (isAbortError(error, signal)) throw signal?.reason instanceof Error ? signal.reason : abortError();
      if (error && /事实包|查询参数|月份|数据域|公司|runner/.test(error.message || "")) throw error;
      throw new Error("实时销帮帮查询失败，未返回任何替代或陈旧结果。", { cause: error });
    } finally {
      try { fs.rmSync(runDir, { recursive: true, force: true }); } catch { /* 单次临时目录由系统清理兜底 */ }
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

module.exports = {
  ALLOWED_DOMAINS,
  DEFAULT_MAX_CONCURRENT_QUERIES,
  DEFAULT_MAX_QUEUED_QUERIES,
  DEFAULT_QUERY_QUEUE_TTL_MS,
  assertSafeFactPack,
  createToolGateway,
  drainProgressFile,
  emitProgress,
  runWithProgress,
  runRunnerProcess,
  runnerTimeoutMs,
  terminateWindowsProcessTree,
  validateRequest
};
