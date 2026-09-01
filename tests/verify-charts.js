"use strict";

const assert = require("node:assert/strict");
const { render } = require("../shared/xbb/render-chart.js");

const specs = [
  { type: "bar", title: "公司排名", categories: ["公司A", "公司B"], series: [{ name: "业绩", values: [100, 80] }], valueFormat: "money" },
  { type: "stacked-bar", title: "收入结构", categories: ["公司A", "公司B"], series: [{ name: "课程", values: [80, 50] }, { name: "咨询", values: [20, 30] }], valueFormat: "money" },
  { type: "line", title: "日度趋势", categories: ["09-01", "09-02", "09-03"], series: [{ name: "业绩", values: [10, 30, 25] }], valueFormat: "money" },
  { type: "donut", title: "集团结构", items: [{ name: "课程", value: 70 }, { name: "咨询", value: 30 }], valueFormat: "percent" },
  { type: "scatter", title: "商机沉默风险", points: [{ label: "商机A", x: 20, y: 100, size: 1000 }, { label: "商机B", x: 5, y: 30, size: 200 }], xLabel: "沉默天数", yLabel: "预计金额", yFormat: "money" },
  { type: "funnel", title: "商机阶段", items: [{ name: "发现需求", value: 10 }, { name: "确认需求", value: 7 }, { name: "解决方案", value: 4 }, { name: "赢单", value: 2 }] }
];

for (const spec of specs) {
  const svg = render(spec);
  assert.match(svg, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(svg, /<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, new RegExp(spec.title));
  assert.doesNotMatch(svg, /<(?:script|foreignObject)\b|\b(?:href|xlink:href)\s*=/i);
  assert.doesNotMatch(svg.replace('xmlns="http://www.w3.org/2000/svg"', ""), /https?:\/\//i);
  assert.ok(Buffer.byteLength(svg, "utf8") > 1000);
}

assert.throws(() => render({ type: "pie", title: "错误类型" }), /type/);
process.stdout.write(`${JSON.stringify({ success: true, chartTypes: specs.map((spec) => spec.type) })}\n`);
