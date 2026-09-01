"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { AgentBusyError } = require("../shared/codex/persistent-agent.js");
const { createLongConnectionHandler, extractQuestion, operationalFailure } = require("../shared/wecom/long-connection-handler.js");
const { createBotService } = require("../shared/wecom/server.js");
const { checkAuthentication } = require("../shared/wecom/check-auth.js");
const { loadConfig, loadWecomConfig, validateWebSocketEndpoint } = require("../shared/config.js");
const { createPairingCode, discoverUser } = require("../shared/wecom/discover-user.js");
const { safeStatus } = require("../shared/wecom/status-writer.js");

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
      await onProgress("正在查询销帮帮实时只读数据，请稍候……");
      return {
        answer: "集团9月业绩排名已生成（MTD）。",
        chart: { type: "bar", title: "集团业绩排名", categories: ["公司A"], series: [{ name: "业绩", values: [100] }], valueFormat: "money" }
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
  assert.deepEqual(client.replies.map((reply) => reply.finish), [false, false, true]);
  assert.match(client.replies[0].content, /正在查询/);
  assert.match(client.replies[1].content, /正在查询销帮帮实时只读数据/);
  assert.equal(client.replies[2].content, "集团9月业绩排名已生成（MTD）。");
  assert.deepEqual(client.replies[2].msgItem, []);
  assert.equal(client.uploads.length, 1);
  assert.deepEqual(client.uploads[0].options, { type: "image", filename: "经营分析图表.png" });
  assert.deepEqual(client.mediaMessages, [{ target: "boss", mediaType: "image", mediaId: "media-chart-1" }]);
  assert.equal(handlerStatuses.some((value) => value.status === "chart_generated"), true);
  assert.equal(handlerStatuses.some((value) => value.status === "chart_delivered"), true);
  assert.equal(agentCalls, 1);

  await handler.handleMessage(textFrame, client);
  assert.equal(client.replies[3].streamId, "stream-1");
  assert.equal(client.replies[3].finish, true);
  assert.deepEqual(client.replies[3].msgItem, []);
  assert.equal(client.mediaMessages.length, 1);
  assert.equal(agentCalls, 1);

  const fallbackStatuses = [];
  const fallbackClient = new FakeClient();
  fallbackClient.sendMediaMessage = async () => { throw new Error("active media unavailable"); };
  const fallbackHandler = createLongConnectionHandler({
    policy,
    agent: { answer: async () => ({ answer: "真实结论。", chart: { type: "bar" } }) },
    streamIdFactory: () => "stream-fallback",
    statusWriter: (value) => fallbackStatuses.push(value),
    chartRenderer: async () => ({ buffer: Buffer.from("fake-png"), item: fakeChartItem })
  });
  await fallbackHandler.handleMessage(frame("msg-fallback", "boss", "text", { text: { content: "集团业绩" } }), fallbackClient);
  assert.deepEqual(fallbackClient.replies.at(-1).msgItem, [fakeChartItem]);
  assert.equal(fallbackStatuses.some((value) => value.status === "chart_delivered"), true);

  const denied = frame("msg-2", "unknown", "text", { text: { content: "集团业绩" } });
  await handler.handleMessage(denied, client);
  assert.equal(client.replies[4].finish, true);
  assert.match(client.replies[4].content, /尚未获准/);
  assert.equal(agentCalls, 1);

  const image = frame("msg-3", "boss", "image", { image: { url: "https://invalid.example/image" } });
  await handler.handleMessage(image, client);
  assert.equal(client.replies[5].finish, true);
  assert.match(client.replies[5].content, /仅支持文字/);

  assert.equal(extractQuestion({ msgtype: "voice", voice: { content: "语音问题" } }), "语音问题");
  assert.equal(extractQuestion({ msgtype: "mixed", mixed: { msg_item: [{ msgtype: "image" }, { msgtype: "text", text: { content: "图文问题" } }] } }), "图文问题");
  assert.match(operationalFailure(new AgentBusyError()), /没有合并到当前任务/);
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
  assert.equal(config.wecomWsUrl, "wss://openws.work.weixin.qq.com/");
  assert.equal(config.wecomMaxReconnectAttempts, -1);
  assert.match(config.agentStatePath, /agent-state\.json$/);
  assert.match(config.statusLogPath, /status\.jsonl$/);
  assert.equal(Object.hasOwn(config, "callbackPath"), false);
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
  const statuses = [];
  const runtime = { handleMessage: async (incoming, activeClient) => handler.handleMessage(incoming, activeClient) };
  const service = createBotService(config, runtime, {
    clientFactory: (options) => { capturedOptions = options; return serviceClient; },
    statusWriter: (status) => statuses.push(status)
  });
  service.start();
  assert.equal(serviceClient.connected, true);
  assert.equal(capturedOptions.botId, "aibot_test");
  assert.equal(capturedOptions.secret, "secret-test");
  assert.equal(capturedOptions.maxReconnectAttempts, -1);
  serviceClient.emit("authenticated");
  assert.equal(statuses.at(-1).status, "ready");
  await service.stop();
  assert.equal(serviceClient.disconnected, true);

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
  assert.deepEqual(Object.keys(safeStatus({ status: "turn_completed", elapsedMs: 1234, userId: "must-not-appear" })), ["at", "status", "transport", "elapsedMs"]);
  assert.throws(() => safeStatus({ status: "unknown" }), /未知机器人状态/);

  process.stdout.write(`${JSON.stringify({ success: true, checks: 61 })}\n`);
})().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
