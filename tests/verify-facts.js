"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { buildFactPack, classifyProduct } = require("../shared/xbb/build-fact-pack.js");

const rel = (id) => ({ id: `rel_${id}` });
const record = (collection, id, fields, extra = {}) => ({
  evidenceRef: `${collection}_${id}`,
  entityId: `rel_${id}`,
  recordId: `record_${id}`,
  serialNo: `${collection}-${id}`,
  addTime: null,
  updateTime: null,
  fields,
  ...extra
});

function sourceFixture() {
  const records = {
    performance: [
      record("performance", "pf1", { date_1: 1767258000, text_3: "公司A", text_26: rel("p1"), num_3: 1, num_6: 100 }),
      record("performance", "pf2", { date_1: 1767344400, text_3: "公司A", text_26: rel("p2"), num_3: 1, num_6: 50 }),
      record("performance", "pf3", { date_1: 1767430800, text_3: "公司A", text_26: rel("p4"), num_3: 2, num_6: 200 }),
      record("performance", "pf4", { date_1: 1767517200, text_3: "公司B", text_26: rel("p1"), num_3: 1, num_6: 80 })
    ],
    oppOrder: [
      record("oppOrder", "oo1", { date_1: 1767258000, text_6: "公司A", text_10: rel("p3"), num_1: 3, num_5: 300 })
    ],
    course: [
      record("course", "c1", { date_1: 1767258000, text_1: "交付一班", text_7: "已结束", text_10: "交付课程", num_3: 2, num_6: 1, num_9: 500, num_10: 400 })
    ],
    booking: [
      record("booking", "b1", { date_3: 1767258000, text_2: rel("c1"), text_7: "业绩订单", text_8: rel("order1"), text_26: "公司A", text_36: "客户企业1", num_1: 1, num_2: 1, num_3: 100 }),
      record("booking", "b2", { date_3: 1767258000, text_2: rel("c1"), text_7: "业绩订单", text_8: rel("order1"), text_26: "公司A", text_36: "客户企业1", num_1: 1, num_2: 1, num_3: 100 })
    ],
    product: [
      record("product", "p1", { text_1: "经营训练营", text_6: "训练营", text_15: "前端" }),
      record("product", "p2", { text_1: "管理咨询", text_6: "咨询", text_15: "后端" }),
      record("product", "p3", { text_1: "OPP门票", text_6: "OPP", text_15: "OPP" }),
      record("product", "p4", { text_1: "商业操盘", text_6: "未分类", text_15: "后端" })
    ],
    opportunity: [
      record("opportunity", "op1", { creatorId: rel("u1"), ownerId: rel("u1"), text_1: "增长项目", text_3: rel("customer1"), text_11: "公司A", text_12: "高", text_17: "解决方案", num_1: 1000, num_14: 0 }, { addTime: 1767258000 })
    ],
    follow: [
      record("follow", "f1", { date_1: 1767603600, text_1: rel("customer1"), text_5: rel("op1"), text_6: "已与老板确认核心需求，下周安排方案沟通并明确下一步时间。", text_10: "客户企业1" })
    ],
    user: [
      { evidenceRef: "user_u1", userId: "rel_u1", name: "销售甲", departments: [{ id: "department_d1", name: "公司A", isLeader: 0 }] },
      { evidenceRef: "user_u2", userId: "rel_u2", name: "销售乙", departments: [{ id: "department_d2", name: "公司AB", isLeader: 0 }] }
    ]
  };
  return {
    schemaVersion: "3.0",
    skill: "xbb-executive-analyst",
    mode: "live-readonly-source",
    month: "2026-01",
    range: { month: "2026-01", start: 1767196800, end: 1769875199, startLabel: "2026-01-01", endLabel: "2026-01-31" },
    refreshedAt: "2026-01-31T10:00:00.000Z",
    provenance: {
      live: true,
      readOnly: true,
      dataSource: "xbb-openapi",
      formIds: { performance: 6404920, oppOrder: 6707824, course: 7452529, booking: 7452855, product: 5614247, opportunity: 5614253, follow: 5614251 },
      recordCounts: Object.fromEntries(Object.entries(records).map(([key, rows]) => [key, rows.length]))
    },
    privacy: { telephoneFieldsExported: false, credentialFieldsExported: false },
    records,
    integrity: { algorithm: "sha256", recordsSha256: crypto.createHash("sha256").update(JSON.stringify(records)).digest("hex") }
  };
}

function main() {
  const source = sourceFixture();
  const pack = buildFactPack(source, { domains: "all" });
  assert.equal(pack.status, "ready");
  assert.equal(pack.facts.performance.summary.total, 430);
  assert.equal(pack.facts.performance.summary.course, 180);
  assert.equal(pack.facts.performance.summary.consulting, 50);
  assert.equal(pack.facts.performance.summary.other, 200);
  assert.equal(pack.facts.productSales.summary.ticketCount, 3);
  assert.equal(pack.facts.productSales.summary.oppOrderQuantity, 3);
  assert.equal(pack.facts.productSales.summary.commercialCount, 2);
  assert.equal(pack.facts.productSales.summary.openOppRevenue, 300);
  assert.equal(pack.facts.courses.summary.courseCount, 1);
  assert.equal(pack.facts.courses.summary.firms, 1);
  assert.equal(pack.facts.courses.summary.bosses, 2);
  assert.equal(pack.facts.courses.summary.conversionRate, 50);
  assert.equal(pack.facts.delivery.summary.invitations, 2);
  assert.equal(pack.facts.delivery.summary.attributedPaidAmount, 100);
  assert.equal(pack.facts.opportunities.summary.createdCount, 1);
  assert.equal(pack.facts.opportunities.summary.forgottenCandidates, 1);
  assert.equal(pack.facts.opportunities.opportunities[0].signals.hasNextAction, true);
  assert.equal(pack.facts.opportunities.opportunities[0].signals.hasDecisionSignal, true);
  assert.equal(Object.hasOwn(pack.facts.opportunities.summary, "qualityScore"), false);
  assert.equal(/"headline"|"insights"|"recommendation"/.test(JSON.stringify(pack)), false);
  assert.equal(classifyProduct(undefined, "企业增长咨询").businessType, "咨询");
  assert.equal(classifyProduct(undefined, "OPP门票").isTicket, true);
  assert.equal(classifyProduct(undefined, "无法识别产品").businessType, "其他");

  const exact = buildFactPack(source, { domains: "courses,opportunities", company: "公司A", person: "销售甲" });
  assert.equal(exact.status, "ready");
  assert.equal(exact.scope.company, "公司A");
  assert.equal(exact.scope.person.name, "销售甲");

  const ambiguous = buildFactPack(source, { domains: "performance", company: "公司" });
  assert.equal(ambiguous.status, "needs_disambiguation");
  assert.ok(ambiguous.entityResolution.company.candidates.length >= 2);
  assert.deepEqual(ambiguous.facts, {});

  process.stdout.write(`${JSON.stringify({ success: true, checks: 28, factPackSha256: pack.integrity.factPackSha256 })}\n`);
}

main();
