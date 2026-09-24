"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { defaultLocalRoot, requireOutsideProject } = require("../config.js");
const { validateInvitations } = require("../security/web-access.js");

const projectRoot = path.resolve(__dirname, "..", "..");
function loadWebConfig(configPath = process.env.XBB_WEB_CONFIG_PATH || path.join(defaultLocalRoot(), "web", "config.json")) {
  const location = requireOutsideProject(configPath, "网页配置");
  const stored = JSON.parse(fs.readFileSync(location, "utf8").replace(/^\uFEFF/, ""));
  const port = stored.port || 8091;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("网页端口无效。");
  const publicOrigin = stored.publicOrigin || `http://127.0.0.1:${port}`;
  const url = new URL(publicOrigin);
  if (url.origin !== publicOrigin || url.username || url.password ||
    (url.protocol !== "https:" && publicOrigin !== `http://127.0.0.1:${port}`)) throw new Error("网页入口必须为 HTTPS 域名或指定的本机回环地址。");
  // Select model settings only. Never decrypt or load the WeCom bot Secret.
  const sourcePath = requireOutsideProject(stored.modelConfigPath || path.join(defaultLocalRoot(), "bot-config.json"), "模型配置来源");
  const source = fs.existsSync(sourcePath) ? JSON.parse(fs.readFileSync(sourcePath, "utf8").replace(/^\uFEFF/, "")) : {};
  return {
    projectRoot, port, publicOrigin, configPath: location,
    invitations: validateInvitations(stored.invitations),
    agentStatePath: requireOutsideProject(path.join(path.dirname(location), "agent-state.json"), "网页会话状态"),
    // All callers of the bundled runner share its isolation registry, but web
    // must never acquire or overwrite the WeCom service lease itself.
    serviceLeasePath: requireOutsideProject(source.serviceLeasePath || path.join(defaultLocalRoot(), "service-lease.json"), "查询隔离注册表"),
    codexCommand: source.codexCommand,
    codexProxyUrl: source.codexProxyUrl,
    codexModel: "gpt-6-astra", codexReasoningEffort: "xhigh",
    codexContextWindow: source.codexContextWindow || 872000,
    codexAutoCompactTokenLimit: source.codexAutoCompactTokenLimit || 750000,
    agentTurnTimeoutMs: 300000, generalTurnTimeoutMs: 900000,
    modelDrivenQueries: true
  };
}

module.exports = { loadWebConfig };
