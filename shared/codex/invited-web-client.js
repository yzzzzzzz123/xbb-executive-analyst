"use strict";

const { AppServerClient } = require("./app-server-client.js");

// The customer's authorization covers business data, not the owner's desktop,
// files, installed connectors or plugins. Apply overrides to every new/resumed
// thread; native chart children inherit the same capability boundary.
const DISABLED_FEATURES = Object.freeze([
  "shell_tool", "unified_exec", "apply_patch_freeform", "js_repl", "code_mode", "code_mode_host",
  "code_mode_only", "view_image", "apps", "connectors", "plugins", "remote_plugin",
  "computer_use", "browser_use", "browser_use_external", "image_generation", "imagegenext",
  "hooks", "codex_hooks", "plugin_hooks", "memories", "memory_tool", "shell_snapshot",
  "skill_mcp_dependency_install", "skill_env_var_dependency_prompt", "request_permissions_tool"
]);

function customerToolConfig(effective) {
  if (!effective || typeof effective !== "object") throw new Error("无法确认网页模型工具权限。");
  const config = { web_search: "disabled", "apps._default.enabled": false };
  for (const name of DISABLED_FEATURES) config[`features.${name}`] = false;
  config.mcp_servers = Object.fromEntries(Object.keys(effective.mcp_servers || {}).map((name) => [name, { enabled: false, required: false }]));
  config.plugins = Object.fromEntries(Object.keys(effective.plugins || {}).map((name) => [name, { enabled: false }]));
  config.apps = Object.fromEntries(Object.keys(effective.apps || {}).map((name) => [name, { enabled: false }]));
  return Object.freeze(config);
}

class InvitedWebClient extends AppServerClient {
  constructor(options) { super(options); this.projectRoot = options.projectRoot; this.customerConfig = null; }
  async connect(options = {}) {
    await super.connect(options);
    const read = await this.request("config/read", { includeLayers: false, cwd: this.projectRoot }, { signal: options.signal });
    this.customerConfig = customerToolConfig(read?.config);
  }
  restricted(params) {
    if (!this.customerConfig) throw new Error("网页模型工具权限尚未就绪。");
    return { ...params, config: { ...params.config, ...this.customerConfig } };
  }
  startThread(params) { return super.startThread(this.restricted(params)); }
  resumeThread(threadId, params) { return super.resumeThread(threadId, this.restricted(params)); }
}

module.exports = { InvitedWebClient, customerToolConfig };
