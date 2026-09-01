"use strict";

const childProcess = require("node:child_process");
const os = require("node:os");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");

function defaultLocalRoot() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(localAppData, "Codex", "xbb-executive-analyst");
}

function readSecureConfig(configPath) {
  const reader = path.join(projectRoot, "scripts", "read-secure-config.ps1");
  const output = childProcess.execFileSync("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", reader, "-Path", configPath
  ], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"]
  });
  return JSON.parse(output);
}

function envValue(env, key, fallback) {
  return typeof env[key] === "string" && env[key] !== "" ? env[key] : fallback;
}

function parseInteger(value, label, min, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`${label} 必须是 ${min}-${max} 的整数。`);
  return parsed;
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

function loadConfig(options = {}) {
  const env = options.env || process.env;
  const localRoot = options.localRoot || defaultLocalRoot();
  const configPath = path.resolve(envValue(env, "XBB_BOT_CONFIG_PATH", path.join(localRoot, "bot-config.json")));

  let stored = {};
  const hasCompleteEnv = env.XBB_WECOM_TOKEN && env.XBB_WECOM_ENCODING_AES_KEY && env.XBB_MODEL_ENDPOINT && env.XBB_MODEL_NAME;
  if (!hasCompleteEnv) stored = readSecureConfig(configPath);

  const config = {
    host: envValue(env, "XBB_WECOM_HOST", stored.host || "127.0.0.1"),
    port: parseInteger(envValue(env, "XBB_WECOM_PORT", stored.port || 8788), "监听端口", 1, 65535),
    callbackPath: envValue(env, "XBB_WECOM_CALLBACK_PATH", stored.callbackPath || "/wecom/callback"),
    wecomToken: envValue(env, "XBB_WECOM_TOKEN", stored.wecomToken),
    wecomEncodingAesKey: envValue(env, "XBB_WECOM_ENCODING_AES_KEY", stored.wecomEncodingAesKey),
    wecomReceiveId: envValue(env, "XBB_WECOM_RECEIVE_ID", stored.wecomReceiveId || ""),
    modelEndpoint: validateEndpoint(envValue(env, "XBB_MODEL_ENDPOINT", stored.modelEndpoint)),
    modelApiKey: envValue(env, "XBB_MODEL_API_KEY", stored.modelApiKey || ""),
    modelName: envValue(env, "XBB_MODEL_NAME", stored.modelName),
    modelTimeoutMs: parseInteger(envValue(env, "XBB_MODEL_TIMEOUT_MS", stored.modelTimeoutMs || 120000), "模型超时", 1000, 360000),
    accessPolicyPath: path.resolve(envValue(env, "XBB_ACCESS_POLICY_PATH", stored.accessPolicyPath || path.join(localRoot, "access-policy.json"))),
    maxBodyBytes: parseInteger(envValue(env, "XBB_WECOM_MAX_BODY_BYTES", stored.maxBodyBytes || 1048576), "回调消息上限", 1024, 10485760)
  };

  if (!config.host || typeof config.host !== "string") throw new Error("监听地址不能为空。");
  if (!/^\/[A-Za-z0-9/_-]*$/.test(config.callbackPath)) throw new Error("回调路径必须是以 / 开头的安全路径。");
  if (typeof config.wecomToken !== "string" || !config.wecomToken) throw new Error("企业微信 Token 未配置。");
  if (typeof config.wecomEncodingAesKey !== "string" || !/^[A-Za-z0-9+/]{43}$/.test(config.wecomEncodingAesKey)) {
    throw new Error("企业微信 EncodingAESKey 必须是 43 位 Base64 字符串。");
  }
  if (typeof config.modelName !== "string" || !config.modelName.trim()) throw new Error("模型名称未配置。");
  return Object.freeze(config);
}

module.exports = { defaultLocalRoot, loadConfig, validateEndpoint };
