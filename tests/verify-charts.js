"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const sharp = require("sharp");
const { CHART_SCHEMA, validateSpec } = require("../skills/xbb-executive-chart/scripts/chart-contract.js");
const { GENERAL_RESPONSE_SCHEMA, WECOM_RESPONSE_SCHEMA, parseAgentResponse } = require("../shared/codex/response-contract.js");
const { render } = require("../shared/xbb/render-chart.js");
const { createWecomAnswerImage, createWecomChartItem, createWecomEmergencyImage, renderAnswerSvg } = require("../shared/wecom/chart-image.js");
const { PALETTE, contrastText, formatValue } = require("../shared/xbb/chart-primitives.js");

const common = (type, title, insight) => ({ type, title, subtitle: "2026年9月｜集团｜截至实时刷新时间", insight, note: "" });
const specs = [
  {
    ...common("bar", "公司业绩排名", "华东增长中心业绩领先，华南增长中心位居第二"),
    categories: ["华东增长中心有限公司", "华南增长中心有限公司", "华北企业服务中心", "西南客户成功中心"],
    series: [{ name: "回款", values: [1280000, 960000, 720000, 510000] }],
    valueFormat: "money",
    unit: ""
  },
  {
    ...common("stacked-bar", "公司回款结构", "公司甲总额最高，公司乙的咨询占比更高"),
    categories: ["公司甲", "公司乙", "公司丙"],
    series: [{ name: "课程", values: [80, 50, 45] }, { name: "咨询", values: [20, 30, 15] }, { name: "其他", values: [10, 5, 8] }],
    valueFormat: "money",
    unit: ""
  },
  {
    ...common("line", "近八月集团业绩趋势", "集团业绩在7月达到阶段高点，8月小幅回落"),
    categories: ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月"],
    series: [{ name: "业绩", values: [98, 99, 98.5, 100, 100.5, 100.2, 101, 100.6] }],
    valueFormat: "number",
    unit: "万"
  },
  {
    ...common("donut", "集团收入构成", "课程收入是当前最大的收入来源"),
    items: [{ name: "课程", value: 700000 }, { name: "咨询", value: 300000 }, { name: "门票", value: 120000 }, { name: "商业操盘", value: 80000 }],
    valueFormat: "money",
    unit: "",
    centerLabel: "收入合计"
  },
  {
    ...common("scatter", "商机沉默风险分布", "右上区域同时具备较高金额和较长沉默时间"),
    points: Array.from({ length: 12 }, (_, index) => ({ label: `商机${index + 1}`, x: 2 + index * 2, y: 20 + index * 8, size: 100 + index * 40 })),
    xLabel: "沉默天数",
    yLabel: "预计金额",
    xFormat: "number",
    yFormat: "money",
    xUnit: "天",
    yUnit: ""
  },
  {
    ...common("funnel", "商机阶段推进", "从发现需求到赢单保留了20%的商机"),
    items: [{ name: "发现需求", value: 10 }, { name: "确认需求", value: 7 }, { name: "解决方案", value: 4 }, { name: "赢单", value: 2 }],
    valueFormat: "number",
    unit: "单"
  }
];

const SUPPORTED_SCHEMA_KEYWORDS = new Set([
  "type", "anyOf", "properties", "required", "additionalProperties", "items",
  "enum", "description", "minLength", "maxLength", "minimum", "minItems", "maxItems"
]);

function assertSupportedOutputSchema(schema, path = "$") {
  assert.ok(schema && typeof schema === "object" && !Array.isArray(schema), `${path} 必须是 Schema 对象`);
  for (const key of Object.keys(schema)) {
    assert.ok(SUPPORTED_SCHEMA_KEYWORDS.has(key), `${path} 使用了 Structured Outputs 不支持的关键字 ${key}`);
  }
  if (schema.type === "object") {
    assert.equal(schema.additionalProperties, false, `${path} 必须禁止额外字段`);
    assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort(), `${path} 的所有字段都必须显式 required`);
  }
  if (schema.properties) {
    for (const [name, propertySchema] of Object.entries(schema.properties)) {
      assertSupportedOutputSchema(propertySchema, `${path}.properties.${name}`);
    }
  }
  if (schema.items) assertSupportedOutputSchema(schema.items, `${path}.items`);
  if (schema.anyOf) schema.anyOf.forEach((variant, index) => assertSupportedOutputSchema(variant, `${path}.anyOf[${index}]`));
}

(async () => {
  assertSupportedOutputSchema(WECOM_RESPONSE_SCHEMA);
  assertSupportedOutputSchema(GENERAL_RESPONSE_SCHEMA);
  assert.equal(CHART_SCHEMA.anyOf.length, 6);
  for (const variant of CHART_SCHEMA.anyOf) {
    assert.equal(variant.type, "object");
    assert.equal(variant.additionalProperties, false);
    assert.deepEqual([...variant.required].sort(), Object.keys(variant.properties).sort());
  }
  const barSchema = CHART_SCHEMA.anyOf.find((variant) => variant.properties.type.enum[0] === "bar");
  assert.ok(barSchema.properties.insight);
  assert.equal(Object.hasOwn(barSchema.properties, "items"), false);

  for (const spec of specs) {
    const normalized = validateSpec(spec);
    assert.ok(Object.isFrozen(normalized));
    assert.ok(Object.isFrozen(normalized.series || normalized.items || normalized.points));
    const svg = render(spec);
    assert.match(svg, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    assert.match(svg, /<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.match(svg, new RegExp(spec.title));
    assert.match(svg, /兼容概述/);
    assert.equal(normalized.finding, null);
    assert.notEqual(normalized.insight, spec.insight, "历史自由洞察不能未经计算原样发布");
    assert.match(svg, /关键发现/);
    assert.doesNotMatch(svg, /<(?:script|foreignObject)\b|\b(?:href|xlink:href)\s*=/i);
    assert.doesNotMatch(svg.replace('xmlns="http://www.w3.org/2000/svg"', ""), /https?:\/\//i);
    assert.ok(Buffer.byteLength(svg, "utf8") > 1500);
  }

  const normalizedBar = validateSpec({ ...specs[0], title: "  公司业绩排名  ", categories: [" 公司甲 ", "公司乙"], series: [{ name: " 回款 ", values: [2, 1] }] });
  assert.equal(normalizedBar.title, "公司业绩排名");
  assert.deepEqual(normalizedBar.categories, ["公司甲", "公司乙"]);
  assert.throws(() => { normalizedBar.categories.push("公司丙"); }, TypeError);

  const parsed = parseAgentResponse(JSON.stringify({ answer: " 真实结论。 ", chart: specs[0] }));
  assert.equal(parsed.chart.insight, validateSpec(specs[0]).insight);
  assert.ok(Object.isFrozen(parsed.chart));

  const longTextChart = {
    ...specs[0],
    insight: "🔎".repeat(160),
    note: "口".repeat(170)
  };
  const longTextParsed = parseAgentResponse(JSON.stringify({ answer: "长字段仍保留文字结论。", chart: longTextChart }));
  assert.match(longTextParsed.chart.insight, /^兼容概述/u);
  assert.doesNotMatch(longTextParsed.chart.insight, /🔎/u);
  assert.equal(Array.from(longTextParsed.chart.note).length, 170);

  let rejectedChartError = null;
  const rejectedChart = parseAgentResponse(JSON.stringify({
    answer: "图表关系错误时仍保留这条真实文字结论。",
    chart: { ...specs[5], items: [{ name: "发现需求", value: 10 }, { name: "确认需求", value: 12 }] }
  }), { onChartInvalid: (error) => { rejectedChartError = error; } });
  assert.match(rejectedChart.answer, /仍保留/);
  assert.equal(rejectedChart.chart, null);
  assert.match(rejectedChartError.message, /非递增/);

  const imageItem = await createWecomChartItem(specs[2]);
  const png = Buffer.from(imageItem.image.base64, "base64");
  const metadata = await sharp(png).metadata();
  assert.equal(imageItem.msgtype, "image");
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(imageItem.image.md5, crypto.createHash("md5").update(png).digest("hex"));
  assert.ok(png.length < 10 * 1024 * 1024);
  assert.equal(metadata.format, "png");
  assert.ok(metadata.width >= 1200 && metadata.height >= 720);

  const summaryImage = await createWecomAnswerImage("集团业绩结论：仅展示已验证文字中的 ¥100，不新增任何数字。<script>不可执行</script>");
  const summaryPng = Buffer.from(summaryImage.item.image.base64, "base64");
  const summaryMetadata = await sharp(summaryPng).metadata();
  assert.equal(summaryImage.kind, "answer-summary");
  assert.equal(summaryMetadata.format, "png");
  assert.ok(summaryMetadata.width >= 1200);
  assert.ok(summaryMetadata.height >= 600, "结论卡随内容调整高度");
  assert.equal(summaryImage.item.image.md5, crypto.createHash("md5").update(summaryPng).digest("hex"));

  const emergencyImage = createWecomEmergencyImage();
  const emergencyPng = Buffer.from(emergencyImage.item.image.base64, "base64");
  const emergencyMetadata = await sharp(emergencyPng).metadata();
  assert.equal(emergencyImage.kind, "safe-placeholder");
  assert.equal(emergencyMetadata.format, "png");
  assert.equal(emergencyMetadata.width, 600);
  assert.equal(emergencyMetadata.height, 240);
  assert.equal(emergencyImage.item.image.md5, crypto.createHash("md5").update(emergencyPng).digest("hex"));

  const percentDonut = {
    ...common("donut", "课程收入占比", "课程收入占70%"),
    items: [{ name: "课程", value: 70 }, { name: "咨询", value: 30 }],
    valueFormat: "percent",
    unit: "",
    centerLabel: "收入占比"
  };
  const percentSvg = render(percentDonut);
  assert.equal((percentSvg.match(/<text\b[^>]*>[^<]*70%/g) || []).length, 3, "洞察、重点数值、明细各一份；不得重复拼接百分比");
  assert.doesNotMatch(percentSvg, /70% · 70%/);

  const percentStack = {
    ...specs[1],
    valueFormat: "percent",
    unit: "",
    series: [
      { name: "课程", values: [33.5, 20, 40] },
      { name: "咨询", values: [33.5, 30, 30] },
      { name: "其他", values: [33.5, 50, 30] }
    ]
  };
  const percentStackSvg = render(percentStack);
  assert.match(percentStackSvg, />100%<\/text>/);
  assert.doesNotMatch(percentStackSvg, />125%<\/text>/);

  const contrastStack = render({
    ...specs[1],
    categories: ["公司甲", "公司乙"],
    series: [
      { name: "课程", values: [25, 25] }, { name: "咨询", values: [25, 25] },
      { name: "门票", values: [25, 25] }, { name: "其他", values: [25, 25] }
    ],
    valueFormat: "percent",
    unit: ""
  });
  const luminance = (hex) => {
    const rgb = hex.slice(1).match(/../g).map((v) => parseInt(v, 16) / 255).map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return rgb.reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
  };
  for (const color of PALETTE.slice(0, 4)) {
    const ink = contrastText(color), first = luminance(color), second = luminance(ink);
    assert.ok((Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05) >= 4.5, `段内文字对比度不足 ${color}`);
    assert.ok(contrastStack.includes(`fill="${ink}"`));
  }

  const roundedPercentDonut = render({
    ...percentDonut,
    insight: "三个构成项各约占三分之一",
    items: [{ name: "课程", value: 33.5 }, { name: "咨询", value: 33.5 }, { name: "其他", value: 33.5 }]
  });
  assert.match(roundedPercentDonut, />100%<\/text>/);

  const unsortedBar = render({
    ...specs[0],
    categories: ["较低", "最高", "居中"],
    series: [{ name: "回款", values: [10, 30, 20] }]
  });
  const lowCategory = unsortedBar.indexOf(">较低</text>");
  const highCategory = unsortedBar.indexOf(">最高</text>");
  const middleCategory = unsortedBar.indexOf(">居中</text>");
  assert.match(unsortedBar.slice(lowCategory, highCategory), /data-value="10" data-baseline="0"/);
  assert.match(unsortedBar.slice(highCategory, middleCategory), /data-value="30" data-baseline="0"/);
  const widths = [...unsortedBar.matchAll(/width="([\d.]+)"[^>]+data-value="([\d.]+)" data-baseline="0"/g)].map((m) => Number(m[1]) / Number(m[2]));
  assert.ok(widths.every((w) => Math.abs(w - widths[0]) < 0.001), "条长必须从零开始并使用统一比例尺");

  const denseLine = render({
    ...specs[2],
    categories: Array.from({ length: 30 }, (_, index) => `M${String(index + 1).padStart(2, "0")}`),
    series: [{ name: "业绩", values: Array.from({ length: 30 }, (_, index) => 98 + index / 10) }]
  });
  const labelXs = [...denseLine.matchAll(/<text x="([\d.]+)" y="[\d.]+"[^>]*>M\d{2}<\/text>/g)].map((match) => Number(match[1]));
  assert.ok(labelXs.length >= 2 && labelXs.length <= 9);
  assert.ok(labelXs.slice(1).every((value, index) => value - labelXs[index] >= 80));

  const boundaryScatter = render({
    ...common("scatter", "边界散点", "边界气泡仍完整位于绘图区内"),
    points: [{ label: "右上边界", x: 100, y: 100, size: 100 }, { label: "左下边界", x: 0, y: 0, size: 100 }],
    xLabel: "完成率",
    yLabel: "转化率",
    xFormat: "percent",
    yFormat: "percent",
    xUnit: "",
    yUnit: ""
  });
  const bubbles = [...boundaryScatter.matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)" fill="#[0-9A-F]+" opacity="0\.85"/g)]
    .map((match) => ({ x: Number(match[1]), y: Number(match[2]), radius: Number(match[3]) }));
  assert.equal(bubbles.length, 2);
  assert.ok(bubbles.every((bubble) => bubble.x - bubble.radius >= 137 && bubble.x + bubble.radius <= 814));
  assert.ok(bubbles.every((bubble) => bubble.y - bubble.radius >= 300 && bubble.y + bubble.radius <= 760));

  for (const spec of specs) {
    assert.equal(validateSpec(spec).focus, null, "旧规格仍可用");
    const focus = spec.series ? { series: spec.series[0].name, category: spec.categories.at(-1) }
      : { series: "", category: (spec.items || spec.points).at(-1).name || spec.points.at(-1).label };
    const first = spec.series ? { series: spec.series[0].name, category: spec.categories[0] }
      : { series: "", category: (spec.items || spec.points)[0].name || spec.points[0].label };
    const axis = spec.type === "scatter" ? "y" : "value";
    const finding = { relation: "difference", subject: { ...focus, axis }, baseline: { ...first, axis } };
    const normalized = validateSpec({ ...spec, focus, finding });
    assert.deepEqual(normalized.focus, focus);
    assert.ok(Object.isFrozen(normalized.focus));
    assert.doesNotThrow(() => render(normalized));
    assert.throws(() => validateSpec({ ...spec, focus: { ...focus, category: "不存在的重点" } }), /focus.category/);
    assert.throws(() => validateSpec({ ...spec, focus: { ...focus, color: "red" } }), /不支持字段/);
  }
  const focusedBar = render({ ...specs[0], focus: null, finding: { relation: "difference",
    subject: { series: "回款", category: specs[0].categories[3], axis: "value" }, baseline: { series: "回款", category: specs[0].categories[0], axis: "value" } } });
  assert.match(focusedBar, /距最高差 ¥77万/);
  assert.match(focusedBar, /fill="#087F8C" data-value="510000" data-baseline="0"/);
  const percentLine = render({ ...specs[2], categories: ["一月", "二月", "三月", "四月"], series: [{ name: "完成率", values: [40, 50, 55, 70] }], valueFormat: "percent", unit: "", focus: null,
    finding: { relation: "period-change", subject: { series: "完成率", category: "三月", axis: "value" }, baseline: { series: "完成率", category: "二月", axis: "value" } } });
  assert.match(percentLine, /\+5 个百分点/);
  assert.match(percentLine, /峰值 70%/);

  const preciseMoneyLine = render({ ...specs[2], categories: ["一月", "二月", "三月", "四月"], series: [{ name: "回款", values: [100000000, 100000020, 100000050, 100000100] }], valueFormat: "money", unit: "" });
  const preciseTicks = [...preciseMoneyLine.matchAll(/<text x="121"[^>]*>([^<]+)<\/text>/g)].map((m) => m[1]);
  assert.ok(preciseTicks.length >= 3);
  assert.equal(new Set(preciseTicks).size, preciseTicks.length, "相邻轴刻度不能被万/亿舍入成相同文本");
  const tinyLine = render({ ...specs[2], categories: ["一月", "二月", "三月", "四月"], series: [{ name: "微小值", values: [1e-12, 2e-12, 3e-12, 4e-12] }], unit: "" });
  const tinyTicks = [...tinyLine.matchAll(/<text x="121"[^>]*>([^<]+)<\/text>/g)].map((m) => m[1]);
  assert.equal(new Set(tinyTicks).size, tinyTicks.length);
  assert.ok(tinyTicks.some((v) => v.includes("e-")), "极小数转科学计数法而非舍入成零");
  const zeroLine = render({ ...specs[2], categories: Array.from({ length: 30 }, (_, i) => `M${i + 1}`), series: [{ name: "零值", values: Array(30).fill(0) }], focus: { series: "零值", category: "M2" } });
  assert.doesNotMatch(zeroLine, />峰值 /, "全相等序列不添加额外峰值标签");

  const narrowScatter = render({ ...specs[4], points: [{ label: "甲", x: 10000, y: 10000, size: 100 }, { label: "乙", x: 10001, y: 10001, size: 0 }] });
  const gridXs = [...narrowScatter.matchAll(/<line x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)"/g)].filter((m) => m[1] === m[3] && m[2] !== m[4]).map((m) => Number(m[1]));
  assert.ok(gridXs.length >= 3 && Math.max(...gridXs) - Math.min(...gridXs) > 400, "补入零点后刻度必须覆盖完整散点坐标域");
  assert.match(narrowScatter, /r="3" fill="none" opacity="0.85"/);
  assert.match(narrowScatter, /空心点：大小指标为 0/);
  const longCenter = render({ ...specs[3], centerLabel: "全部已验证人数".repeat(5), valueFormat: "number", unit: "人" });
  assert.doesNotMatch(longCenter, />收入构成<\/text>/);
  assert.match(longCenter, />合计<\/text>/);
  assert.ok(formatValue(0.0001, "money").includes("1.0e-4"), "真实小数不能被写成零");

  const longSummary = renderAnswerSvg(Array.from({ length: 30 }, (_, i) => `第${i + 1}项：已核对文字答复中的内容。`).join("\n"));
  const summaryHeight = Number(longSummary.match(/<svg[^>]*height="(\d+)"/)[1]);
  assert.ok(summaryHeight > 900);
  assert.ok([...longSummary.matchAll(/<text[^>]* y="([\d.]+)"/g)].every((m) => Number(m[1]) < summaryHeight - 15));
  assert.match(longSummary, /…<\/text>/);
  assert.doesNotMatch(renderAnswerSvg("<script>不执行</script>"), /<script>/);

  assert.throws(() => render({ type: "pie", title: "错误类型" }), /type/);
  assert.throws(() => validateSpec({ ...specs[0], color: "red" }), /不支持字段 color/);
  assert.throws(() => validateSpec({ ...specs[0], insight: undefined }), /insight/);
  assert.throws(() => validateSpec({ ...specs[0], series: [{ name: "回款", values: ["2", 1, 0, 0] }] }), /有限数字/);
  assert.throws(() => validateSpec({ ...specs[0], series: [{ name: "回款", values: [-1, 1, 0, 0] }] }), /负数/);
  assert.throws(() => validateSpec({ ...specs[0], valueFormat: "percent", series: [{ name: "占比", values: [101, 1, 0, 0] }] }), /0–100/);
  assert.throws(() => validateSpec({ ...specs[0], categories: ["公司甲", " 公司甲 ", "公司乙", "公司丙"] }), /不能重复/);
  assert.throws(() => validateSpec({ ...specs[5], items: [{ name: "发现需求", value: 10 }, { name: "确认需求", value: 12 }] }), /非递增/);
  assert.throws(() => validateSpec({ ...percentDonut, items: Array.from({ length: 9 }, (_, index) => ({ name: `类别${index}`, value: 1 })) }), /2–8/);
  assert.throws(() => validateSpec({ ...percentDonut, items: [{ name: "课程", value: 70 }, { name: "咨询", value: 20 }] }), /合计必须为 100/);
  assert.throws(() => validateSpec({ ...percentStack, series: [{ name: "课程", values: [70, 50, 40] }, { name: "咨询", values: [20, 50, 60] }] }), /合计必须为 100/);
  assert.throws(() => validateSpec({ ...specs[0], unit: "万" }), /money 格式下必须为空/);
  assert.throws(() => validateSpec({ ...percentDonut, unit: "个百分点" }), /percent 格式下必须为空/);

  const escapedSvg = render({ ...specs[0], title: "<script>不是脚本</script>" });
  assert.doesNotMatch(escapedSvg, /<script>/i);
  assert.match(escapedSvg, /&lt;script&gt;/);

  process.stdout.write(`${JSON.stringify({ success: true, chartTypes: specs.map((spec) => spec.type), schemaVariants: CHART_SCHEMA.anyOf.length, wecomPng: true, png: { width: metadata.width, height: metadata.height } })}\n`);
})().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
