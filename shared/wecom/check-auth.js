"use strict";

const { WSClient } = require("@wecom/aibot-node-sdk");
const { loadWecomConfig } = require("../config.js");
const { createPrivacyLogger } = require("./privacy-logger.js");

function checkAuthentication({ client, timeoutMs = 15000, setTimer = setTimeout, clearTimer = clearTimeout }) {
  if (!client?.on || !client?.connect || !client?.disconnect) throw new Error("企业微信认证检查客户端不可用。");
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimer(timer);
      client.disconnect();
      resolve(result);
    };
    const timer = setTimer(() => finish({ success: false, stage: "timeout", errorCode: null }), timeoutMs);
    client.on("authenticated", () => finish({ success: true, stage: "authenticated" }));
    client.on("error", (error) => {
      const message = String(error?.message || "");
      const code = message.match(/code:\s*(-?\d+)/i);
      finish({
        success: false,
        stage: /Authentication failed/i.test(message) ? "authentication" : "transport",
        errorCode: code ? Number(code[1]) : null
      });
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
      maxReconnectAttempts: 0,
      maxAuthFailureAttempts: 1,
      heartbeatInterval: config.wecomHeartbeatMs,
      requestTimeout: config.wecomRequestTimeoutMs,
      logger: createPrivacyLogger()
    });
    checkAuthentication({ client }).then((result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      if (!result.success) process.exitCode = 1;
    });
  } catch (error) {
    process.stderr.write("企业微信认证检查无法启动。\n");
    process.exitCode = 1;
  }
}

module.exports = { checkAuthentication };
