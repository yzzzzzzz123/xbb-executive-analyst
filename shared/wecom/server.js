"use strict";

const { WSClient } = require("@wecom/aibot-node-sdk");
const { loadConfig } = require("../config.js");
const { PersistentCodexAgent } = require("../codex/persistent-agent.js");
const { loadAccessPolicy } = require("../security/access-control.js");
const { createLongConnectionHandler } = require("./long-connection-handler.js");
const { createPrivacyLogger } = require("./privacy-logger.js");
const { createStatusWriter } = require("./status-writer.js");

async function buildRuntime(config, options = {}) {
  const policy = loadAccessPolicy(config.accessPolicyPath);
  const agent = options.agent || new PersistentCodexAgent(config);
  await agent.start();
  const handler = createLongConnectionHandler({ policy, agent });
  return Object.freeze({
    handleMessage: (frame, client) => handler.handleMessage(frame, client),
    close: () => agent.close(),
    onFatal: (listener) => agent.on("fatal", listener)
  });
}

function defaultStatusWriter(status, output = process.stdout) {
  output.write(`${JSON.stringify(status)}\n`);
}

function createBotService(config, runtime, options = {}) {
  if (!runtime?.handleMessage) throw new Error("企业微信机器人运行时尚未初始化。");
  const statusWriter = options.statusWriter || createStatusWriter({ logPath: config.statusLogPath });
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

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    client.disconnect();
    if (typeof runtime.close === "function") await runtime.close();
  };
  if (typeof runtime.onFatal === "function") {
    runtime.onFatal(() => {
      statusWriter({ status: "agent_failed", transport: "wecom-websocket" });
      void stop().finally(() => { if (options.exitOnFatal) process.exitCode = 1; });
    });
  }

  return Object.freeze({
    client,
    start() {
      statusWriter({ status: "connecting", transport: "wecom-websocket" });
      client.connect();
    },
    stop
  });
}

if (require.main === module) {
  void (async () => {
    const config = loadConfig();
    const runtime = await buildRuntime(config);
    const service = createBotService(config, runtime, { exitOnFatal: true });
    let stopping = false;
    const shutdown = async () => {
      if (stopping) return;
      stopping = true;
      await service.stop();
    };
    process.once("SIGINT", () => { void shutdown(); });
    process.once("SIGTERM", () => { void shutdown(); });
    service.start();
  })().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { buildRuntime, createBotService, defaultStatusWriter };
