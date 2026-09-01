"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  buildCodexPrompt,
  createCodexCliClient,
  normalizeAssistantMessage,
  resolveCodexInvocation,
  sanitizeCodexEnvironment,
  verifyCodexChatGptLogin
} = require("../shared/agent/codex-cli-client.js");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "xbb-codex-client-test-"));

(async () => {
  let captured;
  const client = createCodexCliClient(
    { modelTimeoutMs: 12345 },
    {
      temporaryRoot: testRoot,
      invocation: { command: "fake-codex", argsPrefix: [] },
      env: { PATH: "safe", USERPROFILE: "C:\\Users\\tester", XBB_WECOM_BOT_SECRET: "must-not-leak", OPENAI_API_KEY: "must-not-leak" },
      runner: async (request) => {
        captured = request;
        assert.equal(fs.existsSync(request.cwd), true);
        assert.equal(fs.existsSync(request.outputPath), false);
        return JSON.stringify({
          role: "assistant",
          content: "",
          tool_calls: [{ id: "call_local_1", type: "function", function: { name: "query_xbb", arguments: "{\"months\":[\"2026-09\"],\"domains\":[\"performance\"]}" } }]
        });
      }
    }
  );

  const message = await client.complete({
    messages: [{ role: "user", content: "集团9月业绩" }],
    tools: [{ type: "function", function: { name: "query_xbb" } }]
  });
  assert.equal(message.tool_calls[0].function.name, "query_xbb");
  assert.equal(captured.timeoutMs, 12345);
  assert.match(captured.prompt, /application_tools_json/);
  assert.match(captured.args.join(" "), /--ephemeral/);
  assert.match(captured.args.join(" "), /read-only/);
  assert.match(captured.args.join(" "), /--model gpt-5\.6-sol/);
  assert.match(captured.args.join(" "), /model_reasoning_effort=\"max\"/);
  assert.equal(Object.hasOwn(captured.env, "XBB_WECOM_BOT_SECRET"), false);
  assert.equal(Object.hasOwn(captured.env, "OPENAI_API_KEY"), false);
  assert.equal(fs.existsSync(captured.cwd), false);

  const cleanEnv = sanitizeCodexEnvironment({ PATH: "ok", CODEX_HOME: "C:\\Codex", SECRET_TOKEN: "bad", XBB_MODEL_API_KEY: "bad" });
  assert.deepEqual(cleanEnv, { CODEX_HOME: "C:\\Codex", PATH: "ok" });
  assert.match(buildCodexPrompt({ messages: [], tools: [] }), /不能调用 Codex 自带/);
  assert.throws(() => normalizeAssistantMessage({ role: "assistant", content: "x", tool_calls: [{ id: "1", type: "function", function: { name: "write_crm", arguments: "{}" } }] }), /未授权/);
  assert.throws(() => resolveCodexInvocation({ codexCommand: "codex.cmd" }), /绝对路径/);
  assert.deepEqual(verifyCodexChatGptLogin({}, {
    invocation: { command: "fake", argsPrefix: [] },
    spawnSync: () => ({ status: 0, stdout: "Logged in using ChatGPT", stderr: "" })
  }), { mode: "chatgpt" });
  assert.throws(() => verifyCodexChatGptLogin({}, {
    invocation: { command: "fake", argsPrefix: [] },
    spawnSync: () => ({ status: 0, stdout: "Logged in using an API key", stderr: "" })
  }), /不是 ChatGPT 登录模式/);

  process.stdout.write(`${JSON.stringify({ success: true, checks: 18 })}\n`);
})().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(testRoot, { recursive: true, force: true });
});
