"use strict";

const crypto = require("node:crypto");
const { sanitizeAgentText } = require("../security/output-sanitizer.js");
const { validateSpec } = require("../xbb/render-chart.js");

const stringArray = { type: "array", maxItems: 30, items: { type: "string", maxLength: 80 } };
const seriesArray = {
  type: "array",
  maxItems: 8,
  items: {
    type: "object",
    additionalProperties: false,
    properties: {
      name: { type: "string", maxLength: 80 },
      values: { type: "array", maxItems: 30, items: { type: "number" } }
    },
    required: ["name", "values"]
  }
};
const itemArray = {
  type: "array",
  maxItems: 12,
  items: {
    type: "object",
    additionalProperties: false,
    properties: {
      name: { type: "string", maxLength: 80 },
      value: { type: "number" }
    },
    required: ["name", "value"]
  }
};
const pointArray = {
  type: "array",
  maxItems: 80,
  items: {
    type: "object",
    additionalProperties: false,
    properties: {
      label: { type: "string", maxLength: 80 },
      x: { type: "number" },
      y: { type: "number" },
      size: { type: "number" }
    },
    required: ["label", "x", "y", "size"]
  }
};

const CHART_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    type: { enum: ["bar", "stacked-bar", "line", "donut", "scatter", "funnel"] },
    title: { type: "string", maxLength: 100 },
    subtitle: { type: "string", maxLength: 140 },
    note: { type: "string", maxLength: 180 },
    valueFormat: { enum: ["number", "money", "percent"] },
    unit: { type: "string", maxLength: 20 },
    categories: stringArray,
    series: seriesArray,
    items: itemArray,
    points: pointArray,
    centerLabel: { type: "string", maxLength: 40 },
    xLabel: { type: "string", maxLength: 40 },
    yLabel: { type: "string", maxLength: 40 },
    xFormat: { enum: ["number", "money", "percent"] },
    yFormat: { enum: ["number", "money", "percent"] },
    xUnit: { type: "string", maxLength: 20 },
    yUnit: { type: "string", maxLength: 20 }
  },
  required: [
    "type", "title", "subtitle", "note", "valueFormat", "unit", "categories", "series", "items", "points",
    "centerLabel", "xLabel", "yLabel", "xFormat", "yFormat", "xUnit", "yUnit"
  ]
});

const WECOM_RESPONSE_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    answer: { type: "string", maxLength: 6000 },
    chart: { anyOf: [{ type: "null" }, CHART_SCHEMA] }
  },
  required: ["answer", "chart"]
});

function parseAgentResponse(value) {
  let parsed;
  try { parsed = JSON.parse(String(value || "").trim()); } catch { throw new Error("Codex Agent 最终答复不是有效结构化结果。"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Codex Agent 最终答复结构无效。");
  const answer = sanitizeAgentText(parsed.answer, { maxBytes: 18000 });
  if (!answer) throw new Error("Codex Agent 最终答复缺少老板可读结论。");
  const chart = parsed.chart === null || parsed.chart === undefined
    ? null
    : JSON.parse(JSON.stringify(parsed.chart, (_key, item) => typeof item === "string" ? sanitizeAgentText(item, { maxBytes: 500 }) : item));
  if (chart) validateSpec(chart);
  return Object.freeze({ answer, chart });
}

function responseContractHash() {
  return crypto.createHash("sha256").update(JSON.stringify(WECOM_RESPONSE_SCHEMA), "utf8").digest("hex");
}

module.exports = { CHART_SCHEMA, WECOM_RESPONSE_SCHEMA, parseAgentResponse, responseContractHash };
