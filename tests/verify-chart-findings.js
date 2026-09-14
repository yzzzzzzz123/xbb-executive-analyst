"use strict";

const assert = require("node:assert/strict");
const sharp = require("sharp");
const { CHART_SCHEMA, validateSpec } = require("../skills/xbb-executive-chart/scripts/chart-contract.js");
const { render } = require("../shared/xbb/render-chart.js");
const { createWecomChartImage } = require("../shared/wecom/chart-image.js");
const { parseAgentResponse } = require("../shared/codex/response-contract.js");

// Every number below is a synthetic arithmetic fixture, never a business fact.
const common = { title: "离线计算验收", subtitle: "虚构数据，不是经营结果", note: "离线虚构验收，仅验证引用关系与算术", insight: "乙比甲下降了九成", focus: null };
const ref = (category, series = "指标", axis = "value") => ({ series, category, axis });
const finding = (relation, subject, baseline = null) => ({ relation, subject, baseline });
const bar = { ...common, type: "bar", categories: ["甲", "乙"], series: [{ name: "指标", values: [10, 30] }], valueFormat: "number", unit: "单" };
const line = { ...bar, type: "line", categories: ["一期", "二期", "三期", "四期"], series: [{ name: "指标", values: [10, 20, 30, 40] }] };
const donut = { ...common, type: "donut", items: [{ name: "甲", value: 30 }, { name: "乙", value: 70 }], valueFormat: "number", unit: "单", centerLabel: "合计" };
const stacked = { ...bar, type: "stacked-bar", series: [{ name: "课程", values: [80, 60] }, { name: "咨询", values: [20, 40] }] };
const funnel = { ...common, type: "funnel", items: [{ name: "开始", value: 100 }, { name: "中间", value: 40 }, { name: "完成", value: 20 }], valueFormat: "number", unit: "单" };
const scatter = { ...common, type: "scatter", points: [{ label: "甲", x: 10, y: 50, size: 0 }, { label: "乙", x: 20, y: 80, size: 0 }],
  xFormat: "number", yFormat: "money", xUnit: "天", yUnit: "", xLabel: "时长", yLabel: "金额" };

function changed(spec, relation, subject, baseline) {
  return validateSpec({ ...spec, finding: finding(relation, subject, baseline) });
}

async function run() {
  const difference = changed(bar, "difference", ref("乙"), ref("甲"));
  assert.equal(difference.insight, "「指标·乙」比「指标·甲」高20单。");
  assert.deepEqual(difference.focus, { series: "指标", category: "乙" });
  assert.doesNotMatch(render(difference), /下降了九成/u, "Contradictory prose must never survive chart normalization");
  assert.deepEqual(changed(bar, "difference", ref("甲"), ref("乙")).focus, { series: "指标", category: "甲" }, "A lower point can be the finding, never force maximum focus");
  assert.match(changed(bar, "difference", ref("甲"), ref("乙")).insight, /低20单/u);
  assert.match(changed({ ...bar, series: [{ name: "指标", values: [30, 30] }] }, "difference", ref("甲"), ref("乙")).insight, /相同，差值为0单/u);
  assert.match(changed({ ...bar, valueFormat: "money", unit: "" }, "difference", ref("乙"), ref("甲")).insight, /高20元/u);
  assert.match(changed({ ...bar, valueFormat: "percent", unit: "" }, "difference", ref("乙"), ref("甲")).insight, /高20个百分点/u);
  const percentChange = changed({ ...line, valueFormat: "percent", unit: "" }, "period-change", ref("四期"), ref("二期"));
  assert.match(percentChange.insight, /增加20个百分点/u);
  assert.doesNotMatch(percentChange.insight, /变化100%/u, "Percentage-point change is not a relative percentage");
  const change = changed(line, "period-change", ref("四期"), ref("二期"));
  assert.match(change.insight, /增加20单，变化率100%/u);
  assert.match(changed({ ...line, series: [{ name: "指标", values: [10, -10, 0, 1] }] }, "period-change", ref("二期"), ref("一期")).insight, /减少20单，变化率-200%/u);

  // Realistic operating scenario with synthetic amounts: an annual collection
  // curve may include September MTD while comparing complete July and August.
  const annualCollections = { ...common, type: "line", title: "年度回款趋势（离线虚构验收）",
    subtitle: "2026年1–9月，9月MTD截至14日", note: "1–8月为完整自然月；9月MTD仅为1–14日累计，不与完整月计算变化率。",
    categories: ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月MTD"],
    series: [{ name: "回款", values: [760000, 920000, 850000, 1120000, 1040000, 1280000, 1420000, 1310000, 560000] }],
    valueFormat: "money", unit: "" };
  const completeMonthChange = changed(annualCollections, "period-change", ref("8月", "回款"), ref("7月", "回款"));
  assert.match(completeMonthChange.insight, /减少11万元，变化率约-7\.746%/u);
  assert.equal(completeMonthChange.categories.at(-1), "9月MTD", "有效比较不删掉同图中的MTD数据");
  assert.deepEqual(completeMonthChange.focus, { series: "回款", category: "8月" });
  const annualSvg = render(completeMonthChange);
  assert.match(annualSvg, /data-partial-period="true"/u);
  assert.match(annualSvg, /9月MTD/u);
  assert.match(annualSvg, /约-7\.746%/u);
  const invalidMtdComparison = { ...annualCollections,
    finding: finding("period-change", ref("9月MTD", "回款"), ref("8月", "回款")) };
  assert.throws(() => validateSpec(invalidMtdComparison), /subject 或 baseline 标记为未完整期间/u);
  const preservedAnnualAnswer = parseAgentResponse(JSON.stringify({ answer: "8月完整月较7月减少11万元；9月仅截至14日。", chart: invalidMtdComparison }));
  assert.equal(preservedAnnualAnswer.chart, null);
  assert.match(preservedAnnualAnswer.answer, /8月完整月较7月减少11万元/u);

  const share = changed(donut, "share", ref("甲", ""));
  assert.match(share.insight, /占所示合计30%（合计100单）/u);
  const stackShare = changed(stacked, "share", ref("乙", "咨询"));
  assert.match(stackShare.insight, /该类别所示合计40%（合计100单）/u);
  assert.deepEqual(stackShare.focus, { series: "咨询", category: "乙" });
  assert.match(changed({ ...donut, items: [{ name: "甲", value: 1 }, { name: "乙", value: 2 }] }, "share", ref("甲", "")).insight, /约33\.33%/u);
  const retention = changed(funnel, "retention", ref("完成", ""), ref("中间", ""));
  assert.match(retention.insight, /从「中间」到「完成」，保留50%/u);
  assert.match(changed(funnel, "loss", ref("完成", ""), ref("开始", "")).insight, /流失80%/u);
  assert.match(changed({ ...funnel, items: [{ name: "开始", value: 10 }, { name: "完成", value: 0 }] }, "retention", ref("完成", ""), ref("开始", "")).insight, /保留0%/u);
  assert.match(changed({ ...funnel, valueFormat: "percent", unit: "" }, "retention", ref("完成", ""), ref("中间", "")).insight, /保留50%/u);
  const pointDifference = changed(scatter, "difference", ref("乙", "", "y"), ref("甲", "", "y"));
  assert.match(pointDifference.insight, /高30元/u);
  assert.match(pointDifference.insight, /y轴（金额）/u);

  const ranked = { ...bar, categories: ["乙", "丁", "甲", "丙"], series: [{ name: "指标", values: [30, 10, 50, 10] }] };
  assert.match(changed(ranked, "maximum", ref("甲"), null).insight, /所示4项中的最高值：50单/u);
  assert.match(changed(ranked, "minimum", ref("丁"), null).insight, /并列最低值：10单/u);
  assert.match(changed(ranked, "share", ref("甲"), null).insight, /该系列所示合计50%（合计100单）/u);
  assert.match(changed(ranked, "top-share", ref("乙"), null).insight, /前2项.*合计80单.*80%（合计100单）/u);
  const rankedDonut = { ...donut, items: ranked.categories.map((name, index) => ({ name, value: ranked.series[0].values[index] })) };
  assert.match(changed(rankedDonut, "top-share", ref("乙", ""), null).insight, /前2项.*80%/u);
  const relationships = [finding("maximum", ref("甲"), null), finding("difference", ref("甲"), ref("乙")), finding("top-share", ref("乙"), null)];
  const analysis = validateSpec({ ...ranked, finding: null, findings: relationships });
  assert.equal(analysis.findings.length, 3);
  assert.deepEqual(analysis.finding, relationships[0]);
  assert.deepEqual(analysis.focus, { series: "指标", category: "甲" });
  assert.deepEqual(validateSpec(JSON.parse(JSON.stringify(analysis))), analysis);
  assert.ok(Object.isFrozen(analysis.findings) && Object.isFrozen(analysis.findings[1]));
  const analysisSvg = render(analysis);
  assert.equal((analysisSvg.match(/data-finding="/gu) || []).length, 3);
  assert.match(analysisSvg, /最高值：50单|高20单|合计80单/u);
  const fourFindings = validateSpec({ ...ranked, findings: [...relationships, finding("minimum", ref("丁"), null)] });
  assert.equal(fourFindings.findings.length, 4);
  assert.equal((render(fourFindings).match(/data-finding="/gu) || []).length, 4);
  for (const invalidAnalysis of [
    { ...ranked, finding: finding("maximum", ref("乙"), null) },
    { ...ranked, finding: finding("maximum", ref("甲"), ref("乙")) },
    { ...bar, series: [{ name: "指标", values: [10, 10] }], finding: finding("minimum", ref("甲"), null) },
    { ...ranked, finding: finding("top-share", ref("丙"), null) },
    { ...bar, finding: finding("top-share", ref("甲"), null) },
    { ...ranked, series: [...ranked.series, { name: "第二", values: [1, 2, 3, 4] }], finding: finding("top-share", ref("乙"), null) },
    { ...ranked, findings: [relationships[0], relationships[0]] },
    { ...ranked, findings: Array(5).fill(relationships[0]) },
    { ...ranked, findings: [null] },
    { ...ranked, findings: null },
    { ...ranked, findings: [{ ...relationships[0], text: "虚构事实" }] },
    { ...ranked, finding: relationships[1], findings: relationships },
    { ...line, categories: ["一期", "二期", "三期", "四期MTD"], finding: finding("period-change", ref("四期MTD"), ref("三期")) }
  ]) assert.throws(() => validateSpec(invalidAnalysis), /finding|findings/u);
  const evidenceLine = { ...line, finding: finding("period-change", ref("四期"), ref("三期")) };
  assert.match(render(evidenceLine), /逐期数值/u);
  for (const category of evidenceLine.categories) assert.ok(render(evidenceLine).includes(category));

  const longNames = ["具有完全相同的类别名称前缀甲", "具有完全相同的类别名称前缀乙"];
  const longSeries = ["具有完全相同的系列名称前缀甲", "具有完全相同的系列名称前缀乙"];
  const collisionSpecs = [
    { ...bar, categories: longNames, finding: finding("difference", ref(longNames[1]), ref(longNames[0])) },
    { ...bar, series: longSeries.map((name, index) => ({ name, values: [10 + index, 30 + index] })), finding: finding("difference", ref("乙", longSeries[1]), ref("乙", longSeries[0])) },
    { ...donut, items: longNames.map((name, index) => ({ name, value: 10 + index })), finding: finding("difference", ref(longNames[1], ""), ref(longNames[0], "")) },
    { ...scatter, points: longNames.map((label, index) => ({ label, x: index, y: index, size: 0 })), finding: finding("difference", ref(longNames[1], "", "y"), ref(longNames[0], "", "y")) }
  ];
  for (const spec of collisionSpecs) {
    const normalized = validateSpec(spec);
    assert.match(normalized.insight, /〔(?:系列|项目|点)/u);
    const displayedLabels = [...normalized.insight.matchAll(/「([^」]+)」/gu)].map((match) => match[1]);
    assert.equal(new Set(displayedLabels).size, 2, "Truncated labels must remain visually distinct");
    assert.deepEqual(normalized.finding.subject, spec.finding.subject, "Disambiguation never rewrites real evidence references");
    assert.ok(Array.from(normalized.insight).length <= 160);
    assert.deepEqual(validateSpec(normalized), normalized);
    const compatibility = validateSpec({ ...spec, finding: null });
    assert.deepEqual(validateSpec(compatibility), compatibility);
  }
  const maximalLegacy = validateSpec({ ...bar, categories: ["名字".repeat(39) + "甲", "名字".repeat(39) + "乙"],
    series: [{ name: "系列".repeat(40), values: [Number.MAX_VALUE, Number.MAX_VALUE] }], unit: "单位".repeat(10) });
  assert.ok(Array.from(maximalLegacy.insight).length <= 160, "Legacy maximum names, units and finite values retain a bounded overview");
  assert.deepEqual(validateSpec(maximalLegacy), maximalLegacy);

  for (const spec of [bar, stacked, line, donut, scatter, funnel]) {
    const old = { ...spec, focus: spec.series ? { series: spec.series[0].name, category: spec.categories[0] }
      : { series: "", category: (spec.items || spec.points)[0].name || spec.points[0].label } };
    const normalized = validateSpec(old);
    assert.doesNotMatch(normalized.insight, /兼容概述|图内计算/u);
    assert.notEqual(normalized.insight, old.insight);
    assert.equal(normalized.finding, null);
    assert.equal(normalized.focus, null, "Unverified legacy focus does not become a claimed finding");
    assert.deepEqual(validateSpec(normalized), normalized, "Legacy normalization is idempotent");
  }
  for (const spec of [difference, stackShare, change, share, pointDifference, retention]) {
    assert.ok(Object.isFrozen(spec.finding) && Object.isFrozen(spec.finding.subject) && Object.isFrozen(spec.focus));
    assert.deepEqual(validateSpec(spec), spec, "Finding normalization is idempotent across parse/render passes");
    assert.deepEqual(validateSpec(JSON.parse(JSON.stringify(spec))), spec, "Serialization cannot change finding meaning");
    const svg = render(spec);
    assert.ok(svg.includes(spec.insight), "已校验算术发现须在图或相邻证据注释显示");
    assert.match(svg, /data-finding="1"/u);
    assert.doesNotMatch(svg, /兼容概述|图内计算/u);
    assert.doesNotMatch(svg, /下降了九成/u);
    const parsed = parseAgentResponse(JSON.stringify({ answer: "保留独立文字答复。", chart: spec }));
    assert.deepEqual(parsed.chart, spec);
  }
  const png = await createWecomChartImage(retention);
  assert.equal((await sharp(png.buffer).metadata()).format, "png");
  assert.ok(png.buffer.length < 10 * 1024 * 1024);
  for (const variant of CHART_SCHEMA.anyOf.flatMap((entry) => entry.properties.panels?.items.anyOf || [entry])) {
    assert.ok(variant.required.includes("finding"));
    assert.ok(variant.properties.finding.anyOf.some((entry) => entry.type === "null"));
  }
  assert.deepEqual(changed(bar, "difference", ref(" 乙 ", " 指标 "), ref(" 甲 ", " 指标 ")), difference);

  const invalid = [
    { ...bar, finding: finding("difference", ref("不存在"), ref("甲")) },
    { ...bar, finding: finding("difference", ref("乙", "不存在"), ref("甲")) },
    { ...bar, finding: finding("difference", ref("乙", "指标", "x"), ref("甲")) },
    { ...bar, finding: finding("difference", ref("甲"), ref("甲")) },
    { ...bar, finding: finding("difference", ref("乙"), null) },
    { ...bar, finding: { relation: "difference", subject: ref("乙") } },
    { ...bar, finding: { ...finding("difference", ref("乙"), ref("甲")), claimedResult: 999 } },
    { ...bar, finding: finding("difference", { ...ref("乙"), value: 999 }, ref("甲")) },
    { ...bar, finding: finding("causes", ref("乙"), ref("甲")) },
    { ...bar, finding: [] },
    { ...bar, finding: undefined },
    { ...bar, unit: "%", finding: finding("difference", ref("乙"), ref("甲")) },
    { ...difference, focus: { series: "指标", category: "甲" } },
    { ...line, finding: finding("period-change", ref("二期"), ref("四期")) },
    { ...line, series: [...line.series, { name: "另一个指标", values: [1, 2, 3, 4] }], finding: finding("period-change", ref("四期"), ref("一期", "另一个指标")) },
    { ...line, series: [{ name: "指标", values: [0, 2, 3, 4] }], finding: finding("period-change", ref("二期"), ref("一期")) },
    { ...line, series: [{ name: "指标", values: [-1, 2, 3, 4] }], finding: finding("period-change", ref("二期"), ref("一期")) },
    { ...donut, finding: finding("share", ref("甲", ""), ref("乙", "")) },
    { ...donut, finding: finding("period-change", ref("乙", ""), ref("甲", "")) },
    { ...donut, valueFormat: "percent", unit: "", items: [{ name: "甲", value: 33.5 }, { name: "乙", value: 67 }], finding: finding("share", ref("甲", "")) },
    { ...stacked, series: [{ name: "课程", values: [0, 1] }, { name: "咨询", values: [0, 2] }], finding: finding("share", ref("甲", "咨询")) },
    { ...funnel, finding: finding("retention", ref("开始", ""), ref("完成", "")) },
    { ...funnel, items: [{ name: "开始", value: 10 }, { name: "中间", value: 0 }, { name: "完成", value: 0 }], finding: finding("loss", ref("完成", ""), ref("中间", "")) },
    { ...scatter, finding: finding("difference", ref("乙", "", "x"), ref("甲", "", "y")) },
    { ...scatter, finding: finding("difference", ref("乙", "", "size"), ref("甲", "", "size")) }
  ];
  for (const spec of invalid) {
    assert.throws(() => validateSpec(spec), /finding|focus/u);
    // Undefined cannot occur in JSON. Exercise the actual serialized failure
    // path only for invalid values that survive JSON transport.
    if (spec.finding === undefined) continue;
    let invalidReported = false;
    const parsed = parseAgentResponse(JSON.stringify({ answer: "坏图只降级，不丢这条文字。", chart: spec }), { onChartInvalid: () => { invalidReported = true; } });
    assert.equal(parsed.chart, null);
    assert.equal(invalidReported, true);
    assert.match(parsed.answer, /不丢/u);
  }

  const decimalDifference = changed({ ...bar, series: [{ name: "指标", values: [0.1, 0.3] }] }, "difference", ref("乙"), ref("甲"));
  assert.match(decimalDifference.insight, /高0\.2单/u);
  assert.doesNotMatch(decimalDifference.insight, /约|999999|0000001/u);
  const tiny = changed({ ...bar, series: [{ name: "指标", values: [5e-324, 1e-323] }] }, "difference", ref("乙"), ref("甲"));
  assert.match(tiny.insight, /高5e-324单/u);
  assert.doesNotThrow(() => changed({ ...bar, series: [{ name: "指标", values: [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1] }] }, "difference", ref("乙"), ref("甲")));
  assert.match(changed({ ...bar, series: [{ name: "指标", values: [0, Number.MAX_VALUE] }] }, "difference", ref("乙"), ref("甲")).insight, /e\+308/u);
  assert.throws(() => changed({ ...line, series: [{ name: "指标", values: [-Number.MAX_VALUE, Number.MAX_VALUE, 0, 1] }] }, "difference", ref("二期"), ref("一期")), /溢出/u);
  assert.throws(() => changed({ ...line, series: [{ name: "指标", values: [Number.MIN_VALUE, 1, 2, 3] }] }, "period-change", ref("二期"), ref("一期")), /溢出/u);
  assert.throws(() => changed({ ...donut, items: [{ name: "甲", value: Number.MIN_VALUE }, { name: "乙", value: 1e308 }] }, "share", ref("甲", "")), /下溢/u);
  for (const value of [null, undefined, NaN, Infinity, "1"]) assert.throws(() => changed({ ...bar, series: [{ name: "指标", values: [value, 2] }] }, "difference", ref("乙"), ref("甲")), /有限数字/u);
  // Rounding tolerance remains available to legacy charts, but cannot become
  // the denominator of a purportedly exact percentage finding.
  assert.doesNotThrow(() => validateSpec({ ...donut, valueFormat: "percent", unit: "", items: [{ name: "甲", value: 33.5 }, { name: "乙", value: 67 }] }));
  process.stdout.write(`${JSON.stringify({ success: true, mode: "synthetic-chart-local-findings", chartTypes: 6, invalidCases: invalid.length + 14,
    checks: "computed-insight/focus/ref-units/zero-overflow-underflow/decimal/compatibility/idempotence/findings-4/extrema/top-share/MTD/parse-degrade/svg/png", sourceFactBinding: false })}\n`);
}

run().catch((error) => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; });
