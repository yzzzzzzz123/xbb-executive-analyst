"use strict";

const { AccessDeniedError } = require("../security/access-control.js");

const QUERY_TOOL = Object.freeze({
  type: "function",
  function: {
    name: "query_xbb",
    description: "从当前配置的真实只读销帮帮数据读取一个或多个自然月的确定性经营事实包。所有经营数字必须来自此工具。",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["months", "domains"],
      properties: {
        months: { type: "array", minItems: 1, maxItems: 12, items: { type: "string", pattern: "^\\d{4}-(0[1-9]|1[0-2])$" } },
        domains: { type: "array", minItems: 1, maxItems: 5, uniqueItems: true, items: { enum: ["all", "performance", "product-sales", "courses", "delivery", "opportunities"] } },
        company: { type: "string", description: "用户明确点名时填写准确公司名称。" },
        person: { type: "string", description: "用户明确点名时填写准确人员名称。" },
        forceRefresh: { type: "boolean", description: "仅用户明确要求立即刷新时使用。" }
      }
    }
  }
});

function stripUnsafeAnswer(value) {
  let text = String(value || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  text = text.replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, "[手机号已脱敏]");
  text = text.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[邮箱已脱敏]");
  text = text.replace(/\b(?:ghp_|github_pat_|sk-)[A-Za-z0-9_-]{16,}\b/g, "[密钥已脱敏]");
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > 20480) {
    let end = text.length;
    while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > 20380) end -= 1;
    text = `${text.slice(0, end).trimEnd()}\n\n（内容已按企业微信长度限制截断）`;
  }
  if (!text) throw new Error("模型未生成可用答复。");
  return text;
}

function accessPrompt(access) {
  if (access.scope === "all") return "当前用户拥有集团只读查询权限。";
  return `当前用户仅可查询这些公司：${access.companies.join("、")}。不得查询或推断其他公司；未指定且只有一家公司时工具会自动限定。`;
}

function shanghaiDateLabel(now = new Date()) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(now);
}

function createExecutiveAgent({ modelClient, queryXbb, systemPrompt, maxToolRounds = 4 }) {
  if (!modelClient?.complete || typeof queryXbb !== "function" || !systemPrompt) throw new Error("智能客服 Agent 初始化参数不完整。");

  return Object.freeze({
    async answer({ question, access }) {
      if (typeof question !== "string" || !question.trim()) throw new Error("经营问题不能为空。");
      const messages = [
        { role: "system", content: systemPrompt },
        { role: "system", content: accessPrompt(access) },
        { role: "system", content: `当前上海日期：${shanghaiDateLabel()}。“本月/当月”必须据此选择 YYYY-MM，并在答复中注明月累计（MTD）。` },
        { role: "user", content: question.trim() }
      ];
      let usedTool = false;

      for (let round = 0; round <= maxToolRounds; round += 1) {
        const assistant = await modelClient.complete({ messages, tools: [QUERY_TOOL] });
        const toolCalls = Array.isArray(assistant.tool_calls) ? assistant.tool_calls : [];
        messages.push({ role: "assistant", content: assistant.content || "", ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
        if (!toolCalls.length) {
          if (!usedTool) throw new Error("模型未调用真实销帮帮查询工具，已拒绝生成无事实答复。");
          return stripUnsafeAnswer(assistant.content);
        }
        if (round === maxToolRounds) throw new Error("模型工具调用轮次超过安全上限。");

        for (const call of toolCalls) {
          if (call?.type !== "function" || call.function?.name !== "query_xbb" || typeof call.id !== "string") {
            throw new Error("模型请求了未授权工具。");
          }
          let args;
          try { args = JSON.parse(call.function.arguments || "{}"); }
          catch { throw new Error("模型生成了无效的 query_xbb 参数。") }
          let result;
          try {
            result = await queryXbb(args, access);
            usedTool = true;
          } catch (error) {
            usedTool = true;
            result = error instanceof AccessDeniedError
              ? { status: "access_denied", code: error.code, message: error.message }
              : { status: "error", message: error.message || "实时查询失败。" };
          }
          messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
        }
      }
      throw new Error("模型未在允许轮次内完成答复。");
    }
  });
}

module.exports = { QUERY_TOOL, createExecutiveAgent, shanghaiDateLabel, stripUnsafeAnswer };
