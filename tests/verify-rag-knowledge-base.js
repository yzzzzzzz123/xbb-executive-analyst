"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const {
  INDEX_VERSION,
  MAX_CHUNK_BYTES,
  SkillKnowledgeBase,
  cosineSimilarity,
  detectedDomains,
  sparseVector,
  splitMarkdown,
  termFrequencies
} = require("../shared/rag/skill-knowledge-base.js");
const { isBusinessFollowUp, isExplicitXbbQuestion, routeSkill } = require("../shared/rag/skill-router.js");
const { chooseTurnEffort, isSchemaOnlyQuestion, parseMonths, planFastQuery, routeDomains } = require("../shared/xbb/fast-query-plan.js");

const projectRoot = path.resolve(__dirname, "..");
const knowledgeBase = new SkillKnowledgeBase(projectRoot);
const stats = knowledgeBase.stats();
assert.equal(stats.sources, 7);
assert.ok(stats.chunks >= 15);
assert.ok(stats.sourceBytes > 25000);
assert.match(stats.digest, /^[a-f0-9]{64}$/);
assert.equal(stats.indexVersion, INDEX_VERSION);
assert.equal(stats.maxChunkBytes, MAX_CHUNK_BYTES);
assert.equal(knowledgeBase.chunks.every((chunk) => Buffer.byteLength(chunk.text, "utf8") <= MAX_CHUNK_BYTES), true);

assert.equal(isExplicitXbbQuestion("对集团业绩按公司排名，区分课程和咨询占比"), true);
assert.equal(isExplicitXbbQuestion("这个月公司的经营情况怎么样"), true);
assert.equal(isExplicitXbbQuestion("业绩订单表 5614255 的 text_63 是什么字段"), true);
assert.equal(isExplicitXbbQuestion("OPP订单的表单ID怎么配置"), true);
assert.equal(isExplicitXbbQuestion("帮我写一份销售方案"), false);
assert.equal(isExplicitXbbQuestion("介绍一下公司法"), false);
assert.equal(isExplicitXbbQuestion("把下面这段话翻译成英文"), false);
assert.equal(isBusinessFollowUp("1"), true);
assert.equal(isBusinessFollowUp("为什么"), true);
assert.equal(isBusinessFollowUp("真实的说"), true);
assert.equal(isBusinessFollowUp("只看风险"), true);
assert.equal(isBusinessFollowUp("为什么天空是蓝色的"), false);
assert.deepEqual(routeSkill("全年业绩", null), { mode: "xbb", reason: "explicit-business-intent" });
assert.deepEqual(routeSkill("继续", "xbb"), { mode: "xbb", reason: "business-follow-up" });
assert.deepEqual(routeSkill("继续", "general"), { mode: "general", reason: "general-intent" });
assert.deepEqual(routeSkill("帮我写会议通知", "xbb"), { mode: "general", reason: "general-intent" });
assert.deepEqual(routeSkill("证明临界 Sobolev 方程的所有正有限能量解都是标准泡状解", "xbb"), { mode: "general", reason: "general-intent" });

const performance = knowledgeBase.retrieve("对集团业绩按公司排名，区分课程和咨询占比");
assert.ok(performance.bytes <= 14000);
assert.ok(performance.sources.length <= 8);
assert.ok(performance.domains.includes("performance"));
assert.match(performance.text, /业绩与收入结构/);
assert.match(performance.text, /课程、咨询、其他金额和占比/);
assert.match(performance.text, /图片与经营图/);
assert.match(performance.text, /先写一句关键发现，再选图/);
assert.match(performance.text, /xbb-executive-chart/);
assert.match(performance.text, /不可突破的边界/);

const annualPerformance = knowledgeBase.retrieve("分析2026年全年业绩和每月趋势");
assert.match(annualPerformance.text, /跨月与年度聚合/);

const plannedPerformance = knowledgeBase.retrieve("对集团业绩按公司排名，区分课程和咨询占比", {
  domains: ["performance"],
  periodCount: 8
});
assert.deepEqual(plannedPerformance.domains, ["performance"]);
assert.equal(plannedPerformance.retrieval.multiPeriod, true);
assert.equal(plannedPerformance.sources.some((source) => source.section === "课程"), false);
assert.match(plannedPerformance.text, /跨月与年度聚合/);
assert.equal(plannedPerformance.bytes, Buffer.byteLength(plannedPerformance.text, "utf8"));
assert.deepEqual(plannedPerformance, knowledgeBase.retrieve("对集团业绩按公司排名，区分课程和咨询占比", {
  domains: ["performance"],
  periodCount: 8
}));

const allDomainRange = knowledgeBase.retrieve("2026年1月至8月集团全部公司，覆盖业绩、产品、课程、交付和商机", {
  domains: ["performance", "product-sales", "courses", "delivery", "opportunities"],
  periodCount: 8
});
for (const section of ["业绩与收入结构", "门票、商业操盘和开源产品", "课程", "交付课程邀约与业绩", "商机与跟进质量", "跨月与年度聚合"]) {
  assert.equal(allDomainRange.sources.some((source) => source.section === section), true, `缺少 fastPlan 强制章节：${section}`);
}
assert.deepEqual(allDomainRange.retrieval.omittedMandatory, []);
assert.ok(allDomainRange.bytes <= 14000);
assert.equal(allDomainRange.bytes, Buffer.byteLength(allDomainRange.text, "utf8"));

for (const maxBytes of [0, 1, 10, 100, 1024, 4096]) {
  const bounded = knowledgeBase.retrieve("集团业绩排名", { domains: ["performance"], periodCount: 1, maxBytes });
  assert.ok(bounded.bytes <= maxBytes);
  assert.equal(bounded.bytes, Buffer.byteLength(bounded.text, "utf8"));
}

const oversizedMarkdown = `# 超大文档\n## 超大章节\n${"经营分析😀".repeat(3000)}末尾标记`;
const oversizedChunks = splitMarkdown("references/oversized.md", oversizedMarkdown);
const oversizedSectionChunks = oversizedChunks.filter((chunk) => chunk.sectionTitle === "超大章节");
assert.ok(oversizedChunks.length > 1);
assert.equal(oversizedChunks.every((chunk) => Buffer.byteLength(chunk.text, "utf8") <= MAX_CHUNK_BYTES), true);
assert.match(oversizedChunks.at(-1).text, /末尾标记$/);
assert.equal(oversizedChunks.map((chunk) => chunk.text).join("").includes("�"), false);
assert.equal(oversizedSectionChunks.map((chunk) => chunk.text).join(""), `## 超大章节\n${"经营分析😀".repeat(3000)}末尾标记`);

const vectorIdf = new Map([...new Set([
  ...termFrequencies("重新激活遗忘商机").keys(),
  ...termFrequencies("盘活沉睡商机").keys(),
  ...termFrequencies("课程交付邀约").keys()
])].map((term) => [term, 1]));
const opportunityVector = sparseVector(termFrequencies("重新激活遗忘商机"), vectorIdf);
assert.ok(cosineSimilarity(opportunityVector, sparseVector(termFrequencies("盘活沉睡商机"), vectorIdf))
  > cosineSimilarity(opportunityVector, sparseVector(termFrequencies("课程交付邀约"), vectorIdf)));

const hugeQuestion = `${"请继续深入分析。".repeat(20000)}商机盘活`;
const hugeQuestionResult = knowledgeBase.retrieve(hugeQuestion, { domains: ["opportunities"], periodCount: 1 });
assert.ok(hugeQuestionResult.bytes <= 14000);
assert.equal(hugeQuestionResult.bytes, Buffer.byteLength(hugeQuestionResult.text, "utf8"));

const annualSizeBoundary = knowledgeBase.retrieve("跨月汇总超过安全大小限制，还能继续完成年度分析吗");
assert.match(annualSizeBoundary.text, /aggregationComplete=true/);
assert.match(annualSizeBoundary.text, /超过大小限制无法分析/);
assert.match(annualSizeBoundary.text, /逐月.*provenance.*审计明细/);

const chartContract = knowledgeBase.retrieve("辅助图规格的 items series 百分比和 centerLabel 怎么填写");
assert.match(chartContract.text, /百分比与空值|百分点/);
assert.equal(chartContract.sources.some((source) => source.source.endsWith("chart-contract.md")), true);

const opportunity = knowledgeBase.retrieve("分析销售商机阶段、跟进质量和被遗忘的有效商机");
assert.ok(opportunity.domains.includes("opportunities"));
assert.match(opportunity.text, /商机与跟进质量/);
assert.match(opportunity.text, /商机建议/);
assert.deepEqual(detectedDomains("本月交付课程邀约情况"), ["performance", "courses", "delivery"]);
assert.deepEqual(routeDomains("集团业绩排名，区分课程和咨询占比"), ["performance"]);
assert.deepEqual(routeDomains("本月开了多少堂课，每堂课成交率如何"), ["courses"]);
assert.deepEqual(routeDomains("某某公司本月每堂课的成家率怎么样"), ["courses"]);
assert.deepEqual(routeDomains("这个月开具交付课程各公司的邀约情况和成交业绩分配"), ["delivery"]);
assert.deepEqual(routeDomains("销售商机阶段和跟进质量"), ["opportunities"]);
assert.deepEqual(parseMonths("对2026年9月业绩排名", new Date("2026-09-01T00:00:00Z")), ["2026-09"]);
assert.deepEqual(parseMonths("看最近3个月趋势", new Date("2026-09-01T00:00:00Z")), ["2026-07", "2026-08", "2026-09"]);
assert.deepEqual(parseMonths("看2026年全年业绩", new Date("2026-09-01T00:00:00Z")), ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"]);
assert.deepEqual(parseMonths("看2025年业绩", new Date("2026-09-01T00:00:00Z")), ["2025-01", "2025-02", "2025-03", "2025-04", "2025-05", "2025-06", "2025-07", "2025-08", "2025-09", "2025-10", "2025-11", "2025-12"]);
assert.deepEqual(parseMonths("最近12个自然月", new Date("2026-09-01T00:00:00Z")), ["2025-10", "2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"]);
assert.deepEqual(parseMonths("2026年1月至3月", new Date("2026-09-01T00:00:00Z")), ["2026-01", "2026-02", "2026-03"]);
assert.deepEqual(parseMonths("2026年11月到2027年2月", new Date("2027-03-01T00:00:00Z")), ["2026-11", "2026-12", "2027-01", "2027-02"]);
assert.deepEqual(parseMonths("2026年7月以来", new Date("2027-03-01T00:00:00Z")), ["2026-07", "2026-08", "2026-09", "2026-10", "2026-11", "2026-12", "2027-01", "2027-02", "2027-03"]);
assert.throws(() => parseMonths("2026年10月", new Date("2026-09-01T00:00:00Z")), /晚于当前上海月份/);
assert.throws(() => parseMonths("2026年13月", new Date("2026-09-01T00:00:00Z")), /月份必须/);
assert.throws(() => planFastQuery("最近12个月业绩", new Date("2026-09-01T00:00:00Z")), /不能混入更早月份/);
assert.throws(() => planFastQuery("2025年12月到2026年2月业绩", new Date("2026-09-01T00:00:00Z")), /不能混入更早月份/);
assert.deepEqual(planFastQuery("全年业绩", new Date("2026-09-01T00:00:00Z")), { months: ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"], domains: ["performance"] });
const yearToDateMonths = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"];
assert.deepEqual(
  planFastQuery("对集团业绩按照公司名称做个排名，并区分课程和咨询占比", new Date("2026-09-04T04:00:00Z")),
  { months: yearToDateMonths, domains: ["performance"] }
);
for (const currentMonthPhrase of ["本月", "这个月", "当月"]) {
  assert.deepEqual(
    planFastQuery(`${currentMonthPhrase}对集团业绩按照公司名称做个排名，并区分课程和咨询占比`, new Date("2026-09-04T04:00:00Z")),
    { months: ["2026-09"], domains: ["performance"] }
  );
}
assert.deepEqual(
  planFastQuery("对2026年3月集团业绩按照公司名称做个排名，并区分课程和咨询占比", new Date("2026-09-04T04:00:00Z")),
  { months: ["2026-03"], domains: ["performance"] }
);
assert.equal(
  planFastQuery("对集团业绩按照公司名称做个排名，并区分课程和咨询占比", new Date("2027-01-04T04:00:00Z")).months.length,
  13
);
assert.deepEqual(planFastQuery("本月门票和商业操盘成交数量", new Date("2026-09-01T00:00:00Z")), { months: ["2026-09"], domains: ["product-sales"] });
assert.equal(isSchemaOnlyQuestion("业绩订单表 5614255 的 text_63 是什么字段"), true);
assert.equal(planFastQuery("业绩订单表 5614255 的 text_63 是什么字段", new Date("2026-09-01T00:00:00Z")), null);
assert.deepEqual(planFastQuery("按业绩订单 text_63 汇总本月金额", new Date("2026-09-01T00:00:00Z")), { months: ["2026-09"], domains: ["performance"] });
assert.equal(chooseTurnEffort("集团业绩排名，区分课程和咨询占比", "medium"), "none");
assert.equal(chooseTurnEffort("本月课程成交率", "medium"), "none");
assert.equal(chooseTurnEffort("分析商机跟进质量并给重新激活建议", "medium"), "medium");
assert.equal(chooseTurnEffort("为什么本月业绩下降", "medium"), "medium");

process.stdout.write(`${JSON.stringify({ success: true, sources: stats.sources, chunks: stats.chunks, maxRetrievedBytes: Math.max(performance.bytes, opportunity.bytes) })}\n`);
