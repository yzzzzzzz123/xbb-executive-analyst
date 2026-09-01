"use strict";

const crypto = require("node:crypto");
const { WSClient, generateReqId } = require("@wecom/aibot-node-sdk");
const { loadWecomConfig } = require("../config.js");
const { extractQuestion } = require("./long-connection-handler.js");
const { createPrivacyLogger } = require("./privacy-logger.js");

function createPairingCode() {
  return crypto.randomBytes(6).toString("hex").toUpperCase();
}

function discoverUser({ client, pairingCode, timeoutMs = 5 * 60 * 1000, output = console.log, setTimer = setTimeout, clearTimer = clearTimeout }) {
  if (!client?.on || !client?.connect || !client?.disconnect || !client?.replyStream) throw new Error("企业微信用户识别客户端不可用。");
  const phrase = `绑定 ${pairingCode}`;

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimer(timer);
      client.disconnect();
      callback();
    };
    const timer = setTimer(() => finish(() => reject(new Error("五分钟内未收到正确绑定口令，已停止识别。"))), timeoutMs);

    client.on("authenticated", () => output({ status: "waiting", pairingPhrase: phrase, expiresInSeconds: Math.floor(timeoutMs / 1000) }));
    client.on("error", () => output({ status: "connection_error" }));
    client.on("message", (frame) => {
      if (settled || String(extractQuestion(frame?.body) || "").trim() !== phrase) return;
      const userId = String(frame?.body?.from?.userid || "");
      if (!userId) return;
      Promise.resolve(client.replyStream(frame, generateReqId("pairing"), "本机已识别你的企业微信 USERID，本次未查询销帮帮数据。", true))
        .then(() => finish(() => resolve({ success: true, userId, chatType: String(frame.body?.chattype || "unknown") })))
        .catch((error) => finish(() => reject(error)));
    });
    client.connect();
  });
}

if (require.main === module) {
  try {
    const config = loadWecomConfig();
    const client = new WSClient({
      botId: config.wecomBotId,
      secret: config.wecomBotSecret,
      wsUrl: config.wecomWsUrl,
      maxReconnectAttempts: config.wecomMaxReconnectAttempts,
      heartbeatInterval: config.wecomHeartbeatMs,
      requestTimeout: config.wecomRequestTimeoutMs,
      logger: createPrivacyLogger()
    });
    discoverUser({
      client,
      pairingCode: createPairingCode(),
      output: (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
    }).then((result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    }).catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { createPairingCode, discoverUser };
