"use strict";

const childProcess = require("node:child_process");
const os = require("node:os");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");

function defaultLocalRoot() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(localAppData, "Codex", "xbb-executive-analyst");
}

function readSecureConfig(configPath, options = {}) {
  const reader = path.join(projectRoot, "scripts", "read-secure-config.ps1");
  const args = [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", reader, "-Path", configPath
  ];
  if (options.wecomOnly) args.push("-WecomOnly");
  const output = childProcess.execFileSync("powershell.exe", args, {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"]
  });
  return JSON.parse(output);
}

function buildWecomConfig(env, stored = {}) {
  const config = {
    wecomBotId: envValue(env, "XBB_WECOM_BOT_ID", stored.wecomBotId),
    wecomBotSecret: envValue(env, "XBB_WECOM_BOT_SECRET", stored.wecomBotSecret),
    wecomWsUrl: validateWebSocketEndpoint(envValue(env, "XBB_WECOM_WS_URL", stored.wecomWsUrl || "wss://openws.work.weixin.qq.com")),
    wecomMaxReconnectAttempts: parseInteger(envValue(env, "XBB_WECOM_MAX_RECONNECT_ATTEMPTS", stored.wecomMaxReconnectAttempts ?? -1), "企业微信最大重连次数", -1, 1000000),
    wecomHeartbeatMs: parseInteger(envValue(env, "XBB_WECOM_HEARTBEAT_MS", stored.wecomHeartbeatMs || 30000), "企业微信心跳间隔", 5000, 300000),
    wecomRequestTimeoutMs: parseInteger(envValue(env, "XBB_WECOM_REQUEST_TIMEOUT_MS", stored.wecomRequestTimeoutMs || 10000), "企业微信请求超时", 1000, 120000)
  };
  if (typeof config.wecomBotId !== "string" || !/^[A-Za-z0-9_-]{4,256}$/.test(config.wecomBotId)) throw new Error("企业微信 Bot ID 未配置或格式无效。");
  if (typeof config.wecomBotSecret !== "string" || !config.wecomBotSecret.trim()) throw new Error("企业微信 Bot Secret 未配置。");
  return Object.freeze(config);
}

function loadWecomConfig(options = {}) {
  const env = options.env || process.env;
  const localRoot = options.localRoot || defaultLocalRoot();
  const configPath = path.resolve(envValue(env, "XBB_BOT_CONFIG_PATH", path.join(localRoot, "bot-config.json")));
  const hasCompleteEnv = env.XBB_WECOM_BOT_ID && env.XBB_WECOM_BOT_SECRET;
  const stored = hasCompleteEnv ? {} : readSecureConfig(configPath, { wecomOnly: true });
  return buildWecomConfig(env, stored);
}

function envValue(env, key, fallback) {
  return typeof env[key] === "string" && env[key] !== "" ? env[key] : fallback;
}

function parseInteger(value, label, min, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`${label} 必须是 ${min}-${max} 的整数。`);
  return parsed;
}

function validateWebSocketEndpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("企业微信长连接地址必须是完整 URL。"); }
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (url.protocol !== "wss:" && !(url.protocol === "ws:" && loopback)) {
    throw new Error("企业微信长连接必须使用 WSS；仅回环测试地址允许 WS。");
  }
  return url.toString();
}

function validateReasoningEffort(value) {
  if (!["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value)) {
    throw new Error("Codex 推理强度只支持 none、minimal、low、medium、high、xhigh 或 max。");
  }
  return value;
}

function validateCodexModel(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]{2,128}$/.test(value)) {
    throw new Error("Codex 模型名称格式无效。");
  }
  return value;
}

function requireOutsideProject(value, label) {
  const resolved = path.resolve(value);
  const relative = path.relative(projectRoot, resolved);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    throw new Error(`${label}必须位于项目仓库外。`);
  }
  return resolved;
}

function loadConfig(options = {}) {
  const env = options.env || process.env;
  const localRoot = options.localRoot || defaultLocalRoot();
  const configPath = path.resolve(envValue(env, "XBB_BOT_CONFIG_PATH", path.join(localRoot, "bot-config.json")));

  let stored = {};
  const hasCompleteEnv = env.XBB_WECOM_BOT_ID && env.XBB_WECOM_BOT_SECRET;
  if (!hasCompleteEnv) stored = readSecureConfig(configPath);

  const transport = buildWecomConfig(env, stored);
  const modelProvider = envValue(env, "XBB_MODEL_PROVIDER", "codex-app-server");
  if (modelProvider !== "codex-app-server") throw new Error("正式运行时只支持 codex-app-server。");

  const config = {
    ...transport,
    modelProvider,
    projectRoot,
    codexModel: validateCodexModel(envValue(env, "XBB_CODEX_MODEL", stored.codexModel || "gpt-5.6-sol")),
    codexReasoningEffort: validateReasoningEffort(envValue(env, "XBB_CODEX_REASONING_EFFORT", stored.codexReasoningEffort || "medium")),
    agentTurnTimeoutMs: parseInteger(envValue(env, "XBB_AGENT_TURN_TIMEOUT_MS", stored.agentTurnTimeoutMs || 300000), "Codex Agent 单轮超时", 30000, 1800000),
    agentStatePath: requireOutsideProject(envValue(env, "XBB_AGENT_STATE_PATH", stored.agentStatePath || path.join(localRoot, "agent-state.json")), "Codex Agent 状态文件"),
    statusLogPath: requireOutsideProject(envValue(env, "XBB_STATUS_LOG_PATH", stored.statusLogPath || path.join(localRoot, "status.jsonl")), "机器人状态日志"),
    accessPolicyPath: path.resolve(envValue(env, "XBB_ACCESS_POLICY_PATH", stored.accessPolicyPath || path.join(localRoot, "access-policy.json")))
  };

  const codexCommand = envValue(env, "XBB_CODEX_COMMAND", stored.codexCommand);
  if (codexCommand) config.codexCommand = codexCommand;
  return Object.freeze(config);
}

module.exports = { defaultLocalRoot, loadConfig, loadWecomConfig, requireOutsideProject, validateCodexModel, validateReasoningEffort, validateWebSocketEndpoint };
