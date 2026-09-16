"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { RunnableLambda } = require("@langchain/core/runnables");
const { RunTree } = require("langsmith/run_trees");
const { withRunTree } = require("langsmith/traceable");
const { invokeLocal } = require("../shared/langchain/local-execution.js");
const { createAgentGraph, createCompletionGraph } = require("../shared/codex/agent-graph.js");
const { AgentResponseParser } = require("../shared/codex/response-parser.js");
const { buildTurnPrompt } = require("../shared/codex/turn-prompt.js");
const { createRuleContextChain } = require("../shared/rag/skill-retriever.js");
const { SkillKnowledgeBase } = require("../shared/rag/skill-knowledge-base.js");
const { invokeQueryTool } = require("../shared/xbb/langchain-query-tool.js");
const { QUERY_XBB_INPUT_SCHEMA } = require("../shared/xbb/query-tool.js");

async function main() {
  const kb = new SkillKnowledgeBase(path.resolve(__dirname, ".."));
  const rules = createRuleContextChain(kb);
  const question = '2026年9月集团业绩 {"literal":"{secret}"}';
  const options = { domains: ["performance"], periodCount: 1 };
  assert.equal(await invokeLocal(rules, { question, businessMode: false }), null);
  const retrieved = await invokeLocal(rules, { question, businessMode: true, options });
  assert.deepEqual(retrieved, kb.retrieve(question, options), "规则与原检索器的字节预算、来源和排序一致");
  const promptInput = { question, retrieved, continuity: [], date: "2026-09-16", scope: "集团" };
  const business = await buildTurnPrompt({ ...promptInput, businessMode: true, prefetchedFactView: { marker: "{facts}" } });
  assert.ok(business.includes(question));
  assert.ok(business.includes('"marker":"{facts}"'));
  const general = await buildTurnPrompt({ ...promptInput, businessMode: false });
  assert.ok(!general.includes(retrieved.text));
  assert.ok(!general.includes("$xbb-executive-chart"));

  const access = Object.freeze({ scope: "group" });
  const controller = new AbortController();
  const args = { months: ["2026-09"], domains: ["performance"], metrics: ["performance.total"] };
  let queries = 0;
  const gateway = async (input, trustedAccess, invocation) => {
    queries += 1;
    assert.deepEqual(input, args);
    assert.equal(trustedAccess, access);
    assert.equal(invocation.signal, controller.signal);
    return { status: "ready", marker: "{facts}" };
  };
  const invocation = { signal: controller.signal };
  assert.equal((await invokeQueryTool(gateway, args, access, invocation)).status, "ready");
  await assert.rejects(invokeQueryTool(gateway, { ...args, access: { scope: "all" } }, access, invocation));
  await assert.rejects(invokeQueryTool(gateway, { months: args.months, domains: args.domains }, access, invocation));
  controller.abort(new Error("cancelled-query"));
  await assert.rejects(invokeQueryTool(gateway, args, access, invocation), /cancelled-query/);
  assert.equal(queries, 1);
  assert.equal(Object.hasOwn(QUERY_XBB_INPUT_SCHEMA, "__absolute_uri__"), false);

  const parser = new AgentResponseParser();
  assert.equal((await invokeLocal(parser, JSON.stringify({ answer: "文字结论不可缺少。", chart: null }))).answer, "文字结论不可缺少。");
  await assert.rejects(invokeLocal(parser, JSON.stringify({ answer: "", chart: null })));
  let verified = 0;
  let rejected = 0;
  let current = true;
  const graphOptions = { parse: async () => ({ answer: "已有完整文字。", chart: { kind: "candidate" } }), businessMode: true,
    verifyChartAgent: async () => { verified += 1; return false; }, isCurrent: () => current, onUnverified: () => { rejected += 1; } };
  const reviewed = await invokeLocal(createCompletionGraph(graphOptions), { rawAnswer: "private" });
  assert.equal(reviewed.answer.chart, null);
  assert.match(reviewed.answer.answer, /已有完整文字/);
  assert.equal(reviewed.rawAnswer, null);
  assert.equal(rejected, 1);
  await invokeLocal(createCompletionGraph({ ...graphOptions, parse: async () => ({ answer: "无需图。", chart: null }) }), { rawAnswer: "private" });
  assert.equal(verified, 1, "没有图的答复不等待子 Agent");
  const stale = await invokeLocal(createCompletionGraph({ ...graphOptions, verifyChartAgent: async () => { current = false; return true; } }), { rawAnswer: "private" });
  assert.equal(stale.stale, true, "等待子 Agent 期间被更正的结果不能交付");
  current = true;
  const staleInvalid = await invokeLocal(createCompletionGraph({ ...graphOptions, parse: async () => { current = false; throw new Error("old invalid response"); } }), { rawAnswer: "old" });
  assert.equal(staleInvalid.stale, true, "旧响应解析失败不能终止接管后的新请求");
  current = true;
  await assert.rejects(invokeLocal(createCompletionGraph({ ...graphOptions, parse: async () => { throw new Error("current invalid response"); } }), { rawAnswer: "current" }), /current invalid response/);
  const deliveryGraph = createAgentGraph();
  await assert.rejects(invokeLocal(deliveryGraph, { completion: async () => ({ answer: "", chart: null, routeMode: "xbb" }) }), /文字/);
  await assert.rejects(invokeLocal(deliveryGraph, { completion: async () => ({ answer: "通用答复", chart: {}, routeMode: "general" }) }), /经营图/);

  const envKeys = ["LANGSMITH_TRACING", "LANGCHAIN_TRACING_V2", "LANGSMITH_API_KEY", "LANGCHAIN_VERBOSE"];
  const saved = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  const leaks = [];
  try {
    process.env.LANGSMITH_TRACING = "false";
    process.env.LANGCHAIN_TRACING_V2 = "false";
    process.env.LANGSMITH_API_KEY = "synthetic-test-key";
    delete process.env.LANGCHAIN_VERBOSE;
    globalThis.fetch = async () => { networkCalls += 1; throw new Error("Tracing must stay offline"); };
    const ambient = new RunTree({ name: "ambient", tracingEnabled: true });
    // The outer callback context is constructed with tracing disabled. Only the
    // nested invocation receives hostile trace settings and an enabled parent.
    const outer = RunnableLambda.from(async () => {
      process.env.LANGSMITH_TRACING = "true";
      process.env.LANGCHAIN_TRACING_V2 = "true";
      return withRunTree(ambient, () => invokeLocal(rules, { question: "business-secret 业绩", businessMode: true, options }));
    });
    await outer.invoke("public-input", { callbacks: [{ name: "ambient-observer", handleChainStart(_chain, input) { leaks.push(JSON.stringify(input)); }, handleRetrieverStart(_retriever, input) { leaks.push(String(input)); } }] });
    assert.ok(leaks.every((entry) => !entry.includes("business-secret")));
    await withRunTree(ambient, () => invokeLocal(RunnableLambda.from(() => "business-secret"), "business-secret"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(networkCalls, 0);
    process.env.LANGCHAIN_VERBOSE = "true";
    assert.throws(() => invokeLocal(rules, { question, businessMode: true }), /verbose/);
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of envKeys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  }
  process.stdout.write(`${JSON.stringify({ success: true, framework: "LangGraph + LangChain", checks: "routing, rules, prompt, schema, access, cancellation, chart-review, stale-results, tracing" })}\n`);
}

const watchdog = setTimeout(() => { process.stderr.write("Framework verification timed out\n"); process.exit(1); }, 30000);
main().then(() => clearTimeout(watchdog), (error) => { clearTimeout(watchdog); process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
