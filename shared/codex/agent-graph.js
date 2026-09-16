"use strict";

const { Annotation, StateGraph, START, END } = require("@langchain/langgraph");
function validateDelivery(result) {
  if (!result || typeof result.answer !== "string" || !result.answer.trim()) {
    throw new Error("机器人答复必须包含可独立阅读的文字。");
  }
  if (!["xbb", "general"].includes(result.routeMode)) throw new Error("机器人答复缺少有效能力路由。");
  if (result.routeMode === "general" && result.chart != null) throw new Error("通用答复不能携带经营图。");
  return result;
}

function createAgentGraph() {
  // Admission happens synchronously in the native session owner before graph
  // scheduling. This lets a new correction supersede an in-flight prefetch
  // before that query starts. The graph awaits that same Thread/Turn operation.
  const state = Annotation.Root({ completion: Annotation(), result: Annotation() });
  return new StateGraph(state)
    .addNode("await_codex_turn", async ({ completion }) => ({ result: await completion(), completion: null }))
    .addNode("validate_delivery", ({ result }) => ({ result: validateDelivery(result) }))
    .addEdge(START, "await_codex_turn")
    .addEdge("await_codex_turn", "validate_delivery")
    .addEdge("validate_delivery", END)
    // Native per-user Threads own recovery; no second checkpoint/history store.
    .compile({ name: "xbb_multi_agent" });
}

function createCompletionGraph({ parse, businessMode, verifyChartAgent, isCurrent, onUnverified }) {
  const state = Annotation.Root({ rawAnswer: Annotation(), answer: Annotation(), stale: Annotation() });
  return new StateGraph(state)
    .addNode("parse_answer", async ({ rawAnswer }) => {
      if (!isCurrent()) return { stale: true, rawAnswer: null };
      try { return { answer: await parse(rawAnswer), rawAnswer: null }; }
      catch (error) {
        // Parsing is asynchronous in the framework. An invalid old response
        // must not fail the request that superseded it during that await.
        if (!isCurrent()) return { stale: true, rawAnswer: null };
        throw error;
      }
    })
    .addNode("verify_chart_agent", async ({ answer }) => {
      if (!isCurrent()) return { stale: true };
      const verified = await verifyChartAgent();
      if (!isCurrent()) return { stale: true };
      if (verified) return {};
      onUnverified();
      return { answer: { answer: `${answer.answer}\n\n本次图表未通过专职 ultra 子 Agent 完成校验，暂未生成；以上为已核验的数据分析。`, chart: null } };
    })
    .addNode("join_review", () => ({ stale: !isCurrent() }))
    .addEdge(START, "parse_answer")
    .addConditionalEdges("parse_answer", ({ answer, stale }) => !stale && businessMode && answer?.chart ? "verify_chart_agent" : "join_review")
    .addEdge("verify_chart_agent", "join_review")
    .addEdge("join_review", END)
    .compile({ name: "xbb_review_delegated_result" });
}

module.exports = { createAgentGraph, createCompletionGraph };
