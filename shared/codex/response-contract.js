"use strict";

const crypto = require("node:crypto");
const { CHART_SCHEMA, validateSpec } = require("../../skills/xbb-executive-chart/scripts/chart-contract.js");
const { sanitizeAgentText } = require("../security/output-sanitizer.js");

const VALIDATED_CHART_REFERENCE_SCHEMA = Object.freeze({
  type: "object", additionalProperties: false, required: ["type", "id"],
  properties: {
    type: { type: "string", enum: ["validated"] },
    id: { type: "string", minLength: 36, maxLength: 36, description: "原样使用本轮validate_xbb_chart返回的图引用，不自行编造。" }
  }
});

const ANSWER_SCHEMA = Object.freeze({
  type: "string", minLength: 1, maxLength: 6000,
  description: "每个问题都必须有可独立阅读的文字答复。有图时仍须完整回答；复杂问题逐项写明结论、关键数字、依据和限制，不能只写见图或图表已生成，也不能以图中文字替代正文。"
});

const WECOM_RESPONSE_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    answer: ANSWER_SCHEMA,
    chart: { anyOf: [{ type: "null" }, VALIDATED_CHART_REFERENCE_SCHEMA, ...CHART_SCHEMA.anyOf] }
  },
  required: ["answer", "chart"]
});

const GENERAL_RESPONSE_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    answer: ANSWER_SCHEMA,
    chart: { type: "null" }
  },
  required: ["answer", "chart"]
});

function parseAgentResponse(value, options = {}) {
  let parsed;
  try { parsed = JSON.parse(String(value || "").trim()); } catch { throw new Error("Codex Agent 最终答复不是有效结构化结果。"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Codex Agent 最终答复结构无效。");
  if (typeof parsed.answer !== "string") throw new Error("Codex Agent 最终答复缺少文字答复。");
  const answer = sanitizeAgentText(parsed.answer, { maxBytes: 18000 });
  if (!answer) throw new Error("Codex Agent 最终答复缺少老板可读结论。");
  const chartCandidate = parsed.chart === null || parsed.chart === undefined
    ? null
    : JSON.parse(JSON.stringify(parsed.chart, (_key, item) => typeof item === "string" ? sanitizeAgentText(item, { maxBytes: 4096 }) : item));
  let chart = null;
  if (chartCandidate) {
    try {
      if (chartCandidate.type === "validated" && (Object.keys(chartCandidate).some((key) => !["type", "id"].includes(key))
          || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(chartCandidate.id || ""))) throw new Error("图引用结构无效。");
      const resolved = chartCandidate.type === "validated" ? options.resolveChart?.(chartCandidate.id) : chartCandidate;
      if (!resolved) throw new Error("已验证图引用失效，请在本轮重新校验。");
      chart = validateSpec(resolved);
    } catch (error) {
      if (typeof options.onChartInvalid === "function") {
        try { options.onChartInvalid(error); } catch {}
      }
    }
  }
  return Object.freeze({ answer, chart });
}

function responseContractHash() {
  return crypto.createHash("sha256").update(JSON.stringify({ general: GENERAL_RESPONSE_SCHEMA, business: WECOM_RESPONSE_SCHEMA }), "utf8").digest("hex");
}

module.exports = { CHART_SCHEMA, GENERAL_RESPONSE_SCHEMA, WECOM_RESPONSE_SCHEMA, parseAgentResponse, responseContractHash };
