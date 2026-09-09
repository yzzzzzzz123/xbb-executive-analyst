"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const util = require("node:util");

const execFile = util.promisify(childProcess.execFile);
const ISOLATION_SCHEMA_VERSION = "2.0";
const ISOLATION_SERVICE = "xbb-executive-analyst-runner";
const ISOLATION_TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const RUNNER_ISOLATION_DIRECTORY_NAME = "runner-isolation";
const RUNNER_ISOLATION_ERROR_CODE = "XBB_RUNNER_ISOLATION_STATE_UNCONFIRMED";
const CHILD_SCRIPT_RELATIVE_PATHS = Object.freeze([
  path.join("shared", "xbb", "export-live-data.js"),
  path.join("shared", "xbb", "build-fact-pack.js"),
  path.join("shared", "xbb", "aggregate-multi-period.js")
]);
const QUERY_SCRIPT_RELATIVE_PATH = path.join("skills", "xbb-executive-analyst", "scripts", "query-xbb.ps1");
const DEFAULT_BIND_TIMEOUT_MS = 10 * 1000;
const RUN_ROOT_RELATIVE_PATH = path.join("Codex", "xbb-executive-analyst", "runs");
const GATEWAY_WORK_ROOT_RELATIVE_PATH = path.join("Codex", "xbb-executive-analyst", "bot-runs");
const GATEWAY_WORK_DIRECTORY_PATTERN = /^request-[A-Za-z0-9_-]{6,64}$/;
const TEST_ONLY_PLATFORM_CAPABILITY = Symbol("xbb-runner-isolation-test-only-platform-capability");

function isolationError(message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = RUNNER_ISOLATION_ERROR_CODE;
  return error;
}

function isFullyQualifiedWindowsPath(value) {
  if (typeof value !== "string" || !value.trim() || !path.win32.isAbsolute(value)) return false;
  const root = path.win32.parse(value).root;
  return /^[A-Za-z]:\\$/.test(root) || /^\\\\[^\\/]+\\[^\\/]+\\?$/.test(root);
}

function canonicalExistingPath(value, label) {
  if (typeof value !== "string" || !value.trim() || !path.isAbsolute(value)) throw new Error(`${label}必须是绝对路径。`);
  try { return fs.realpathSync.native(path.resolve(value)); } catch (error) { throw new Error(`${label}不存在或无法规范化。`, { cause: error }); }
}

function canonicalDirectory(value, label) {
  if (typeof value !== "string" || !value.trim() || !path.isAbsolute(value)) throw new Error(`${label}必须是绝对路径。`);
  fs.mkdirSync(path.resolve(value), { recursive: true });
  return canonicalExistingPath(value, label);
}

function defaultRunRoot() {
  return path.join(os.tmpdir(), RUN_ROOT_RELATIVE_PATH);
}

function defaultGatewayWorkRoot() {
  return path.join(os.tmpdir(), GATEWAY_WORK_ROOT_RELATIVE_PATH);
}

function samePath(left, right) {
  const a = path.resolve(String(left || ""));
  const b = path.resolve(String(right || ""));
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isLexicallyCanonicalAbsolutePath(value) {
  if (typeof value !== "string" || !value || !path.isAbsolute(value)) return false;
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() === value.toLowerCase() : normalized === value;
}

function runnerIsolationDirectory(serviceLeasePath) {
  if (typeof serviceLeasePath !== "string" || !serviceLeasePath.trim() || !path.isAbsolute(serviceLeasePath)) {
    throw new Error("runner 隔离目录必须由绝对机器人服务租约路径派生。");
  }
  return path.join(path.dirname(path.resolve(serviceLeasePath)), RUNNER_ISOLATION_DIRECTORY_NAME);
}

function markerPathForToken(directory, token) {
  if (!ISOLATION_TOKEN_PATTERN.test(String(token || ""))) throw new Error("runner 隔离 token 格式无效。");
  return path.join(path.resolve(directory), `${token}.json`);
}

function atomicWriteJson(target, payload) {
  const directory = path.dirname(target);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(target)}.tmp-${process.pid}-${crypto.randomBytes(8).toString("hex")}`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(payload)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, target);
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch {}
  }
}

function canonicalGatewayWorkDirectory(value) {
  const canonicalRoot = canonicalDirectory(defaultGatewayWorkRoot(), "runner gateway 临时根目录");
  const canonicalWorkDirectory = canonicalExistingPath(value, "runner gateway 临时目录");
  if (!samePath(path.dirname(canonicalWorkDirectory), canonicalRoot)
      || !GATEWAY_WORK_DIRECTORY_PATTERN.test(path.basename(canonicalWorkDirectory))) {
    throw new Error("runner gateway 临时目录不属于固定白名单布局。");
  }
  return canonicalWorkDirectory;
}

function expectedLayout(projectRoot, runner, runRoot, gatewayWorkDirectory) {
  const canonicalProjectRoot = canonicalExistingPath(projectRoot, "runner 项目根目录");
  const canonicalQueryScript = canonicalExistingPath(path.join(canonicalProjectRoot, QUERY_SCRIPT_RELATIVE_PATH), "runner 查询脚本");
  if (runner !== undefined && !samePath(canonicalExistingPath(runner, "runner 查询脚本"), canonicalQueryScript)) {
    throw new Error("runner 查询脚本不属于固定项目布局。");
  }
  const childScriptPaths = CHILD_SCRIPT_RELATIVE_PATHS.map((relative) => canonicalExistingPath(path.join(canonicalProjectRoot, relative), "runner 子脚本"));
  const canonicalRunRoot = runRoot === null
    ? null
    : canonicalDirectory(runRoot || defaultRunRoot(), "runner 临时目录");
  const canonicalGatewayWork = canonicalGatewayWorkDirectory(gatewayWorkDirectory);
  return Object.freeze({
    projectRoot: canonicalProjectRoot,
    queryScriptPath: canonicalQueryScript,
    childScriptPaths: Object.freeze(childScriptPaths),
    runRoot: canonicalRunRoot,
    gatewayWorkDirectory: canonicalGatewayWork
  });
}

function validateRootProcess(value) {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("runner 根进程绑定无效。");
  if (Object.keys(value).sort().join("\n") !== ["createdAtMs", "creationToken", "executablePath", "pid"].join("\n")) {
    throw new Error("runner 根进程绑定字段无效。");
  }
  if (!Number.isInteger(value.pid) || value.pid <= 0
      || !Number.isSafeInteger(value.createdAtMs) || value.createdAtMs <= 0
      || typeof value.creationToken !== "string" || !/^\d{10,20}$/.test(value.creationToken)
      || !isLexicallyCanonicalAbsolutePath(value.executablePath)
      || !/^(?:powershell|pwsh)\.exe$/i.test(path.basename(value.executablePath))) {
    throw new Error("runner 根进程绑定内容无效。");
  }
  return Object.freeze({
    pid: value.pid,
    creationToken: value.creationToken,
    createdAtMs: value.createdAtMs,
    executablePath: path.resolve(value.executablePath)
  });
}

function readRunnerIsolationMarker(markerPath) {
  let payload;
  try { payload = JSON.parse(fs.readFileSync(markerPath, "utf8")); } catch (error) { throw isolationError("runner 隔离标记无法读取。", error); }
  try {
    const expectedKeys = ["childScriptPaths", "createdAtMs", "gatewayWorkDirectory", "projectRoot", "queryScriptPath", "rootProcess", "runRoot", "schemaVersion", "service", "token"];
    if (!payload || typeof payload !== "object" || Array.isArray(payload)
        || Object.keys(payload).sort().join("\n") !== expectedKeys.join("\n")
        || payload.schemaVersion !== ISOLATION_SCHEMA_VERSION
        || payload.service !== ISOLATION_SERVICE
        || !ISOLATION_TOKEN_PATTERN.test(payload.token)
        || path.resolve(markerPath) !== markerPathForToken(path.dirname(markerPath), payload.token)
        || !Number.isSafeInteger(payload.createdAtMs) || payload.createdAtMs <= 0
        || !isLexicallyCanonicalAbsolutePath(payload.projectRoot)
        || !isLexicallyCanonicalAbsolutePath(payload.queryScriptPath)
        || !Array.isArray(payload.childScriptPaths) || payload.childScriptPaths.length !== CHILD_SCRIPT_RELATIVE_PATHS.length
        || payload.childScriptPaths.some((item) => !isLexicallyCanonicalAbsolutePath(item))
        || !isLexicallyCanonicalAbsolutePath(payload.gatewayWorkDirectory)
        || (payload.runRoot !== null && !isLexicallyCanonicalAbsolutePath(payload.runRoot))) {
      throw new Error("invalid marker contract");
    }
    const expectedQuery = path.join(payload.projectRoot, QUERY_SCRIPT_RELATIVE_PATH);
    const expectedChildren = CHILD_SCRIPT_RELATIVE_PATHS.map((relative) => path.join(payload.projectRoot, relative));
    const expectedGatewayRoot = path.resolve(defaultGatewayWorkRoot());
    if (!samePath(payload.queryScriptPath, expectedQuery)
        || payload.childScriptPaths.some((item, index) => !samePath(item, expectedChildren[index]))
        || !samePath(path.dirname(payload.gatewayWorkDirectory), expectedGatewayRoot)
        || !GATEWAY_WORK_DIRECTORY_PATTERN.test(path.basename(payload.gatewayWorkDirectory))) {
      throw new Error("marker layout mismatch");
    }
    const rootProcess = validateRootProcess(payload.rootProcess);
    return Object.freeze({ ...payload, rootProcess });
  } catch (error) {
    if (error?.code === RUNNER_ISOLATION_ERROR_CODE) throw error;
    throw isolationError("runner 隔离标记合同无效。", error);
  }
}

function createRunnerIsolationMarker({ serviceLeasePath, projectRoot, runner, runRoot, gatewayWorkDirectory, token = crypto.randomBytes(32).toString("hex"), now = Date.now } = {}) {
  if (!ISOLATION_TOKEN_PATTERN.test(String(token || ""))) throw new Error("runner 隔离 token 格式无效。");
  if (typeof now !== "function") throw new Error("runner 隔离时钟无效。");
  const directory = runnerIsolationDirectory(serviceLeasePath);
  const markerPath = markerPathForToken(directory, token);
  const createdAtMs = now();
  if (!Number.isSafeInteger(createdAtMs) || createdAtMs <= 0) throw new Error("runner 隔离标记时间无效。");
  const layout = expectedLayout(projectRoot, runner, runRoot, gatewayWorkDirectory);
  const payload = Object.freeze({
    schemaVersion: ISOLATION_SCHEMA_VERSION,
    service: ISOLATION_SERVICE,
    token,
    createdAtMs,
    projectRoot: layout.projectRoot,
    queryScriptPath: layout.queryScriptPath,
    childScriptPaths: layout.childScriptPaths,
    runRoot: layout.runRoot,
    gatewayWorkDirectory: layout.gatewayWorkDirectory,
    rootProcess: null
  });
  try { atomicWriteJson(markerPath, payload); } catch (error) { throw isolationError("runner 隔离标记无法原子持久化；本次查询未启动。", error); }
  return Object.freeze({ token, markerPath, directory, createdAtMs, ...layout });
}

function clearRunnerIsolationMarker(marker) {
  const token = marker?.token;
  const markerPath = marker?.markerPath;
  const directory = marker?.directory;
  if (!ISOLATION_TOKEN_PATTERN.test(String(token || ""))
      || typeof markerPath !== "string"
      || typeof directory !== "string"
      || path.resolve(markerPath) !== markerPathForToken(directory, token)) {
    throw isolationError("runner 隔离标记引用无效，不能确认安全清理。", new Error("invalid marker reference"));
  }
  try { fs.rmSync(markerPath, { force: true }); } catch (error) { throw isolationError("runner 隔离标记无法清理。", error); }
}

function waitForRunnerIsolationBinding(marker, expectedPid, options = {}) {
  if (!Number.isInteger(expectedPid) || expectedPid <= 0) return Promise.reject(isolationError("runner 根进程 PID 无效。"));
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0 ? Math.min(options.timeoutMs, 60000) : DEFAULT_BIND_TIMEOUT_MS;
  const pollMs = Number.isInteger(options.pollMs) && options.pollMs > 0 ? Math.min(options.pollMs, 1000) : 25;
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const inspect = () => {
      try {
        const payload = readRunnerIsolationMarker(marker.markerPath);
        if (payload.rootProcess) {
          if (payload.rootProcess.pid !== expectedPid) throw isolationError("runner 根进程 PID 与已启动进程不一致。");
          resolve(payload.rootProcess);
          return;
        }
      } catch (error) {
        reject(error?.code === RUNNER_ISOLATION_ERROR_CODE ? error : isolationError("runner 根进程绑定校验失败。", error));
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(isolationError("runner 未在安全时限内绑定根进程身份。"));
        return;
      }
      setTimeout(inspect, pollMs);
    };
    inspect();
  });
}

function parseRecoveryResult(stdout) {
  const lines = String(stdout || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) throw new Error("runner 隔离恢复器未返回结果。");
  let result;
  try { result = JSON.parse(lines.at(-1)); } catch (error) { throw new Error("runner 隔离恢复器返回了无效结果。", { cause: error }); }
  if (result?.success !== true
      || !Number.isInteger(result.markersRecovered) || result.markersRecovered < 0
      || !Number.isInteger(result.processesTerminated) || result.processesTerminated < 0
      || !Number.isInteger(result.runDirectoriesRemoved) || result.runDirectoriesRemoved < 0) {
    throw new Error("runner 隔离恢复器结果合同无效。");
  }
  return Object.freeze({
    status: "recovered",
    markersRecovered: result.markersRecovered,
    processesTerminated: result.processesTerminated,
    runDirectoriesRemoved: result.runDirectoriesRemoved
  });
}

async function recoverRunnerIsolation(options = {}, testOnlyCapability) {
  if (Object.hasOwn(options, "platform")) {
    throw new Error("platform 覆盖已禁用；测试必须使用显式 testOnlyPlatform 注入。");
  }
  const testOnlyPlatform = options.testOnlyPlatform;
  if (testOnlyPlatform !== undefined
      && (testOnlyCapability !== TEST_ONLY_PLATFORM_CAPABILITY
        || !new Set(["win32", "linux", "darwin"]).has(testOnlyPlatform)
        || typeof options.execFile !== "function")) {
    throw new Error("testOnlyPlatform 只能通过测试专用 recovery 工厂与 execFile 替身注入。");
  }
  const platform = testOnlyPlatform || process.platform;
  if (platform !== "win32") return Object.freeze({ status: "not_applicable", markersRecovered: 0, processesTerminated: 0, runDirectoriesRemoved: 0 });
  const serviceLeasePath = options.serviceLeasePath;
  const projectRoot = canonicalExistingPath(options.projectRoot || path.resolve(__dirname, "..", ".."), "当前项目根目录");
  const markerDirectory = runnerIsolationDirectory(serviceLeasePath);
  const recoveryScript = canonicalExistingPath(options.recoveryScript || path.join(projectRoot, "scripts", "recover-runner-isolation.ps1"), "runner 隔离恢复器");
  const powershell = options.powershell || "powershell.exe";
  const run = options.execFile || execFile;
  const isolationToken = options.isolationToken;
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
    ? Math.min(options.timeoutMs, 60 * 1000)
    : isolationToken === undefined ? 60 * 1000 : 8 * 1000;
  if (isolationToken !== undefined && !ISOLATION_TOKEN_PATTERN.test(String(isolationToken || ""))) {
    throw isolationError("runner 隔离恢复 token 格式无效。", new Error("invalid isolation token"));
  }
  try {
    const args = [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", recoveryScript,
      "-MarkerDirectory", markerDirectory,
      "-ProjectRoot", projectRoot
    ];
    if (isolationToken !== undefined) args.push("-IsolationToken", isolationToken);
    if (options.confirmationOnly === true) args.push("-ConfirmationOnly");
    const result = await run(powershell, args, {
      windowsHide: true,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024
    });
    const parsed = parseRecoveryResult(result?.stdout ?? result);
    if (isolationToken !== undefined) {
      const expectedRecovered = options.confirmationOnly === true ? 0 : 1;
      if (parsed.markersRecovered !== expectedRecovered) throw new Error(options.confirmationOnly === true
        ? "指定 runner 隔离标记未被唯一确认仍处于受保护状态。"
        : "指定 runner 隔离标记未被唯一确认并清理。");
    }
    return options.confirmationOnly === true ? Object.freeze({ ...parsed, status: "confirmed" }) : parsed;
  } catch (error) {
    if (error?.code === RUNNER_ISOLATION_ERROR_CODE) throw error;
    throw isolationError("runner 隔离恢复未能确认安全状态，机器人本轮启动已关闭。", error);
  }
}

function recoverRunnerIsolationForTest(options = {}) {
  return recoverRunnerIsolation(options, TEST_ONLY_PLATFORM_CAPABILITY);
}

module.exports = {
  CHILD_SCRIPT_RELATIVE_PATHS,
  DEFAULT_BIND_TIMEOUT_MS,
  GATEWAY_WORK_DIRECTORY_PATTERN,
  GATEWAY_WORK_ROOT_RELATIVE_PATH,
  ISOLATION_SCHEMA_VERSION,
  ISOLATION_SERVICE,
  ISOLATION_TOKEN_PATTERN,
  QUERY_SCRIPT_RELATIVE_PATH,
  RUN_ROOT_RELATIVE_PATH,
  RUNNER_ISOLATION_DIRECTORY_NAME,
  RUNNER_ISOLATION_ERROR_CODE,
  clearRunnerIsolationMarker,
  createRunnerIsolationMarker,
  defaultGatewayWorkRoot,
  defaultRunRoot,
  isFullyQualifiedWindowsPath,
  markerPathForToken,
  parseRecoveryResult,
  readRunnerIsolationMarker,
  recoverRunnerIsolation,
  recoverRunnerIsolationForTest,
  runnerIsolationDirectory,
  waitForRunnerIsolationBinding
};
