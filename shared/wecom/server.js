"use strict";

const http = require("node:http");
const { loadConfig } = require("../config.js");
const { createChatCompletionsClient } = require("../agent/chat-completions-client.js");
const { createExecutiveAgent } = require("../agent/executive-agent.js");
const { loadSystemPrompt } = require("../agent/system-prompt.js");
const { loadAccessPolicy } = require("../security/access-control.js");
const { createToolGateway } = require("../xbb/tool-gateway.js");
const { createCallbackHandler } = require("./callback-handler.js");
const { WecomCrypto } = require("./crypto.js");

function send(res, status, contentType, body) {
  const payload = Buffer.from(body, "utf8");
  res.writeHead(status, { "content-type": `${contentType}; charset=utf-8`, "content-length": payload.length, "cache-control": "no-store" });
  res.end(payload);
}

function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("回调消息超过大小上限。"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new Error("回调消息不是有效 JSON。")); }
    });
    req.on("error", reject);
  });
}

function buildRuntime(config) {
  const policy = loadAccessPolicy(config.accessPolicyPath);
  const modelClient = createChatCompletionsClient(config);
  const queryXbb = createToolGateway();
  const agent = createExecutiveAgent({ modelClient, queryXbb, systemPrompt: loadSystemPrompt() });
  const wecomCrypto = new WecomCrypto({ token: config.wecomToken, encodingAesKey: config.wecomEncodingAesKey, receiveId: config.wecomReceiveId });
  return createCallbackHandler({ wecomCrypto, policy, agent });
}

function createServer(config, runtime = buildRuntime(config)) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      if (req.method === "GET" && url.pathname === "/healthz") {
        send(res, 200, "application/json", JSON.stringify({ status: "ok", service: "xbb-executive-analyst-wecom" }));
        return;
      }
      if (url.pathname !== config.callbackPath) {
        send(res, 404, "application/json", JSON.stringify({ error: "not_found" }));
        return;
      }
      const query = Object.fromEntries(url.searchParams.entries());
      if (req.method === "GET") {
        send(res, 200, "text/plain", runtime.verifyUrl(query));
        return;
      }
      if (req.method === "POST") {
        const reply = runtime.handlePost(query, await readJsonBody(req, config.maxBodyBytes));
        if (reply === null) {
          res.writeHead(200, { "content-length": "0", "cache-control": "no-store" });
          res.end();
        } else {
          send(res, 200, "application/json", JSON.stringify(reply));
        }
        return;
      }
      send(res, 405, "application/json", JSON.stringify({ error: "method_not_allowed" }));
    } catch (error) {
      send(res, 400, "application/json", JSON.stringify({ error: "invalid_callback", message: error.message }));
    }
  });
}

if (require.main === module) {
  try {
    const config = loadConfig();
    const server = createServer(config);
    server.listen(config.port, config.host, () => {
      process.stdout.write(`${JSON.stringify({ success: true, host: config.host, port: config.port, callbackPath: config.callbackPath })}\n`);
    });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { buildRuntime, createServer, readJsonBody };
