"use strict";

// Explicit live model test. Synthetic non-business material stays in memory;
// this script never queries CRM, sends WeCom messages, or persists a Thread.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { LocalAppServerHost } = require("../shared/codex/app-server-host.js");
const { AppServerClient } = require("../shared/codex/app-server-client.js");
const { modelContextConfig } = require("../shared/codex/model-context.js");

async function main() {
  const runtimePath = path.join(process.env.LOCALAPPDATA, "Codex", "xbb-executive-analyst", "bot-config.json");
  const stored = JSON.parse(fs.readFileSync(runtimePath, "utf8").replace(/^\uFEFF/, ""));
  const config = {
    projectRoot: path.resolve(__dirname, ".."),
    codexCommand: stored.codexCommand,
    codexProxyUrl: stored.codexProxyUrl,
    codexContextWindow: stored.codexContextWindow,
    codexAutoCompactTokenLimit: stored.codexAutoCompactTokenLimit
  };
  const expected = { beginning: 95021, middle: 48713, end: 63569, total: 207303 };
  const rows = Array.from({ length: 12000 }, (_, index) =>
    `record_${index}: ${crypto.createHash("sha256").update(`context-test-${index}`).digest("hex").slice(0, 48)}`);
  rows[100] += `\nCONTEXT_PROBE_BEGINNING=${expected.beginning}`;
  rows[6000] += `\nCONTEXT_PROBE_MIDDLE=${expected.middle}`;
  rows[11900] += `\nCONTEXT_PROBE_END=${expected.end}`;
  const input = "Synthetic context test, no business data. Read all three CONTEXT_PROBE markers and return their exact integers plus their sum. No tools.\n"
    + rows.join("\n") + "\nReturn JSON with beginning, middle, end, total. Each value must come from the three named markers.";
  const started = Date.now();
  const host = await LocalAppServerHost.start(config);
  const client = new AppServerClient({ endpoint: host.endpoint, token: host.token });
  let timer;
  let progress;
  let usage;
  let finalText = "";
  let compacted = false;
  try {
    await client.connect();
    client.on("serverRequest", (request) => client.reject(request.id, "Tools are not needed for this synthetic context test."));
    const thread = await client.startThread({
      model: "gpt-6-astra", allowProviderModelFallback: false,
      cwd: config.projectRoot, approvalPolicy: "never", sandbox: "read-only",
      ephemeral: true, config: modelContextConfig(config),
      developerInstructions: "This is an isolated synthetic context-window test. Do not use tools or retrieve business facts. Return only the requested JSON."
    });
    const done = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Long-context live test timed out.")), 300000);
      client.on("notification", (event) => {
        if (event.params?.threadId !== thread.thread.id) return;
        if (event.method === "thread/tokenUsage/updated") usage = event.params.tokenUsage;
        if (/compact/i.test(event.method) || event.params.item?.type === "contextCompaction") compacted = true;
        if (event.method === "item/completed" && event.params.item?.type === "agentMessage") finalText = event.params.item.text;
        if (event.method === "turn/completed") {
          if (event.params.turn.status === "completed") resolve();
          else reject(new Error(`Long-context model turn failed: ${event.params.turn.status}`));
        }
      });
    });
    // Attach rejection handling before a potentially slow turn/start response.
    void done.catch(() => {});
    process.stdout.write(`${JSON.stringify({ stage: "large_context_test_started", inputBytes: Buffer.byteLength(input), configuredWindow: modelContextConfig(config).model_context_window })}\n`);
    progress = setInterval(() => process.stdout.write(`${JSON.stringify({ stage: "large_context_test_running", elapsedMs: Date.now() - started })}\n`), 45000);
    await client.startTurn({
      threadId: thread.thread.id, model: "gpt-6-astra", effort: "xhigh",
      input: [{ type: "text", text: input, text_elements: [] }],
      approvalPolicy: "never", sandboxPolicy: { type: "readOnly", networkAccess: false },
      outputSchema: { type: "object", additionalProperties: false,
        properties: Object.fromEntries(Object.keys(expected).map((key) => [key, { type: "integer" }])), required: Object.keys(expected) }
    });
    await done;
    assert.deepEqual(JSON.parse(finalText), expected, "Beginning, middle, end values and their sum must match.");
    assert.ok(usage?.last?.inputTokens > 272000, "The actual model input must exceed the old 272K window.");
    assert.ok(usage.modelContextWindow > 272000, "The runtime must report the larger effective window.");
    assert.equal(compacted, false, "This test must verify the whole supplied context without compaction.");
    process.stdout.write(`${JSON.stringify({ success: true, model: "gpt-6-astra", effectiveContextWindow: usage.modelContextWindow,
      inputTokens: usage.last.inputTokens, outputTokens: usage.last.outputTokens, markersVerified: 3, sumVerified: true, compacted, elapsedMs: Date.now() - started })}\n`);
  } finally {
    clearTimeout(timer);
    clearInterval(progress);
    await client.close();
    await host.close();
  }
}

main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
