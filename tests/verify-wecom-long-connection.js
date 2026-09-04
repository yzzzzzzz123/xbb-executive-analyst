"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AgentTurnFailureError, AgentTurnTimeoutError } = require("../shared/codex/persistent-agent.js");
const { createLongConnectionHandler, extractQuestion, operationalFailure } = require("../shared/wecom/long-connection-handler.js");
const { DEFAULT_CONNECTION_STALL_TIMEOUT_MS, createBotService, managedConfigOptions } = require("../shared/wecom/server.js");
const { checkAuthentication } = require("../shared/wecom/check-auth.js");
const { loadConfig, loadWecomConfig, validateWebSocketEndpoint } = require("../shared/config.js");
const { createPairingCode, discoverUser } = require("../shared/wecom/discover-user.js");
const { acquireInstanceLock, releaseInstanceLock } = require("../shared/wecom/instance-lock.js");
const { ServiceLease } = require("../shared/wecom/service-lease.js");
const { createStatusWriter, safeStatus } = require("../shared/wecom/status-writer.js");

class FakeClient extends EventEmitter {
  constructor() {
    super();
    this.replies = [];
    this.connected = false;
    this.disconnected = false;
    this.uploads = [];
    this.mediaMessages = [];
  }

  connect() {
    this.connected = true;
    return this;
  }

  disconnect() {
    this.disconnected = true;
  }

  async replyStream(frame, streamId, content, finish, msgItem) {
    const reply = { reqId: frame.headers.req_id, streamId, content, finish, msgItem };
    this.replies.push(reply);
    return reply;
  }

  async uploadMedia(buffer, options) {
    this.uploads.push({ buffer, options });
    return { type: "image", media_id: "media-chart-1" };
  }

  async sendMediaMessage(target, mediaType, mediaId) {
    const message = { target, mediaType, mediaId };
    this.mediaMessages.push(message);
    return message;
  }
}

class FakeClock {
  constructor() {
    this.nextId = 1;
    this.timers = new Map();
  }

  setTimeout = (callback, delay) => {
    const id = this.nextId++;
    this.timers.set(id, { callback, delay });
    return id;
  };

  clearTimeout = (id) => {
    this.timers.delete(id);
  };

  fireAll() {
    const pending = [...this.timers.values()];
    this.timers.clear();
    for (const timer of pending) timer.callback();
  }
}

function frame(messageId, userId, msgtype, body) {
  return {
    cmd: "aibot_msg_callback",
    headers: { req_id: `req-${messageId}` },
    body: { msgid: messageId, aibotid: "aibot-test", chattype: "single", from: { userid: userId }, msgtype, ...body }
  };
}

(async () => {
  const policy = { schemaVersion: "1.0", users: { boss: { scope: "all" } } };
  let agentCalls = 0;
  const agent = {
    answer: async ({ question, access, principalKey, messageId, onProgress }) => {
      agentCalls += 1;
      assert.equal(question, "集团9月业绩排名");
      assert.equal(access.scope, "all");
      assert.match(principalKey, /^[a-f0-9]{64}$/);
      assert.equal(messageId, "msg-1");
      await onProgress("正在分析：2026年9月｜集团｜集团业绩\n数据进度：正在读取第 1/1 个月");
      await onProgress("数据已就绪：1 个月完整，并通过隐私与完整性校验\n正在分析：公司排名和收入结构");
      return {
        answer: "集团9月业绩排名已生成（MTD）。",
        chart: { type: "bar", title: "集团业绩排名", subtitle: "2026年9月｜集团", insight: "公司A业绩高于公司B", note: "", categories: ["公司A", "公司B"], series: [{ name: "业绩", values: [100, 80] }], valueFormat: "money", unit: "" }
      };
    }
  };
  let streamCounter = 0;
  const handlerStatuses = [];
  const fakeChartItem = { msgtype: "image", image: { base64: "iVBORw0KGgo=", md5: "fake-md5" } };
  const handler = createLongConnectionHandler({
    policy,
    agent,
    streamIdFactory: () => `stream-${++streamCounter}`,
    statusWriter: (value) => handlerStatuses.push(value),
    chartRenderer: async () => ({ buffer: Buffer.from("fake-png"), item: fakeChartItem })
  });
  const client = new FakeClient();

  const textFrame = frame("msg-1", "boss", "text", { text: { content: "集团9月业绩排名" } });
  await handler.handleMessage(textFrame, client);
  assert.equal(client.replies[0].finish, false);
  assert.match(client.replies[0].content, /正在识别问题范围/);
  assert.equal(client.replies.some((reply) => /第 1\/1 个月/.test(reply.content)), true);
  assert.equal(client.replies.some((reply) => /数据已就绪/.test(reply.content)), true);
  assert.equal(client.replies.some((reply) => /正在制作：排名条形图/.test(reply.content)), true);
  assert.equal(client.replies.some((reply) => /排名条形图已生成/.test(reply.content)), true);
  assert.equal(client.replies.at(-1).finish, true);
  assert.equal(client.replies.at(-1).content, "集团9月业绩排名已生成（MTD）。");
  assert.deepEqual(client.replies.at(-1).msgItem, []);
  assert.equal(client.uploads.length, 1);
  assert.deepEqual(client.uploads[0].options, { type: "image", filename: "经营分析图表.png" });
  assert.deepEqual(client.mediaMessages, [{ target: "boss", mediaType: "image", mediaId: "media-chart-1" }]);
  assert.equal(handlerStatuses.some((value) => value.status === "chart_generated"), true);
  assert.equal(handlerStatuses.some((value) => value.status === "chart_delivered"), true);
  assert.equal(agentCalls, 1);

  const firstReplyCount = client.replies.length;
  await handler.handleMessage(textFrame, client);
  assert.equal(client.replies[firstReplyCount].streamId, "stream-1");
  assert.equal(client.replies[firstReplyCount].finish, true);
  assert.deepEqual(client.replies[firstReplyCount].msgItem, [fakeChartItem], "同一 msgid 重放的经营答复也必须带图");
  assert.equal(client.mediaMessages.length, 1);
  assert.equal(agentCalls, 1);

  const fallbackStatuses = [];
  const fallbackClient = new FakeClient();
  let failedMediaSends = 0;
  fallbackClient.sendMediaMessage = async () => {
    failedMediaSends += 1;
    throw new Error("active media unavailable");
  };
  const fallbackHandler = createLongConnectionHandler({
    policy,
    agent: { answer: async () => ({ answer: "真实结论。", chart: { type: "bar", title: "集团业绩排名", subtitle: "2026年9月｜集团", insight: "公司A业绩高于公司B", note: "", categories: ["公司A", "公司B"], series: [{ name: "业绩", values: [100, 80] }], valueFormat: "money", unit: "" } }) },
    streamIdFactory: () => "stream-fallback",
    statusWriter: (value) => fallbackStatuses.push(value),
    chartRenderer: async () => ({ buffer: Buffer.from("fake-png"), item: fakeChartItem }),
    retryWait: async () => {}
  });
  await fallbackHandler.handleMessage(frame("msg-fallback", "boss", "text", { text: { content: "集团业绩" } }), fallbackClient);
  assert.deepEqual(fallbackClient.replies.at(-1).msgItem, [fakeChartItem]);
  assert.equal(failedMediaSends, 2);
  assert.equal(fallbackStatuses.some((value) => value.status === "chart_media_delivery_failed"), true);
  assert.equal(fallbackStatuses.some((value) => value.status === "chart_inline_delivered"), true);
  assert.equal(fallbackStatuses.some((value) => value.status === "chart_delivered"), true);

  const summaryClient = new FakeClient();
  let summaryRenders = 0;
  const summaryHandler = createLongConnectionHandler({
    policy,
    agent: { answer: async () => ({ answer: "事实不足以形成比较，已保留范围说明。", chart: null, routeMode: "xbb" }) },
    streamIdFactory: () => "stream-summary",
    answerRenderer: async (answer) => {
      summaryRenders += 1;
      assert.match(answer, /事实不足/);
      return { buffer: Buffer.from("safe-summary"), item: fakeChartItem };
    },
    retryWait: async () => {}
  });
  await summaryHandler.handleMessage(frame("msg-summary", "boss", "text", { text: { content: "为什么" } }), summaryClient);
  assert.equal(summaryRenders, 1, "经营追问即使 chart:null 也必须生成结论速览图");
  assert.equal(summaryClient.mediaMessages.length, 1);
  assert.equal(summaryClient.replies.at(-1).content, "事实不足以形成比较，已保留范围说明。");

  const generalClient = new FakeClient();
  const generalHandler = createLongConnectionHandler({
    policy,
    agent: { answer: async () => ({ answer: "四。", chart: null, routeMode: "general" }) },
    streamIdFactory: () => "stream-general",
    answerRenderer: async () => { throw new Error("通用问题不应生成经营图片"); }
  });
  await generalHandler.handleMessage(frame("msg-general", "boss", "text", { text: { content: "2加2等于几" } }), generalClient);
  assert.equal(generalClient.uploads.length, 0);
  assert.deepEqual(generalClient.replies.at(-1).msgItem, []);

  const degradedClient = new FakeClient();
  let chartRenderAttempts = 0;
  let answerRenderAttempts = 0;
  let uploadAttempts = 0;
  degradedClient.uploadMedia = async () => {
    uploadAttempts += 1;
    throw new Error("temporary upload failure");
  };
  const emergencyItem = { msgtype: "image", image: { base64: "emergency", md5: "safe" } };
  const degradedHandler = createLongConnectionHandler({
    policy,
    agent: { answer: async () => ({
      answer: "已验证的文字结论保留。",
      chart: { type: "bar", title: "集团业绩排名" },
      routeMode: "xbb"
    }) },
    streamIdFactory: () => "stream-degraded",
    statusWriter: () => { throw new Error("status disk unavailable"); },
    chartRenderer: async () => {
      chartRenderAttempts += 1;
      throw new Error("temporary render failure");
    },
    answerRenderer: async () => {
      answerRenderAttempts += 1;
      throw new Error("temporary summary render failure");
    },
    emergencyImageFactory: () => ({ buffer: Buffer.from("emergency-png"), item: emergencyItem }),
    retryWait: async () => {},
    renderAttempts: 2,
    transportAttempts: 3
  });
  await degradedHandler.handleMessage(frame("msg-degraded", "boss", "text", { text: { content: "集团业绩排名" } }), degradedClient);
  assert.equal(chartRenderAttempts, 2);
  assert.equal(answerRenderAttempts, 2);
  assert.equal(uploadAttempts, 3);
  assert.deepEqual(degradedClient.replies.at(-1).msgItem, [emergencyItem]);
  assert.match(degradedClient.replies.at(-1).content, /改用结论速览图/);
  assert.match(degradedClient.replies.at(-1).content, /已附安全占位图/);
  assert.equal(degradedClient.replies.at(-1).finish, true, "状态写入失败不能阻断图片和文字最终答复");

  const denied = frame("msg-2", "unknown", "text", { text: { content: "集团业绩" } });
  await handler.handleMessage(denied, client);
  assert.equal(client.replies[firstReplyCount + 1].finish, true);
  assert.match(client.replies[firstReplyCount + 1].content, /尚未获准/);
  assert.equal(agentCalls, 1);

  const image = frame("msg-3", "boss", "image", { image: { url: "https://invalid.example/image" } });
  await handler.handleMessage(image, client);
  assert.equal(client.replies[firstReplyCount + 2].finish, true);
  assert.match(client.replies[firstReplyCount + 2].content, /仅支持文字/);

  assert.equal(extractQuestion({ msgtype: "voice", voice: { content: "语音问题" } }), "语音问题");
  assert.equal(extractQuestion({ msgtype: "mixed", mixed: { msg_item: [{ msgtype: "image" }, { msgtype: "text", text: { content: "图文问题" } }] } }), "图文问题");
  assert.match(operationalFailure(new AgentTurnTimeoutError("general", 900000)), /较长推理/);
  assert.doesNotMatch(operationalFailure(new AgentTurnTimeoutError("general", 900000)), /经营分析/);
  assert.match(operationalFailure(new AgentTurnTimeoutError("xbb", 300000)), /自动恢复流程/);
  assert.match(operationalFailure(new AgentTurnFailureError("failed", "general")), /自动恢复/);
  assert.match(operationalFailure(new AgentTurnFailureError("failed", "xbb")), /看门狗恢复/);
  assert.doesNotMatch(operationalFailure(new AgentTurnFailureError("failed", "xbb")), /请稍后重试|重新发送|缩小.*主题/);
  await assert.rejects(() => handler.handleMessage({ headers: {}, body: {} }, client), /req_id/);

  const config = loadConfig({ env: {
    XBB_WECOM_BOT_ID: "aibot_test",
    XBB_WECOM_BOT_SECRET: "secret-test",
    XBB_ACCESS_POLICY_PATH: "D:\\policy.json"
  } });
  assert.equal(config.modelProvider, "codex-app-server");
  assert.equal(config.codexModel, "gpt-5.6-sol");
  assert.equal(config.codexReasoningEffort, "medium");
  assert.equal(config.agentTurnTimeoutMs, 300000);
  assert.equal(config.generalTurnTimeoutMs, 900000);
  assert.equal(config.wecomWsUrl, "wss://openws.work.weixin.qq.com/");
  assert.equal(config.wecomMaxReconnectAttempts, -1);
  assert.match(config.agentStatePath, /agent-state\.json$/);
  assert.match(config.statusLogPath, /status\.jsonl$/);
  assert.match(config.serviceLeasePath, /service-lease\.json$/);
  assert.equal(Object.hasOwn(config, "callbackPath"), false);
  const managedOptions = managedConfigOptions(["--managed-config", path.join(os.tmpdir(), "managed-bot-config.json")], {
    PATH: "managed-test-path",
    XBB_SERVICE_LEASE_PATH: "must-not-leak",
    XBB_WECOM_BOT_SECRET: "must-not-leak"
  });
  assert.equal(managedOptions.env.PATH, "managed-test-path");
  assert.equal(managedOptions.env.XBB_BOT_CONFIG_PATH, path.resolve(os.tmpdir(), "managed-bot-config.json"));
  assert.equal(Object.hasOwn(managedOptions.env, "XBB_SERVICE_LEASE_PATH"), false);
  assert.equal(Object.hasOwn(managedOptions.env, "XBB_WECOM_BOT_SECRET"), false);
  assert.throws(() => managedConfigOptions(["--unknown", "value"]), /启动参数无效/);
  assert.throws(() => validateWebSocketEndpoint("ws://public.example"), /必须使用 WSS/);
  assert.equal(validateWebSocketEndpoint("ws://127.0.0.1:9000"), "ws://127.0.0.1:9000/");
  const transportOnly = loadWecomConfig({ env: { XBB_WECOM_BOT_ID: "aibot_transport", XBB_WECOM_BOT_SECRET: "transport-secret" } });
  assert.equal(transportOnly.wecomBotId, "aibot_transport");
  assert.equal(Object.hasOwn(transportOnly, "modelEndpoint"), false);

  assert.throws(() => loadConfig({ env: {
    XBB_WECOM_BOT_ID: "aibot_external",
    XBB_WECOM_BOT_SECRET: "external-secret",
    XBB_MODEL_PROVIDER: "chat-completions",
    XBB_ACCESS_POLICY_PATH: "D:\\policy.json"
  } }), /只支持 codex-app-server/);

  let capturedOptions;
  const serviceClient = new FakeClient();
  const serviceClock = new FakeClock();
  const statuses = [];
  const leaseCalls = [];
  const serviceInstanceId = "service-generation-20260904";
  const runtime = { handleMessage: async (incoming, activeClient) => handler.handleMessage(incoming, activeClient) };
  const service = createBotService(config, runtime, {
    clientFactory: (options) => { capturedOptions = options; return serviceClient; },
    clock: serviceClock,
    connectionStallTimeoutMs: 1000,
    lease: { instanceId: serviceInstanceId, start: () => leaseCalls.push("start"), stop: () => leaseCalls.push("stop") },
    statusWriter: (status) => statuses.push(status)
  });
  service.start();
  assert.equal(serviceClient.connected, true);
  assert.equal(serviceClock.timers.size, 1);
  assert.equal(capturedOptions.botId, "aibot_test");
  assert.equal(capturedOptions.secret, "secret-test");
  assert.equal(capturedOptions.maxReconnectAttempts, -1);
  serviceClient.emit("authenticated");
  assert.equal(statuses.at(-1).status, "ready");
  assert.equal(statuses.at(-1).instanceId, serviceInstanceId);
  assert.equal(serviceClock.timers.size, 0);
  service.start();
  assert.equal(serviceClock.timers.size, 0);
  serviceClient.emit("disconnected");
  serviceClient.emit("reconnecting", 1);
  assert.equal(serviceClock.timers.size, 1);
  serviceClient.emit("authenticated");
  assert.equal(serviceClock.timers.size, 0);
  await service.stop();
  assert.equal(serviceClient.disconnected, true);
  assert.deepEqual(leaseCalls, ["start", "stop"]);

  const logFailureClient = new FakeClient();
  const logFailureClock = new FakeClock();
  const logFailureService = createBotService(config, { handleMessage: async () => {} }, {
    clientFactory: () => logFailureClient,
    clock: logFailureClock,
    connectionStallTimeoutMs: 1000,
    statusWriter: () => { throw new Error("status disk unavailable"); }
  });
  logFailureService.start();
  logFailureClient.emit("authenticated");
  assert.equal(logFailureClock.timers.size, 0);
  logFailureClient.emit("disconnected");
  assert.equal(logFailureClock.timers.size, 1);
  await logFailureService.stop();

  const connectFailureClient = new FakeClient();
  connectFailureClient.connect = () => { throw new Error("synchronous connect failure"); };
  const connectFailureExitCodes = [];
  let connectFailureClosed = 0;
  let connectFailureStopped;
  const connectFailureDone = new Promise((resolve) => { connectFailureStopped = resolve; });
  const connectFailureService = createBotService(config, {
    handleMessage: async () => {},
    close: async () => { connectFailureClosed += 1; }
  }, {
    clientFactory: () => connectFailureClient,
    statusWriter: () => {},
    exitOnFatal: true,
    exitProcess: (code) => connectFailureExitCodes.push(code),
    onStopped: () => connectFailureStopped()
  });
  connectFailureService.start();
  await connectFailureDone;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(connectFailureClient.disconnected, true);
  assert.equal(connectFailureClosed, 1);
  assert.deepEqual(connectFailureExitCodes, [1]);

  const stalledClient = new FakeClient();
  const stalledClock = new FakeClock();
  const stalledStatuses = [];
  const exitCodes = [];
  let stalledRuntimeClosed = 0;
  let stalledServiceStopped;
  const stalledStopped = new Promise((resolve) => { stalledServiceStopped = resolve; });
  const stalledService = createBotService(config, {
    handleMessage: async () => {},
    close: async () => { stalledRuntimeClosed += 1; }
  }, {
    clientFactory: () => stalledClient,
    clock: stalledClock,
    connectionStallTimeoutMs: 1000,
    statusWriter: (status) => stalledStatuses.push(status),
    exitOnFatal: true,
    exitProcess: (code) => exitCodes.push(code),
    onStopped: () => stalledServiceStopped()
  });
  stalledService.start();
  stalledClient.emit("reconnecting", 1);
  stalledClient.emit("reconnecting", 2);
  assert.equal(stalledClock.timers.size, 1);
  assert.equal([...stalledClock.timers.values()][0].delay, 1000);
  stalledClock.fireAll();
  await stalledStopped;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stalledStatuses.filter((value) => value.status === "connection_stalled").length, 1);
  assert.equal(stalledClient.disconnected, true);
  assert.equal(stalledRuntimeClosed, 1);
  assert.deepEqual(exitCodes, [1]);
  assert.equal(DEFAULT_CONNECTION_STALL_TIMEOUT_MS, 120000);

  const pairingClient = new FakeClient();
  const pairingCode = createPairingCode();
  assert.match(pairingCode, /^[A-F0-9]{12}$/);
  const pairingOutput = [];
  const discovery = discoverUser({ client: pairingClient, pairingCode, timeoutMs: 1000, output: (value) => pairingOutput.push(value) });
  pairingClient.emit("authenticated");
  pairingClient.emit("message", frame("pair-ignored", "wrong", "text", { text: { content: "无关消息" } }));
  pairingClient.emit("message", frame("pair-ok", "encrypted-userid", "text", { text: { content: `绑定 ${pairingCode}` } }));
  const discovered = await discovery;
  assert.equal(discovered.userId, "encrypted-userid");
  assert.equal(pairingClient.replies.length, 1);
  assert.equal(pairingClient.disconnected, true);
  assert.equal(pairingOutput[0].pairingPhrase, `绑定 ${pairingCode}`);

  const authClient = new FakeClient();
  const authCheck = checkAuthentication({ client: authClient, timeoutMs: 1000 });
  authClient.emit("authenticated");
  assert.deepEqual(await authCheck, { success: true, stage: "authenticated" });
  assert.equal(authClient.disconnected, true);

  const rejectedAuthClient = new FakeClient();
  const rejectedAuth = checkAuthentication({ client: rejectedAuthClient, timeoutMs: 1000 });
  rejectedAuthClient.emit("error", new Error("Authentication failed: invalid secret (code: 853000)"));
  assert.deepEqual(await rejectedAuth, { success: false, stage: "authentication", errorCode: 853000 });
  assert.deepEqual(Object.keys(safeStatus({ status: "ready", secret: "must-not-appear" })), ["at", "status", "transport"]);
  const safeReady = safeStatus({
    status: "ready",
    instanceId: "ready-generation-20260904",
    secret: "must-not-appear",
    userId: "must-not-appear",
    facts: { revenue: 100 }
  });
  assert.equal(safeReady.instanceId, "ready-generation-20260904");
  assert.deepEqual(Object.keys(safeReady), ["at", "status", "transport", "instanceId"]);
  assert.equal(Object.hasOwn(safeStatus({ status: "ready", instanceId: "unsafe/id-with-secret" }), "instanceId"), false);
  assert.equal(Object.hasOwn(safeStatus({ status: "connecting", instanceId: "ready-generation-20260904" }), "instanceId"), false);
  assert.equal(safeStatus({ status: "chart_upload_failed" }).status, "chart_upload_failed");
  assert.equal(safeStatus({ status: "chart_media_delivery_failed" }).status, "chart_media_delivery_failed");
  assert.equal(safeStatus({ status: "chart_inline_delivered" }).status, "chart_inline_delivered");
  assert.deepEqual(Object.keys(safeStatus({ status: "turn_completed", elapsedMs: 1234, userId: "must-not-appear" })), ["at", "status", "transport", "elapsedMs"]);
  assert.deepEqual(Object.keys(safeStatus({ status: "connection_stalled", elapsedMs: 120000, reason: "must-not-appear" })), ["at", "status", "transport", "elapsedMs"]);
  assert.equal(safeStatus({ status: "turn_steered", question: "must-not-appear" }).status, "turn_steered");
  assert.equal(safeStatus({ status: "turn_queued", question: "must-not-appear" }).status, "turn_queued");
  assert.equal(safeStatus({ status: "answer_recovered", reason: "must-not-appear", elapsedMs: 12 }).status, "answer_recovered");
  assert.throws(() => safeStatus({ status: "unknown" }), /未知机器人状态/);

  const statusRoot = fs.mkdtempSync(path.join(os.tmpdir(), "xbb-ready-status-test-"));
  try {
    const statusPath = path.join(statusRoot, "status.jsonl");
    const statusOutput = { write: () => {} };
    const writeStatus = createStatusWriter({ logPath: statusPath, output: statusOutput });
    writeStatus({
      status: "ready",
      instanceId: "unsafe/id-with-secret",
      secret: "credential-must-not-appear",
      userId: "user-must-not-appear",
      facts: "facts-must-not-appear"
    });
    const unsafeLine = fs.readFileSync(statusPath, "utf8");
    assert.doesNotMatch(unsafeLine, /unsafe|credential|user-must|facts-must|instanceId/);
    writeStatus({ status: "ready", instanceId: "ready-generation-20260904", secret: "credential-must-not-appear" });
    const statusLines = fs.readFileSync(statusPath, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.equal(statusLines[1].instanceId, "ready-generation-20260904");
    assert.equal(Object.hasOwn(statusLines[1], "secret"), false);
  } finally {
    fs.rmSync(statusRoot, { recursive: true, force: true });
  }

  const leaseRoot = fs.mkdtempSync(path.join(os.tmpdir(), "xbb-service-lease-test-"));
  try {
    const leasePath = path.join(leaseRoot, "service-lease.json");
    let nowMs = Date.parse("2026-09-04T08:00:00.000Z");
    let intervalCallback = null;
    const lease = new ServiceLease({
      leasePath,
      heartbeatMs: 5000,
      now: () => nowMs,
      clock: {
        setInterval: (callback) => { intervalCallback = callback; return 1; },
        clearInterval: () => { intervalCallback = null; }
      }
    });
    assert.equal(lease.start("starting"), true);
    const startingLease = JSON.parse(fs.readFileSync(leasePath, "utf8"));
    assert.equal(startingLease.state, "starting");
    assert.match(startingLease.instanceId, /^[a-f0-9-]{36}$/);
    assert.equal(startingLease.stateSinceAt, "2026-09-04T08:00:00.000Z");
    nowMs += 5000;
    intervalCallback();
    const heartbeatLease = JSON.parse(fs.readFileSync(leasePath, "utf8"));
    assert.equal(heartbeatLease.updatedAt, "2026-09-04T08:00:05.000Z");
    assert.equal(heartbeatLease.stateSinceAt, "2026-09-04T08:00:00.000Z");
    assert.equal(lease.start("running"), true);
    const runningLease = JSON.parse(fs.readFileSync(leasePath, "utf8"));
    assert.equal(runningLease.state, "running");
    assert.equal(runningLease.stateSinceAt, "2026-09-04T08:00:05.000Z");
    assert.equal(lease.stop(), true);
    assert.equal(JSON.parse(fs.readFileSync(leasePath, "utf8")).state, "stopped");
    assert.equal(intervalCallback, null);

    const blockedParent = path.join(leaseRoot, "blocked-parent");
    fs.writeFileSync(blockedParent, "not-a-directory", "utf8");
    let failedInterval = null;
    let leaseWriteErrors = 0;
    const failingLease = new ServiceLease({
      leasePath: path.join(blockedParent, "service-lease.json"),
      heartbeatMs: 5000,
      onError: () => { leaseWriteErrors += 1; },
      clock: {
        setInterval: (callback) => { failedInterval = callback; return 2; },
        clearInterval: () => { failedInterval = null; }
      }
    });
    assert.equal(failingLease.start(), false);
    assert.equal(leaseWriteErrors, 1);
    assert.equal(typeof failedInterval, "function");
    assert.equal(failingLease.stop(), false);
    assert.equal(failedInterval, null);
  } finally {
    fs.rmSync(leaseRoot, { recursive: true, force: true });
  }

  const lockEndpoint = `\\\\.\\pipe\\codex-xbb-test-${process.pid}-${Date.now()}`;
  const instanceLock = await acquireInstanceLock(lockEndpoint);
  await assert.rejects(acquireInstanceLock(lockEndpoint), /已有实例/);
  await releaseInstanceLock(instanceLock);
  const reacquiredLock = await acquireInstanceLock(lockEndpoint);
  await releaseInstanceLock(reacquiredLock);

  const installer = fs.readFileSync(path.resolve(__dirname, "..", "scripts", "install-wecom-task.ps1"), "utf8");
  assert.match(installer, /RepetitionInterval/);
  assert.match(installer, /-MultipleInstances IgnoreNew/);
  assert.match(installer, /-RestartCount 3/);
  assert.match(installer, /watchdog-wecom-task\.ps1/);
  assert.match(installer, /external-lease-watchdog/);
  assert.match(installer, /--managed-config/);
  assert.match(installer, /Disable-ScheduledTask/);
  assert.match(installer, /authenticated = \$true/);
  assert.match(installer, /System32\\WindowsPowerShell\\v1\.0\\powershell\.exe/);
  const watchdog = fs.readFileSync(path.resolve(__dirname, "..", "scripts", "watchdog-wecom-task.ps1"), "utf8");
  assert.match(watchdog, /stateSinceAt/);
  assert.match(watchdog, /pidAlive/);
  assert.match(watchdog, /futureSkewSeconds/);
  assert.doesNotMatch(watchdog, /Get-ScheduledTaskInfo|\.LastRunTime/);
  assert.match(watchdog, /Disable-ScheduledTask/);
  assert.match(watchdog, /Stop-ScheduledTask/);
  assert.match(watchdog, /Start-ScheduledTask/);

  process.stdout.write(`${JSON.stringify({ success: true, checks: 109 })}\n`);
})().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
