"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AgentTurnFailureError, AgentTurnTimeoutError } = require("../shared/codex/persistent-agent.js");
const {
  XBB_FOLLOW_UP_HANDOFF_ANSWER,
  createLongConnectionHandler,
  extractQuestion,
  isXbbOperationalHandoff,
  operationalFailure
} = require("../shared/wecom/long-connection-handler.js");
const {
  DEFAULT_CONNECTION_STALL_TIMEOUT_MS,
  buildRuntime,
  createBotService,
  managedConfigOptions,
  runEntrypoint,
  runMain,
  startBotLifecycle
} = require("../shared/wecom/server.js");
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
  assert.equal(client.replies.some((reply) => /集团9月业绩排名已生成（MTD）。/.test(reply.content) && reply.finish === false), true, "完整结论必须在图表交付前可读");
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
  assert.equal(failedMediaSends, 1, "默认不叠加 SDK 内部重试；失败后走内嵌图片");
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
  assert.equal(summaryRenders, 0, "无图表时不能生成文字图片");
  assert.equal(summaryClient.mediaMessages.length, 0);
  assert.equal(summaryClient.replies.at(-1).content, "事实不足以形成比较，已保留范围说明。");

  const schemaClient = new FakeClient();
  let schemaSummaryRenders = 0;
  const schemaHandler = createLongConnectionHandler({
    policy,
    agent: {
      answer: async ({ question }) => {
        assert.equal(question, "text_63 是什么字段？");
        return { answer: "字段说明已生成。", chart: null };
      }
    },
    streamIdFactory: () => "stream-schema",
    answerRenderer: async () => {
      schemaSummaryRenders += 1;
      return { buffer: Buffer.from("schema-summary"), item: fakeChartItem };
    }
  });
  await schemaHandler.handleMessage(frame("msg-schema", "boss", "text", { text: { content: "text_63 是什么字段？" } }), schemaClient);
  assert.equal(schemaSummaryRenders, 0, "纯字段说明不生成文字图片");
  assert.equal(schemaClient.mediaMessages.length, 0);
  assert.equal(schemaClient.replies.at(-1).content, "字段说明已生成。");

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
  assert.equal(answerRenderAttempts, 0);
  assert.equal(uploadAttempts, 0);
  assert.deepEqual(degradedClient.replies.at(-1).msgItem, []);
  assert.match(degradedClient.replies.at(-1).content, /图表暂未生成/);
  assert.doesNotMatch(degradedClient.replies.at(-1).content, /速览|占位/);
  assert.equal(degradedClient.replies.at(-1).finish, true, "状态写入失败不能阻断图片和文字最终答复");

  const denied = frame("msg-2", "unknown", "text", { text: { content: "集团业绩" } });
  await handler.handleMessage(denied, client);
  assert.equal(client.replies.at(-1).finish, true);
  assert.match(client.replies.at(-1).content, /尚未获准/);
  assert.deepEqual(client.replies.at(-1).msgItem, [], "未授权拒绝仅回复文字");
  const deniedContinue = frame("msg-2-continue", "unknown", "text", { text: { content: "继续" } });
  await handler.handleMessage(deniedContinue, client);
  assert.equal(client.replies.at(-1).finish, true);
  assert.match(client.replies.at(-1).content, /尚未获准/);
  assert.deepEqual(client.replies.at(-1).msgItem, [], "拒绝后的省略追问不能生成状态图片");
  assert.equal(agentCalls, 1);

  const openClient = new FakeClient();
  const openPrincipals = new Map();
  const openHandler = createLongConnectionHandler({
    policy: { schemaVersion: "1.0", users: { "*": { scope: "all" } } },
    agent: {
      answer: async ({ access, principalKey }) => {
        openPrincipals.set(access.userId, principalKey);
        return { answer: "可以使用。", chart: null, routeMode: "general" };
      }
    },
    streamIdFactory: () => `stream-open-${openPrincipals.size + 1}`,
    emergencyImageFactory: () => ({ buffer: Buffer.from("emergency-png"), item: emergencyItem })
  });
  await openHandler.handleMessage(frame("msg-open-a", "employee-a", "text", { text: { content: "你好" } }), openClient);
  await openHandler.handleMessage(frame("msg-open-b", "employee-b", "text", { text: { content: "你好" } }), openClient);
  assert.equal(openClient.replies.at(-1).content, "可以使用。");
  assert.equal(openPrincipals.size, 2, "显式通配策略应允许机器人可触达范围内的其他用户");
  assert.notEqual(openPrincipals.get("employee-a"), openPrincipals.get("employee-b"), "通配授权用户仍须使用隔离主体");

  const image = frame("msg-3", "boss", "image", { image: { url: "https://invalid.example/image" } });
  await handler.handleMessage(image, client);
  assert.equal(client.replies.at(-1).finish, true);
  assert.match(client.replies.at(-1).content, /仅支持文字/);

  assert.equal(extractQuestion({ msgtype: "voice", voice: { content: "语音问题" } }), "语音问题");
  assert.equal(extractQuestion({ msgtype: "mixed", mixed: { msg_item: [{ msgtype: "image" }, { msgtype: "text", text: { content: "图文问题" } }] } }), "图文问题");
  assert.match(operationalFailure(new AgentTurnTimeoutError("general", 900000)), /较长推理/);
  assert.doesNotMatch(operationalFailure(new AgentTurnTimeoutError("general", 900000)), /经营分析/);
  assert.match(operationalFailure(new AgentTurnTimeoutError("xbb", 300000)), /自动恢复流程/);
  assert.match(operationalFailure(new AgentTurnFailureError("failed", "general")), /自动恢复/);
  assert.match(operationalFailure(new AgentTurnFailureError("failed", "xbb")), /看门狗恢复/);
  assert.doesNotMatch(operationalFailure(new AgentTurnFailureError("failed", "xbb")), /请稍后重试|重新发送|缩小.*主题/);
  const loginError = new AgentTurnFailureError("private upstream token details", "general", { modelErrorCode: "unauthorized" });
  assert.match(operationalFailure(loginError), /登录已失效/);
  assert.doesNotMatch(operationalFailure(loginError), /private|自动恢复|较长推理/);
  assert.match(operationalFailure(new AgentTurnFailureError("private", "general", { modelErrorCode: "connection_failed" })), /网络和代理/);
  const loginClient = new FakeClient();
  const loginHandler = createLongConnectionHandler({ policy, agent: {
    answer: async ({ onProgress }) => {
      onProgress("模型服务连接暂时异常，正在自动重试……");
      throw loginError;
    }
  } });
  await loginHandler.handleMessage(frame("login-error", "boss", "text", { text: { content: "你好" } }), loginClient);
  assert.equal(loginClient.replies.at(-1).finish, true, "登录失效必须结束流式等待");
  assert.match(loginClient.replies.at(-1).content, /登录已失效/);
  assert.doesNotMatch(loginClient.replies.at(-1).content, /private|正在组织|当前阶段仍在继续/);
  assert.equal(loginClient.uploads.length, 0, "通用问题失败不得查询经营或制作经营图");
  assert.equal(isXbbOperationalHandoff({ answer: XBB_FOLLOW_UP_HANDOFF_ANSWER, chart: null, routeMode: "xbb" }), true);
  assert.equal(isXbbOperationalHandoff({ answer: XBB_FOLLOW_UP_HANDOFF_ANSWER, chart: null, routeMode: "general" }), false);
  assert.equal(isXbbOperationalHandoff({ answer: "正常最终经营答复", chart: null, routeMode: "xbb" }), false);
  await assert.rejects(() => handler.handleMessage({ headers: {}, body: {} }, client), /req_id/);

  const config = loadConfig({ env: {
    XBB_WECOM_BOT_ID: "aibot_test",
    XBB_WECOM_BOT_SECRET: "secret-test",
    XBB_ACCESS_POLICY_PATH: "D:\\policy.json"
  } });
  assert.equal(config.modelProvider, "codex-app-server");
  assert.equal(config.codexModel, "gpt-6-astra");
  assert.equal(config.codexReasoningEffort, "xhigh");
  assert.equal(config.modelDrivenQueries, true);
  assert.equal(config.agentTurnTimeoutMs, 300000);
  assert.equal(config.generalTurnTimeoutMs, 900000);
  assert.equal(config.wecomWsUrl, "wss://openws.work.weixin.qq.com/");
  assert.equal(config.wecomMaxReconnectAttempts, -1);
  assert.match(config.agentStatePath, /agent-state\.json$/);
  assert.match(config.statusLogPath, /status\.jsonl$/);
  assert.match(config.serviceLeasePath, /service-lease\.json$/);
  assert.equal(Object.hasOwn(config, "callbackPath"), false);
  const proxyConfig = loadConfig({ env: {
    XBB_WECOM_BOT_ID: "aibot_proxy_test", XBB_WECOM_BOT_SECRET: "secret-test",
    XBB_CODEX_PROXY_URL: "http://127.0.0.1:18080"
  } });
  assert.equal(proxyConfig.codexProxyUrl, "http://127.0.0.1:18080");
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
  const noRunnerIsolationRecovery = async () => ({ status: "recovered", markersRecovered: 0, processesTerminated: 0 });

  assert.throws(() => loadConfig({ env: {
    XBB_WECOM_BOT_ID: "aibot_external",
    XBB_WECOM_BOT_SECRET: "external-secret",
    XBB_MODEL_PROVIDER: "chat-completions",
    XBB_ACCESS_POLICY_PATH: "D:\\policy.json"
  } }), /只支持 codex-app-server/);

  const earlyFatalAgent = new EventEmitter();
  let earlyFatalClosed = 0;
  earlyFatalAgent.start = async () => {};
  earlyFatalAgent.warm = async () => {};
  earlyFatalAgent.close = async () => { earlyFatalClosed += 1; };
  const earlyFatalRuntime = await buildRuntime(config, {
    agent: earlyFatalAgent,
    policy,
    handlerFactory: () => ({ handleMessage: async () => {} })
  });
  earlyFatalAgent.emit("fatal", { message: "runtime 返回后、Bot Service 订阅前 App Server 已退出" });
  let replayedFatal = null;
  earlyFatalRuntime.onFatal((event) => { replayedFatal = event; });
  assert.equal(replayedFatal?.message, "runtime 返回后、Bot Service 订阅前 App Server 已退出", "fatal 早于 Bot Service 订阅时必须立即回放");
  const earlyFatalClient = new FakeClient();
  const earlyFatalExitCodes = [];
  let earlyFatalStopped;
  const earlyFatalDone = new Promise((resolve) => { earlyFatalStopped = resolve; });
  createBotService(config, earlyFatalRuntime, {
    clientFactory: () => earlyFatalClient,
    statusWriter: () => {},
    exitOnFatal: true,
    exitProcess: (code) => earlyFatalExitCodes.push(code),
    onStopped: earlyFatalStopped
  });
  await earlyFatalDone;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(earlyFatalClient.disconnected, true);
  assert.deepEqual(earlyFatalExitCodes, [1], "晚订阅的 Bot Service 必须在清理后触发重启退出");
  await earlyFatalRuntime.close();
  await earlyFatalRuntime.close();
  assert.equal(earlyFatalClosed, 1, "runtime.close 必须幂等");

  const hangingStartClock = new FakeClock();
  const hangingStartFatalAgent = new EventEmitter();
  let hangingStartCloseCalls = 0;
  hangingStartFatalAgent.start = () => {
    hangingStartFatalAgent.emit("fatal", { message: "start 挂起期间发生致命故障" });
    return new Promise(() => {});
  };
  hangingStartFatalAgent.close = () => {
    hangingStartCloseCalls += 1;
    return new Promise(() => {});
  };
  const hangingStartRuntime = buildRuntime(config, {
    agent: hangingStartFatalAgent,
    policy,
    clock: hangingStartClock,
    cleanupTimeoutMs: 10,
    handlerFactory: () => ({ handleMessage: async () => {} })
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(hangingStartCloseCalls, 1, "start 未 settle 时 fatal 也必须立刻进入清理");
  assert.equal([...hangingStartClock.timers.values()].some((timer) => timer.delay === 10), true);
  hangingStartClock.fireAll();
  await assert.rejects(hangingStartRuntime, /start 挂起期间发生致命故障/);

  const startFailureAgent = new EventEmitter();
  let startFailureClosed = 0;
  startFailureAgent.start = async () => { throw new Error("agent start failed"); };
  startFailureAgent.close = async () => { startFailureClosed += 1; };
  await assert.rejects(buildRuntime(config, {
    agent: startFailureAgent,
    policy,
    handlerFactory: () => ({ handleMessage: async () => {} })
  }), /agent start failed/);
  assert.equal(startFailureClosed, 1, "agent.start 失败也必须关闭 App Server 资源");

  const warmFailureAgent = new EventEmitter();
  const warmFailureEvents = [];
  warmFailureAgent.start = async () => { warmFailureEvents.push("start"); };
  warmFailureAgent.warm = async () => { warmFailureEvents.push("warm"); throw new Error("agent warm failed"); };
  warmFailureAgent.close = async () => { warmFailureEvents.push("close"); };
  await assert.rejects(buildRuntime(config, {
    agent: warmFailureAgent,
    policy,
    statusWriter: (value) => warmFailureEvents.push(value.status),
    handlerFactory: () => ({ handleMessage: async () => {} })
  }), /agent warm failed/);
  assert.deepEqual(warmFailureEvents, ["start", "warm", "agent_warm_failed", "close"]);

  const handlerFailureAgent = new EventEmitter();
  let handlerFailureClosed = 0;
  handlerFailureAgent.start = async () => {};
  handlerFailureAgent.warm = async () => {};
  handlerFailureAgent.close = async () => { handlerFailureClosed += 1; };
  await assert.rejects(buildRuntime(config, {
    agent: handlerFailureAgent,
    policy,
    handlerFactory: () => { throw new Error("handler construction failed"); }
  }), /handler construction failed/);
  assert.equal(handlerFailureClosed, 1, "消息处理器构建失败必须关闭 Agent/App Server");

  const constructionEvents = [];
  const constructionLease = {
    start: (state) => { constructionEvents.push(`lease:${state}`); return true; },
    stop: () => { constructionEvents.push("lease:stop"); }
  };
  const constructionErrorOutput = [];
  await runEntrypoint({
    main: () => startBotLifecycle(config, {
      statusWriter: () => {},
      lease: constructionLease,
      acquireLock: async () => { constructionEvents.push("lock:acquire"); return { id: "test-lock" }; },
      releaseLock: async (lock) => { assert.equal(lock.id, "test-lock"); constructionEvents.push("lock:release"); },
      runnerIsolationRecovery: async () => { constructionEvents.push("isolation:recover"); return noRunnerIsolationRecovery(); },
      runtimeFactory: async () => {
        constructionEvents.push("runtime:create");
        return { handleMessage: async () => {}, close: async () => { constructionEvents.push("runtime:close"); } };
      },
      serviceFactory: () => {
        constructionEvents.push("service:create");
        throw new Error("service construction failed");
      }
    }),
    output: { write: (text) => constructionErrorOutput.push(text) },
    exitProcess: (code) => { constructionEvents.push(`exit:${code}`); }
  });
  assert.deepEqual(constructionEvents, [
    "lock:acquire",
    "lease:starting",
    "isolation:recover",
    "runtime:create",
    "service:create",
    "runtime:close",
    "lease:stop",
    "lock:release",
    "exit:1"
  ], "Service 构造失败时必须完成 runtime/lease/lock 清理后再硬退出");
  assert.deepEqual(constructionErrorOutput, ["service construction failed\n"]);

  const lateStartupClock = new FakeClock();
  const lateStartupEvents = [];
  let releaseLateRuntime;
  const lateRuntime = {
    handleMessage: async () => {},
    close: async () => { lateStartupEvents.push("runtime:close"); }
  };
  const lateStartupRun = runEntrypoint({
    startupTimeoutMs: 25,
    clock: lateStartupClock,
    main: ({ signal, clock }) => startBotLifecycle(config, {
      signal,
      clock,
      cleanupTimeoutMs: 10,
      statusWriter: () => {},
      lease: {
        start: (state) => { lateStartupEvents.push(`lease:${state}`); return true; },
        stop: () => { lateStartupEvents.push("lease:stop"); }
      },
      acquireLock: async () => { lateStartupEvents.push("lock:acquire"); return { id: "late-lock" }; },
      releaseLock: async () => { lateStartupEvents.push("lock:release"); },
      runnerIsolationRecovery: async () => { lateStartupEvents.push("isolation:recover"); },
      runtimeFactory: () => {
        lateStartupEvents.push("runtime:create");
        return new Promise((resolve) => { releaseLateRuntime = () => resolve(lateRuntime); });
      },
      serviceFactory: () => {
        lateStartupEvents.push("service:create");
        return { start: () => lateStartupEvents.push("service:start"), stop: async () => {} };
      }
    }),
    output: { write: (text) => lateStartupEvents.push(`error:${text.trim()}`) },
    exitProcess: (code) => lateStartupEvents.push(`exit:${code}`)
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof releaseLateRuntime, "function");
  assert.equal([...lateStartupClock.timers.values()].some((timer) => timer.delay === 25), true);
  lateStartupClock.fireAll();
  await lateStartupRun;
  assert.equal(lateStartupEvents.includes("exit:1"), true);
  releaseLateRuntime();
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lateStartupEvents.includes("runtime:close"), true, "启动超时后迟到 runtime 必须回收");
  assert.equal(lateStartupEvents.includes("lease:stop"), true);
  assert.equal(lateStartupEvents.includes("lock:release"), true);
  assert.equal(lateStartupEvents.includes("service:create"), false, "启动超时后的迟到 runtime 不得创建 Bot Service");
  assert.equal(lateStartupEvents.includes("service:start"), false, "启动超时后的迟到 runtime 不得复活 running/ready");

  const entrypointExitCodes = [];
  await runEntrypoint({
    main: async ({ exitProcess }) => {
      exitProcess(1);
      exitProcess(0);
      return { service: { stop: async () => {} } };
    },
    output: { write: () => {} },
    exitProcess: (code) => entrypointExitCodes.push(code)
  });
  assert.deepEqual(entrypointExitCodes, [1], "runEntrypoint 注入的退出闩锁必须全程幂等");

  const gracefulSignalProcess = new EventEmitter();
  const gracefulSignalExitCodes = [];
  let gracefulSignalStops = 0;
  let gracefulLifecycleExit;
  await runMain({
    config,
    processObject: gracefulSignalProcess,
    statusWriter: () => {},
    lease: {},
    lifecycleFactory: async (_config, lifecycleOptions) => {
      gracefulLifecycleExit = lifecycleOptions.exitProcess;
      return { service: { stop: async () => { gracefulSignalStops += 1; } } };
    },
    exitProcess: (code) => gracefulSignalExitCodes.push(code)
  });
  gracefulSignalProcess.emit("SIGTERM");
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof gracefulLifecycleExit, "function", "退出函数必须传入运行期 service 生命周期");
  assert.equal(gracefulSignalStops, 1);
  assert.deepEqual(gracefulSignalExitCodes, [0], "信号清理成功后必须确定性正常退出");

  const failedSignalProcess = new EventEmitter();
  const failedSignalExitCodes = [];
  await runMain({
    config,
    processObject: failedSignalProcess,
    statusWriter: () => {},
    lease: {},
    lifecycleFactory: async () => ({ service: { stop: async () => { throw new Error("signal cleanup failed"); } } }),
    exitProcess: (code) => failedSignalExitCodes.push(code)
  });
  failedSignalProcess.emit("SIGINT");
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(failedSignalExitCodes, [1], "信号清理失败后必须确定性异常退出且不得产生未处理拒绝");

  const racingSignalProcess = new EventEmitter();
  const racingSignalExitCodes = [];
  let runtimeExit;
  let finishRacingStop;
  await runMain({
    config,
    processObject: racingSignalProcess,
    statusWriter: () => {},
    lease: {},
    lifecycleFactory: async (_config, lifecycleOptions) => {
      runtimeExit = lifecycleOptions.exitProcess;
      return { service: { stop: () => new Promise((resolve) => { finishRacingStop = resolve; }) } };
    },
    exitProcess: (code) => racingSignalExitCodes.push(code)
  });
  racingSignalProcess.emit("SIGTERM");
  await new Promise((resolve) => setImmediate(resolve));
  runtimeExit(1);
  finishRacingStop();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(racingSignalExitCodes, [1], "运行期 fatal 与信号清理竞态只能请求一次退出");

  const isolationStartupEvents = [];
  await assert.rejects(startBotLifecycle(config, {
    statusWriter: () => {},
    lease: {
      start: (state) => { isolationStartupEvents.push(`lease:${state}`); return true; },
      stop: () => { isolationStartupEvents.push("lease:stop"); }
    },
    acquireLock: async () => { isolationStartupEvents.push("lock:acquire"); return { id: "isolation-lock" }; },
    releaseLock: async () => { isolationStartupEvents.push("lock:release"); },
    runnerIsolationRecovery: async () => { isolationStartupEvents.push("isolation:recover"); throw new Error("isolation uncertain"); },
    runtimeFactory: async () => { isolationStartupEvents.push("runtime:create"); throw new Error("must not run"); }
  }), /isolation uncertain/);
  assert.deepEqual(isolationStartupEvents, [
    "lock:acquire", "lease:starting", "isolation:recover", "lease:stop", "lock:release"
  ], "跨代 runner 状态不确定时必须在 buildRuntime 前失败关闭并完整释放生命周期资源");

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

  const disconnectFailureClient = new FakeClient();
  disconnectFailureClient.disconnect = () => { throw new Error("disconnect failed"); };
  let disconnectFailureRuntimeClosed = 0;
  const disconnectFailureService = createBotService(config, {
    handleMessage: async () => {},
    close: async () => { disconnectFailureRuntimeClosed += 1; }
  }, {
    clientFactory: () => disconnectFailureClient,
    statusWriter: () => {}
  });
  await disconnectFailureService.stop();
  assert.equal(disconnectFailureRuntimeClosed, 1, "SDK disconnect 失败不能跳过 Agent/App Server 关闭");

  const stoppedEventClient = new FakeClient();
  let rejectLateConnect;
  stoppedEventClient.connect = () => new Promise((_, reject) => { rejectLateConnect = reject; });
  let emitLateFatal;
  let stoppedMessageCalls = 0;
  const stoppedEventStatuses = [];
  const stoppedEventExitCodes = [];
  const stoppedEventService = createBotService(config, {
    handleMessage: async () => { stoppedMessageCalls += 1; },
    onFatal: (listener) => { emitLateFatal = listener; },
    close: async () => {}
  }, {
    clientFactory: () => stoppedEventClient,
    statusWriter: (status) => stoppedEventStatuses.push(status.status),
    exitOnFatal: true,
    exitProcess: (code) => stoppedEventExitCodes.push(code)
  });
  stoppedEventService.start();
  await new Promise((resolve) => setImmediate(resolve));
  await stoppedEventService.stop();
  rejectLateConnect(new Error("connect rejected after normal stop"));
  emitLateFatal({ message: "fatal emitted after normal stop" });
  stoppedEventClient.emit("message", frame("late-after-stop", "boss", "text", { text: { content: "集团业绩" } }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stoppedMessageCalls, 0, "stop 后迟到消息不得重新进入已关闭 runtime");
  assert.deepEqual(stoppedEventExitCodes, [], "stop 后迟到 connect/fatal 不得把正常关闭升级为异常退出");
  assert.equal(stoppedEventStatuses.includes("agent_failed"), false);
  assert.equal(stoppedEventStatuses.includes("connection_error"), false);

  const fatalCleanupClock = new FakeClock();
  const fatalCleanupClient = new FakeClient();
  const fatalCleanupExitCodes = [];
  const fatalCleanupLeaseCalls = [];
  let triggerFatalCleanup;
  let fatalCleanupRuntimeCloseCalls = 0;
  let fatalCleanupReleaseCalls = 0;
  const fatalCleanupService = createBotService(config, {
    handleMessage: async () => {},
    onFatal: (listener) => { triggerFatalCleanup = listener; },
    close: () => {
      fatalCleanupRuntimeCloseCalls += 1;
      return new Promise(() => {});
    }
  }, {
    clientFactory: () => fatalCleanupClient,
    clock: fatalCleanupClock,
    cleanupTimeoutMs: 10,
    fatalExitTimeoutMs: 10,
    exitOnFatal: true,
    exitProcess: (code) => fatalCleanupExitCodes.push(code),
    lease: { stop: () => fatalCleanupLeaseCalls.push("stop") },
    statusWriter: () => {},
    onStopped: () => {
      fatalCleanupReleaseCalls += 1;
      return new Promise(() => {});
    }
  });
  triggerFatalCleanup({ message: "fatal cleanup test" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fatalCleanupRuntimeCloseCalls, 1);
  assert.equal([...fatalCleanupClock.timers.values()].filter((timer) => timer.delay === 10).length >= 2, true);
  fatalCleanupClock.fireAll();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(fatalCleanupExitCodes, [1], "runtime 清理挂死仍须在 fatal 10 秒截止触发一次硬退出");
  assert.deepEqual(fatalCleanupLeaseCalls, ["stop"]);
  assert.equal(fatalCleanupReleaseCalls, 1);
  fatalCleanupClock.fireAll();
  await assert.rejects(fatalCleanupService.stop(), /实例锁释放超过硬截止/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(fatalCleanupExitCodes, [1], "迟到清理完成路径不得重复退出");

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
  const safeModelFailure = safeStatus({ status: "turn_failed", modelErrorCode: "unauthorized", error: "private token", message: "private body" });
  assert.equal(safeModelFailure.modelErrorCode, "unauthorized");
  assert.doesNotMatch(JSON.stringify(safeModelFailure), /private/);
  assert.equal(Object.hasOwn(safeStatus({ status: "turn_failed", modelErrorCode: "private token" }), "modelErrorCode"), false);
  assert.equal(safeStatus({ status: "model_retrying", modelErrorCode: "connection_failed" }).modelErrorCode, "connection_failed");
  assert.equal(safeStatus({ status: "model_responding" }).status, "model_responding");
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
    assert.equal(lease.start("running"), false, "租约 stop 后必须保持终止态，迟到启动不得复活");
    assert.equal(lease.state, "stopped");
    assert.equal(intervalCallback, null);
    assert.equal(JSON.parse(fs.readFileSync(leasePath, "utf8")).state, "stopped");

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

  process.stdout.write(`${JSON.stringify({ success: true, checks: 119 })}\n`);
})().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
