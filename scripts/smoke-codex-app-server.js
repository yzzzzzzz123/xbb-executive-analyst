"use strict";

const path = require("node:path");
const { AppServerClient } = require("../shared/codex/app-server-client.js");
const { LocalAppServerHost } = require("../shared/codex/app-server-host.js");
const { buildThreadInstructions } = require("../shared/codex/thread-instructions.js");
const { WECOM_RESPONSE_SCHEMA, parseAgentResponse } = require("../shared/codex/response-contract.js");
const { readCodexVersion, verifyCodexChatGptLogin } = require("../shared/codex/runtime.js");
const { QUERY_XBB_DYNAMIC_TOOL } = require("../shared/xbb/query-tool.js");

async function runSmoke() {
  const projectRoot = path.resolve(__dirname, "..");
  const config = { projectRoot, codexModel: "gpt-5.6-sol", codexReasoningEffort: "medium" };
  verifyCodexChatGptLogin(config);
  const codexVersion = readCodexVersion(config);
  let host;
  let client;
  let timer;
  try {
    host = await LocalAppServerHost.start(config);
    client = new AppServerClient({ endpoint: host.endpoint, token: host.token, requestTimeoutMs: 60000 });
    await client.connect();
    const threadResult = await client.startThread({
      model: config.codexModel,
      allowProviderModelFallback: false,
      cwd: projectRoot,
      approvalPolicy: "never",
      sandbox: "read-only",
      developerInstructions: buildThreadInstructions(projectRoot),
      ephemeral: true,
      dynamicTools: [QUERY_XBB_DYNAMIC_TOOL]
    });
    const threadId = threadResult?.thread?.id;
    if (typeof threadId !== "string" || !threadId) throw new Error("App Server smoke did not return a thread ID.");

    let unexpectedToolCall = false;
    client.on("serverRequest", (request) => {
      unexpectedToolCall = true;
      try { client.reject(request.id, "Smoke greeting must not call a business tool."); } catch {}
    });
    const completion = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Codex App Server smoke turn timed out.")), 300000);
      client.on("notification", ({ method, params }) => {
        if (method !== "turn/completed" || params?.threadId !== threadId) return;
        const turn = params.turn;
        const final = Array.isArray(turn?.items)
          ? [...turn.items].reverse().find((item) => item?.type === "agentMessage" && typeof item.text === "string" && item.text.trim())
          : null;
        if (turn?.status !== "completed" || !final) reject(new Error("Codex App Server smoke turn did not produce a final answer."));
        else {
          try { resolve(parseAgentResponse(final.text.trim())); } catch (error) { reject(error); }
        }
      });
    });
    await client.startTurn({
      threadId,
      clientUserMessageId: "local-smoke",
      input: [
        { type: "skill", name: "xbb-executive-analyst", path: path.join(projectRoot, "skills", "xbb-executive-analyst", "SKILL.md") },
        { type: "text", text: "你好。请只用一句中文说明你的专用身份。这是连接冒烟测试，不要查询销帮帮。", text_elements: [] }
      ],
      cwd: projectRoot,
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      model: config.codexModel,
      effort: config.codexReasoningEffort,
      summary: "none",
      outputSchema: WECOM_RESPONSE_SCHEMA
    });
    const response = await completion;
    if (response.chart !== null) throw new Error("Codex App Server smoke greeting unexpectedly generated a chart.");
    if (unexpectedToolCall) throw new Error("Codex App Server smoke greeting unexpectedly called query_xbb.");
    process.stdout.write(`${JSON.stringify({ success: true, codexVersion, model: config.codexModel, effort: config.codexReasoningEffort, skill: "xbb-executive-analyst", toolCalls: 0 })}\n`);
  } finally {
    if (timer) clearTimeout(timer);
    if (client) await client.close().catch(() => {});
    if (host) await host.close().catch(() => {});
  }
}

runSmoke().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
