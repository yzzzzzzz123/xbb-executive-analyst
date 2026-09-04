"use strict";

const crypto = require("node:crypto");
const { MAX_QUERY_MONTHS } = require("./fast-query-plan.js");

const QUERY_XBB_INPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["months", "domains"],
  properties: {
    months: { type: "array", minItems: 1, maxItems: MAX_QUERY_MONTHS, description: "上海自然月，不得晚于当前上海月份。业绩订单和 OPP 订单仅支持 2026-01 及以后。", items: { type: "string", pattern: "^\\d{4}-(0[1-9]|1[0-2])$" } },
    domains: { type: "array", minItems: 1, maxItems: 5, uniqueItems: true, items: { enum: ["all", "performance", "product-sales", "courses", "delivery", "opportunities"] } },
    company: { type: "string", description: "仅当用户明确点名时填写准确公司名称。" },
    person: { type: "string", description: "仅当用户明确点名时填写准确人员名称。" },
    forceRefresh: { type: "boolean", description: "仅用户明确要求立即刷新时使用。" }
  }
});

const QUERY_XBB_DYNAMIC_TOOL = Object.freeze({
  type: "function",
  name: "query_xbb",
  description: "从正式 bundled runner 读取当前配置的真实只读销帮帮事实包。所有经营数字必须来自此工具；寒暄和澄清问题不得无意义调用。",
  inputSchema: QUERY_XBB_INPUT_SCHEMA,
  deferLoading: false
});

function queryToolContractHash() {
  return crypto.createHash("sha256").update(JSON.stringify(QUERY_XBB_DYNAMIC_TOOL), "utf8").digest("hex");
}

module.exports = { QUERY_XBB_DYNAMIC_TOOL, QUERY_XBB_INPUT_SCHEMA, queryToolContractHash };
