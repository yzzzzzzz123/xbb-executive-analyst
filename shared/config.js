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

function validateEndpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("模型接口必须是完整 URL。"); }
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("模型接口必须使用 HTTPS；仅回环地址允许 HTTP。");
  }
  return url.toString();
}

function validateReasoningEffort(value) {
  if (!["minimal", "low", "medium", "high", "xhigh", "max"].includes(value)) {
    throw new Error("Codex 推理强度只支持 minimal、low、medium、high、xhigh 或 max。");
  }
  return value;
}

function validateCodexModel(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]{2,128}$/.test(value)) {
    throw new Error("Codex 模型名称格式无效。");
  }
  return value;
}

function loadConfig(options = {}) {
  const env = options.env || process.env;
  const localRoot = options.localRoot || defaultLocalRoot();
  const configPath = path.resolve(envValue(env, "XBB_BOT_CONFIG_PATH", path.join(localRoot, "bot-config.json")));

  let stored = {};
  const hasCompleteEnv = env.XBB_WECOM_BOT_ID && env.XBB_WECOM_BOT_SECRET;
  if (!hasCompleteEnv) stored = readSecureConfig(configPath);

  const transport = buildWecomConfig(env, stored);
  const modelProvider = envValue(env, "XBB_MODEL_PROVIDER", stored.modelProvider || "local-codex");
  if (!["local-codex", "chat-completions"].includes(modelProvider)) {
    throw new Error("模型提供方式只支持 local-codex 或 chat-completions。");
  }

  const config = {
    ...transport,
    modelProvider,
    modelTimeoutMs: parseInteger(envValue(env, "XBB_MODEL_TIMEOUT_MS", stored.modelTimeoutMs || 300000), "模型超时", 1000, 600000),
    accessPolicyPath: path.resolve(envValue(env, "XBB_ACCESS_POLICY_PATH", stored.accessPolicyPath || path.join(localRoot, "access-policy.json")))
  };

  if (modelProvider === "local-codex") {
    const codexCommand = envValue(env, "XBB_CODEX_COMMAND", stored.codexCommand);
    if (codexCommand) config.codexCommand = codexCommand;
    config.codexModel = validateCodexModel(envValue(env, "XBB_CODEX_MODEL", stored.codexModel || "gpt-5.6-sol"));
    config.codexReasoningEffort = validateReasoningEffort(envValue(env, "XBB_CODEX_REASONING_EFFORT", stored.codexReasoningEffort || "max"));
  } else {
    config.modelEndpoint = validateEndpoint(envValue(env, "XBB_MODEL_ENDPOINT", stored.modelEndpoint));
    config.modelApiKey = envValue(env, "XBB_MODEL_API_KEY", stored.modelApiKey || "");
    config.modelName = envValue(env, "XBB_MODEL_NAME", stored.modelName);
    if (typeof config.modelName !== "string" || !config.modelName.trim()) throw new Error("模型名称未配置。");
  }
  return Object.freeze(config);
}

module.exports = { defaultLocalRoot, loadConfig, loadWecomConfig, validateCodexModel, validateEndpoint, validateReasoningEffort, validateWebSocketEndpoint };
