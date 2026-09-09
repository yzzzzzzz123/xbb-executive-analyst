"use strict";

const path = require("node:path");
const { WSClient } = require("@wecom/aibot-node-sdk");
const { loadConfig } = require("../config.js");
const { PersistentCodexAgent } = require("../codex/persistent-agent.js");
const { loadAccessPolicy } = require("../security/access-control.js");
const { recoverRunnerIsolation } = require("../xbb/runner-isolation.js");
const { createLongConnectionHandler } = require("./long-connection-handler.js");
const { createPrivacyLogger } = require("./privacy-logger.js");
const { createStatusWriter, safeInstanceId } = require("./status-writer.js");
const { acquireInstanceLock, releaseInstanceLock } = require("./instance-lock.js");
const { ServiceLease } = require("./service-lease.js");

const DEFAULT_FATAL_EXIT_TIMEOUT_MS = 10000;
const DEFAULT_LIFECYCLE_CLEANUP_TIMEOUT_MS = 10000;
const DEFAULT_STARTUP_TIMEOUT_MS = 90000;

function positiveBoundedTimeout(value, fallback, maximum = 10 * 60 * 1000) {
  return Number.isInteger(value) && value > 0 ? Math.min(value, maximum) : fallback;
}

function settleWithDeadline(operation, timeoutMs, message, clock = { setTimeout, clearTimeout }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clock.clearTimeout(timer);
      callback(value);
    };
    timer = clock.setTimeout(() => finish(reject, new Error(message)), timeoutMs);
    Promise.resolve(operation).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error)
    );
  });
}

function abortError(signal, fallback = "机器人启动已取消。") {
  return signal?.reason instanceof Error ? signal.reason : new Error(fallback);
}

function assertNotAborted(signal) {
  if (signal?.aborted) throw abortError(signal);
}

function createExitRequester(exitProcess) {
  if (typeof exitProcess !== "function") throw new Error("机器人退出处理器无效。");
  let requested = false;
  return (code) => {
    if (requested) return false;
    requested = true;
    exitProcess(code);
    return true;
  };
}

async function buildRuntime(config, options = {}) {
  const policy = options.policy || loadAccessPolicy(config.accessPolicyPath);
  const agent = options.agent || new PersistentCodexAgent(config);
  const statusWriter = options.statusWriter || (() => {});
  const handlerFactory = options.handlerFactory || createLongConnectionHandler;
  const signal = options.signal;
  const clock = options.clock || { setTimeout, clearTimeout };
  const cleanupTimeoutMs = positiveBoundedTimeout(
    options.cleanupTimeoutMs,
    DEFAULT_LIFECYCLE_CLEANUP_TIMEOUT_MS,
    60 * 1000
  );
  const fatalListeners = new Set();
  let fatalEvent = null;
  let wakeFatal;
  const fatalGate = new Promise((resolve) => { wakeFatal = resolve; });
  let closePromise = null;

  const captureFatal = (event = {}) => {
    if (fatalEvent !== null) return;
    fatalEvent = event;
    wakeFatal(event);
    for (const listener of [...fatalListeners]) {
      try { listener(fatalEvent); } catch { /* 单个监听器不能阻断其他故障订阅者 */ }
    }
  };
  const close = () => {
    if (closePromise) return closePromise;
    closePromise = Promise.resolve().then(async () => {
      fatalListeners.clear();
      if (typeof agent.off === "function") {
        agent.off("fatal", captureFatal);
        agent.off("activity", statusWriter);
      }
      if (typeof agent.close === "function") {
        await settleWithDeadline(
          agent.close(),
          cleanupTimeoutMs,
          "Codex Agent/App Server 清理超过硬截止。",
          clock
        );
      }
    });
    return closePromise;
  };

  const runStartupStage = async (operation, label) => {
    assertNotAborted(signal);
    let onAbort = null;
    const abortGate = signal ? new Promise((resolve) => {
      onAbort = () => resolve({ kind: "aborted" });
      signal.addEventListener("abort", onAbort, { once: true });
    }) : new Promise(() => {});
    let outcome;
    try {
      outcome = await Promise.race([
        Promise.resolve(operation).then(
          (value) => ({ kind: "value", value }),
          (error) => ({ kind: "error", error })
        ),
        fatalGate.then((event) => ({ kind: "fatal", event })),
        abortGate
      ]);
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
    if (outcome.kind === "error") throw outcome.error;
    if (outcome.kind === "fatal") throw new Error(outcome.event?.message || `${label}期间发生致命故障。`);
    if (outcome.kind === "aborted") throw abortError(signal);
    assertNotAborted(signal);
    if (fatalEvent !== null) throw new Error(fatalEvent?.message || `${label}期间发生致命故障。`);
    return outcome.value;
  };

  try {
    // 必须早于 start：App Server 可能在 start 返回前退出。故障先锁存，
    // Bot Service 稍后订阅时同步回放，避免进程“看似运行但永远不重启”。
    agent.on("fatal", captureFatal);
    agent.on("activity", statusWriter);
    await runStartupStage(agent.start({ signal }), "Codex Agent 启动");
    if (typeof agent.warm === "function") {
      try {
        // 只同步校验本地知识索引。逐用户模型预热会让 WebSocket 认证延后数分钟，
        // 且用户数越多启动越慢；Thread 在首条消息到达时按主体惰性创建。
        await runStartupStage(agent.warm({ principals: [], signal }), "Codex Agent 预热");
      } catch (error) {
        try { statusWriter({ status: "agent_warm_failed" }); } catch {}
        throw error;
      }
    }
    const handler = handlerFactory({
      policy, agent, statusWriter,
      businessRequestBudgetMs: agent.businessTotalTimeoutMs,
      generalRequestBudgetMs: agent.generalTotalTimeoutMs
    });
    return Object.freeze({
      handleMessage: (frame, client) => handler.handleMessage(frame, client),
      close,
      onFatal(listener) {
        if (typeof listener !== "function") throw new TypeError("机器人致命故障监听器必须是函数。");
        fatalListeners.add(listener);
        if (fatalEvent !== null) {
          try { listener(fatalEvent); } catch { /* 与实时 fatal 分发保持隔离 */ }
        }
        return () => fatalListeners.delete(listener);
      }
    });
  } catch (error) {
    try { await close(); } catch { /* 启动原始错误优先，清理仍已尽力完成 */ }
    throw error;
  }
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
  const fatalExitTimeoutMs = positiveBoundedTimeout(options.fatalExitTimeoutMs, DEFAULT_FATAL_EXIT_TIMEOUT_MS, 60 * 1000);
  const cleanupTimeoutMs = positiveBoundedTimeout(options.cleanupTimeoutMs, DEFAULT_LIFECYCLE_CLEANUP_TIMEOUT_MS, 60 * 1000);
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
  let exitRequested = false;

  function requestExit(code) {
    if (exitRequested) return;
    exitRequested = true;
    exitProcess(code);
  }

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
      try { client.disconnect(); } catch { /* 传输层清理失败不能跳过 Agent/App Server 回收 */ }
      try {
        if (typeof runtime.close === "function") {
          await settleWithDeadline(
            runtime.close(),
            cleanupTimeoutMs,
            "机器人 runtime 清理超过硬截止。",
            clock
          );
        }
      } finally {
        try { lease?.stop(); } catch {}
        if (typeof options.onStopped === "function") {
          await settleWithDeadline(
            options.onStopped(),
            cleanupTimeoutMs,
            "机器人实例锁释放超过硬截止。",
            clock
          );
        }
      }
    });
    return stopPromise;
  }

  function failService() {
    if (fatalPromise) return fatalPromise;
    let hardExitTimer = null;
    if (options.exitOnFatal) {
      // 这个计时器故意保持 ref：清理 Promise 即使永不 settle，也必须让计划任务
      // 看到确定的非零退出并启动新代际。
      hardExitTimer = clock.setTimeout(() => requestExit(1), fatalExitTimeoutMs);
    }
    fatalPromise = stop()
      .catch(() => {})
      .finally(() => {
        if (hardExitTimer !== null) clock.clearTimeout(hardExitTimer);
        if (options.exitOnFatal) requestExit(1);
      });
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
    if (stopped) return;
    Promise.resolve(runtime.handleMessage(frame, client))
      .catch(() => writeStatus({ status: "message_failed", transport: "wecom-websocket" }));
  });

  if (typeof runtime.onFatal === "function") {
    runtime.onFatal(() => {
      if (stopped) return;
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
            if (stopped) return;
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

async function startBotLifecycle(config, options = {}) {
  const statusWriter = options.statusWriter || createStatusWriter({ logPath: config.statusLogPath });
  const lease = options.lease || new ServiceLease({
    leasePath: config.serviceLeasePath,
    onError: () => statusWriter({ status: "lease_write_failed", transport: "wecom-websocket" })
  });
  const acquireLock = options.acquireLock || acquireInstanceLock;
  const releaseLock = options.releaseLock || releaseInstanceLock;
  const runtimeFactory = options.runtimeFactory || buildRuntime;
  const serviceFactory = options.serviceFactory || createBotService;
  const isolationRecovery = options.runnerIsolationRecovery || recoverRunnerIsolation;
  const signal = options.signal;
  const clock = options.clock || { setTimeout, clearTimeout };
  const cleanupTimeoutMs = positiveBoundedTimeout(
    options.cleanupTimeoutMs,
    DEFAULT_LIFECYCLE_CLEANUP_TIMEOUT_MS,
    60 * 1000
  );
  let instanceLock = null;
  let runtime = null;
  let service = null;
  let releasePromise = null;

  const releaseOnce = () => {
    if (releasePromise) return releasePromise;
    releasePromise = Promise.resolve().then(async () => {
      if (instanceLock !== null) {
        await settleWithDeadline(
          releaseLock(instanceLock),
          cleanupTimeoutMs,
          "机器人实例锁释放超过硬截止。",
          clock
        );
      }
    });
    return releasePromise;
  };

  try {
    assertNotAborted(signal);
    instanceLock = await acquireLock();
    assertNotAborted(signal);
    // 租约必须先于 App Server/RAG 初始化出现，使外部看门狗能区分
    // “正在启动”与“进程假活”。进入可连接企微的阶段后再切为 running。
    if (lease.start("starting") === false) throw new Error("机器人 starting 租约写入失败。");
    // 新代际在创建 App Server/RAG/runtime 之前先收敛上代际留下的严格
    // token runner；无法通过 CIM 再确认时直接启动失败，交给计划任务重试。
    await isolationRecovery({
      serviceLeasePath: config.serviceLeasePath,
      projectRoot: config.projectRoot || path.resolve(__dirname, "..", "..")
    });
    assertNotAborted(signal);
    runtime = await runtimeFactory(config, { statusWriter, signal, cleanupTimeoutMs, clock });
    assertNotAborted(signal);
    service = serviceFactory(config, runtime, {
      exitOnFatal: options.exitOnFatal !== false,
      exitProcess: options.exitProcess,
      lease,
      statusWriter,
      onStopped: releaseOnce,
      clock,
      cleanupTimeoutMs,
      fatalExitTimeoutMs: options.fatalExitTimeoutMs
    });
    service.start();
    return Object.freeze({ instanceLock, lease, runtime, service, releaseOnce });
  } catch (error) {
    const rollback = (async () => {
      // createBotService 构造失败时，runtime 尚未移交给 service；必须按
      // runtime -> lease -> lock 的顺序完整回收。若 service 已接管，则其
      // stop 执行同一顺序。
      if (service && typeof service.stop === "function") await service.stop();
      else {
        try { if (runtime && typeof runtime.close === "function") await runtime.close(); } finally {
          try { lease.stop(); } finally { await releaseOnce(); }
        }
      }
    })();
    try {
      await settleWithDeadline(rollback, cleanupTimeoutMs, "机器人启动回滚清理超过硬截止。", clock);
    } catch {
      // 某个异步清理永不 settle 时仍主动终止租约并发起锁释放；顶层随即
      // 以非零码硬退出，不能再被残留句柄拖成永久 Running。
      try { lease.stop(); } catch {}
      try { if (runtime && typeof runtime.close === "function") void Promise.resolve(runtime.close()).catch(() => {}); } catch {}
      try { void releaseOnce().catch(() => {}); } catch {}
    }
    throw error;
  }
}

async function runMain(options = {}) {
  const processObject = options.processObject || process;
  const config = options.config || loadConfig(managedConfigOptions(processObject.argv.slice(2), processObject.env));
  const statusWriter = options.statusWriter || createStatusWriter({ logPath: config.statusLogPath });
  const lease = options.lease || new ServiceLease({
    leasePath: config.serviceLeasePath,
    onError: () => statusWriter({ status: "lease_write_failed", transport: "wecom-websocket" })
  });
  const lifecycleFactory = options.lifecycleFactory || startBotLifecycle;
  const requestExit = createExitRequester(options.exitProcess || ((code) => process.exit(code)));
  const monitor = () => statusWriter({ status: "agent_failed", transport: "wecom-websocket" });
  processObject.on("uncaughtExceptionMonitor", monitor);
  let lifecycle;
  try {
    lifecycle = await lifecycleFactory(config, {
      lease,
      statusWriter,
      signal: options.signal,
      clock: options.clock,
      cleanupTimeoutMs: options.cleanupTimeoutMs,
      fatalExitTimeoutMs: options.fatalExitTimeoutMs,
      exitProcess: requestExit
    });
  } catch (error) {
    processObject.removeListener("uncaughtExceptionMonitor", monitor);
    throw error;
  }
  let shutdownPromise = null;
  const shutdown = () => {
    if (shutdownPromise) return shutdownPromise;
    processObject.removeListener("SIGINT", onSignal);
    processObject.removeListener("SIGTERM", onSignal);
    processObject.removeListener("uncaughtExceptionMonitor", monitor);
    shutdownPromise = Promise.resolve().then(() => lifecycle.service.stop());
    return shutdownPromise;
  };
  const onSignal = () => {
    void shutdown().then(
      () => requestExit(0),
      () => requestExit(1)
    ).catch(() => {});
  };
  processObject.once("SIGINT", onSignal);
  processObject.once("SIGTERM", onSignal);
  return Object.freeze({ ...lifecycle, shutdown });
}

async function runEntrypoint(options = {}) {
  const main = options.main || runMain;
  const output = options.output || process.stderr;
  const requestExit = createExitRequester(options.exitProcess || ((code) => process.exit(code)));
  const startupTimeoutMs = positiveBoundedTimeout(options.startupTimeoutMs, DEFAULT_STARTUP_TIMEOUT_MS);
  const clock = options.clock || { setTimeout, clearTimeout };
  const startupController = new AbortController();
  let startupTimedOut = false;
  const startup = Promise.resolve().then(() => main({ signal: startupController.signal, clock, exitProcess: requestExit }));
  // 测试替身不会真正结束进程；若超时后的 main 迟到完成，立即关闭它，避免
  // 迟到 runtime 在已宣布失败后复活。生产中 process.exit 会更早终止进程。
  void startup.then((lateLifecycle) => {
    if (!startupTimedOut) return;
    try {
      const cleanup = typeof lateLifecycle?.shutdown === "function"
        ? lateLifecycle.shutdown()
        : typeof lateLifecycle?.service?.stop === "function"
          ? lateLifecycle.service.stop()
          : null;
      if (cleanup && typeof cleanup.then === "function") void cleanup.catch(() => {});
    } catch {}
  }, () => {});
  let startupTimer;
  try {
    return await Promise.race([
      startup,
      new Promise((_, reject) => {
        startupTimer = clock.setTimeout(() => {
          startupTimedOut = true;
          const error = new Error(`机器人启动超过 ${startupTimeoutMs}ms 硬截止。`);
          startupController.abort(error);
          reject(error);
        }, startupTimeoutMs);
      })
    ]);
  } catch (error) {
    try { output.write(`${error?.message || "机器人服务启动失败。"}\n`); } finally {
      // 资源清理由 runMain/startBotLifecycle 完成后才会到达这里。硬退出可
      // 避免 SDK/App Server 的残留句柄令计划任务永久停留在 Running。
      requestExit(1);
    }
    return null;
  } finally {
    if (startupTimer !== undefined) clock.clearTimeout(startupTimer);
  }
}

if (require.main === module) {
  void runEntrypoint();
}

module.exports = {
  DEFAULT_CONNECTION_STALL_TIMEOUT_MS,
  DEFAULT_FATAL_EXIT_TIMEOUT_MS,
  DEFAULT_LIFECYCLE_CLEANUP_TIMEOUT_MS,
  DEFAULT_STARTUP_TIMEOUT_MS,
  buildRuntime,
  createBotService,
  defaultStatusWriter,
  managedConfigOptions,
  runEntrypoint,
  runMain,
  settleWithDeadline,
  startBotLifecycle
};
