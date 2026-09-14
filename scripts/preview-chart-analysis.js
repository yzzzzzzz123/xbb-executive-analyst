"use strict";

// Explicitly synthetic, internally consistent acceptance data. This module is
// only run offline and must never be imported by the production business path.
const fs = require("node:fs");
const path = require("node:path");
const sharp = require("sharp");
const { render, validateSpec } = require("../shared/xbb/render-chart.js");
const ref = (category, series = "回款") => ({ series, category, axis: "value" });
const relation = (name, subject, baseline = null) => ({ relation: name, subject, baseline });
const common = { insight: "由finding生成", finding: null, focus: null, valueFormat: "money", unit: "" };

const monthly = {
  ...common, type: "line", title: "月度回款：增长与波动", subtitle: "2026年1–8月 · 8个完整自然月",
  note: "按到账日期归月；9月MTD不纳入完整月份比较。",
  categories: ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月"],
  series: [{ name: "回款", values: [760000, 920000, 850000, 1120000, 1040000, 1280000, 1420000, 1310000] }],
  findings: [relation("period-change", ref("8月"), ref("7月")), relation("maximum", ref("7月")), relation("period-change", ref("8月"), ref("1月"))]
};
const companies = {
  ...common, type: "bar", title: "区域回款：排名与集中度", subtitle: "2026年1–8月 · 同一范围的4个区域",
  note: "覆盖全部4个区域；各区域回款合计870万元。",
  categories: ["华东区域", "华南区域", "华北区域", "西南区域"], series: [{ name: "回款", values: [3300000, 2550000, 1740000, 1110000] }],
  findings: [relation("difference", ref("华东区域"), ref("华南区域")), relation("share", ref("华东区域")), relation("top-share", ref("华南区域"))]
};
const products = {
  ...common, type: "donut", title: "产品回款：来源与贡献", subtitle: "2026年1–8月 · 同一范围的全部产品",
  note: "各产品互斥归类，与月度及区域图合计一致。", centerLabel: "累计回款",
  items: [{ name: "课程", value: 5220000 }, { name: "咨询", value: 2175000 }, { name: "门票", value: 870000 }, { name: "商业操盘", value: 435000 }],
  findings: [relation("share", ref("课程", "")), relation("top-share", ref("咨询", "")), relation("difference", ref("课程", ""), ref("咨询", ""))]
};
const composite = { type: "composite", title: "回款经营分析 · 离线虚构验收", subtitle: "2026年1–8月 · 同一统计范围 · 累计870万元",
  note: "所有数字均为一致的离线虚构验收数据，仅用于检查分析表达、算术、布局和手机阅读效果。", panels: [monthly, companies, products] };
const mtd = { ...monthly, title: "完整月与9月MTD的区分", subtitle: "离线虚构验收 · 9月截至14日",
  note: "9月MTD为1–14日累计，虚线表示未完整月；完整月变化仅比较8月和7月。",
  categories: ["7月", "8月", "9月MTD"], series: [{ name: "回款", values: [1420000, 1310000, 560000] }],
  findings: [relation("period-change", ref("8月"), ref("7月")), relation("maximum", ref("7月"))] };

async function main() {
  const output = path.resolve(process.argv[2] || "test-results/chart-analysis-review");
  fs.mkdirSync(output, { recursive: true });
  const results = [];
  for (const [name, spec] of Object.entries({ composite, monthly, companies, products, mtd })) {
    validateSpec(spec);
    // The production renderer source footer is replaced only in this offline
    // artifact to avoid labelling synthetic figures as live CRM records.
    const svg = render(spec).replaceAll("数据来源 / 销帮帮实时只读数据", "数据来源 / 离线虚构验收数据");
    fs.writeFileSync(path.join(output, `${name}.svg`), svg);
    const png = await sharp(Buffer.from(svg), { density: 96 }).png().toBuffer();
    fs.writeFileSync(path.join(output, `${name}.png`), png);
    await sharp(png).resize({ width: 390 }).png().toFile(path.join(output, `${name}-mobile.png`));
    const metadata = await sharp(png).metadata();
    results.push({ name, width: metadata.width, height: metadata.height, bytes: png.length });
  }
  fs.writeFileSync(path.join(output, "acceptance-spec.json"), JSON.stringify(composite, null, 2));
  process.stdout.write(`${JSON.stringify({ mode: "offline-synthetic-only", output, results })}\n`);
}
if (require.main === module) main().catch((error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
module.exports = { composite, monthly, companies, products, mtd };
