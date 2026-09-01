"use strict";

const assert = require("node:assert/strict");
const { createExecutiveAgent, stripUnsafeAnswer } = require("../shared/agent/executive-agent.js");

const calls = [];
const modelClient = {
  async complete({ messages, tools }) {
    calls.push({ messages: structuredClone(messages), tools: structuredClone(tools) });
    if (calls.length === 1) {
      return {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "query_xbb", arguments: JSON.stringify({ months: ["2026-09"], domains: ["performance"] }) } }]
      };
    }
    const factMessage = messages.findLast((message) => message.role === "tool");
    assert.equal(JSON.parse(factMessage.content).facts.performance.summary.total, 100);
    return { role: "assistant", content: "<think>内部过程</think>集团本月业绩为100元（MTD）。" };
  }
};
let toolCalls = 0;
const queryXbb = async (args, access) => {
  toolCalls += 1;
  assert.deepEqual(args.domains, ["performance"]);
  assert.equal(access.scope, "all");
  return { status: "ready", facts: { performance: { summary: { total: 100 } } } };
};
const agent = createExecutiveAgent({ modelClient, queryXbb, systemPrompt: "只用真实事实" });

(async () => {
  const answer = await agent.answer({ question: "集团本月业绩？", access: { scope: "all", companies: [] } });
  assert.equal(answer, "集团本月业绩为100元（MTD）。");
  assert.equal(toolCalls, 1);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].tools.length, 1);
  assert.equal(calls[0].tools[0].function.name, "query_xbb");
  assert.doesNotMatch(stripUnsafeAnswer("联系 13800138000 或 a@example.com"), /13800138000|a@example\.com/);
  const unsafeAgent = createExecutiveAgent({
    modelClient: { complete: async () => ({ role: "assistant", content: "凭记忆回答：100元" }) },
    queryXbb,
    systemPrompt: "只用真实事实"
  });
  await assert.rejects(() => unsafeAgent.answer({ question: "业绩？", access: { scope: "all", companies: [] } }), /未调用真实销帮帮查询工具/);
  process.stdout.write(`${JSON.stringify({ success: true, checks: 9 })}\n`);
})().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
