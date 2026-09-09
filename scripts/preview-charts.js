"use strict";

// Offline design fixtures only. This script is never imported by the business runtime.
const fs = require("node:fs");
const path = require("node:path");
const sharp = require("sharp");
const { render } = require("../shared/xbb/render-chart.js");
const { createWecomAnswerImage } = require("../shared/wecom/chart-image.js");
const common = (type, title, insight) => ({ type, title, subtitle: "设计验收数据 · 非真实经营数据", insight, note: "仅用于检查排版与渲染效果" });
const fixtures = [
  { ...common("bar", "区域回款排名", "华东回款 128 万，领先第二名 32 万"), categories: ["华东增长中心有限公司", "华南增长中心有限公司", "华北企业服务中心", "西南客户成功中心"], series: [{ name: "回款", values: [1280000, 960000, 720000, 510000] }], valueFormat: "money", unit: "" },
  { ...common("line", "月度回款趋势", "7 月达到峰值 142 万，8 月回落至 131 万"), categories: ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月"], series: [{ name: "回款", values: [760000, 920000, 850000, 1120000, 1040000, 1280000, 1420000, 1310000] }], valueFormat: "money", unit: "" },
  { ...common("donut", "收入来源构成", "课程收入 70 万，占展示收入的 58.3%"), items: [{ name: "课程", value: 700000 }, { name: "咨询", value: 300000 }, { name: "门票", value: 120000 }, { name: "商业操盘", value: 80000 }], valueFormat: "money", unit: "", centerLabel: "收入合计" },
  { ...common("stacked-bar", "区域收入结构", "华东总额最高，华南咨询收入占比更高"), categories: ["华东增长中心", "华南增长中心", "华北企业服务", "西南客户成功"], series: [{ name: "课程", values: [800000, 500000, 450000, 300000] }, { name: "咨询", values: [200000, 300000, 150000, 170000] }, { name: "其他", values: [100000, 50000, 80000, 40000] }], valueFormat: "money", unit: "" },
  { ...common("funnel", "商机阶段转化", "100 条初始商机中，20 条进入赢单阶段"), items: [{ name: "发现需求", value: 100 }, { name: "确认需求", value: 72 }, { name: "方案沟通", value: 48 }, { name: "商务谈判", value: 31 }, { name: "赢单", value: 20 }], valueFormat: "number", unit: "条" },
  { ...common("scatter", "商机金额与沉默天数", "沉默 24 天的商机预计金额为 98 万"), points: [4, 9, 3, 14, 8, 17, 5, 21, 12, 24, 15, 7].map((x, i) => ({ label: `商机${String.fromCharCode(65 + i)}`, x, y: [32, 56, 18, 42, 74, 64, 48, 81, 27, 98, 53, 35][i] * 10000, size: 0 })), xLabel: "沉默天数", yLabel: "预计金额", xFormat: "number", yFormat: "money", xUnit: "天", yUnit: "" }
];
fixtures.forEach((spec) => {
  spec.focus = spec.series
    ? { series: spec.type === "stacked-bar" ? "咨询" : spec.series[0].name, category: spec.categories[spec.type === "line" ? 7 : spec.type === "stacked-bar" ? 1 : 0] }
    : { series: "", category: spec.type === "scatter" ? "商机J" : spec.items[spec.type === "funnel" ? 4 : 0].name };
});

async function main() {
  const output = path.resolve(process.argv[2] || "test-results/chart-design");
  fs.mkdirSync(output, { recursive: true });
  const thumbnails = [];
  for (const spec of fixtures) {
    const svg = render(spec);
    fs.writeFileSync(path.join(output, `${spec.type}.svg`), svg);
    const png = await sharp(Buffer.from(svg)).png().toBuffer();
    fs.writeFileSync(path.join(output, `${spec.type}.png`), png);
    thumbnails.push(await sharp(png).resize(600, 550, { fit: "contain", background: "#EBEFED" }).png().toBuffer());
    await sharp(png).resize({ width: 390 }).png().toFile(path.join(output, `${spec.type}-mobile.png`));
  }
  const summary = await createWecomAnswerImage("设计验收数据 · 非真实经营答复\n\n当前没有满足同口径比较条件的数据。\n请明确需要查看的公司和期间，再继续分析回款表现。", { subtitle: "设计验收 · 结论卡" });
  fs.writeFileSync(path.join(output, "answer-summary.png"), summary.buffer);
  await sharp({ create: { width: 1800, height: 1100, channels: 3, background: "#EBEFED" } }).composite(thumbnails.map((input, i) => ({ input, left: i % 3 * 600, top: Math.floor(i / 3) * 550 }))).png().toFile(path.join(output, "overview.png"));
  process.stdout.write(`${JSON.stringify({ output, charts: fixtures.length })}\n`);
}

if (require.main === module) main().catch((error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
module.exports = { fixtures };
