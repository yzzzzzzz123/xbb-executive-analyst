"use strict";

const path = require("node:path");
const { WSClient } = require("@wecom/aibot-node-sdk");
const { loadConfig } = require("../config.js");
const { PersistentCodexAgent } = require("../codex/persistent-agent.js");
const { loadAccessPolicy } = require("../security/access-control.js");
const { createLongConnectionHandler } = require("./long-connection-handler.js");
const { createPrivacyLogger } = require("./privacy-logger.js");
const { createStatusWriter, safeInstanceId } = require("./status-writer.js");
const { acquireInstanceLock, releaseInstanceLock } = require("./instance-lock.js");
const { ServiceLease } = require("./service-lease.js");

async function buildRuntime(config, options = {}) {
  const policy = loadAccessPolicy(config.accessPolicyPath);
  const agent = options.agent || new PersistentCodexAgent(config);
  const statusWriter = options.statusWriter || (() => {});
  agent.on("activity", statusWriter);
  await agent.start();
  if (typeof agent.warm === "function") {
    try {
      // 只同步校验本地知识索引。逐用户模型预热会让 WebSocket 认证延后数分钟，
      // 且用户数越多启动越慢；Thread 在首条消息到达时按主体惰性创建。
      await agent.warm({ principals: [] });
    } catch (error) {
      statusWriter({ status: "agent_warm_failed" });
      throw error;
    }
  }
  const handler = createLongConnectionHandler({ policy, agent, statusWriter });
  return Object.freeze({
    handleMessage: (frame, client) => handler.handleMessage(frame, client),
    close: () => agent.close(),
    onFatal: (listener) => agent.on("fatal", listener)
  });
}

function defaultStatusWriter(status, output = process.stdout) {
  output.write(`${JSON.stringify(status)}\n`);
}

const DEFAULT_CONNECTION_STALL_TIMEOUT_MS = 120000;

function managedConfigOptions(argv = process.argv.slice(2), baseEnv = process.env) {
  if (!Array.isArray(argv) || argv.length === 0) return {};
  if (argv.length !== 2 || argv[0] !== "--managed-config" || typeof argv[1] !== "string" || !argv[1].trim()) {
    throw new Error("机器人服务启动参数无效。");
  }
  const env = { ...baseEnv };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase().startsWith("XBB_")) delete env[key];
  }
  env.XBB_BOT_CONFIG_PATH = path.resolve(argv[1]);
  return { env };
}

function createBotService(config, runtime, options = {}) {
  if (!runtime?.handleMessage) throw new Error("企业微信机器人运行时尚未初始化。");
  const statusWriter = options.statusWriter || createStatusWriter({ logPath: config.statusLogPath });
  const clientFactory = options.clientFactory || ((clientOptions) => new WSClient(clientOptions));
  const clock = options.clock || { setTimeout, clearTimeout };
  const connectionStallTimeoutMs = options.connectionStallTimeoutMs ?? DEFAULT_CONNECTION_STALL_TIMEOUT_MS;
  const exitProcess = options.exitProcess || ((code) => process.exit(code));
  const lease = options.lease || null;
  if (options.getInstanceId !== undefined && typeof options.getInstanceId !== "function") throw new Error("机器人实例代际读取器无效。");
  const getInstanceId = options.getInstanceId || (() => {
    if (typeof lease?.getInstanceId === "function") return lease.getInstanceId();
    return lease?.instanceId;
  });
  if (typeof clock.setTimeout !== "function" || typeof clock.clearTimeout !== "function") throw new Error("企业微信连接看门狗时钟无效。");
  if (typeof exitProcess !== "function") throw new Error("企业微信机器人退出处理器无效。");
  if (!Number.isInteger(connectionStallTimeoutMs) || connectionStallTimeoutMs < 1000) throw new Error("企业微信连接看门狗超时必须是不小于 1000 毫秒的整数。");
  const client = clientFactory({
    botId: config.wecomBotId,
    secret: config.wecomBotSecret,
    wsUrl: config.wecomWsUrl,
    maxReconnectAttempts: config.wecomMaxReconnectAttempts,
    heartbeatInterval: config.wecomHeartbeatMs,
    requestTimeout: config.wecomRequestTimeoutMs,
    logger: createPrivacyLogger()
  });

  let started = false;
  let stopped = false;
  let authenticated = false;
  let connectionWatchdog = null;
  let stopPromise = null;
  let fatalPromise = null;

  function writeStatus(value) {
    try { statusWriter(value); } catch { /* 状态日志不可影响连接与恢复状态机 */ }
  }

  function currentInstanceId() {
    try { return safeInstanceId(getInstanceId()); } catch { return null; }
  }

  function clearConnectionWatchdog() {
    if (connectionWatchdog === null) return;
    clock.clearTimeout(connectionWatchdog);
    connectionWatchdog = null;
  }

  function armConnectionWatchdog() {
    if (stopped || authenticated || connectionWatchdog !== null) return;
    connectionWatchdog = clock.setTimeout(() => {
      connectionWatchdog = null;
      if (stopped || authenticated) return;
      writeStatus({ status: "connection_stalled", transport: "wecom-websocket", elapsedMs: connectionStallTimeoutMs });
      void failService();
    }, connectionStallTimeoutMs);
    connectionWatchdog?.unref?.();
  }

  function stop() {
    if (stopPromise) return stopPromise;
    stopped = true;
    authenticated = false;
    clearConnectionWatchdog();
    stopPromise = Promise.resolve().then(async () => {
      try {
        client.disconnect();
        if (typeof runtime.close === "function") await runtime.close();
      } finally {
        try { lease?.stop(); } catch {}
        if (typeof options.onStopped === "function") await options.onStopped();
      }
    });
    return stopPromise;
  }

  function failService() {
    if (fatalPromise) return fatalPromise;
    fatalPromise = stop()
      .catch(() => {})
      .finally(() => { if (options.exitOnFatal) exitProcess(1); });
    return fatalPromise;
  }

  client.on("authenticated", () => {
    if (stopped) return;
    authenticated = true;
    clearConnectionWatchdog();
    const instanceId = currentInstanceId();
    writeStatus(instanceId === null
      ? { status: "ready", transport: "wecom-websocket" }
      : { status: "ready", transport: "wecom-websocket", instanceId });
  });
  client.on("disconnected", () => {
    if (stopped) return;
    authenticated = false;
    armConnectionWatchdog();
    writeStatus({ status: "disconnected", transport: "wecom-websocket" });
  });
  client.on("reconnecting", (attempt) => {
    if (stopped) return;
    authenticated = false;
    armConnectionWatchdog();
    writeStatus({ status: "reconnecting", transport: "wecom-websocket", attempt });
  });
  client.on("error", () => {
    if (stopped) return;
    authenticated = false;
    armConnectionWatchdog();
    writeStatus({ status: "connection_error", transport: "wecom-websocket" });
  });
  client.on("message", (frame) => {
    Promise.resolve(runtime.handleMessage(frame, client))
      .catch(() => writeStatus({ status: "message_failed", transport: "wecom-websocket" }));
  });

  if (typeof runtime.onFatal === "function") {
    runtime.onFatal(() => {
      writeStatus({ status: "agent_failed", transport: "wecom-websocket" });
      void failService();
    });
  }

  return Object.freeze({
    client,
    start() {
      if (started || stopped) return;
      started = true;
      writeStatus({ status: "connecting", transport: "wecom-websocket" });
      try {
        if (lease?.start("running") === false) throw new Error("机器人 running 租约写入失败。");
      } catch {
        writeStatus({ status: "lease_write_failed", transport: "wecom-websocket" });
        void failService();
        return;
      }
      authenticated = false;
      armConnectionWatchdog();
      try {
        const connecting = client.connect();
        if (connecting && typeof connecting.then === "function") {
          void connecting.catch(() => {
            writeStatus({ status: "connection_error", transport: "wecom-websocket" });
            void failService();
          });
        }
      } catch {
        writeStatus({ status: "connection_error", transport: "wecom-websocket" });
        void failService();
      }
    },
    stop
  });
}

if (require.main === module) {
  void (async () => {
    const config = loadConfig(managedConfigOptions());
    const statusWriter = createStatusWriter({ logPath: config.statusLogPath });
    const lease = new ServiceLease({
      leasePath: config.serviceLeasePath,
      onError: () => statusWriter({ status: "lease_write_failed", transport: "wecom-websocket" })
    });
    process.on("uncaughtExceptionMonitor", () => statusWriter({ status: "agent_failed", transport: "wecom-websocket" }));
    const instanceLock = await acquireInstanceLock();
    let runtime;
    let service;
    try {
      // 租约必须先于 App Server/RAG 初始化出现，使外部看门狗能区分
      // “正在启动”与“进程假活”。进入可连接企微的阶段后再切为 running。
      if (lease.start("starting") === false) throw new Error("机器人 starting 租约写入失败。");
      runtime = await buildRuntime(config, { statusWriter });
      service = createBotService(config, runtime, {
        exitOnFatal: true,
        lease,
        statusWriter,
        onStopped: () => releaseInstanceLock(instanceLock)
      });
    } catch (error) {
      try { lease.stop(); } catch {}
      await releaseInstanceLock(instanceLock);
      throw error;
    }
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

module.exports = { DEFAULT_CONNECTION_STALL_TIMEOUT_MS, buildRuntime, createBotService, defaultStatusWriter, managedConfigOptions };
