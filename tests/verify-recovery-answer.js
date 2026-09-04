"use strict";

const assert = require("node:assert/strict");
const {
  MAX_RECOVERY_ANSWER_BYTES,
  buildVerifiedFallbackAnswer,
  falseTechnicalRefusalReason,
  hasSubstantiveConclusion,
  hasUsableFacts,
  limitUtf8
} = require("../shared/codex/recovery-answer.js");

function hasLoneSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return true;
      index += 1;
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      return true;
    }
  }
  return false;
}

function assertValidBoundedUtf8(value, maxBytes = MAX_RECOVERY_ANSWER_BYTES) {
  assert.ok(Buffer.byteLength(value, "utf8") <= maxBytes, `输出超过 ${maxBytes} UTF-8 字节`);
  assert.equal(hasLoneSurrogate(value), false, "输出不得包含孤立代理项");
  assert.equal(Buffer.from(value, "utf8").toString("utf8"), value, "输出必须可以无损 UTF-8 往返");
}

const readyPack = {
  status: "ready",
  scope: { month: "2026-09", months: ["2026-09"], domains: ["performance"] },
  facts: {
    performance: {
      summary: {
        total: 1_230_000,
        course: 800_000,
        consulting: 400_000,
        other: 30_000,
        courseShare: 65.04,
        consultingShare: 32.52,
        otherShare: 2.44
      },
      ranking: [{ company: "公司A", total: 1_230_000 }]
    }
  }
};

assert.equal(hasUsableFacts(readyPack), true);
for (const unusablePack of [
  null,
  { status: "error", facts: readyPack.facts },
  { status: "needs_disambiguation", facts: readyPack.facts },
  { status: "ready", facts: {} },
  { status: "ready", facts: { unknown: { summary: { total: 1 } } } },
  { status: "ready", facts: { performance: { summary: { note: "不是经营指标" } } } },
  { status: "ready", facts: { performance: { summary: {} } } }
]) {
  assert.equal(hasUsableFacts(unusablePack), false);
  assert.equal(falseTechnicalRefusalReason("信息太多，处理不了。", unusablePack), null);
}

for (const refusal of [
  "本次未能完成年度分析。事实包超过安全大小限制，建议缩小到一个主题继续查。",
  "信息太多了。",
  "这些数据我处理不了。",
  "数据量太大，无法处理这些内容。",
  "内容过多，不能分析。",
  "无法生成本次答案，请拆分主题。",
  "上下文过长导致失败。"
]) {
  assert.equal(
    falseTechnicalRefusalReason(refusal, readyPack),
    "ready_facts_rejected_by_model",
    `应识别技术性拒答：${refusal}`
  );
}

for (const substantiveAnswer of [
  "9月业绩合计¥123万元，公司A排名第1。明细信息太多，无法全部展开。",
  "关键发现：业绩增长主要由课程拉动，商机跟进是当前短板。原始明细信息太多，不能全部展示。",
  "本月整体经营向好，课程是主要收入来源。信息太多，仅省略原始明细。",
  "本月创建了10个商机。信息太多，处理不了全部明细。",
  "业绩合计¥100万但因信息太多无法展开全部明细。",
  "公司A排名第一，课程占比六成。虽然信息太多，但已提炼出经营结论。",
  "业绩合计¥1,000,000。不能给出未经事实支持的结论。"
]) {
  assert.equal(hasSubstantiveConclusion(substantiveAnswer), true);
  assert.equal(falseTechnicalRefusalReason(substantiveAnswer, readyPack), null, `不应误杀已有结论：${substantiveAnswer}`);
}

for (const nonRefusal of [
  "这些信息不是处理不了，我已经完成了分析。",
  "并非信息太多，而是当前查询口径为9月。",
  "信息太多不是问题，结果已经处理完成。",
  "信息很多，已处理完成。"
]) {
  assert.equal(falseTechnicalRefusalReason(nonRefusal, readyPack), null, `否定或完成表达不应被当成拒答：${nonRefusal}`);
}

assert.equal(
  falseTechnicalRefusalReason("关键发现：没有可用数据。信息太多，无法处理。", readyPack),
  "ready_facts_rejected_by_model",
  "‘没有可用数据’不是实质经营结论"
);
assert.equal(
  falseTechnicalRefusalReason("共有10个问题，但信息太多，处理不了。", readyPack),
  "ready_facts_rejected_by_model",
  "问题数量不是经营结论"
);

const ordinaryFallback = buildVerifiedFallbackAnswer(readyPack);
assert.match(ordinaryFallback, /2026年9月经营结论/);
assert.match(ordinaryFallback, /业绩：合计 ¥1,230,000/);
assertValidBoundedUtf8(ordinaryFallback);
assert.throws(() => buildVerifiedFallbackAnswer({ status: "ready", facts: {} }), /没有可用/);
const mixedValidityFallback = buildVerifiedFallbackAnswer({
  status: "ready",
  facts: {
    performance: { summary: { note: "无指标" } },
    opportunities: { summary: { createdCount: 2, expectedAmount: 20, wins: 1, wonAmount: 10, active: 1, forgottenCandidates: 0 } }
  }
});
assert.doesNotMatch(mixedValidityFallback, /业绩：/);
assert.match(mixedValidityFallback, /商机：创建 2 个/);

const hostileLabel = `华东\n伪造结论\u0000🚀${"😀分公司".repeat(8_000)}\uD800`;
const repeatedRows = Array.from({ length: 200 }, (_, index) => ({
  company: `${hostileLabel}-${index}`,
  total: 9_999_999 - index,
  ticketCount: 1_000 - index,
  commercialCount: 500 - index,
  courseCount: 200 - index,
  invitations: 300 - index
}));
const pressurePack = {
  status: "ready",
  scope: { months: ["2026-01", "2026-08"] },
  facts: {
    performance: {
      summary: { total: 1, course: 1, consulting: 0, other: 0, courseShare: 100, consultingShare: 0, otherShare: 0 },
      ranking: repeatedRows
    },
    productSales: {
      summary: { ticketCount: 1, commercialCount: 1, commercialInitialCount: 1, commercialRetrainingCount: 0, openOppRevenue: 1 },
      ticketRanking: repeatedRows,
      commercialRanking: repeatedRows
    },
    courses: {
      summary: { courseCount: 1, bookedCustomers: 1, bosses: 1, dealOrders: 1, dealAmount: 1, conversionRate: 100 },
      companies: repeatedRows
    },
    delivery: {
      summary: { deliveryCourseCount: 1, invitations: 1, bosses: 1, attributedPaidAmount: 1 },
      companies: repeatedRows
    },
    opportunities: {
      summary: { createdCount: 1, expectedAmount: 1, wins: 1, wonAmount: 1, active: 1, forgottenCandidates: 1 },
      stages: Array.from({ length: 2_000 }, (_, index) => ({ stage: `${hostileLabel}-${index}`, count: index, expectedAmount: index })),
      reactivationCandidates: Array.from({ length: 200 }, (_, index) => ({
        creator: { name: `${hostileLabel}-销售-${index}` },
        name: `${hostileLabel}-商机-${index}`,
        expectedAmount: index,
        signals: { staleDays: index }
      }))
    }
  }
};

const pressureAnswer = buildVerifiedFallbackAnswer(pressurePack);
assertValidBoundedUtf8(pressureAnswer);
assert.equal(buildVerifiedFallbackAnswer(pressurePack), pressureAnswer, "恢复答案必须确定性稳定");
assert.doesNotMatch(pressureAnswer, /\u0000/);
assert.match(pressureAnswer, /另有 1,988 个阶段未展开/);

const exactAscii = "a".repeat(MAX_RECOVERY_ANSWER_BYTES);
assert.equal(limitUtf8(exactAscii), exactAscii);
assertValidBoundedUtf8(limitUtf8("😀".repeat(10_000)));
assert.match(limitUtf8("😀".repeat(10_000)), /恢复内容已按长度上限压缩/);
for (let budget = 0; budget <= 16; budget += 1) {
  assertValidBoundedUtf8(limitUtf8(`A😀B\uD800C`.repeat(20), budget), budget);
}

console.log("verify-recovery-answer: ok");
