"use strict";

const { WSClient } = require("@wecom/aibot-node-sdk");
const { loadConfig } = require("../config.js");
const { createChatCompletionsClient } = require("../agent/chat-completions-client.js");
const { createExecutiveAgent } = require("../agent/executive-agent.js");
const { loadSystemPrompt } = require("../agent/system-prompt.js");
const { loadAccessPolicy } = require("../security/access-control.js");
const { createToolGateway } = require("../xbb/tool-gateway.js");
const { createLongConnectionHandler } = require("./long-connection-handler.js");
const { createPrivacyLogger } = require("./privacy-logger.js");

function buildRuntime(config) {
  const policy = loadAccessPolicy(config.accessPolicyPath);
  const modelClient = createChatCompletionsClient(config);
  const queryXbb = createToolGateway();
  const agent = createExecutiveAgent({ modelClient, queryXbb, systemPrompt: loadSystemPrompt() });
  return createLongConnectionHandler({ policy, agent });
}

function defaultStatusWriter(status) {
  process.stdout.write(`${JSON.stringify(status)}\n`);
}

function createBotService(config, runtime = buildRuntime(config), options = {}) {
  const statusWriter = options.statusWriter || defaultStatusWriter;
  const clientFactory = options.clientFactory || ((clientOptions) => new WSClient(clientOptions));
  const client = clientFactory({
    botId: config.wecomBotId,
    secret: config.wecomBotSecret,
    wsUrl: config.wecomWsUrl,
    maxReconnectAttempts: config.wecomMaxReconnectAttempts,
    heartbeatInterval: config.wecomHeartbeatMs,
    requestTimeout: config.wecomRequestTimeoutMs,
    logger: createPrivacyLogger()
  });

  client.on("authenticated", () => statusWriter({ status: "ready", transport: "wecom-websocket" }));
  client.on("disconnected", () => statusWriter({ status: "disconnected", transport: "wecom-websocket" }));
  client.on("reconnecting", (attempt) => statusWriter({ status: "reconnecting", transport: "wecom-websocket", attempt }));
  client.on("error", () => statusWriter({ status: "connection_error", transport: "wecom-websocket" }));
  client.on("message", (frame) => {
    Promise.resolve(runtime.handleMessage(frame, client))
      .catch(() => statusWriter({ status: "message_failed", transport: "wecom-websocket" }));
  });

  return Object.freeze({
    client,
    start() {
      statusWriter({ status: "connecting", transport: "wecom-websocket" });
      client.connect();
    },
    stop() {
      client.disconnect();
    }
  });
}

if (require.main === module) {
  try {
    const config = loadConfig();
    const service = createBotService(config);
    let stopping = false;
    const shutdown = () => {
      if (stopping) return;
      stopping = true;
      service.stop();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    service.start();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { buildRuntime, createBotService, defaultStatusWriter };
