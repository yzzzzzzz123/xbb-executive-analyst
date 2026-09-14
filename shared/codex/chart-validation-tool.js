"use strict";

const crypto = require("node:crypto");
const { CHART_SCHEMA, parseAgentResponse } = require("./response-contract.js");
const { renderChartPreview } = require("../xbb/chart-preview.js");

const VALIDATE_CHART_TOOL = Object.freeze({
  type: "function", name: "validate_xbb_chart", deferLoading: false,
  description: "校验完整经营图的字段、引用、算术并渲染手机预览；不取业务数据。失败时按具体错误修正后重试。成功返回已验证图引用，最终chart原样使用该引用，避免再次抄写规格改变数值或单位。",
  inputSchema: { type: "object", additionalProperties: false, required: ["spec"], properties: { spec: CHART_SCHEMA } }
});

async function validateChartPreview(args) {
  if (!args || Object.keys(args).some((key) => key !== "spec") || Buffer.byteLength(JSON.stringify(args), "utf8") > 64 * 1024) throw new Error("请提交64 KiB以内的完整spec，不附加其他字段。");
  let invalid;
  const result = parseAgentResponse(JSON.stringify({ answer: "图表规格校验", chart: args.spec }), { onChartInvalid: (error) => { invalid = error; } });
  if (!result.chart) throw invalid || new Error("缺少可验证图表规格。");
  const preview = await renderChartPreview(result.chart);
  const panels = result.chart.type === "composite" ? result.chart.panels : [result.chart];
  return { id: crypto.randomUUID(), spec: result.chart, preview,
    panelCount: panels.length, findingCount: panels.reduce((sum, panel) => sum + (panel.findings?.length || 0), 0) };
}

module.exports = { VALIDATE_CHART_TOOL, validateChartPreview };
