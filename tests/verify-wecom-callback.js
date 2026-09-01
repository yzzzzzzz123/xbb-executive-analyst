"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const { createCallbackHandler } = require("../shared/wecom/callback-handler.js");
const { WecomCrypto } = require("../shared/wecom/crypto.js");
const { createServer } = require("../shared/wecom/server.js");

const epoch = 1788192000;
const token = "callback-test-token";
const encodingAesKey = Buffer.alloc(32, 9).toString("base64").replace(/=$/, "");
const codec = new WecomCrypto({ token, encodingAesKey, receiveId: "", randomBytes: () => Buffer.alloc(16, 3) });
const policy = { schemaVersion: "1.0", users: { boss: { scope: "all" } } };
let agentCalls = 0;
const agent = { answer: async () => { agentCalls += 1; return "集团9月业绩排名已生成（MTD）。"; } };
const handler = createCallbackHandler({ wecomCrypto: codec, policy, agent, now: () => epoch * 1000 });

function queryFor(encrypted, nonce = "nonce-callback") {
  return { msg_signature: codec.sign(String(epoch), nonce, encrypted), timestamp: String(epoch), nonce };
}

function wrapMessage(message, nonce) {
  const encrypted = codec.encrypt(JSON.stringify(message));
  return { query: queryFor(encrypted, nonce), body: { encrypt: encrypted } };
}

function decryptReply(reply) {
  return JSON.parse(codec.decryptVerified(reply.encrypt, reply.msgsignature, reply.timestamp, reply.nonce));
}

function httpGet(port, requestPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: requestPath }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    }).on("error", reject);
  });
}

(async () => {
  const echoPlain = "url-check-ok";
  const echoEncrypted = codec.encrypt(echoPlain);
  assert.equal(handler.verifyUrl({ ...queryFor(echoEncrypted, "nonce-echo"), echostr: echoEncrypted }), echoPlain);

  const initial = wrapMessage({ msgid: "msg-1", aibotid: "bot", chattype: "single", from: { userid: "boss" }, msgtype: "text", text: { content: "集团9月业绩排名" } }, "nonce-initial");
  const first = decryptReply(handler.handlePost(initial.query, initial.body));
  assert.equal(first.msgtype, "stream");
  assert.equal(first.stream.finish, false);
  assert.match(first.stream.content, /正在查询/);
  const duplicate = decryptReply(handler.handlePost(initial.query, initial.body));
  assert.equal(duplicate.stream.id, first.stream.id);

  await new Promise((resolve) => setImmediate(resolve));
  const refresh = wrapMessage({ msgid: "msg-refresh", aibotid: "bot", chattype: "single", from: { userid: "boss" }, msgtype: "stream", stream: { id: first.stream.id } }, "nonce-refresh");
  const finished = decryptReply(handler.handlePost(refresh.query, refresh.body));
  assert.equal(finished.stream.finish, true);
  assert.equal(finished.stream.content, "集团9月业绩排名已生成（MTD）。");
  assert.equal(agentCalls, 1);

  const denied = wrapMessage({ msgid: "msg-2", from: { userid: "unknown" }, msgtype: "text", text: { content: "集团业绩" } }, "nonce-denied");
  const deniedReply = decryptReply(handler.handlePost(denied.query, denied.body));
  assert.equal(deniedReply.stream.finish, true);
  assert.match(deniedReply.stream.content, /尚未获准/);
  assert.equal(agentCalls, 1);

  const config = { callbackPath: "/wecom/callback", maxBodyBytes: 1024 * 1024 };
  const server = createServer(config, handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = server.address().port;
    const health = await httpGet(port, "/healthz");
    assert.equal(health.status, 200);
    assert.equal(JSON.parse(health.body).status, "ok");
    const missing = await httpGet(port, "/missing");
    assert.equal(missing.status, 404);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }

  process.stdout.write(`${JSON.stringify({ success: true, checks: 15 })}\n`);
})().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
