"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AppServerClient } = require("../shared/codex/app-server-client.js");
const { LocalAppServerHost, buildAppServerCommand } = require("../shared/codex/app-server-host.js");
const { CHART_AGENT_CONFIG } = require("../shared/codex/chart-agent-config.js");
const { modelContextConfig } = require("../shared/codex/model-context.js");
const { PersistentCodexAgent, principalKeyFromUserId } = require("../shared/codex/persistent-agent.js");
const { sanitizeCodexEnvironment } = require("../shared/codex/runtime.js");
const { classifyModelError } = require("../shared/codex/model-error.js");
const { parseMonths, planFastQuery } = require("../shared/xbb/fast-query-plan.js");
const { emptyState, loadAgentState, saveAgentState } = require("../shared/codex/state-store.js");

function nextImmediate() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitUntil(predicate, message, attempts = 80) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await nextImmediate();
  }
  assert.fail(message);
}

class FakeWebSocket extends EventEmitter {
  static OPEN = 1;
  static CLOSED = 3;

  constructor(endpoint, options) {
    super();
    this.endpoint = endpoint;
    this.options = options;
    this.readyState = FakeWebSocket.OPEN;
    this.sent = [];
    FakeWebSocket.instance = this;
    setImmediate(() => this.emit("open"));
  }

  send(raw) {
    const message = JSON.parse(raw);
    this.sent.push(message);
    if (message.method === "initialize") {
      setImmediate(() => this.emit("message", Buffer.from(JSON.stringify({ id: message.id, result: { userAgent: "fake" } })), false));
    }
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    setImmediate(() => this.emit("close"));
  }
}

class HangingInitializeWebSocket extends EventEmitter {
  static OPEN = 1;
  static CLOSED = 3;

  constructor() {
    super();
    this.readyState = HangingInitializeWebSocket.OPEN;
    this.sent = [];
    this.terminated = false;
    HangingInitializeWebSocket.instance = this;
    setImmediate(() => this.emit("open"));
  }

  send(raw) { this.sent.push(JSON.parse(raw)); }

  terminate() {
    this.terminated = true;
    this.readyState = HangingInitializeWebSocket.CLOSED;
    setImmediate(() => this.emit("close"));
  }

  close() { this.terminate(); }
}

class FakeAppServerClient extends EventEmitter {
  constructor() {
    super();
    this.connected = false;
    this.startThreadCalls = [];
    this.resumeThreadCalls = [];
    this.startTurnCalls = [];
    this.steerTurnCalls = [];
    this.interruptTurnCalls = [];
    this.responses = [];
    this.turnCounter = 0;
    this.threadCounter = 0;
    this.childThreads = new Map();
  }

  async connect() { this.connected = true; }
  async close() { this.connected = false; }
  async startThread(params) {
    this.startThreadCalls.push(params);
    return { thread: { id: `thread-${++this.threadCounter}` } };
  }
  async resumeThread(threadId, params) {
    this.resumeThreadCalls.push({ threadId, params });
    return { thread: { id: threadId, turns: [] } };
  }
  async startTurn(params) {
    const id = `turn-${++this.turnCounter}`;
    this.startTurnCalls.push({ id, params });
    return { turn: { id } };
  }
  async steerTurn(params) {
    this.steerTurnCalls.push(params);
    return { turnId: params.expectedTurnId };
  }
  async interruptTurn(threadId, turnId) {
    this.interruptTurnCalls.push({ threadId, turnId });
    return {};
  }
  respond(id, result) { this.responses.push({ id, result }); }
  reject(id, message, code) { this.responses.push({ id, error: { message, code } }); }
  async request(method, { threadId }) {
    assert.equal(method, "thread/read");
    assert.ok(this.childThreads.has(threadId));
    return { thread: this.childThreads.get(threadId) };
  }

  complete(threadId, turnId, text) {
    const item = { type: "agentMessage", id: `item-${turnId}`, text, phase: "final_answer" };
    this.emit("notification", { method: "item/completed", params: { threadId, turnId, item } });
    this.emit("notification", { method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [item] } } });
  }
}

(async () => {
  assert.deepEqual(modelContextConfig(), { model_context_window: 872000, model_auto_compact_token_limit: 750000 });
  assert.throws(() => modelContextConfig({ codexContextWindow: 1050000 }), /先验证/);
  assert.throws(() => modelContextConfig({ codexAutoCompactTokenLimit: 872000 }), /90%/);
  const monthTestNow = new Date("2026-09-09T00:00:00Z");
  assert.deepEqual(planFastQuery("集团8月业绩排名", monthTestNow).months, ["2026-08"]);
  assert.deepEqual(planFastQuery("集团8月业绩排名并区分课程和咨询", monthTestNow).months, ["2026-08"], "裸月份覆盖集团排名的默认全年范围");
  assert.deepEqual(parseMonths("今年8月", monthTestNow), ["2026-08"]);
  assert.deepEqual(parseMonths("去年8月", monthTestNow), ["2025-08"]);
  assert.deepEqual(planFastQuery("去年8月商机质量", monthTestNow).months, ["2025-08"]);
  assert.throws(() => planFastQuery("去年8月业绩排名", monthTestNow), /不能混入更早月份/, "旧业绩越界必须拒绝而不是改查今年");
  assert.deepEqual(parseMonths("8月和9月", monthTestNow), ["2026-08", "2026-09"]);
  assert.deepEqual(parseMonths("2026年8月和2026年9月", monthTestNow), ["2026-08", "2026-09"]);
  assert.throws(() => parseMonths("8、9月", monthTestNow), /逐个写明月份/);
  assert.throws(() => parseMonths("2026年8月和9月", monthTestNow), /每个月写明年份/);
  assert.deepEqual(parseMonths("最近3月", monthTestNow), ["2026-07", "2026-08", "2026-09"]);
  for (const invalidPeriod of ["10月", "明年8月"]) assert.throws(() => parseMonths(invalidPeriod, monthTestNow), /晚于当前上海月份/);
  for (const invalidPeriod of ["0月", "13月"]) assert.throws(() => parseMonths(invalidPeriod, monthTestNow), /月份必须/);
  assert.deepEqual(parseMonths("9月", new Date("2026-08-31T16:00:00Z")), ["2026-09"], "当前年份和未来边界使用上海月份");

  const verifier = "a".repeat(64);
  const command = buildAppServerCommand({ command: "codex.exe", argsPrefix: [] }, "ws://127.0.0.1:43123", verifier);
  assert.deepEqual(command.args, ["app-server", "--listen", "ws://127.0.0.1:43123", "--ws-auth", "capability-token", "--ws-token-sha256", verifier]);
  assert.equal(command.args.some((value) => value.includes("raw-capability-token")), false);

  const proxyEnv = {
    HTTP_PROXY: "http://127.0.0.1:7890", HTTPS_PROXY: "http://127.0.0.1:7890",
    ALL_PROXY: "socks5://127.0.0.1:7891", NO_PROXY: "localhost,127.0.0.1",
    http_proxy: "http://127.0.0.1:7890", https_proxy: "http://127.0.0.1:7890",
    all_proxy: "socks5://127.0.0.1:7891", no_proxy: "localhost,127.0.0.1"
  };
  const safeEnv = sanitizeCodexEnvironment({ ...proxyEnv, PATH: "safe", LOCALAPPDATA: "local", XBB_WECOM_BOT_SECRET: "do-not-inherit", OPENAI_API_KEY: "do-not-inherit" });
  assert.equal(safeEnv.PATH, "safe");
  assert.equal(Object.hasOwn(safeEnv, "XBB_WECOM_BOT_SECRET"), false);
  assert.equal(Object.hasOwn(safeEnv, "OPENAI_API_KEY"), false);
  for (const [name, value] of Object.entries(proxyEnv)) assert.equal(safeEnv[name], value, `${name} 必须保留部署网络配置`);
  const overriddenEnv = sanitizeCodexEnvironment({ ...proxyEnv, XBB_WECOM_BOT_SECRET: "must-not-inherit" }, { codexProxyUrl: "http://127.0.0.1:18080" });
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) {
    assert.equal(overriddenEnv[name], "http://127.0.0.1:18080", "独立代理必须覆盖计划任务继承的所有旧代理变量");
  }
  assert.equal(overriddenEnv.NO_PROXY, proxyEnv.NO_PROXY);
  assert.equal(overriddenEnv.no_proxy, proxyEnv.no_proxy);
  assert.equal(Object.hasOwn(overriddenEnv, "XBB_WECOM_BOT_SECRET"), false);
  assert.equal(proxyEnv.HTTP_PROXY, "http://127.0.0.1:7890", "不得改变父进程或其他应用的代理");
  for (const codexProxyUrl of ["invalid", "http://user:password@127.0.0.1:18080", "http://public.example:18080", "http://127.0.0.1:18080/path"]) {
    assert.throws(() => sanitizeCodexEnvironment({}, { codexProxyUrl }), /本机 HTTP\/HTTPS 代理地址/);
  }
  assert.equal(classifyModelError({ codexErrorInfo: "unauthorized" }), "unauthorized");
  assert.equal(classifyModelError({ codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } } }), "connection_failed");
  assert.equal(classifyModelError({ codexErrorInfo: { HttpConnectionFailed: { httpStatusCode: 401 } } }), "unauthorized");
  assert.equal(classifyModelError({ codexErrorInfo: "UsageLimitExceeded" }), "usage_limit");
  assert.equal(classifyModelError({ codexErrorInfo: "ContextWindowExceeded" }), "context_limit");
  assert.equal(classifyModelError({ codexErrorInfo: "BadRequest" }), "invalid_request");
  assert.equal(classifyModelError({ codexErrorInfo: "InternalServerError" }), "service_error");
  assert.equal(classifyModelError({ message: "sensitive upstream details", codexErrorInfo: "untrusted-code" }), "unknown");

  const client = new AppServerClient({ endpoint: "ws://127.0.0.1:43123", token: "t".repeat(48), WebSocketImpl: FakeWebSocket });
  await client.connect();
  assert.equal(FakeWebSocket.instance.options.headers.Authorization, `Bearer ${"t".repeat(48)}`);
  assert.equal(FakeWebSocket.instance.sent[0].method, "initialize");
  assert.equal(FakeWebSocket.instance.sent[0].params.capabilities.experimentalApi, true);
  assert.equal(Object.hasOwn(FakeWebSocket.instance.sent[0], "jsonrpc"), false);
  assert.equal(FakeWebSocket.instance.sent[1].method, "initialized");
  let retryNotification = null;
  client.on("serverErrorNotification", (value) => { retryNotification = value; });
  FakeWebSocket.instance.emit("message", Buffer.from(JSON.stringify({ method: "error", params: { willRetry: true, error: { message: "Reconnecting" } } })), false);
  assert.equal(retryNotification.willRetry, true);
  await client.close();

  const connectAbortController = new AbortController();
  const abortingClient = new AppServerClient({
    endpoint: "ws://127.0.0.1:43124",
    token: "u".repeat(48),
    WebSocketImpl: HangingInitializeWebSocket
  });
  const abortedConnect = abortingClient.connect({ signal: connectAbortController.signal });
  await waitUntil(
    () => HangingInitializeWebSocket.instance?.sent.some((message) => message.method === "initialize"),
    "WebSocket 初始化请求应已发出"
  );
  const connectAbortError = new Error("startup deadline aborted websocket");
  connectAbortController.abort(connectAbortError);
  await assert.rejects(abortedConnect, /startup deadline aborted websocket/);
  assert.equal(HangingInitializeWebSocket.instance.terminated, true, "AbortSignal 必须主动终止初始化中的 WebSocket");
  assert.equal(abortingClient.pending.size, 0, "取消初始化后不得残留 RPC pending/timer");

  const hostAbortController = new AbortController();
  const hostChild = new EventEmitter();
  hostChild.exitCode = null;
  hostChild.stderr = null;
  const hostKillSignals = [];
  hostChild.kill = (signal) => {
    hostKillSignals.push(signal || "SIGTERM");
    hostChild.exitCode = 0;
    setImmediate(() => hostChild.emit("close"));
    return true;
  };
  let markHostProbeStarted;
  const hostProbeStarted = new Promise((resolve) => { markHostProbeStarted = resolve; });
  const abortedHostStart = LocalAppServerHost.start({ projectRoot: process.cwd(), codexProxyUrl: "http://127.0.0.1:18080" }, {
    signal: hostAbortController.signal,
    reservePort: async () => 43125,
    invocation: { command: "codex.exe", argsPrefix: [] },
    env: { ...proxyEnv, XBB_WECOM_BOT_SECRET: "must-not-inherit" },
    spawn: (_command, _args, options) => {
      assert.equal(options.env.HTTPS_PROXY, "http://127.0.0.1:18080", "真实子进程启动边界必须使用独立代理");
      assert.equal(Object.hasOwn(options.env, "XBB_WECOM_BOT_SECRET"), false);
      return hostChild;
    },
    probe: () => {
      markHostProbeStarted();
      return new Promise(() => {});
    },
    readyTimeoutMs: 30000
  });
  await hostProbeStarted;
  hostAbortController.abort(new Error("startup deadline aborted host"));
  await assert.rejects(abortedHostStart, /startup deadline aborted host/);
  assert.deepEqual(hostKillSignals, ["SIGTERM"], "取消就绪探测必须回收已经创建的 App Server 子进程");

  const forcedChild = new EventEmitter();
  forcedChild.exitCode = null;
  const forcedSignals = [];
  forcedChild.kill = (signal) => {
    forcedSignals.push(signal || "SIGTERM");
    if (signal === "SIGKILL") {
      forcedChild.exitCode = 1;
      setImmediate(() => forcedChild.emit("close"));
    }
    return true;
  };
  const forcedHost = new LocalAppServerHost({
    process: forcedChild,
    endpoint: "ws://127.0.0.1:43129",
    token: "v".repeat(48),
    port: 43129,
    closeGraceMs: 5,
    killConfirmTimeoutMs: 5
  });
  await forcedHost.close();
  assert.deepEqual(forcedSignals, ["SIGTERM", "SIGKILL"], "优雅关闭未确认时必须升级到 SIGKILL 并等待退出事件");

  const unconfirmedChild = new EventEmitter();
  unconfirmedChild.exitCode = null;
  const unconfirmedSignals = [];
  unconfirmedChild.kill = (signal) => {
    unconfirmedSignals.push(signal || "SIGTERM");
    return signal === "SIGKILL";
  };
  const unconfirmedHost = new LocalAppServerHost({
    process: unconfirmedChild,
    endpoint: "ws://127.0.0.1:43130",
    token: "w".repeat(48),
    port: 43130,
    closeGraceMs: 5,
    killConfirmTimeoutMs: 5
  });
  const unconfirmedClose = unconfirmedHost.close();
  assert.equal(unconfirmedHost.close(), unconfirmedClose, "并发 close 必须共享同一个终止确认 Promise");
  await assert.rejects(unconfirmedClose, /终止未得到确认/);
  assert.deepEqual(unconfirmedSignals, ["SIGTERM", "SIGKILL"], "kill 返回失败或 SIGKILL 后无退出确认必须 fail closed");

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "xbb-app-server-test-"));
  try {
    const statePath = path.join(tempRoot, "agent-state.json");
    const state = emptyState();
    const testPrincipal = "f".repeat(64);
    state.threads[testPrincipal] = { threadId: "thread-old", contractHash: "contract-old" };
    saveAgentState(statePath, state);
    state.threads[testPrincipal].threadId = "thread-new";
    saveAgentState(statePath, state);
    assert.equal(loadAgentState(statePath).threads[testPrincipal].threadId, "thread-new");
    assert.equal(fs.readdirSync(tempRoot).some((name) => name.includes(".tmp-")), false);

    const fakeClient = new FakeAppServerClient();
    const fakeProcess = new EventEmitter();
    fakeProcess.exitCode = null;
    const fakeHost = { endpoint: "ws://127.0.0.1:43124", token: "h".repeat(48), process: fakeProcess, close: async () => {} };
    const queryCalls = [];
    const config = {
      projectRoot: path.resolve(__dirname, ".."),
      agentStatePath: statePath,
      serviceLeasePath: path.join(tempRoot, "service-lease.json"),
      agentTurnTimeoutMs: 30000,
      generalTurnTimeoutMs: 900000,
      codexModel: "gpt-5.6-sol",
      codexReasoningEffort: "medium"
    };

    const lateHostController = new AbortController();
    const lateHostProcess = new EventEmitter();
    lateHostProcess.exitCode = null;
    let lateHostCloseCalls = 0;
    const lateHost = {
      endpoint: "ws://127.0.0.1:43126",
      token: "l".repeat(48),
      process: lateHostProcess,
      close: async () => { lateHostCloseCalls += 1; }
    };
    let resolveLateHost;
    let lateHostFactorySignal = null;
    let lateHostClientFactoryCalls = 0;
    const lateHostAgent = new PersistentCodexAgent({
      ...config,
      agentStatePath: path.join(tempRoot, "late-host-state.json")
    }, {
      hostFactory: { start: (_config, options) => {
        lateHostFactorySignal = options.signal;
        return new Promise((resolve) => { resolveLateHost = resolve; });
      } },
      clientFactory: () => { lateHostClientFactoryCalls += 1; return new FakeAppServerClient(); },
      verifyLogin: () => ({ mode: "chatgpt" }),
      readVersion: () => "0.151.0",
      queryXbb: async () => ({ status: "ready" })
    });
    let lateHostReadyEvents = 0;
    lateHostAgent.on("ready", () => { lateHostReadyEvents += 1; });
    const lateHostStart = lateHostAgent.start({ signal: lateHostController.signal });
    await nextImmediate();
    assert.equal(lateHostFactorySignal?.aborted, false);
    lateHostController.abort(new Error("late host startup cancelled"));
    assert.equal(lateHostFactorySignal?.aborted, true, "外部启动取消必须传递到 hostFactory");
    resolveLateHost(lateHost);
    await assert.rejects(lateHostStart, /late host startup cancelled/);
    assert.equal(lateHostCloseCalls, 1, "取消后迟到返回的 Host 必须立即关闭");
    assert.equal(lateHostClientFactoryCalls, 0, "取消后迟到 Host 不得继续创建 Client");
    assert.equal(lateHostAgent.started, false);
    assert.equal(lateHostReadyEvents, 0);

    const fatalHostProcess = new EventEmitter();
    fatalHostProcess.exitCode = null;
    let fatalHostCloseCalls = 0;
    const fatalHost = {
      endpoint: "ws://127.0.0.1:43128",
      token: "n".repeat(48),
      process: fatalHostProcess,
      close: async () => { fatalHostCloseCalls += 1; }
    };
    let resolveFatalHost;
    let fatalHostSignal = null;
    let triggerStartupFatal;
    const fatalHostAgent = new PersistentCodexAgent({
      ...config,
      agentStatePath: path.join(tempRoot, "fatal-host-state.json")
    }, {
      hostFactory: { start: (_config, options) => {
        fatalHostSignal = options.signal;
        return new Promise((resolve) => { resolveFatalHost = resolve; });
      } },
      clientFactory: () => new FakeAppServerClient(),
      verifyLogin: () => ({ mode: "chatgpt" }),
      readVersion: () => "0.151.0",
      toolGatewayFactory: (options) => {
        triggerStartupFatal = options.onIsolationFailure;
        return async () => ({ status: "ready" });
      }
    });
    const fatalHostStart = fatalHostAgent.start();
    await nextImmediate();
    triggerStartupFatal();
    assert.equal(fatalHostSignal?.aborted, true, "fatal 必须主动取消仍挂起的 Host 启动");
    resolveFatalHost(fatalHost);
    await assert.rejects(fatalHostStart, /进程隔离状态失效/);
    assert.equal(fatalHostCloseCalls, 1, "fatal 后迟到 Host 必须关闭");
    assert.equal(fatalHostAgent.started, false);

    const lateClientController = new AbortController();
    const lateClientProcess = new EventEmitter();
    lateClientProcess.exitCode = null;
    let lateClientHostCloseCalls = 0;
    const lateClientHost = {
      endpoint: "ws://127.0.0.1:43127",
      token: "m".repeat(48),
      process: lateClientProcess,
      close: async () => { lateClientHostCloseCalls += 1; }
    };
    const lateClient = new FakeAppServerClient();
    let lateClientSignal = null;
    let resolveLateClientConnect;
    let lateClientCloseCalls = 0;
    lateClient.connect = (options = {}) => {
      lateClientSignal = options.signal;
      return new Promise((resolve) => { resolveLateClientConnect = resolve; });
    };
    lateClient.close = async () => { lateClientCloseCalls += 1; lateClient.connected = false; };
    const lateClientAgent = new PersistentCodexAgent({
      ...config,
      agentStatePath: path.join(tempRoot, "late-client-state.json")
    }, {
      hostFactory: { start: async () => lateClientHost },
      clientFactory: () => lateClient,
      verifyLogin: () => ({ mode: "chatgpt" }),
      readVersion: () => "0.151.0",
      queryXbb: async () => ({ status: "ready" })
    });
    let lateClientReadyEvents = 0;
    lateClientAgent.on("ready", () => { lateClientReadyEvents += 1; });
    const lateClientStart = lateClientAgent.start({ signal: lateClientController.signal });
    await waitUntil(() => typeof resolveLateClientConnect === "function", "Client connect 应已进入等待");
    lateClientController.abort(new Error("late client startup cancelled"));
    assert.equal(lateClientSignal?.aborted, true, "外部启动取消必须传递到 AppServerClient.connect");
    resolveLateClientConnect();
    await assert.rejects(lateClientStart, /late client startup cancelled/);
    assert.equal(lateClientCloseCalls, 1, "取消后迟到完成的 Client 必须关闭");
    assert.equal(lateClientHostCloseCalls, 1, "Client 迟到完成后 Host 也必须关闭");
    assert.equal(lateClientAgent.started, false);
    assert.equal(lateClientReadyEvents, 0);

    const readyPerformancePack = (month = "2026-09", total = 123) => ({
      status: "ready",
      scope: { month, domains: ["performance"] },
      provenance: { live: true, readOnly: true, dataSource: "xbb-openapi", telephoneFieldsExported: false, credentialFieldsExported: false },
      facts: {
        performance: {
          summary: { total, course: total, consulting: 0, other: 0, courseShare: 100, consultingShare: 0, otherShare: 0 },
          ranking: [{ company: "公司A", total, course: total, consulting: 0, other: 0 }]
        }
      },
      limitations: [],
      integrity: { algorithm: "sha256", factPackSha256: "b".repeat(64) }
    });
    const isolatedAgent = (label, isolatedClient, options = {}) => {
      const isolatedProcess = new EventEmitter();
      isolatedProcess.exitCode = null;
      const isolatedHost = { endpoint: "ws://127.0.0.1:43125", token: "i".repeat(48), process: isolatedProcess, close: async () => {} };
      return new PersistentCodexAgent({
        ...config,
        agentStatePath: path.join(tempRoot, `${label}-state.json`),
        ...(options.config || {})
      }, {
        hostFactory: { start: async () => isolatedHost },
        clientFactory: () => isolatedClient,
        verifyLogin: () => ({ mode: "chatgpt" }),
        readVersion: () => "0.151.0",
        queryXbb: options.queryXbb || (async () => readyPerformancePack())
      });
    };
    fs.rmSync(statePath, { force: true });
    const agent = new PersistentCodexAgent(config, {
      hostFactory: { start: async () => fakeHost },
      clientFactory: () => fakeClient,
      verifyLogin: () => ({ mode: "chatgpt" }),
      readVersion: () => "0.151.0",
      queryXbb: async (args, access, invocation = {}) => {
        queryCalls.push({ args, access });
        await invocation.onProgress?.({ stage: "month_started", month: "2026-09", index: 1, completed: 0, total: 1 });
        await invocation.onProgress?.({ stage: "query_ready", completed: 1, total: 1 });
        return {
          status: "ready",
          scope: { month: "2026-09", domains: ["performance"] },
          provenance: { live: true, readOnly: true, dataSource: "xbb-openapi", telephoneFieldsExported: false, credentialFieldsExported: false },
          facts: {
            performance: {
              summary: { total: 123, course: 80, consulting: 40, other: 3, courseShare: 65.04, consultingShare: 32.52, otherShare: 2.44 },
              ranking: [{ company: "公司A", total: 123, course: 80, consulting: 40, other: 3 }]
            }
          },
          limitations: [],
          integrity: { algorithm: "sha256", factPackSha256: "b".repeat(64) }
        };
      }
    });
    await agent.start();
    assert.equal(fakeClient.connected, true);

    const access = { scope: "all" };
    const principal = principalKeyFromUserId("boss-user", access);
    assert.match(principal, /^[a-f0-9]{64}$/);
    assert.notEqual(principal, principalKeyFromUserId("boss-user", { scope: "companies", companies: ["公司A"] }));
    assert.notEqual(
      principalKeyFromUserId("boss-user", { scope: "companies", companies: ["甲", "乙"] }),
      principalKeyFromUserId("boss-user", { scope: "companies", companies: ["甲、乙"] })
    );
    assert.equal(
      principalKeyFromUserId("boss-user", { scope: "companies", companies: ["甲", "乙"] }),
      principalKeyFromUserId("boss-user", { scope: "companies", companies: ["乙", "甲"] })
    );

    const warmPromise = agent.warm({ access, principalKey: principal });
    await nextImmediate();
    assert.equal(fakeClient.startThreadCalls.length, 1);
    assert.equal(fakeClient.startTurnCalls[0].params.effort, "none");
    assert.match(fakeClient.startTurnCalls[0].params.input[0].text, /后台缓存预热/);
    assert.equal(queryCalls.length, 0);
    assert.equal(loadAgentState(statePath).threads[principal].turnInProgress, true);
    fakeClient.complete("thread-1", "turn-1", JSON.stringify({ answer: "ready", chart: null }));
    const ragStats = await warmPromise;
    assert.equal(ragStats.sources, 7);
    assert.equal(fakeClient.startTurnCalls[0].params.input.length, 3);
    assert.equal(fakeClient.startTurnCalls[0].params.input[2].name, "xbb-executive-chart");
    assert.equal(ragStats.principals, 1);
    assert.equal(loadAgentState(statePath).threads[principal].lastMode, null);
    assert.equal(loadAgentState(statePath).threads[principal].lastModeSource, null);
    assert.equal(loadAgentState(statePath).threads[principal].turnInProgress, false);

    const greetingPromise = agent.answer({ question: "你好", access, principalKey: principal, messageId: "msg-greeting" });
    await nextImmediate();
    assert.equal(fakeClient.startThreadCalls.length, 1);
    assert.equal(fakeClient.startThreadCalls[0].ephemeral, false);
    assert.equal(fakeClient.startThreadCalls[0].dynamicTools[0].name, "query_xbb");
    assert.equal(fakeClient.startTurnCalls[1].params.input.length, 1);
    assert.equal(fakeClient.startTurnCalls[1].params.input[0].type, "text");
    assert.match(fakeClient.startTurnCalls[1].params.input[0].text, /能力路由】通用 Codex/);
    assert.doesNotMatch(fakeClient.startTurnCalls[1].params.input[0].text, /销帮帮 Skill RAG 适用规则/);
    assert.equal(fakeClient.startTurnCalls[1].params.effort, "none", "严格匹配的简单问候不消耗复杂推理预算");
    assert.deepEqual(fakeClient.startTurnCalls[1].params.sandboxPolicy, { type: "readOnly", networkAccess: true });
    assert.deepEqual(fakeClient.startTurnCalls[1].params.outputSchema.required, ["answer", "chart"]);
    assert.equal(fakeClient.startTurnCalls[1].params.outputSchema.properties.chart.type, "null");
    assert.equal(Object.hasOwn(fakeClient.startTurnCalls[1].params.outputSchema.properties.chart, "anyOf"), false);
    assert.match(fakeClient.startTurnCalls[1].params.input[0].text, /chart 固定为 null/);
    assert.equal(agent.sessions.get(principal).active.timeoutMs, 900000);
    assert.equal(agent.sessions.get(principal).active.totalTimeoutMs, 900000);
    assert.ok(agent.sessions.get(principal).active.absoluteTimeout);
    assert.equal(loadAgentState(statePath).threads[principal].turnInProgress, true);
    fakeClient.emit("serverRequest", {
      id: 76,
      method: "item/tool/call",
      params: { threadId: "thread-1", turnId: "turn-2", callId: "call-general", namespace: null, tool: "query_xbb", arguments: { months: ["2026-09"], domains: ["performance"] } }
    });
    await nextImmediate();
    assert.equal(fakeClient.responses[0].id, 76);
    assert.equal(fakeClient.responses[0].result.success, false);
    assert.match(fakeClient.responses[0].result.contentItems[0].text, /不是销帮帮经营问题/);
    assert.equal(queryCalls.length, 0);
    fakeClient.complete("thread-1", "turn-2", JSON.stringify({ answer: "你好，我是通用 Codex 助手，也可以查询销帮帮经营数据。", chart: null }));
    const greetingResult = await greetingPromise;
    assert.match(greetingResult.answer, /通用 Codex/);
    assert.equal(greetingResult.routeMode, "general");
    assert.equal(queryCalls.length, 0);
    assert.equal(loadAgentState(statePath).threads[principal].lastMode, "general");
    assert.equal(loadAgentState(statePath).threads[principal].lastModeSource, "user");
    assert.equal(loadAgentState(statePath).threads[principal].turnInProgress, false);

    const modelErrorClient = new FakeAppServerClient();
    let modelErrorQueryCalls = 0;
    const modelErrorAgent = isolatedAgent("model-error", modelErrorClient, {
      queryXbb: async () => { modelErrorQueryCalls += 1; throw new Error("通用问题禁止查询经营数据"); }
    });
    const modelProgress = [];
    const modelActivities = [];
    modelErrorAgent.on("activity", (event) => modelActivities.push(event));
    await modelErrorAgent.start();
    const modelPrincipal = principalKeyFromUserId("model-error-user", access);
    const retryAnswer = modelErrorAgent.answer({ question: "你好", access, principalKey: modelPrincipal, onProgress: (value) => modelProgress.push(value) });
    await nextImmediate();
    modelErrorClient.emit("notification", { method: "error", params: {
      threadId: "thread-1", turnId: "old-turn", willRetry: true,
      error: { codexErrorInfo: "unauthorized", message: "must-not-appear" }
    } });
    assert.equal(modelActivities.some((event) => event.status === "model_retrying"), false, "迟到错误不得改变当前问题状态");
    modelErrorClient.emit("notification", { method: "error", params: {
      threadId: "thread-1", turnId: "turn-1", willRetry: true,
      error: { codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } }, message: "sensitive-url-and-token" }
    } });
    await nextImmediate();
    assert.match(modelProgress.at(-1), /自动重试/);
    assert.equal(modelActivities.at(-1).modelErrorCode, "connection_failed");
    assert.doesNotMatch(JSON.stringify({ modelProgress, modelActivities }), /sensitive-url-and-token/);
    modelErrorClient.emit("notification", { method: "item/started", params: {
      threadId: "thread-1", turnId: "turn-1", item: { id: "retry-response", type: "agentMessage" }
    } });
    await nextImmediate();
    assert.match(modelProgress.at(-1), /连接已恢复/);
    modelErrorClient.complete("thread-1", "turn-1", JSON.stringify({ answer: "你好，连接已恢复。", chart: null }));
    assert.match((await retryAnswer).answer, /连接已恢复/);

    const unauthorizedAnswer = modelErrorAgent.answer({ question: "解释一下缓存", access, principalKey: modelPrincipal });
    const unauthorizedResult = assert.rejects(unauthorizedAnswer, (error) => error.routeMode === "general" && error.modelErrorCode === "unauthorized");
    await nextImmediate();
    const failedActive = modelErrorAgent.sessions.get(modelPrincipal).active;
    modelErrorClient.emit("notification", { method: "error", params: {
      threadId: "thread-1", turnId: "turn-2", willRetry: false,
      error: { codexErrorInfo: "unauthorized", message: "refresh token private details" }
    } });
    modelErrorClient.emit("notification", { method: "turn/completed", params: {
      threadId: "thread-1", turn: { id: "turn-2", status: "failed", items: [] }
    } });
    await unauthorizedResult;
    assert.equal(modelActivities.at(-1).modelErrorCode, "unauthorized", "最终错误必须保留上游固定类别");
    assert.equal(modelErrorAgent.sessions.get(modelPrincipal).threadId, null, "失败 Thread 必须清理，登录恢复后才能重新创建");
    assert.equal(loadAgentState(modelErrorAgent.statePath).threads[modelPrincipal], undefined);
    assert.equal(failedActive.timeout, null);
    assert.equal(failedActive.absoluteTimeout, null);
    const afterLoginAnswer = modelErrorAgent.answer({ question: "你好", access, principalKey: modelPrincipal });
    await nextImmediate();
    assert.equal(modelErrorClient.startTurnCalls.at(-1).params.threadId, "thread-2");
    modelErrorClient.complete("thread-2", "turn-3", JSON.stringify({ answer: "重新登录后正常回答。", chart: null }));
    assert.match((await afterLoginAnswer).answer, /正常回答/);
    assert.equal(modelErrorQueryCalls, 0);
    await modelErrorAgent.close();

    const progress = [];
    const businessPromise = agent.answer({ question: "集团9月业绩排名", access, principalKey: principal, messageId: "msg-business", onProgress: async (text) => progress.push(text) });
    await nextImmediate();
    assert.equal(queryCalls.length, 1);
    assert.deepEqual(queryCalls[0].args, { months: ["2026-09"], domains: ["performance"] });
    assert.equal(queryCalls[0].access.scope, "all");
    assert.equal(fakeClient.startTurnCalls[2].params.input.length, 3);
    assert.equal(fakeClient.startTurnCalls[2].params.input[1].type, "skill");
    assert.equal(fakeClient.startTurnCalls[2].params.input[1].name, "xbb-executive-analyst");
    assert.match(fakeClient.startTurnCalls[2].params.input[1].path, /skills[\\/]xbb-executive-analyst[\\/]SKILL\.md$/);
    assert.equal(fakeClient.startTurnCalls[2].params.input[2].type, "skill");
    assert.equal(fakeClient.startTurnCalls[2].params.input[2].name, "xbb-executive-chart");
    assert.match(fakeClient.startTurnCalls[2].params.input[2].path, /skills[\\/]xbb-executive-chart[\\/]SKILL\.md$/);
    assert.match(fakeClient.startTurnCalls[2].params.input[0].text, /\$xbb-executive-analyst/);
    assert.match(fakeClient.startTurnCalls[2].params.input[0].text, /\$xbb-executive-chart/);
    assert.match(fakeClient.startTurnCalls[2].params.input[0].text, /销帮帮 Skill RAG 适用规则/);
    assert.match(fakeClient.startTurnCalls[2].params.input[0].text, /本轮 query_xbb 实时预取事实包/);
    assert.equal(fakeClient.startTurnCalls[2].params.effort, "none");
    assert.deepEqual(fakeClient.startTurnCalls[2].params.sandboxPolicy, { type: "readOnly", networkAccess: false });
    assert.equal(fakeClient.startTurnCalls[2].params.outputSchema.properties.chart.anyOf.length, 9);
    assert.match(fakeClient.startTurnCalls[2].params.input[0].text, /业绩与收入结构/);
    assert.equal(agent.sessions.get(principal).active.timeoutMs, 30000);
    assert.equal(agent.sessions.get(principal).active.totalTimeoutMs, 20 * 60 * 1000, "业务生成预算与端到端绝对预算必须分离");
    assert.ok(agent.sessions.get(principal).active.absoluteTimeout);
    fakeClient.emit("serverRequest", {
      id: 77,
      method: "item/tool/call",
      params: { threadId: "thread-1", turnId: "turn-3", callId: "call-1", namespace: null, tool: "query_xbb", arguments: { months: ["2026-09"], domains: ["performance"] } }
    });
    await nextImmediate();
    assert.equal(queryCalls.length, 1);
    assert.equal(fakeClient.responses[1].id, 77);
    assert.equal(fakeClient.responses[1].result.success, true);
    const reusedPrefetch = JSON.parse(fakeClient.responses[1].result.contentItems[0].text);
    assert.equal(reusedPrefetch.reusedPrefetch, true);
    assert.ok(Buffer.byteLength(fakeClient.responses[1].result.contentItems[0].text, "utf8") < 512);
    assert.doesNotMatch(fakeClient.responses[1].result.contentItems[0].text, /"ranking"/);
    assert.match(progress.join("\n"), /正在分析：2026年9月/);
    assert.match(progress.join("\n"), /已完成 0\/1/);
    assert.match(progress.join("\n"), /数据已就绪/);
    fakeClient.childThreads.set("child-chart", { parentThreadId: "thread-1", model: "gpt-6-astra", reasoningEffort: "ultra", forkedFromId: null });
    const chartActivity = (kind) => fakeClient.emit("notification", { method: "item/completed", params: { threadId: "thread-1", turnId: "turn-3",
      item: { type: "subAgentActivity", id: `native-${kind}`, agentThreadId: "child-chart", kind } } });
    chartActivity("started");
    assert.equal(agent.sessions.get(principal).active.timeout, null, "子 Agent 分析暂停主模型生成预算");
    assert.ok(agent.sessions.get(principal).active.absoluteTimeout, "子 Agent 不延长业务绝对截止");
    fakeClient.emit("serverRequest", { id: 78, method: "item/tool/call", params: { threadId: "child-chart", turnId: "child-turn", tool: "query_xbb", arguments: {} } });
    await nextImmediate();
    assert.ok(fakeClient.responses.find((response) => response.id === 78).error, "图表子 Agent 不能自行取业务事实");
    const reviewedSpec = { type: "bar", title: "公司排名 13800138000", subtitle: "MTD", insight: "公司A业绩高于公司B", note: "", valueFormat: "money", unit: "", categories: ["公司A", "公司B"], series: [{ name: "业绩", values: [123, 80] }] };
    await agent._handleServerRequest({ id: 79, method: "item/tool/call", params: { threadId: "child-chart", turnId: "child-turn", tool: "validate_xbb_chart", arguments: { spec: { ...reviewedSpec, unit: "元" } } } });
    assert.equal(fakeClient.responses.find((response) => response.id === 79).result.success, false, "金额单位格式错误必须在子 Agent 内可修正");
    assert.equal(agent.sessions.get(principal).active.validatedCharts.size, 0);
    await agent._handleServerRequest({ id: 80, method: "item/tool/call", params: { threadId: "child-chart", turnId: "child-turn", tool: "validate_xbb_chart", arguments: { spec: reviewedSpec } } });
    const reviewed = fakeClient.responses.find((response) => response.id === 80).result;
    assert.equal(reviewed.success, true);
    assert.equal(reviewed.contentItems[1].type, "inputImage", "子 Agent 必须拿到实际手机图片预览");
    const reviewedReference = JSON.parse(reviewed.contentItems[0].text).chart;
    assert.equal(reviewedReference.type, "validated");
    chartActivity("completed");
    assert.ok(agent.sessions.get(principal).active.timeout);
    fakeClient.complete("thread-1", "turn-3", JSON.stringify({
      answer: "9月集团业绩排名结论（MTD）。",
      chart: reviewedReference
    }));
    const businessResult = await businessPromise;
    assert.match(businessResult.answer, /MTD/);
    assert.equal(businessResult.routeMode, "xbb");
    assert.equal(businessResult.chart.type, "bar");
    assert.doesNotMatch(businessResult.chart.title, /13800138000/);

    const followUpPromise = agent.answer({ question: "1", access, principalKey: principal, messageId: "msg-business-follow-up" });
    await nextImmediate();
    assert.equal(fakeClient.startTurnCalls[3].params.input[1].type, "skill");
    assert.equal(fakeClient.startTurnCalls[3].params.input[2].name, "xbb-executive-chart");
    assert.match(fakeClient.startTurnCalls[3].params.input[0].text, /能力路由】销帮帮经营 Skill/);
    fakeClient.complete("thread-1", "turn-4", JSON.stringify({ answer: "继续解释上一条经营结论。", chart: null }));
    assert.match((await followUpPromise).answer, /经营结论/);

    const activities = [];
    agent.on("activity", (value) => activities.push(value));
    const first = agent.answer({ question: "继续分析商机", access, principalKey: principal, messageId: "msg-busy-1" });
    await nextImmediate();
    assert.equal(fakeClient.startTurnCalls[4].params.effort, "medium");
    const second = agent.answer({ question: "真实的说", access, principalKey: principal, messageId: "msg-follow-up-1" });
    await nextImmediate();
    assert.equal(fakeClient.steerTurnCalls.length, 1);
    assert.equal(fakeClient.steerTurnCalls[0].threadId, "thread-1");
    assert.equal(fakeClient.steerTurnCalls[0].expectedTurnId, "turn-5");
    assert.match(fakeClient.steerTurnCalls[0].input[0].text, /真实的说/);
    assert.match(fakeClient.steerTurnCalls[0].input[0].text, /最新要求/);
    assert.match((await first).answer, /最新一条消息/);
    const third = agent.answer({ question: "只看风险", access, principalKey: principal, messageId: "msg-follow-up-2" });
    await nextImmediate();
    assert.equal(fakeClient.steerTurnCalls.length, 2);
    assert.equal(fakeClient.steerTurnCalls[1].expectedTurnId, "turn-5");
    assert.match((await second).answer, /最新一条消息/);
    assert.equal(activities.filter((value) => value.status === "turn_steered").length, 2);
    assert.equal(activities.some((value) => value.status === "agent_busy"), false);
    assert.equal(fakeClient.startTurnCalls.length, 5);
    fakeClient.complete("thread-1", "turn-5", JSON.stringify({ answer: "商机风险分析结论，已按最新要求直说。", chart: null }));
    assert.match((await third).answer, /按最新要求直说/);

    const general = agent.answer({ question: "帮我写会议通知", access, principalKey: principal, messageId: "msg-general-before-queue" });
    await nextImmediate();
    assert.equal(fakeClient.startTurnCalls.length, 6);
    assert.match(fakeClient.startTurnCalls[5].params.input[0].text, /能力路由】通用 Codex/);
    const queuedProgress = [];
    const queuedBusiness = agent.answer({
      question: "集团9月业绩排名",
      access,
      principalKey: principal,
      messageId: "msg-queued-business",
      onProgress: async (text) => queuedProgress.push(text)
    });
    await nextImmediate();
    assert.equal(fakeClient.startTurnCalls.length, 6);
    assert.match(queuedProgress.join("\n"), /不同范围/);
    assert.equal(activities.some((value) => value.status === "turn_queued"), true);
    fakeClient.complete("thread-1", "turn-6", JSON.stringify({ answer: "会议通知已起草。", chart: null }));
    assert.match((await general).answer, /会议通知/);
    await nextImmediate();
    assert.equal(fakeClient.startTurnCalls.length, 7);
    assert.equal(fakeClient.startTurnCalls[6].params.input[1].name, "xbb-executive-analyst");
    assert.equal(fakeClient.startTurnCalls[6].params.input[2].name, "xbb-executive-chart");
    fakeClient.complete("thread-1", "turn-7", JSON.stringify({ answer: "排队后的经营问题已完成。", chart: null }));
    assert.match((await queuedBusiness).answer, /排队后的经营问题/);

    const invalidChartPromise = agent.answer({ question: "继续", access, principalKey: principal, messageId: "msg-invalid-chart" });
    await nextImmediate();
    assert.equal(fakeClient.startTurnCalls.at(-1).params.input[2].name, "xbb-executive-chart");
    fakeClient.complete("thread-1", "turn-8", JSON.stringify({
      answer: "图表关系校验失败时仍返回真实文字结论。",
      chart: {
        type: "funnel", title: "阶段推进", subtitle: "2026年9月｜集团", insight: "确认需求数量高于发现需求，不能形成真实漏斗", note: "",
        valueFormat: "number", unit: "单", items: [{ name: "发现需求", value: 10 }, { name: "确认需求", value: 12 }]
      }
    }));
    const invalidChartResult = await invalidChartPromise;
    assert.match(invalidChartResult.answer, /仍返回真实文字结论/);
    assert.equal(invalidChartResult.chart, null);
    assert.equal(activities.some((value) => value.status === "chart_failed"), true);

    fakeClient.emit("notification", {
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-1",
        turnId: "turn-8",
        tokenUsage: { last: { inputTokens: 900, totalTokens: 900 }, total: { inputTokens: 900, totalTokens: 900 }, modelContextWindow: 1000 }
      }
    });
    const rotatedPromise = agent.answer({ question: "集团9月业绩排名", access, principalKey: principal, messageId: "msg-context-rotation" });
    await nextImmediate();
    assert.equal(fakeClient.startThreadCalls.length, 2);
    assert.equal(fakeClient.startTurnCalls.at(-1).params.threadId, "thread-2");
    assert.equal(activities.some((value) => value.status === "context_rotated"), true);
    fakeClient.complete("thread-2", "turn-9", JSON.stringify({ answer: "换新上下文后仍完成9月业绩分析。", chart: null }));
    assert.match((await rotatedPromise).answer, /换新上下文/);

    const refusalPromise = agent.answer({ question: "集团9月业绩排名", access, principalKey: principal, messageId: "msg-false-refusal" });
    await nextImmediate();
    fakeClient.complete("thread-2", "turn-10", JSON.stringify({
      answer: "本次未能完成年度分析。事实包超过安全大小限制，建议缩小到一个主题继续查。",
      chart: null
    }));
    const recovered = await refusalPromise;
    assert.match(recovered.answer, /业绩：合计 ¥123/);
    assert.doesNotMatch(recovered.answer, /未能完成|缩小到一个主题/);
    assert.equal(recovered.chart, null);
    assert.equal(activities.some((value) => value.status === "answer_recovered"), true);
    assert.equal(agent.sessions.get(principal).threadId, null);

    const afterRecoveryPromise = agent.answer({ question: "你好", access, principalKey: principal, messageId: "msg-after-recovery" });
    await nextImmediate();
    assert.equal(fakeClient.startThreadCalls.length, 3);
    assert.equal(fakeClient.startTurnCalls.at(-1).params.threadId, "thread-3");
    fakeClient.complete("thread-3", "turn-11", JSON.stringify({ answer: "恢复后的新会话已就绪。", chart: null }));
    assert.match((await afterRecoveryPromise).answer, /新会话已就绪/);

    await agent.close();
    assert.equal(fakeClient.connected, false);

    const contextClient = new FakeAppServerClient();
    let contextQueryCalls = 0;
    const contextAgent = isolatedAgent("task-context", contextClient, {
      queryXbb: async () => { contextQueryCalls += 1; return readyPerformancePack(); }
    });
    await contextAgent.start();
    const contextPrincipal = principalKeyFromUserId("task-context-user", access);
    const databaseSource = "优化数据库 notes 的表结构。必须兼容旧接口。\n\n```sql\nCREATE TABLE notes (body TEXT);\n```\n\n不能停机，必须提供回退方案。";
    const databaseStart = contextAgent.answer({ question: databaseSource, access, principalKey: contextPrincipal });
    await nextImmediate();
    const databaseParams = contextClient.startTurnCalls.at(-1).params;
    assert.deepEqual(contextClient.startThreadCalls[0].config, { ...modelContextConfig(), ...CHART_AGENT_CONFIG });
    assert.equal(databaseParams.effort, "medium", "复杂通用任务必须保留配置推理强度");
    assert.equal(databaseParams.approvalPolicy, "never");
    assert.deepEqual(databaseParams.sandboxPolicy, { type: "readOnly", networkAccess: true });
    assert.equal(databaseParams.input.length, 1, "数据库通用任务不注入经营 Skill");
    assert.match(databaseParams.input[0].text, /现状[\s\S]*影响[\s\S]*迁移与回退[\s\S]*验证[\s\S]*执行条件/u);
    const databaseCorrection = contextAgent.answer({ question: "补充：不要删除 notes 表，保持旧字段可读。", access, principalKey: contextPrincipal });
    await nextImmediate();
    assert.match((await databaseStart).answer, /最新一条消息/u);
    contextClient.complete("thread-1", "turn-1", JSON.stringify({ answer: "已完成迁移草案；模型输出标记不应进入续接摘要。", chart: null }));
    await databaseCorrection;
    const contextSession = contextAgent.sessions.get(contextPrincipal);
    const largeSession = { ...contextSession, turnCount: 30, estimatedInputBytes: 1024 * 1024,
      tokenUsage: { modelContextWindow: 828400, last: { totalTokens: 400000 } } };
    assert.equal(contextAgent._shouldRotateThread(largeSession, 10000), false, "有效 token 计量充足时，不被旧字节和轮次阈值提前切断大上下文");
    largeSession.tokenUsage.last.totalTokens = 744000;
    assert.equal(contextAgent._shouldRotateThread(largeSession, 10000), true, "接近有效窗口时预留生成空间");
    largeSession.tokenUsage = { modelContextWindow: 1000, last: { totalTokens: 950 } };
    assert.equal(contextAgent._shouldRotateThread(largeSession, 10), true, "按运行时实际小窗口判断，不能盲信配置值");
    assert.match(contextSession.taskContext.goal, /优化数据库 notes/u, "steer 不能覆盖初始目标");
    assert.match(contextSession.taskContext.corrections.at(-1), /不要删除 notes 表/u);
    assert.doesNotMatch(JSON.stringify(contextSession.taskContext), /CREATE TABLE|模型输出标记/u);
    assert.doesNotMatch(fs.readFileSync(contextAgent.statePath, "utf8"), /优化数据库|taskContext|不要删除/u, "任务摘要只保存在内存，不扩大历史持久化");
    contextSession.turnCount = 24;
    const continuedDatabase = contextAgent.answer({ question: "继续，按刚才方案补充验证步骤。", access, principalKey: contextPrincipal });
    await nextImmediate();
    const continuedParams = contextClient.startTurnCalls.at(-1).params;
    assert.equal(continuedParams.threadId, "thread-2");
    assert.match(continuedParams.input[0].text, /用户任务续接摘要/u);
    assert.match(continuedParams.input[0].text, /优化数据库 notes/u);
    assert.match(continuedParams.input[0].text, /不能停机/u);
    assert.match(continuedParams.input[0].text, /不要删除 notes 表/u);
    assert.doesNotMatch(continuedParams.input[0].text, /CREATE TABLE|模型输出标记/u);
    contextClient.complete("thread-2", "turn-2", JSON.stringify({ answer: "已按原目标与最新约束补充验证草案，未执行数据库变更。", chart: null }));
    await continuedDatabase;
    await assert.rejects(contextAgent.answer({ question: "继续", access: { scope: "companies", companies: ["公司A"] }, principalKey: contextPrincipal }), /授权范围已变化/u);
    assert.equal(contextClient.startTurnCalls.length, 2, "权限不一致的同 key 请求不得进入模型");
    const unrelatedGreeting = contextAgent.answer({ question: "你好", access, principalKey: contextPrincipal });
    await nextImmediate();
    assert.equal(contextClient.startTurnCalls.at(-1).params.effort, "none");
    assert.doesNotMatch(contextClient.startTurnCalls.at(-1).params.input[0].text, /复杂数据库|用户任务续接摘要/u, "问候不套复杂任务模板");
    contextClient.complete("thread-2", "turn-3", JSON.stringify({ answer: "你好。", chart: null }));
    await unrelatedGreeting;
    assert.equal(contextQueryCalls, 0);
    const contextBusiness = contextAgent.answer({ question: "集团9月业绩排名", access, principalKey: contextPrincipal });
    await nextImmediate();
    assert.doesNotMatch(contextClient.startTurnCalls.at(-1).params.input[0].text, /优化数据库|不要删除 notes/u);
    contextClient.complete("thread-2", "turn-4", JSON.stringify({ answer: "经营测试结论。", chart: null }));
    await contextBusiness;
    contextSession.turnCount = 24;
    const businessContinuity = contextAgent.answer({ question: "继续", access, principalKey: contextPrincipal });
    await nextImmediate();
    assert.equal(contextClient.startTurnCalls.at(-1).params.threadId, "thread-3");
    assert.match(contextClient.startTurnCalls.at(-1).params.input[0].text, /集团9月业绩排名/u);
    assert.doesNotMatch(contextClient.startTurnCalls.at(-1).params.input[0].text, /"total":123|经营测试结论|优化数据库/u, "经营续接仅携意图，不携旧事实或跨路由材料");
    contextClient.complete("thread-3", "turn-5", JSON.stringify({ answer: "需按当前问题重新核实事实。", chart: null }));
    await businessContinuity;
    await contextAgent.close();

    const timingClient = new FakeAppServerClient();
    const originalTimings = [];
    const steeredTimings = [];
    let timingCalls = 0;
    let delayedTimingInvocation;
    let releaseTimingQuery;
    const timingAgent = isolatedAgent("query-timing-forwarding", timingClient, {
      queryXbb: async (args, _access, invocation) => {
        timingCalls += 1;
        invocation.onTiming({ stage: "started", elapsedMs: 2, queueWaitMs: 2, runMs: 0, shared: false });
        if (timingCalls === 2) {
          delayedTimingInvocation = invocation;
          return new Promise((resolve) => { releaseTimingQuery = () => resolve(readyPerformancePack(args.months[0])); });
        }
        invocation.onTiming({ stage: "completed", elapsedMs: 11, queueWaitMs: 3, runMs: 8, shared: false });
        return readyPerformancePack(args.months[0]);
      }
    });
    await timingAgent.start();
    const timingPrincipal = principalKeyFromUserId("query-timing-user", access);
    const sessionTimings = [];
    const timingAnswer = timingAgent.answer({ question: "集团8月业绩排名", access, principalKey: timingPrincipal, onTiming: (event) => {
      if (["session_started", "session_expired"].includes(event.stage)) sessionTimings.push(event);
      else originalTimings.push(event);
      return new Promise(() => {});
    } });
    await nextImmediate();
    assert.deepEqual(timingAgent.sessions.get(timingPrincipal).active.queryPlan.months, ["2026-08"], "首次裸月份必须真正选中8月");
    assert.deepEqual(originalTimings.map((event) => event.stage), ["completed"], "预取终态时长应转发，阶段事件不重复计时");
    assert.deepEqual(sessionTimings.map((event) => event.stage), ["session_started"], "会话排队与取数计时分开记录");
    assert.equal(timingClient.startTurnCalls.length, 1, "未完成的外部 timing Promise 不得阻塞模型启动");
    timingClient.emit("serverRequest", { id: 991, method: "item/tool/call", params: {
      threadId: "thread-1", turnId: "turn-1", tool: "query_xbb", arguments: { months: ["2026-09"], domains: ["performance"] }
    } });
    await waitUntil(() => Boolean(delayedTimingInvocation), "动态查询应建立独立计时订阅");
    const timingSteer = timingAgent.answer({ question: "集团9月业绩排名", access, principalKey: timingPrincipal, onTiming: (event) => {
      if (!["session_started", "session_expired"].includes(event.stage)) steeredTimings.push(event);
      throw new Error("offline observer failure");
    } });
    await nextImmediate();
    assert.match((await timingAnswer).answer, /最新一条消息/);
    assert.equal(delayedTimingInvocation.signal.aborted, false, "相同查询范围的 steer 不取消已有查询");
    delayedTimingInvocation.onTiming({ stage: "completed", elapsedMs: 37, queueWaitMs: 12, runMs: 25, shared: true });
    delayedTimingInvocation.onTiming({ stage: "failed", elapsedMs: 38, queueWaitMs: 12, runMs: 26, shared: true });
    releaseTimingQuery();
    await waitUntil(() => timingClient.responses.some((item) => item.id === 991), "未完成的 observer 不能阻塞动态工具返回");
    assert.equal(originalTimings.length, 1, "已交接完成的旧 waiter 不接受迟到查询计时");
    assert.equal(originalTimings.at(-1).runMs, 8, "只保留 handoff 前已完成的预取计时");
    assert.equal(steeredTimings.length, 0, "新 waiter 不得继承 steer 前查询的整段耗时");
    timingClient.emit("serverRequest", { id: 992, method: "item/tool/call", params: {
      threadId: "thread-1", turnId: "turn-1", tool: "query_xbb", arguments: { months: ["2026-07"], domains: ["performance"] }
    } });
    await waitUntil(() => timingClient.responses.some((item) => item.id === 992), "timing observer 同步抛错不能阻塞新动态查询");
    assert.equal(steeredTimings.length, 1);
    const waitersBeforeInvalidSteer = timingAgent.sessions.get(timingPrincipal).active.waiters;
    const steerCountBeforeInvalid = timingClient.steerTurnCalls.length;
    await assert.rejects(timingAgent.answer({ question: "改成9999年12月业绩排名", access, principalKey: timingPrincipal }), /晚于当前上海月份/);
    assert.equal(timingClient.steerTurnCalls.length, steerCountBeforeInvalid, "未来月份不能发送到活动模型Turn");
    assert.equal(timingAgent.sessions.get(timingPrincipal).active.waiters, waitersBeforeInvalidSteer, "无效修正保留原答复所有者");
    timingClient.complete("thread-1", "turn-1", JSON.stringify({ answer: "计时隔离验证完成。", chart: null }));
    assert.match((await timingSteer).answer, /计时隔离验证完成/, "无效修正后原请求仍正常完成");
    const septemberAnswer = timingAgent.answer({ question: "集团9月业绩排名", access, principalKey: timingPrincipal });
    await nextImmediate();
    const augustCorrection = timingAgent.answer({ question: "改成集团8月业绩排名", access, principalKey: timingPrincipal });
    await nextImmediate();
    assert.match((await septemberAnswer).answer, /最新一条消息/);
    assert.deepEqual(timingAgent.sessions.get(timingPrincipal).active.queryPlan.months, ["2026-08"], "活动steer中的裸8月不能误当当前9月");
    assert.equal(timingAgent.sessions.get(timingPrincipal).active.latestFactView, null, "月份修正必须撤销9月旧事实");
    timingClient.complete("thread-1", "turn-2", JSON.stringify({ answer: "已将分析期间修正为8月，需按8月核实数据。", chart: null }));
    await augustCorrection;
    await timingAgent.close();

    const schemaClient = new FakeAppServerClient();
    let schemaQueryCalls = 0;
    const schemaAgent = isolatedAgent("schema-only-route", schemaClient, {
      queryXbb: async () => {
        schemaQueryCalls += 1;
        return readyPerformancePack();
      }
    });
    await schemaAgent.start();
    const schemaPrincipal = principalKeyFromUserId("schema-user", access);
    const schemaPromise = schemaAgent.answer({
      question: "业绩订单表 5614255 的 text_63 是什么字段",
      access,
      principalKey: schemaPrincipal,
      messageId: "schema-only-field"
    });
    await nextImmediate();
    assert.equal(schemaQueryCalls, 0, "纯表单字段问法不得发起无价值的实时取数");
    assert.equal(schemaClient.startTurnCalls.length, 1);
    assert.equal(schemaClient.startTurnCalls[0].params.input[1].name, "xbb-executive-analyst");
    assert.match(schemaClient.startTurnCalls[0].params.input[0].text, /销帮帮 Skill RAG 适用规则/);
    assert.doesNotMatch(schemaClient.startTurnCalls[0].params.input[0].text, /本轮 query_xbb 实时预取事实包/);
    schemaClient.complete("thread-1", "turn-1", JSON.stringify({ answer: "text_63 是所属公司字段。", chart: null }));
    const schemaResult = await schemaPromise;
    assert.equal(schemaResult.routeMode, "xbb");
    assert.match(schemaResult.answer, /所属公司/);
    await schemaAgent.close();

    const resumedClient = new FakeAppServerClient();
    const resumed = new PersistentCodexAgent(config, {
      hostFactory: { start: async () => fakeHost },
      clientFactory: () => resumedClient,
      verifyLogin: () => ({ mode: "chatgpt" }),
      readVersion: () => "0.151.0",
      queryXbb: async () => ({ status: "ready" })
    });
    await resumed.start();
    assert.equal(resumedClient.resumeThreadCalls.length, 0);
    assert.equal(resumedClient.startThreadCalls.length, 0);
    const resumedWarmStats = await resumed.warm({ access, principalKey: principal });
    assert.equal(resumedClient.startTurnCalls.length, 0);
    assert.equal(resumedWarmStats.principals, 1);
    const lazyResumePromise = resumed.answer({ question: "你好", access, principalKey: principal, messageId: "msg-lazy-resume" });
    await nextImmediate();
    assert.equal(resumedClient.resumeThreadCalls.length, 1);
    assert.equal(resumedClient.resumeThreadCalls[0].params.excludeTurns, true);
    assert.deepEqual(resumedClient.resumeThreadCalls[0].params.config, { ...modelContextConfig(), ...CHART_AGENT_CONFIG }, "恢复 Thread 必须重新应用扩容和压缩配置");
    assert.equal(resumedClient.startThreadCalls.length, 0);
    resumedClient.complete("thread-3", "turn-1", JSON.stringify({ answer: "懒恢复成功。", chart: null }));
    assert.match((await lazyResumePromise).answer, /懒恢复成功/);
    await resumed.close();

    const unfinishedStatePath = path.join(tempRoot, "unfinished-state.json");
    const unfinishedClient = new FakeAppServerClient();
    const unfinishedAgent = isolatedAgent("unfinished-source", unfinishedClient, { config: { agentStatePath: unfinishedStatePath } });
    await unfinishedAgent.start();
    const unfinishedPrincipal = principalKeyFromUserId("unfinished-user", access);
    const abandonedPromise = unfinishedAgent.answer({ question: "帮我写一段通知", access, principalKey: unfinishedPrincipal, messageId: "unfinished-active" });
    const abandonedOutcome = Promise.allSettled([abandonedPromise]);
    await nextImmediate();
    assert.equal(loadAgentState(unfinishedStatePath).threads[unfinishedPrincipal].turnInProgress, true);

    const recoveryClient = new FakeAppServerClient();
    const recoveryAgent = isolatedAgent("unfinished-recovery", recoveryClient, { config: { agentStatePath: unfinishedStatePath } });
    await recoveryAgent.start();
    const recoveredContextPromise = recoveryAgent.answer({ question: "你好", access, principalKey: unfinishedPrincipal, messageId: "unfinished-recovered" });
    await nextImmediate();
    assert.equal(recoveryClient.resumeThreadCalls.length, 0);
    assert.equal(recoveryClient.startThreadCalls.length, 1);
    recoveryClient.complete("thread-1", "turn-1", JSON.stringify({ answer: "未完成旧轮次已隔离，新会话正常。", chart: null }));
    assert.match((await recoveredContextPromise).answer, /新会话正常/);
    await recoveryAgent.close();
    await unfinishedAgent.close();
    assert.equal((await abandonedOutcome)[0].status, "rejected");

    const staleClient = new FakeAppServerClient();
    let staleQueryCount = 0;
    let releaseStaleQuery;
    let markStaleQueryStarted;
    const staleQueryStarted = new Promise((resolve) => { markStaleQueryStarted = resolve; });
    const staleAgent = isolatedAgent("stale-steer", staleClient, {
      queryXbb: async (args) => {
        staleQueryCount += 1;
        if (staleQueryCount > 1) {
          markStaleQueryStarted();
          await new Promise((resolve) => { releaseStaleQuery = resolve; });
        }
        return readyPerformancePack(args.months[0], 321);
      }
    });
    await staleAgent.start();
    const stalePrincipal = principalKeyFromUserId("stale-user", access);
    const originalScopePromise = staleAgent.answer({ question: "集团9月业绩排名", access, principalKey: stalePrincipal, messageId: "stale-a" });
    await nextImmediate();
    staleClient.emit("serverRequest", {
      id: 901,
      method: "item/tool/call",
      params: { threadId: "thread-1", turnId: "turn-1", tool: "query_xbb", arguments: { months: ["2026-08"], domains: ["opportunities"] } }
    });
    await staleQueryStarted;
    assert.equal(staleAgent.sessions.get(stalePrincipal).active.latestFactView, null, "新范围查询一发起就必须撤销旧事实回退");
    assert.equal(staleAgent.sessions.get(stalePrincipal).active.fallbackBlockedUntilFreshScope, true);
    const changedScopePromise = staleAgent.answer({ question: "集团7月商机分析", access, principalKey: stalePrincipal, messageId: "stale-b" });
    await nextImmediate();
    assert.equal(staleClient.steerTurnCalls.length, 1);
    assert.match((await originalScopePromise).answer, /最新一条消息/);
    assert.equal(staleAgent.sessions.get(stalePrincipal).active.prefetchedFactAvailable, false);
    releaseStaleQuery();
    await nextImmediate();
    await nextImmediate();
    assert.equal(staleClient.responses.at(-1).id, 901);
    assert.equal(staleClient.responses.at(-1).result.success, true);
    const staleToolResult = JSON.parse(staleClient.responses.at(-1).result.contentItems[0].text);
    assert.equal(staleToolResult.status, "superseded");
    assert.equal(Object.hasOwn(staleToolResult, "facts"), false);
    assert.equal(staleAgent.sessions.get(stalePrincipal).active.latestFactView, null);
    staleClient.complete("thread-1", "turn-1", "not-json");
    await assert.rejects(changedScopePromise, /结构化结果/);
    assert.equal(staleQueryCount, 2);
    await staleAgent.close();

    const prefetchClient = new FakeAppServerClient();
    const prefetchCalls = [];
    let firstPrefetchSignal;
    let firstPrefetchTiming;
    const oldPrefetchTimings = [];
    const newPrefetchTimings = [];
    let releaseFirstPrefetch;
    let markFirstPrefetchStarted;
    const firstPrefetchStarted = new Promise((resolve) => { markFirstPrefetchStarted = resolve; });
    const prefetchAgent = isolatedAgent("prefetch-scope-takeover", prefetchClient, {
      queryXbb: async (args, _access, invocation = {}) => {
        prefetchCalls.push(args);
        if (prefetchCalls.length === 1) {
          firstPrefetchSignal = invocation.signal;
          firstPrefetchTiming = invocation.onTiming;
          markFirstPrefetchStarted();
          return new Promise((resolve) => { releaseFirstPrefetch = () => resolve(readyPerformancePack(args.months[0], 901)); });
        }
        invocation.onTiming({ stage: "completed", elapsedMs: 8, queueWaitMs: 2, runMs: 6, shared: false });
        return readyPerformancePack(args.months[0], 802);
      }
    });
    await prefetchAgent.start();
    const prefetchPrincipal = principalKeyFromUserId("prefetch-takeover-user", access);
    const supersededPrefetch = prefetchAgent.answer({
      question: "分析华东公司2026年1—8月业绩排名",
      access,
      principalKey: prefetchPrincipal,
      messageId: "prefetch-old",
      onTiming: (event) => { if (!["session_started", "session_expired"].includes(event.stage)) oldPrefetchTimings.push(event); }
    });
    await firstPrefetchStarted;
    const latestPrefetch = prefetchAgent.answer({
      question: "改成只看9月",
      access,
      principalKey: prefetchPrincipal,
      messageId: "prefetch-new",
      onTiming: (event) => { if (!["session_started", "session_expired"].includes(event.stage)) newPrefetchTimings.push(event); }
    });
    assert.match((await supersededPrefetch).answer, /最新一条消息/);
    for (let index = 0; index < 4; index += 1) await nextImmediate();
    assert.equal(firstPrefetchSignal.aborted, true, "范围变化必须立即取消旧预取订阅");
    firstPrefetchTiming({ stage: "completed", elapsedMs: 99, queueWaitMs: 1, runMs: 98, shared: false });
    assert.equal(oldPrefetchTimings.length, 0, "被取代和取消的旧预取不能补发迟到时长");
    assert.equal(newPrefetchTimings.length, 1);
    assert.equal(newPrefetchTimings[0].runMs, 6, "新请求只记录自己订阅的查询时长");
    assert.equal(prefetchCalls.length, 2, "旧预取即便忽略 Abort，新范围也必须立即开始");
    assert.deepEqual(prefetchCalls[0], { months: ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08"], domains: ["performance"] });
    assert.deepEqual(prefetchCalls[1], { months: ["2026-09"], domains: ["performance"] });
    assert.equal(prefetchClient.startTurnCalls.length, 1);
    assert.equal(prefetchClient.startTurnCalls[0].params.clientUserMessageId, "prefetch-new", "最新消息必须成为结果所有者");
    assert.match(prefetchClient.startTurnCalls[0].params.input[0].text, /启动前仍有效的意图链/);
    assert.match(prefetchClient.startTurnCalls[0].params.input[0].text, /分析华东公司2026年1—8月业绩排名/);
    assert.match(prefetchClient.startTurnCalls[0].params.input[0].text, /【用户问题】\n改成只看9月/);
    assert.match(prefetchClient.startTurnCalls[0].params.input[0].text, /"month":"2026-09"/);
    assert.match(prefetchClient.startTurnCalls[0].params.input[0].text, /"total":802/);
    assert.doesNotMatch(prefetchClient.startTurnCalls[0].params.input[0].text, /"total":901/, "旧月份事实不得进入新 Turn");
    prefetchClient.complete("thread-1", "turn-1", JSON.stringify({ answer: "9月范围已接管并完成。", chart: null }));
    const latestPrefetchResult = await latestPrefetch;
    assert.equal(latestPrefetchResult.routeMode, "xbb");
    assert.match(latestPrefetchResult.answer, /9月范围已接管/);
    releaseFirstPrefetch();
    await nextImmediate();
    assert.equal(prefetchClient.startTurnCalls.length, 1, "迟到的旧预取结果不得二次提交 Turn");
    assert.equal(prefetchAgent.sessions.get(prefetchPrincipal).requestQueue.length, 0);
    assert.equal(prefetchAgent.sessions.get(prefetchPrincipal).active, null);
    await prefetchAgent.close();

    const companyScopeClient = new FakeAppServerClient();
    const companyScopeCalls = [];
    let companyOldSignal;
    let releaseCompanyOldQuery;
    let markCompanyOldQueryStarted;
    const companyOldQueryStarted = new Promise((resolve) => { markCompanyOldQueryStarted = resolve; });
    const companyScopeAgent = isolatedAgent("prefetch-company-scope", companyScopeClient, {
      queryXbb: async (args, _access, invocation = {}) => {
        companyScopeCalls.push(args);
        if (companyScopeCalls.length === 1) {
          companyOldSignal = invocation.signal;
          markCompanyOldQueryStarted();
          return new Promise((resolve) => { releaseCompanyOldQuery = () => resolve(readyPerformancePack(args.months[0], 777)); });
        }
        return readyPerformancePack(args.months[0], 606);
      }
    });
    await companyScopeAgent.start();
    const companyScopePrincipal = principalKeyFromUserId("prefetch-company-user", access);
    const companyOldAnswer = companyScopeAgent.answer({
      question: "集团2026年9月业绩排名",
      access,
      principalKey: companyScopePrincipal,
      messageId: "prefetch-company-old"
    });
    await companyOldQueryStarted;
    const companyLatestAnswer = companyScopeAgent.answer({
      question: "改成只看华南公司",
      access,
      principalKey: companyScopePrincipal,
      messageId: "prefetch-company-new"
    });
    assert.match((await companyOldAnswer).answer, /最新一条消息/);
    await waitUntil(() => companyScopeClient.startTurnCalls.length === 1, "公司范围更正后应立即启动无宽范围预取的新 Turn");
    assert.equal(companyOldSignal.aborted, true, "公司范围更正即使月份和业务域不变也必须取消旧预取");
    assert.equal(companyScopeCalls.length, 1, "公司范围更正不得自动执行集团宽范围预取");
    const companyScopePrompt = companyScopeClient.startTurnCalls[0].params.input[0].text;
    assert.equal(companyScopeClient.startTurnCalls[0].params.clientUserMessageId, "prefetch-company-new");
    assert.match(companyScopePrompt, /华南公司/);
    assert.match(companyScopePrompt, /最新实体范围必须动态查询/);
    assert.doesNotMatch(companyScopePrompt, /本轮 query_xbb 实时预取事实包/);
    assert.doesNotMatch(companyScopePrompt, /"total":777/, "旧集团事实不得进入公司范围新 Turn");
    companyScopeClient.emit("serverRequest", {
      id: 905,
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        tool: "query_xbb",
        arguments: { months: ["2026-09"], domains: ["performance"], company: "华南公司" }
      }
    });
    await waitUntil(() => companyScopeClient.responses.some((response) => response.id === 905), "公司动态精确查询应返回事实视图");
    assert.deepEqual(companyScopeCalls[1], { months: ["2026-09"], domains: ["performance"], company: "华南公司" });
    companyScopeClient.complete("thread-1", "turn-1", JSON.stringify({ answer: "华南公司范围已动态查询。", chart: null }));
    assert.match((await companyLatestAnswer).answer, /华南公司范围/);
    releaseCompanyOldQuery();
    await nextImmediate();
    assert.equal(companyScopeClient.startTurnCalls.length, 1, "公司旧预取迟到结果不得再次启动 Turn");
    await companyScopeAgent.close();

    const personProgressClient = new FakeAppServerClient();
    const personProgressCalls = [];
    let releasePersonInitialProgress;
    let markPersonInitialProgress;
    let personInitialProgressBlocked = false;
    const personInitialProgress = new Promise((resolve) => { markPersonInitialProgress = resolve; });
    const personProgressAgent = isolatedAgent("prefetch-person-progress", personProgressClient, {
      queryXbb: async (args) => {
        personProgressCalls.push(args);
        return readyPerformancePack(args.months[0], 505);
      }
    });
    await personProgressAgent.start();
    const personProgressPrincipal = principalKeyFromUserId("prefetch-person-user", access);
    const personOldAnswer = personProgressAgent.answer({
      question: "集团2026年9月商机质量分析",
      access,
      principalKey: personProgressPrincipal,
      messageId: "prefetch-person-old",
      onProgress: async () => {
        if (personInitialProgressBlocked) return;
        personInitialProgressBlocked = true;
        markPersonInitialProgress();
        await new Promise((resolve) => { releasePersonInitialProgress = resolve; });
      }
    });
    await personInitialProgress;
    const personLatestAnswer = personProgressAgent.answer({
      question: "换个销售看：张三",
      access,
      principalKey: personProgressPrincipal,
      messageId: "prefetch-person-new"
    });
    assert.match((await personOldAnswer).answer, /最新一条消息/);
    releasePersonInitialProgress();
    await waitUntil(() => personProgressClient.startTurnCalls.length === 1, "销售范围更正应越过通用路由并启动新 Turn");
    assert.equal(personProgressCalls.length, 0, "进度通知 await 期间的销售更正必须阻止旧 runner 启动");
    const personScopePrompt = personProgressClient.startTurnCalls[0].params.input[0].text;
    assert.match(personScopePrompt, /换个销售看：张三/);
    assert.match(personScopePrompt, /最新实体范围必须动态查询/);
    assert.doesNotMatch(personScopePrompt, /本轮 query_xbb 实时预取事实包/);
    personProgressClient.emit("serverRequest", {
      id: 906,
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        tool: "query_xbb",
        arguments: { months: ["2026-09"], domains: ["opportunities"], person: "张三" }
      }
    });
    await waitUntil(() => personProgressClient.responses.some((response) => response.id === 906), "销售动态精确查询应返回事实视图");
    assert.deepEqual(personProgressCalls[0], { months: ["2026-09"], domains: ["opportunities"], person: "张三" });
    personProgressClient.complete("thread-1", "turn-1", JSON.stringify({ answer: "张三销售范围已动态查询。", chart: null }));
    assert.match((await personLatestAnswer).answer, /张三销售范围/);
    await personProgressAgent.close();

    const correctionChainClient = new FakeAppServerClient();
    const correctionChainCalls = [];
    let correctionChainOldSignal;
    let releaseCorrectionChainOldQuery;
    let markCorrectionChainOldQueryStarted;
    const correctionChainOldQueryStarted = new Promise((resolve) => { markCorrectionChainOldQueryStarted = resolve; });
    const correctionChainAgent = isolatedAgent("prefetch-correction-chain", correctionChainClient, {
      queryXbb: async (args, _access, invocation = {}) => {
        correctionChainCalls.push(args);
        if (correctionChainCalls.length === 1) {
          correctionChainOldSignal = invocation.signal;
          markCorrectionChainOldQueryStarted();
          return new Promise((resolve) => { releaseCorrectionChainOldQuery = () => resolve(readyPerformancePack(args.months[0], 404)); });
        }
        return readyPerformancePack(args.months[0], 303);
      }
    });
    await correctionChainAgent.start();
    const correctionChainPrincipal = principalKeyFromUserId("prefetch-chain-user", access);
    const correctionChainAnswers = [correctionChainAgent.answer({
      question: "分析集团2026年1—8月业绩排名",
      access,
      principalKey: correctionChainPrincipal,
      messageId: "prefetch-chain-original"
    })];
    await correctionChainOldQueryStarted;
    correctionChainAnswers.push(correctionChainAgent.answer({
      question: "改成只看华南公司",
      access,
      principalKey: correctionChainPrincipal,
      messageId: "prefetch-chain-company"
    }));
    correctionChainAnswers.push(correctionChainAgent.answer({
      question: "改成商机分析",
      access,
      principalKey: correctionChainPrincipal,
      messageId: "prefetch-chain-domain"
    }));
    correctionChainAnswers.push(correctionChainAgent.answer({
      question: "再只看8月",
      access,
      principalKey: correctionChainPrincipal,
      messageId: "prefetch-chain-month"
    }));
    const correctionChainSettlements = [0, 0, 0, 0];
    correctionChainAnswers.forEach((promise, index) => promise.then(
      () => { correctionChainSettlements[index] += 1; },
      () => { correctionChainSettlements[index] += 1; }
    ));
    assert.match((await correctionChainAnswers[0]).answer, /最新一条消息/);
    assert.match((await correctionChainAnswers[1]).answer, /最新一条消息/);
    assert.match((await correctionChainAnswers[2]).answer, /最新一条消息/);
    await waitUntil(() => correctionChainClient.startTurnCalls.length === 1, "连续范围更正后最新消息应启动唯一 Turn");
    assert.equal(correctionChainOldSignal.aborted, true);
    assert.equal(correctionChainCalls.length, 1, "实体更正链不得重新执行宽范围自动预取");
    assert.deepEqual(correctionChainAgent.sessions.get(correctionChainPrincipal).active.queryPlan, {
      months: ["2026-08"],
      domains: ["opportunities"]
    });
    const correctionChainPrompt = correctionChainClient.startTurnCalls[0].params.input[0].text;
    assert.equal(correctionChainClient.startTurnCalls[0].params.clientUserMessageId, "prefetch-chain-month");
    assert.match(correctionChainPrompt, /改成只看华南公司/);
    assert.match(correctionChainPrompt, /改成商机分析/);
    assert.match(correctionChainPrompt, /【用户问题】\n再只看8月/);
    assert.match(correctionChainPrompt, /最新实体范围必须动态查询/);
    assert.doesNotMatch(correctionChainPrompt, /"total":404/);
    correctionChainClient.emit("serverRequest", {
      id: 907,
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        tool: "query_xbb",
        arguments: { months: ["2026-08"], domains: ["opportunities"], company: "华南公司" }
      }
    });
    await waitUntil(() => correctionChainClient.responses.some((response) => response.id === 907), "连续更正后的动态查询应使用最终合并范围");
    assert.deepEqual(correctionChainCalls[1], { months: ["2026-08"], domains: ["opportunities"], company: "华南公司" });
    correctionChainClient.complete("thread-1", "turn-1", JSON.stringify({ answer: "华南公司8月商机已完成。", chart: null }));
    assert.match((await correctionChainAnswers[3]).answer, /华南公司8月商机/);
    releaseCorrectionChainOldQuery();
    await nextImmediate();
    assert.deepEqual(correctionChainSettlements, [1, 1, 1, 1], "连续 replacement 与迟到旧结果不得造成 waiter 双结算");
    assert.equal(correctionChainClient.startTurnCalls.length, 1);
    await correctionChainAgent.close();

    const passiveFollowupClient = new FakeAppServerClient();
    let passiveFollowupSignal;
    let releasePassiveFollowupQuery;
    let markPassiveFollowupQueryStarted;
    const passiveFollowupQueryStarted = new Promise((resolve) => { markPassiveFollowupQueryStarted = resolve; });
    const passiveFollowupAgent = isolatedAgent("prefetch-passive-followup", passiveFollowupClient, {
      queryXbb: async (_args, _access, invocation = {}) => {
        passiveFollowupSignal = invocation.signal;
        markPassiveFollowupQueryStarted();
        return new Promise((resolve) => { releasePassiveFollowupQuery = () => resolve(readyPerformancePack()); });
      }
    });
    await passiveFollowupAgent.start();
    const passiveFollowupPrincipal = principalKeyFromUserId("prefetch-passive-user", access);
    const passiveFollowupAnswers = [passiveFollowupAgent.answer({
      question: "集团2026年9月业绩排名",
      access,
      principalKey: passiveFollowupPrincipal,
      messageId: "prefetch-passive-original"
    })];
    await passiveFollowupQueryStarted;
    passiveFollowupAnswers.push(passiveFollowupAgent.answer({
      question: "继续",
      access,
      principalKey: passiveFollowupPrincipal,
      messageId: "prefetch-passive-continue"
    }));
    passiveFollowupAnswers.push(passiveFollowupAgent.answer({
      question: "进度",
      access,
      principalKey: passiveFollowupPrincipal,
      messageId: "prefetch-passive-progress"
    }));
    passiveFollowupAnswers.push(passiveFollowupAgent.answer({
      question: "只看公司排名",
      access,
      principalKey: passiveFollowupPrincipal,
      messageId: "prefetch-passive-company-dimension"
    }));
    await nextImmediate();
    const passiveActive = passiveFollowupAgent.sessions.get(passiveFollowupPrincipal).active;
    assert.equal(passiveFollowupSignal.aborted, false, "继续、进度或公司分组维度不得取消范围未变化的慢预取");
    assert.equal(passiveActive.preStartReplacement, null, "继续、进度或公司分组维度不得冒充实体 replacement");
    assert.equal(passiveFollowupAgent.sessions.get(passiveFollowupPrincipal).requestQueue.length, 3);
    assert.equal(passiveFollowupClient.startTurnCalls.length, 0);
    const passiveFollowupOutcomes = Promise.allSettled(passiveFollowupAnswers);
    await passiveFollowupAgent.close();
    releasePassiveFollowupQuery();
    assert.equal((await passiveFollowupOutcomes).length, 4);
    await nextImmediate();

    const takeoverCloseClient = new FakeAppServerClient();
    let releaseClosingPrefetch;
    let markClosingPrefetchStarted;
    const closingPrefetchStarted = new Promise((resolve) => { markClosingPrefetchStarted = resolve; });
    const takeoverCloseAgent = isolatedAgent("prefetch-takeover-close", takeoverCloseClient, {
      queryXbb: async (_args, _access, invocation = {}) => {
        markClosingPrefetchStarted();
        return new Promise((resolve) => { releaseClosingPrefetch = () => resolve(readyPerformancePack()); });
      }
    });
    await takeoverCloseAgent.start();
    const takeoverClosePrincipal = principalKeyFromUserId("prefetch-close-user", access);
    const closingOld = takeoverCloseAgent.answer({ question: "集团2026年9月业绩排名", access, principalKey: takeoverClosePrincipal, messageId: "prefetch-close-old" });
    await closingPrefetchStarted;
    const closingLatest = takeoverCloseAgent.answer({ question: "集团2026年8月业绩排名", access, principalKey: takeoverClosePrincipal, messageId: "prefetch-close-new" });
    const closingTakeoverOutcomes = Promise.allSettled([closingOld, closingLatest]);
    await takeoverCloseAgent.close();
    releaseClosingPrefetch();
    const settledTakeoverClose = await closingTakeoverOutcomes;
    assert.deepEqual(settledTakeoverClose.map((item) => item.status), ["fulfilled", "rejected"], "关闭时接管 waiter 必须全部结算");
    assert.equal(takeoverCloseClient.startTurnCalls.length, 0);

    const prefetchQueueClient = new FakeAppServerClient();
    let releaseQueuedPrefetch;
    let markQueuedPrefetchStarted;
    const queuedPrefetchStarted = new Promise((resolve) => { markQueuedPrefetchStarted = resolve; });
    const prefetchQueueAgent = isolatedAgent("prefetch-cross-route-bound", prefetchQueueClient, {
      queryXbb: async () => {
        markQueuedPrefetchStarted();
        return new Promise((resolve) => { releaseQueuedPrefetch = () => resolve(readyPerformancePack()); });
      }
    });
    await prefetchQueueAgent.start();
    const prefetchQueuePrincipal = principalKeyFromUserId("prefetch-queue-user", access);
    const prefetchQueuePromises = [prefetchQueueAgent.answer({
      question: "集团2026年9月业绩排名",
      access,
      principalKey: prefetchQueuePrincipal,
      messageId: "prefetch-queue-active"
    })];
    await queuedPrefetchStarted;
    for (let index = 0; index < 100; index += 1) {
      prefetchQueuePromises.push(prefetchQueueAgent.answer({
        question: `帮我写会议通知${index}`,
        access,
        principalKey: prefetchQueuePrincipal,
        messageId: `prefetch-cross-route-${index}`
      }));
    }
    const prefetchQueueOutcomes = Promise.allSettled(prefetchQueuePromises);
    await nextImmediate();
    assert.ok(prefetchQueueAgent.sessions.get(prefetchQueuePrincipal).requestQueue.length <= 8, "预取阻塞期间跨路由队列必须保持硬上限");
    assert.equal(prefetchQueueClient.startTurnCalls.length, 0);
    await prefetchQueueAgent.close();
    releaseQueuedPrefetch();
    assert.equal((await prefetchQueueOutcomes).length, 101, "关闭时跨路由有界队列不得遗留 waiter");

    const isolationCallbackClient = new FakeAppServerClient();
    let isolationFailureCallback;
    let isolationGatewayLeasePath;
    const isolationCallbackAgent = new PersistentCodexAgent({
      ...config,
      agentStatePath: path.join(tempRoot, "gateway-isolation-callback-state.json")
    }, {
      hostFactory: { start: async () => ({ endpoint: "ws://127.0.0.1:43126", token: "j".repeat(48), process: Object.assign(new EventEmitter(), { exitCode: null }), close: async () => {} }) },
      clientFactory: () => isolationCallbackClient,
      verifyLogin: () => ({ mode: "chatgpt" }),
      readVersion: () => "0.151.0",
      toolGatewayFactory: (gatewayOptions) => {
        isolationFailureCallback = gatewayOptions.onIsolationFailure;
        isolationGatewayLeasePath = gatewayOptions.serviceLeasePath;
        return async () => readyPerformancePack();
      }
    });
    const isolationCallbackEvents = [];
    isolationCallbackAgent.on("fatal", (event) => isolationCallbackEvents.push(event));
    await isolationCallbackAgent.start();
    assert.equal(typeof isolationFailureCallback, "function", "默认网关必须接入隔离失败回调");
    assert.equal(isolationGatewayLeasePath, config.serviceLeasePath, "默认网关必须从租约同目录派生跨代 runner 隔离标记");
    const isolationCallbackPrincipal = principalKeyFromUserId("gateway-isolation-callback-user", access);
    let isolationCallbackSettlements = 0;
    const isolationCallbackAnswer = isolationCallbackAgent.answer({
      question: "帮我写会议通知",
      access,
      principalKey: isolationCallbackPrincipal,
      messageId: "gateway-isolation-callback"
    });
    isolationCallbackAnswer.then(
      () => { isolationCallbackSettlements += 1; },
      () => { isolationCallbackSettlements += 1; }
    );
    await nextImmediate();
    isolationFailureCallback(new Error("simulated gateway isolation failure"));
    await assert.rejects(isolationCallbackAnswer, /隔离状态失效.*自动重启/);
    await nextImmediate();
    assert.equal(isolationCallbackSettlements, 1, "隔离失败回调不得双结算活动请求");
    assert.equal(isolationCallbackEvents.length, 1);
    assert.equal(isolationCallbackAgent.started, false);
    await isolationCallbackAgent.close();

    const fatalPrefetchClient = new FakeAppServerClient();
    const fatalPrefetchAgent = isolatedAgent("runner-termination-prefetch", fatalPrefetchClient, {
      queryXbb: async () => {
        const error = new Error("simulated fail-closed query gateway");
        error.code = "XBB_QUERY_GATEWAY_FAIL_CLOSED";
        throw error;
      }
    });
    const fatalPrefetchEvents = [];
    fatalPrefetchAgent.on("fatal", (event) => fatalPrefetchEvents.push(event));
    await fatalPrefetchAgent.start();
    const fatalPrefetchPrincipal = principalKeyFromUserId("runner-fatal-prefetch-user", access);
    let fatalPrefetchSettlements = 0;
    const fatalPrefetchAnswer = fatalPrefetchAgent.answer({
      question: "集团2026年9月业绩排名",
      access,
      principalKey: fatalPrefetchPrincipal,
      messageId: "runner-fatal-prefetch"
    });
    fatalPrefetchAnswer.then(
      () => { fatalPrefetchSettlements += 1; },
      () => { fatalPrefetchSettlements += 1; }
    );
    await assert.rejects(fatalPrefetchAnswer, /服务将自动重启/);
    await nextImmediate();
    assert.equal(fatalPrefetchSettlements, 1, "预取 fatal 不得双结算原请求");
    assert.equal(fatalPrefetchEvents.length, 1);
    assert.equal(fatalPrefetchAgent.started, false);
    assert.equal(fatalPrefetchClient.startTurnCalls.length, 0);
    await fatalPrefetchAgent.close();

    const fatalDynamicClient = new FakeAppServerClient();
    const fatalDynamicAgent = isolatedAgent("runner-termination-dynamic", fatalDynamicClient, {
      queryXbb: async () => {
        const error = new Error("simulated unconfirmed process-tree termination");
        error.code = "XBB_RUNNER_TERMINATION_UNCONFIRMED";
        throw error;
      }
    });
    const fatalDynamicEvents = [];
    fatalDynamicAgent.on("fatal", (event) => fatalDynamicEvents.push(event));
    await fatalDynamicAgent.start();
    const fatalDynamicPrincipal = principalKeyFromUserId("runner-fatal-dynamic-user", access);
    let fatalDynamicSettlements = 0;
    const fatalDynamicAnswer = fatalDynamicAgent.answer({
      question: "请做集团经营分析",
      access,
      principalKey: fatalDynamicPrincipal,
      messageId: "runner-fatal-dynamic"
    });
    fatalDynamicAnswer.then(
      () => { fatalDynamicSettlements += 1; },
      () => { fatalDynamicSettlements += 1; }
    );
    await nextImmediate();
    assert.equal(fatalDynamicClient.startTurnCalls.length, 1);
    fatalDynamicClient.emit("serverRequest", {
      id: 904,
      method: "item/tool/call",
      params: { threadId: "thread-1", turnId: "turn-1", tool: "query_xbb", arguments: { months: ["2026-09"], domains: ["performance"] } }
    });
    await assert.rejects(fatalDynamicAnswer, /服务将自动重启/);
    await nextImmediate();
    assert.equal(fatalDynamicSettlements, 1, "动态工具 fatal 不得双结算原请求");
    assert.equal(fatalDynamicEvents.length, 1);
    assert.equal(fatalDynamicAgent.started, false);
    assert.equal(fatalDynamicClient.responses.some((response) => response.id === 904), false, "fatal 后不得向失效 Turn 回写工具结果");
    await fatalDynamicAgent.close();

    const timeoutClient = new FakeAppServerClient();
    let releaseInterrupt;
    timeoutClient.interruptTurn = async (threadId, turnId) => {
      timeoutClient.interruptTurnCalls.push({ threadId, turnId });
      await new Promise((resolve) => { releaseInterrupt = resolve; });
      return {};
    };
    const timeoutAgent = isolatedAgent("timeout-race", timeoutClient);
    const timeoutActivities = [];
    timeoutAgent.on("activity", (value) => timeoutActivities.push(value));
    await timeoutAgent.start();
    const timeoutPrincipal = principalKeyFromUserId("timeout-user", access);
    const timeoutAnswer = timeoutAgent.answer({ question: "你好", access, principalKey: timeoutPrincipal, messageId: "timeout-race" });
    const timeoutRejected = assert.rejects(timeoutAnswer, /超时/);
    await nextImmediate();
    const timeoutSession = timeoutAgent.sessions.get(timeoutPrincipal);
    const timeoutActive = timeoutSession.active;
    const timeoutOperation = timeoutAgent._timeoutTurn(timeoutSession, timeoutActive);
    await timeoutRejected;
    await nextImmediate();
    timeoutClient.complete("thread-1", "turn-1", JSON.stringify({ answer: "抢在中断确认前正常完成。", chart: null }));
    releaseInterrupt();
    await timeoutOperation;
    assert.equal(timeoutSession.turnCount, 0, "超时后的迟到完成不能复活或推进旧Turn");
    assert.equal(timeoutSession.threadId, null);
    assert.equal(timeoutActivities.some((value) => value.status === "context_invalidated"), true);
    assert.equal(timeoutActivities.some((value) => value.status === "turn_failed"), true);
    await timeoutAgent.close();

    const failingClient = new FakeAppServerClient();
    failingClient.startTurn = async function startTurn(params) {
      this.startTurnCalls.push({ id: null, params });
      throw new Error("simulated turn/start failure");
    };
    const failingAgent = isolatedAgent("turn-start-failure", failingClient);
    const fatalEvents = [];
    failingAgent.on("fatal", (value) => fatalEvents.push(value));
    await failingAgent.start();
    const failingPrincipal = principalKeyFromUserId("failing-user", access);
    await assert.rejects(
      failingAgent.answer({ question: "你好", access, principalKey: failingPrincipal, messageId: "failure-1" }),
      /simulated turn\/start failure/
    );
    assert.equal(fatalEvents.length, 0);
    await assert.rejects(
      failingAgent.answer({ question: "再试一次", access, principalKey: failingPrincipal, messageId: "failure-2" }),
      /simulated turn\/start failure/
    );
    assert.equal(failingClient.startTurnCalls.length, 2);
    assert.equal(fatalEvents.length, 1);
    assert.equal(failingAgent.started, false);
    await failingAgent.close();

    const closingClient = new FakeAppServerClient();
    let closingQueries = 0;
    const closingAgent = isolatedAgent("close-queue", closingClient, {
      queryXbb: async () => {
        closingQueries += 1;
        return readyPerformancePack();
      }
    });
    await closingAgent.start();
    const closingPrincipal = principalKeyFromUserId("closing-user", access);
    const activeAtClose = closingAgent.answer({ question: "帮我写会议通知", access, principalKey: closingPrincipal, messageId: "close-active" });
    await nextImmediate();
    const activeBeforeClose = closingAgent.sessions.get(closingPrincipal).active;
    const queuedAtClose = closingAgent.answer({ question: "集团9月业绩排名", access, principalKey: closingPrincipal, messageId: "close-queued" });
    await nextImmediate();
    const closeOutcomes = Promise.allSettled([activeAtClose, queuedAtClose]);
    await closingAgent.close();
    const settledAtClose = await closeOutcomes;
    assert.deepEqual(settledAtClose.map((item) => item.status), ["rejected", "rejected"]);
    assert.equal(closingQueries, 0);
    assert.equal(closingClient.startTurnCalls.length, 1);
    assert.equal(closingAgent.sessions.get(closingPrincipal).active, null);
    assert.equal(activeBeforeClose.timeout, null);

    const fatalQueueClient = new FakeAppServerClient();
    let fatalQueueQueries = 0;
    const fatalQueueAgent = isolatedAgent("fatal-queue", fatalQueueClient, {
      queryXbb: async () => {
        fatalQueueQueries += 1;
        return readyPerformancePack();
      }
    });
    await fatalQueueAgent.start();
    const fatalQueuePrincipal = principalKeyFromUserId("fatal-queue-user", access);
    const activeAtFatal = fatalQueueAgent.answer({ question: "帮我写会议通知", access, principalKey: fatalQueuePrincipal, messageId: "fatal-active" });
    await nextImmediate();
    const activeBeforeFatal = fatalQueueAgent.sessions.get(fatalQueuePrincipal).active;
    const queuedAtFatal = fatalQueueAgent.answer({ question: "集团9月业绩排名", access, principalKey: fatalQueuePrincipal, messageId: "fatal-queued" });
    await nextImmediate();
    const fatalQueueOutcomes = Promise.allSettled([activeAtFatal, queuedAtFatal]);
    fatalQueueAgent._fatal("simulated fatal shutdown");
    assert.deepEqual((await fatalQueueOutcomes).map((item) => item.status), ["rejected", "rejected"]);
    assert.equal(fatalQueueQueries, 0);
    assert.equal(fatalQueueClient.startTurnCalls.length, 1);
    assert.equal(fatalQueueAgent.sessions.get(fatalQueuePrincipal).active, null);
    assert.equal(activeBeforeFatal.timeout, null);
    await fatalQueueAgent.close();

    const absoluteClient = new FakeAppServerClient();
    let absoluteQuerySignal;
    const absoluteAgent = isolatedAgent("absolute-deadline", absoluteClient, {
      config: { agentTurnTimeoutMs: 1000, agentTotalTimeoutMs: 30 },
      queryXbb: async (_args, _access, invocation = {}) => new Promise((_resolve, reject) => {
        absoluteQuerySignal = invocation.signal;
        const fail = () => reject(invocation.signal.reason || new Error("aborted"));
        if (invocation.signal.aborted) fail();
        else invocation.signal.addEventListener("abort", fail, { once: true });
      })
    });
    await absoluteAgent.start();
    const absolutePrincipal = principalKeyFromUserId("absolute-user", access);
    const absoluteStartedAt = Date.now();
    const absoluteAnswer = absoluteAgent.answer({ question: "集团9月业绩排名", access, principalKey: absolutePrincipal, messageId: "absolute-deadline" });
    const keepAbsoluteTimerAlive = setTimeout(() => {}, 1000);
    await assert.rejects(
      absoluteAnswer,
      (error) => /本轮处理超时/.test(error?.message || "") && error?.timeoutMs === 30
    );
    clearTimeout(keepAbsoluteTimerAlive);
    assert.equal(absoluteQuerySignal.aborted, true);
    assert.ok(Date.now() - absoluteStartedAt < 500, "预取必须受非滑动端到端截止约束");
    assert.equal(absoluteClient.startTurnCalls.length, 0);
    assert.equal(absoluteAgent.sessions.get(absolutePrincipal).active, null);
    await absoluteAgent.close();

    const cancelClient = new FakeAppServerClient();
    let dynamicQuerySignal;
    let markDynamicQueryStarted;
    const dynamicQueryStarted = new Promise((resolve) => { markDynamicQueryStarted = resolve; });
    const cancelAgent = isolatedAgent("cancel-in-flight", cancelClient, {
      queryXbb: async (_args, _access, invocation = {}) => new Promise((_resolve, reject) => {
        dynamicQuerySignal = invocation.signal;
        markDynamicQueryStarted();
        const fail = () => reject(invocation.signal.reason || new Error("aborted"));
        if (invocation.signal.aborted) fail();
        else invocation.signal.addEventListener("abort", fail, { once: true });
      })
    });
    await cancelAgent.start();
    const cancelPrincipal = principalKeyFromUserId("cancel-user", access);
    const cancelAnswer = cancelAgent.answer({ question: "请做集团经营分析", access, principalKey: cancelPrincipal, messageId: "cancel-active" });
    await nextImmediate();
    assert.equal(cancelClient.startTurnCalls.length, 1);
    const cancelActive = cancelAgent.sessions.get(cancelPrincipal).active;
    assert.ok(cancelActive.timeout, "模型生成阶段必须保留独立超时");
    assert.ok(cancelActive.absoluteTimeout, "整轮必须同时存在非滑动绝对截止");
    cancelClient.emit("serverRequest", {
      id: 902,
      method: "item/tool/call",
      params: { threadId: "thread-1", turnId: "turn-1", tool: "query_xbb", arguments: { months: ["2026-09"], domains: ["opportunities"] } }
    });
    await dynamicQueryStarted;
    assert.equal(cancelActive.timeout, null, "工具执行期间只暂停生成阶段计时器");
    assert.ok(cancelActive.absoluteTimeout);
    const cancelOutcome = Promise.allSettled([cancelAnswer]);
    await cancelAgent.close();
    assert.equal((await cancelOutcome)[0].status, "rejected");
    assert.equal(dynamicQuerySignal.aborted, true);
    await nextImmediate();
    assert.equal(cancelClient.responses.some((response) => response.id === 902), false, "关闭后的迟到工具不得 respond");

    const lateProgressClient = new FakeAppServerClient();
    let lateProgressQueries = 0;
    const lateProgressAgent = isolatedAgent("late-progress-cancel", lateProgressClient, {
      queryXbb: async () => {
        lateProgressQueries += 1;
        throw new Error("query must not start after close");
      }
    });
    await lateProgressAgent.start();
    const lateProgressPrincipal = principalKeyFromUserId("late-progress-user", access);
    const lateProgressAnswer = lateProgressAgent.answer({
      question: "请做集团经营分析",
      access,
      principalKey: lateProgressPrincipal,
      messageId: "late-progress-active"
    });
    await nextImmediate();
    const lateProgressActive = lateProgressAgent.sessions.get(lateProgressPrincipal).active;
    let releaseLateProgress;
    let markLateProgressEntered;
    const lateProgressEntered = new Promise((resolve) => { markLateProgressEntered = resolve; });
    lateProgressActive.waiters[0].onProgress = async () => {
      markLateProgressEntered();
      await new Promise((resolve) => { releaseLateProgress = resolve; });
    };
    lateProgressClient.emit("serverRequest", {
      id: 903,
      method: "item/tool/call",
      params: { threadId: "thread-1", turnId: "turn-1", tool: "query_xbb", arguments: { months: ["2026-09"], domains: ["opportunities"] } }
    });
    await lateProgressEntered;
    const lateProgressOutcome = Promise.allSettled([lateProgressAnswer]);
    await lateProgressAgent.close();
    releaseLateProgress();
    assert.equal((await lateProgressOutcome)[0].status, "rejected");
    await nextImmediate();
    assert.equal(lateProgressQueries, 0, "关闭发生在进度 await 期间时不得再启动迟到查询");
    assert.equal(lateProgressClient.responses.some((response) => response.id === 903), false, "关闭后的迟到工具不得 respond");

    const floodClient = new FakeAppServerClient();
    const floodAgent = isolatedAgent("bounded-request-queue", floodClient);
    await floodAgent.start();
    const floodPrincipal = principalKeyFromUserId("flood-user", access);
    const floodPromises = [floodAgent.answer({ question: "帮我写一句通知", access, principalKey: floodPrincipal, messageId: "flood-active" })];
    await nextImmediate();
    let floodSettled = 0;
    for (let index = 0; index < 1000; index += 1) {
      const promise = floodAgent.answer({ question: `集团${(index % 9) + 1}月业绩排名`, access, principalKey: floodPrincipal, messageId: `flood-${index}` });
      promise.then(() => { floodSettled += 1; }, () => { floodSettled += 1; });
      floodPromises.push(promise);
    }
    await nextImmediate();
    const floodSession = floodAgent.sessions.get(floodPrincipal);
    assert.ok(floodSession.requestQueue.length <= 8, "单主体等待队列必须保持硬上限");
    assert.ok(floodSettled >= 990, "洪泛时较早排队请求必须由 latest-wins 有界收敛");
    assert.equal(floodClient.startTurnCalls.length, 1);
    const floodOutcomes = Promise.allSettled(floodPromises);
    await floodAgent.close();
    assert.equal((await floodOutcomes).length, 1001);

    const boundsClient = new FakeAppServerClient();
    const boundsAgent = isolatedAgent("hard-bounds", boundsClient);
    await boundsAgent.start();
    const boundsPrincipal = principalKeyFromUserId("bounds-user", access);
    await assert.rejects(
      boundsAgent.answer({ question: "问".repeat(11000), access, principalKey: boundsPrincipal, messageId: "oversized-question" }),
      /32768 字节/
    );
    assert.equal(boundsClient.startThreadCalls.length, 0);
    const boundedAnswers = [boundsAgent.answer({ question: "帮我写一句通知", access, principalKey: boundsPrincipal, messageId: "bounded-base" })];
    await nextImmediate();
    for (let index = 0; index < 40; index += 1) {
      boundsClient.emit("notification", {
        method: "item/started",
        params: { threadId: "thread-1", turnId: "turn-1", item: { type: "agentMessage", id: `stream-${index}` } }
      });
    }
    boundsClient.emit("notification", {
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "stream-0", delta: "流".repeat(100000) }
    });
    await nextImmediate();
    const boundedActive = boundsAgent.sessions.get(boundsPrincipal).active;
    assert.equal(boundedActive.messages.size, 32);
    assert.ok(Buffer.byteLength(boundedActive.messages.get("stream-0").text, "utf8") <= 64 * 1024);
    assert.ok(boundedActive.streamedMessageBytes <= 128 * 1024);
    boundsClient.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { type: "agentMessage", id: "oversized-completed", text: "终".repeat(100000), phase: "commentary" }
      }
    });
    await nextImmediate();
    assert.ok(Buffer.byteLength(boundedActive.lastText, "utf8") <= 64 * 1024);
    for (let index = 1; index <= 8; index += 1) {
      boundedAnswers.push(boundsAgent.answer({ question: `补充要求${index}`, access, principalKey: boundsPrincipal, messageId: `bounded-steer-${index}` }));
      await nextImmediate();
      assert.match((await boundedAnswers[index - 1]).answer, /最新一条消息/);
    }
    const overSteerBudget = boundsAgent.answer({ question: "补充要求9", access, principalKey: boundsPrincipal, messageId: "bounded-steer-9" });
    await nextImmediate();
    assert.equal(boundsClient.steerTurnCalls.length, 8);
    assert.equal(boundsClient.startTurnCalls.length, 1);
    boundsClient.complete("thread-1", "turn-1", JSON.stringify({ answer: "前八条补充已完成。", chart: null }));
    assert.match((await boundedAnswers.at(-1)).answer, /前八条补充/);
    await nextImmediate();
    assert.equal(boundsClient.startTurnCalls.length, 2);
    boundsClient.complete("thread-1", "turn-2", JSON.stringify({ answer: "第九条补充使用新 Turn 完成。", chart: null }));
    assert.match((await overSteerBudget).answer, /新 Turn/);
    await boundsAgent.close();

    const preciseClient = new FakeAppServerClient();
    const preciseCalls = [];
    const preciseAgent = isolatedAgent("precise-gpt6", preciseClient, {
      config: { strictDataDemand: true, codexModel: "gpt-6-astra", codexReasoningEffort: "xhigh" },
      queryXbb: async (args) => {
        preciseCalls.push(args);
        return { ...readyPerformancePack(), scope: { month: args.months[0], domains: args.domains },
          facts: { opportunities: { summary: { createdCount: 2, expectedAmount: 999, followCount: 7 }, opportunities: [{ name: "unasked-secret-sentinel" }] } } };
      }
    });
    await preciseAgent.start();
    const precisePrincipal = principalKeyFromUserId("precise-synthetic", access);
    const preciseAnswer = preciseAgent.answer({ question: "2026年9月集团创建多少商机", access, principalKey: precisePrincipal, messageId: "precise-1" });
    await waitUntil(() => preciseClient.startTurnCalls.length === 1, "精确查询应先启动模型规划");
    assert.equal(preciseCalls.length, 0, "生产禁止粗数据域预取");
    assert.equal(preciseClient.startTurnCalls[0].params.model, "gpt-6-astra");
    assert.equal(preciseClient.startTurnCalls[0].params.effort, "xhigh");
    const preciseCall = async (id, arguments_) => {
      preciseClient.emit("serverRequest", { id, method: "item/tool/call", params: { threadId: "thread-1", turnId: "turn-1", tool: "query_xbb", arguments: arguments_ } });
      await waitUntil(() => preciseClient.responses.some((response) => response.id === id), "查询响应未完成");
      return preciseClient.responses.find((response) => response.id === id).result;
    };
    const extra = await preciseCall(1001, { months: ["2026-09"], domains: ["opportunities"], metrics: ["opportunities.quality"] });
    assert.equal(extra.success, false);
    assert.equal(preciseCalls.length, 0, "拒绝读取未问的跟进质量数据");
    const exact = await preciseCall(1002, { months: ["2026-09"], domains: ["opportunities"], metrics: ["opportunities.count"] });
    assert.equal(exact.success, true);
    assert.equal(preciseCalls.length, 1);
    assert.doesNotMatch(JSON.stringify(exact), /unasked-secret-sentinel|expectedAmount|followCount/);
    preciseClient.complete("thread-1", "turn-1", JSON.stringify({ answer: "合成验证数据：创建商机 2 个。", chart: null }));
    await preciseAnswer;
    const preciseFollowup = preciseAgent.answer({ question: "图表呈现出来", access, principalKey: precisePrincipal, messageId: "precise-2" });
    await waitUntil(() => preciseClient.startTurnCalls.length === 2, "追问应继续原问题");
    assert.equal(preciseClient.startTurnCalls[1].params.threadId, "thread-2", "只继承意图，不携带旧业务事实");
    assert.match(preciseClient.startTurnCalls[1].params.input[0].text, /创建多少商机/);
    assert.doesNotMatch(preciseClient.startTurnCalls[1].params.input[0].text, /unasked-secret-sentinel|createdCount/);
    preciseClient.complete("thread-2", "turn-2", JSON.stringify({ answer: "仅有一个数量指标，不适合比较图。", chart: null }));
    await preciseFollowup;
    await preciseAgent.close();

    const intentClient = new FakeAppServerClient();
    const intentAgent = isolatedAgent("multidimensional-intent", intentClient, {
      config: { strictDataDemand: true, codexModel: "gpt-6-astra", codexReasoningEffort: "xhigh" },
      queryXbb: async () => readyPerformancePack()
    });
    await intentAgent.start();
    const intentPrincipal = principalKeyFromUserId("intent-synthetic", access);
    const intentTurn = async (question, check) => {
      const count = intentClient.startTurnCalls.length;
      const pending = intentAgent.answer({ question, access, principalKey: intentPrincipal });
      await waitUntil(() => intentClient.startTurnCalls.length > count, "经营追问未启动");
      const call = intentClient.startTurnCalls.at(-1);
      check(intentAgent.sessions.get(intentPrincipal).active, call.params.input[0].text);
      intentClient.complete(call.params.threadId, call.id, JSON.stringify({ answer: "仅验证意图续接的合成轮次。", chart: null }));
      await pending;
    };
    await intentTurn("2026年8月集团业绩怎么样？", (active) => assert.deepEqual(active.demandPlan.months, ["2026-08"]));
    await intentTurn("趋势是什么？", (active, text) => {
      assert.deepEqual(active.demandPlan.months, ["2026-08"]);
      assert.match(text, /2026年8月集团业绩/);
    });
    await intentTurn("其次哪个分公司业绩好？", (active, text) => {
      assert.deepEqual(active.demandPlan.domains, ["performance"]);
      assert.match(text, /趋势是什么/);
      assert.match(text, /2026年8月集团业绩/);
    });
    await intentTurn("另外开了多少课？", (active) => assert.deepEqual([...active.demandPlan.domains].sort(), ["courses", "performance"], "新增业务维度保留此前业绩维度"));
    await intentTurn("只看今天集团业绩多少", (active) => {
      assert.deepEqual(active.demandPlan.domains, ["performance"]);
      assert.match(active.demandPlan.date, /^\d{4}-\d{2}-\d{2}$/);
      assert.deepEqual(active.demandPlan.months, [active.demandPlan.date.slice(0, 7)]);
    });
    await intentTurn("改为2026年8月", (active) => {
      assert.equal(active.demandPlan.date, undefined, "从今日改为整月必须清除旧单日范围");
      assert.deepEqual(active.demandPlan.months, ["2026-08"]);
    });
    await intentAgent.close();

    process.stdout.write(`${JSON.stringify({ success: true, checks: 235, runtime: "persistent-steerable-general-codex-with-xbb-skill" })}\n`);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
})().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
