"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { SkillKnowledgeBase, detectedDomains } = require("../shared/rag/skill-knowledge-base.js");
const { chooseTurnEffort, parseMonths, planFastQuery, routeDomains } = require("../shared/xbb/fast-query-plan.js");

const projectRoot = path.resolve(__dirname, "..");
const knowledgeBase = new SkillKnowledgeBase(projectRoot);
const stats = knowledgeBase.stats();
assert.equal(stats.sources, 5);
assert.ok(stats.chunks >= 15);
assert.ok(stats.sourceBytes > 25000);
assert.match(stats.digest, /^[a-f0-9]{64}$/);

const performance = knowledgeBase.retrieve("对集团业绩按公司排名，区分课程和咨询占比");
assert.ok(performance.bytes <= 14000);
assert.ok(performance.sources.length <= 8);
assert.ok(performance.domains.includes("performance"));
assert.match(performance.text, /业绩与收入结构/);
assert.match(performance.text, /何时画图/);
assert.match(performance.text, /不可突破的边界/);

const opportunity = knowledgeBase.retrieve("分析销售商机阶段、跟进质量和被遗忘的有效商机");
assert.ok(opportunity.domains.includes("opportunities"));
assert.match(opportunity.text, /商机与跟进质量/);
assert.match(opportunity.text, /商机建议/);
assert.deepEqual(detectedDomains("本月交付课程邀约情况"), ["performance", "courses", "delivery"]);
assert.deepEqual(routeDomains("集团业绩排名，区分课程和咨询占比"), ["performance"]);
assert.deepEqual(routeDomains("本月开了多少堂课，每堂课成交率如何"), ["courses"]);
assert.deepEqual(routeDomains("销售商机阶段和跟进质量"), ["opportunities"]);
assert.deepEqual(parseMonths("对2026年9月业绩排名", new Date("2026-09-01T00:00:00Z")), ["2026-09"]);
assert.deepEqual(parseMonths("看最近3个月趋势", new Date("2026-09-01T00:00:00Z")), ["2026-07", "2026-08", "2026-09"]);
assert.deepEqual(planFastQuery("本月门票和商业操盘成交数量", new Date("2026-09-01T00:00:00Z")), { months: ["2026-09"], domains: ["product-sales"] });
assert.equal(chooseTurnEffort("集团业绩排名，区分课程和咨询占比", "medium"), "none");
assert.equal(chooseTurnEffort("本月课程成交率", "medium"), "none");
assert.equal(chooseTurnEffort("分析商机跟进质量并给重新激活建议", "medium"), "medium");
assert.equal(chooseTurnEffort("为什么本月业绩下降", "medium"), "medium");

process.stdout.write(`${JSON.stringify({ success: true, sources: stats.sources, chunks: stats.chunks, maxRetrievedBytes: Math.max(performance.bytes, opportunity.bytes) })}\n`);
