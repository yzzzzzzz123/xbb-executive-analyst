"use strict";

const crypto = require("node:crypto");
const { CHART_SCHEMA, validateSpec } = require("../../skills/xbb-executive-chart/scripts/chart-contract.js");
const { sanitizeAgentText } = require("../security/output-sanitizer.js");

const WECOM_RESPONSE_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    answer: { type: "string", maxLength: 6000 },
    chart: { anyOf: [{ type: "null" }, ...CHART_SCHEMA.anyOf] }
  },
  required: ["answer", "chart"]
});

const GENERAL_RESPONSE_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    answer: { type: "string", maxLength: 6000 },
    chart: { type: "null" }
  },
  required: ["answer", "chart"]
});

function parseAgentResponse(value, options = {}) {
  let parsed;
  try { parsed = JSON.parse(String(value || "").trim()); } catch { throw new Error("Codex Agent 最终答复不是有效结构化结果。"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Codex Agent 最终答复结构无效。");
  const answer = sanitizeAgentText(parsed.answer, { maxBytes: 18000 });
  if (!answer) throw new Error("Codex Agent 最终答复缺少老板可读结论。");
  const chartCandidate = parsed.chart === null || parsed.chart === undefined
    ? null
    : JSON.parse(JSON.stringify(parsed.chart, (_key, item) => typeof item === "string" ? sanitizeAgentText(item, { maxBytes: 4096 }) : item));
  let chart = null;
  if (chartCandidate) {
    try {
      chart = validateSpec(chartCandidate);
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
