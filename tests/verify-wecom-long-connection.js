"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createLongConnectionHandler, extractQuestion } = require("../shared/wecom/long-connection-handler.js");
const { createBotService } = require("../shared/wecom/server.js");
const { loadConfig, loadWecomConfig, validateWebSocketEndpoint } = require("../shared/config.js");
const { createPairingCode, discoverUser } = require("../shared/wecom/discover-user.js");

class FakeClient extends EventEmitter {
  constructor() {
    super();
    this.replies = [];
    this.connected = false;
    this.disconnected = false;
  }

  connect() {
    this.connected = true;
    return this;
  }

  disconnect() {
    this.disconnected = true;
  }

  async replyStream(frame, streamId, content, finish) {
    const reply = { reqId: frame.headers.req_id, streamId, content, finish };
    this.replies.push(reply);
    return reply;
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
    answer: async ({ question, access }) => {
      agentCalls += 1;
      assert.equal(question, "集团9月业绩排名");
      assert.equal(access.scope, "all");
      return "集团9月业绩排名已生成（MTD）。";
    }
  };
  let streamCounter = 0;
  const handler = createLongConnectionHandler({ policy, agent, streamIdFactory: () => `stream-${++streamCounter}` });
  const client = new FakeClient();

  const textFrame = frame("msg-1", "boss", "text", { text: { content: "集团9月业绩排名" } });
  await handler.handleMessage(textFrame, client);
  assert.deepEqual(client.replies.map((reply) => reply.finish), [false, true]);
  assert.match(client.replies[0].content, /正在查询/);
  assert.equal(client.replies[1].content, "集团9月业绩排名已生成（MTD）。");
  assert.equal(agentCalls, 1);

  await handler.handleMessage(textFrame, client);
  assert.equal(client.replies[2].streamId, "stream-1");
  assert.equal(client.replies[2].finish, true);
  assert.equal(agentCalls, 1);

  const denied = frame("msg-2", "unknown", "text", { text: { content: "集团业绩" } });
  await handler.handleMessage(denied, client);
  assert.equal(client.replies[3].finish, true);
  assert.match(client.replies[3].content, /尚未获准/);
  assert.equal(agentCalls, 1);

  const image = frame("msg-3", "boss", "image", { image: { url: "https://invalid.example/image" } });
  await handler.handleMessage(image, client);
  assert.equal(client.replies[4].finish, true);
  assert.match(client.replies[4].content, /仅支持文字/);

  assert.equal(extractQuestion({ msgtype: "voice", voice: { content: "语音问题" } }), "语音问题");
  assert.equal(extractQuestion({ msgtype: "mixed", mixed: { msg_item: [{ msgtype: "image" }, { msgtype: "text", text: { content: "图文问题" } }] } }), "图文问题");
  await assert.rejects(() => handler.handleMessage({ headers: {}, body: {} }, client), /req_id/);

  const config = loadConfig({ env: {
    XBB_WECOM_BOT_ID: "aibot_test",
    XBB_WECOM_BOT_SECRET: "secret-test",
    XBB_MODEL_ENDPOINT: "https://model.example/v1/chat/completions",
    XBB_MODEL_NAME: "tool-model",
    XBB_ACCESS_POLICY_PATH: "D:\\policy.json"
  } });
  assert.equal(config.wecomWsUrl, "wss://openws.work.weixin.qq.com/");
  assert.equal(config.wecomMaxReconnectAttempts, -1);
  assert.equal(Object.hasOwn(config, "callbackPath"), false);
  assert.throws(() => validateWebSocketEndpoint("ws://public.example"), /必须使用 WSS/);
  assert.equal(validateWebSocketEndpoint("ws://127.0.0.1:9000"), "ws://127.0.0.1:9000/");
  const transportOnly = loadWecomConfig({ env: { XBB_WECOM_BOT_ID: "aibot_transport", XBB_WECOM_BOT_SECRET: "transport-secret" } });
  assert.equal(transportOnly.wecomBotId, "aibot_transport");
  assert.equal(Object.hasOwn(transportOnly, "modelEndpoint"), false);

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
  service.stop();
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

  process.stdout.write(`${JSON.stringify({ success: true, checks: 34 })}\n`);
})().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
