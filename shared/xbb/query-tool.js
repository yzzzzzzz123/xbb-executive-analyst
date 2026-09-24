"use strict";

const crypto = require("node:crypto");
const { MAX_QUERY_MONTHS } = require("./fast-query-plan.js");
const { METRICS } = require("./data-demand.js");

const QUERY_XBB_INPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["months", "domains"],
  properties: {
    metrics: { type: "array", minItems: 1, uniqueItems: true, items: { enum: Object.keys(METRICS) }, description: "可选的数据投影，用于选择所需指标；省略即可取得所选数据域的完整事实。综合分析、转化分析或现有指标不足时省略，不必把问题套入固定指标。" },
    months: { type: "array", minItems: 1, maxItems: MAX_QUERY_MONTHS, description: "上海自然月，不得晚于当前上海月份。业绩订单和 OPP 订单仅支持 2026-01 及以后。", items: { type: "string", pattern: "^\\d{4}-(0[1-9]|1[0-2])$" } },
    date: { type: "string", pattern: "^\\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])$", description: "用户问今天或明确单日业绩时必填上海 YYYY-MM-DD；仅支持 performance，months 必须且只能含该日所在月。当天截止本次刷新，不能省略后改查月累计。" },
    domains: { type: "array", minItems: 1, maxItems: 5, uniqueItems: true, items: { enum: ["performance", "product-sales", "courses", "delivery", "opportunities", "all"] }, description: "自主选择一个或多个数据域；综合经营分析可单独使用 all，并省略 metrics。" },
    company: { type: "string", description: "公司筛选，可根据问题或分析需要下钻。集团、各个公司、公司排名均应省略；实际访问范围由服务端授权控制。" },
    person: { type: "string", description: "人员筛选，可根据问题或分析需要下钻；未限定人员时省略。" },
    forceRefresh: { type: "boolean", description: "需要重新核验最新事实时使用。" }
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
