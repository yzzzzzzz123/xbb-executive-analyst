"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const util = require("node:util");
const { assertNoSensitiveFactValues, findSensitiveFactValue } = require("../shared/security/fact-privacy.js");
const { buildMultiPeriodFactPack, MAX_AGGREGATE_BYTES } = require("../shared/xbb/aggregate-multi-period.js");
const { buildFactPack, classifyProduct } = require("../shared/xbb/build-fact-pack.js");
const {
  apiIdValue,
  buildSourceBundle,
  collectionsForDomains,
  followOpportunityConditions,
  isRetryableApiMessage,
  isRetryableHttpStatus,
  monthRange,
  normalizeDomains: normalizeExportDomains,
  paginationPlan,
  retryBackoffMs
} = require("../shared/xbb/export-live-data.js");
const { formatQueryProgress, monthsLabel, normalizeRunnerProgressEvent } = require("../shared/xbb/query-progress.js");
const { QUERY_XBB_INPUT_SCHEMA } = require("../shared/xbb/query-tool.js");
const { MAX_MODEL_FACT_VIEW_BYTES, buildModelFactView, utf8Prefix } = require("../shared/xbb/model-fact-view.js");
const {
  DEFAULT_MAX_CONCURRENT_QUERIES,
  DEFAULT_QUERY_QUEUE_TTL_MS,
  assertSafeFactPack,
  createToolGateway,
  runRunnerProcess,
  runnerTimeoutMs,
  terminateWindowsProcessTree,
  validateRequest
} = require("../shared/xbb/tool-gateway.js");

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

const shanghaiTimestamp = (date) => Math.floor(Date.parse(`${date}T12:00:00+08:00`) / 1000);

function assertApproximately(actual, expected, epsilon = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `expected ${actual} to be within ${epsilon} of ${expected}`);
}

function emptyBusinessRecords(source) {
  const copy = JSON.parse(JSON.stringify(source));
  for (const collection of ["performance", "courseOrders", "oppOrder", "course", "booking", "deliveryBooking", "product", "opportunity", "follow", "user"]) {
    copy.records[collection] = [];
  }
  return copy;
}

function sealSource(source) {
  source.provenance.recordCounts = Object.fromEntries(Object.entries(source.records).map(([key, rows]) => [key, rows.length]));
  source.integrity.recordsSha256 = crypto.createHash("sha256").update(JSON.stringify(source.records)).digest("hex");
  return source;
}

function sourceFixture() {
  const records = {
    performance: [
      record("performance", "pf1", { date_1: 1767258000, text_63: "公司A", text_28: rel("c1"), num_1: 500, array_4: [{ text_10: "课程", text_1: "经营训练营", num_3: 1, num_5: 100 }] }),
      record("performance", "pf2", { date_1: 1767344400, text_63: "公司A", array_4: [{ text_10: "咨询", text_1: "管理咨询", num_3: 1, num_5: 50 }] }),
      record("performance", "pf3", { date_1: 1767430800, text_63: "公司A", array_4: [{ text_10: "课程", text_1: "商业操盘", num_3: 2, num_5: 200 }] }),
      record("performance", "pf4", { date_1: 1767517200, text_63: "公司B", array_4: [{ text_10: "课程", text_1: "经营训练营", num_3: 1, num_5: 80 }] }),
      record("performance", "pf5", { date_1: 1767603600, text_63: "公司A", array_4: [{ text_10: "课程", text_1: "商业操盘复训", num_3: 1, num_5: 60 }] })
    ],
    courseOrders: [
      record("courseOrders", "pf1", { date_1: 1767258000, text_63: "公司A", text_28: rel("c1"), num_1: 500 })
    ],
    oppOrder: [
      record("oppOrder", "oo1", { date_1: 1767258000, text_31: "公司A", array_4: [{ text_1: "OPP门票", num_3: 3, num_5: 300 }] })
    ],
    course: [
      record("course", "c1", { date_1: 1767258000, text_1: "交付一班", text_5: "公司A", text_7: "已结束", text_10: "交付课程", num_10: 400 })
    ],
    booking: [
      record("booking", "b1", { text_5: rel("c1"), text_22: "老板", text_36: "客户企业1" }),
      record("booking", "b2", { text_5: rel("c1"), text_22: "员工", text_36: "客户企业2" })
    ],
    deliveryBooking: [
      record("deliveryBooking", "db1", { date_3: 1767258000, text_2: rel("c1"), text_7: "业绩订单", text_8: rel("order1"), text_26: "公司A", text_36: "客户企业1", num_1: 1, num_2: 1, num_3: 100 }),
      record("deliveryBooking", "db2", { date_3: 1767258000, text_2: rel("c1"), text_7: "业绩订单", text_8: rel("order1"), text_26: "公司A", text_36: "客户企业1", num_1: 1, num_2: 1, num_3: 100 })
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
    schemaVersion: "3.1",
    skill: "xbb-executive-analyst",
    mode: "live-readonly-source",
    month: "2026-01",
    range: { month: "2026-01", start: 1767196800, end: 1769875199, startLabel: "2026-01-01", endLabel: "2026-01-31" },
    refreshedAt: "2026-01-31T10:00:00.000Z",
    provenance: {
      live: true,
      readOnly: true,
      dataSource: "xbb-openapi",
      formIds: { performance: 5614255, courseOrders: 5614255, oppOrder: 6707824, course: 7452529, booking: 7642173, deliveryBooking: 7452855, product: 5614247, opportunity: 5614253, follow: 5614251 },
      recordCounts: Object.fromEntries(Object.entries(records).map(([key, rows]) => [key, rows.length]))
    },
    privacy: { telephoneFieldsExported: false, credentialFieldsExported: false },
    records,
    integrity: { algorithm: "sha256", recordsSha256: crypto.createHash("sha256").update(JSON.stringify(records)).digest("hex") }
  };
}

async function main() {
  const normalized = buildSourceBundle({
    month: "2026-01",
    range: { month: "2026-01", start: 1767196800, end: 1769875199 },
    loadedAt: "2026-01-31T10:00:00.000Z",
    metadata: Object.fromEntries(["performance", "courseOrders", "oppOrder", "course", "booking", "deliveryBooking", "product", "opportunity", "follow"].map((name) => [name, new Map()])),
    collections: {
      performance: [{ dataId: "raw-pf1", serialNo: "PF-1", date_1: 1767258000, text_63: "公司A", array_4: JSON.stringify([{ text_10: "课程", text_1: "经营训练营", num_3: 2, num_5: 200 }]) }],
      courseOrders: [{ dataId: "raw-pf-cross-month", serialNo: "PF-X", date_1: shanghaiTimestamp("2026-02-03"), text_28: "raw-c1", num_1: 800 }],
      oppOrder: [],
      course: [{ dataId: "raw-c1", serialNo: "COURSE-1", date_1: shanghaiTimestamp("2026-01-10"), text_1: "一月课程", text_5: "公司A" }],
      booking: [], deliveryBooking: [], product: [], opportunity: [], follow: []
    },
    users: []
  });
  assert.equal(normalized.provenance.formIds.performance, 5614255);
  assert.equal(normalized.provenance.formIds.courseOrders, 5614255);
  assert.equal(normalized.provenance.formIds.booking, 7642173);
  assert.deepEqual(normalized.records.performance[0].fields.array_4, [{ text_10: "课程", num_5: 200, text_1: "经营训练营", num_3: 2 }]);
  assert.equal(normalized.records.courseOrders[0].fields.num_1, 800);
  assert.equal(normalized.records.courseOrders[0].fields.text_28.id, normalized.records.course[0].entityId);

  assert.equal(typeof followOpportunityConditions, "function");
  const opportunityFollowConditions = followOpportunityConditions({ start: 1767196800, end: 1769875199 }, "9007199254740993");
  assert.deepEqual(opportunityFollowConditions.find((condition) => condition.attr === "text_5"), {
    attr: "text_5",
    value: ["9007199254740993"],
    symbol: "equal"
  });
  assert.equal(opportunityFollowConditions.some((condition) => condition.value.includes(301)), false);
  assert.throws(() => followOpportunityConditions({ start: 1, end: 2 }), /商机 dataId/);
  assert.equal(apiIdValue("12345"), 12345);
  assert.equal(apiIdValue("9007199254740993"), "9007199254740993");
  assert.equal(isRetryableHttpStatus(503), true);
  assert.equal(isRetryableHttpStatus(404), false);
  assert.equal(isRetryableApiMessage("系统繁忙，请稍后"), true);
  assert.equal(isRetryableApiMessage("字段不存在"), false);
  assert.equal(retryBackoffMs(0, () => 0), 250);
  assert.equal(retryBackoffMs(8, () => 0), 5000);
  assert.deepEqual(paginationPlan({ list: Array.from({ length: 100 }), totalCount: 201, totalPage: 3 }), {
    firstRows: Array.from({ length: 100 }),
    totalCount: 201,
    declaredTotalPage: 3,
    totalPages: 3,
    effectivePageSize: 100,
    maxPages: 1000
  });
  assert.throws(() => paginationPlan({ list: [], totalCount: 100001, totalPage: 1001 }), /超过安全上限/);
  assert.throws(() => normalizeExportDomains(["all", "performance"]), /all 不能/);
  assert.throws(() => normalizeExportDomains(["all", "unknown"]), /不支持的数据域/);
  assert.throws(() => monthRange("2026-10", new Date("2026-09-04T04:00:00Z")), /晚于当前上海月份/);
  assert.throws(
    () => validateRequest({ months: ["2025-12"], domains: ["performance"] }, new Date("2026-09-04T04:00:00Z")),
    /2026-01/
  );
  assert.deepEqual(validateRequest({ months: ["2025-12"], domains: ["opportunities"] }, new Date("2026-09-04T04:00:00Z")), {
    months: ["2025-12"],
    domains: ["opportunities"],
    company: undefined,
    person: undefined,
    forceRefresh: false
  });
  assert.throws(
    () => validateRequest({ months: ["2025-12", "2026-01"], domains: ["performance"] }, new Date("2026-09-04T04:00:00Z")),
    /不能混入更早月份/
  );
  assert.throws(
    () => validateRequest({ months: ["2026-10"], domains: ["opportunities"] }, new Date("2026-09-04T04:00:00Z")),
    /晚于当前上海月份/
  );

  const source = sourceFixture();
  const pack = buildFactPack(source, { domains: "all" });
  assert.equal(pack.status, "ready");
  assert.equal(pack.facts.performance.summary.total, 490);
  assert.equal(pack.facts.performance.summary.course, 440);
  assert.equal(pack.facts.performance.summary.consulting, 50);
  assert.equal(pack.facts.performance.summary.other, 0);
  assert.equal(pack.facts.productSales.summary.ticketCount, 3);
  assert.equal(pack.facts.productSales.summary.oppOrderQuantity, 3);
  assert.equal(pack.facts.productSales.summary.commercialCount, 3);
  assert.equal(pack.facts.productSales.summary.commercialInitialCount, 2);
  assert.equal(pack.facts.productSales.summary.commercialRetrainingCount, 1);
  assert.equal(pack.facts.productSales.summary.openOppRevenue, 300);
  assert.equal(pack.facts.courses.summary.courseCount, 1);
  assert.equal(pack.facts.courses.summary.firms, 2);
  assert.equal(pack.facts.courses.summary.bosses, 1);
  assert.equal(pack.facts.courses.summary.students, 2);
  assert.equal(pack.facts.courses.summary.dealAmount, 500);
  assert.equal(pack.facts.courses.summary.conversionRate, 50);
  assert.equal(pack.facts.courses.courses[0].primaryCompanyBasis, "课程表举办方 text_5");
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

  const largeSinglePeriod = JSON.parse(JSON.stringify(pack));
  const baseOpportunity = largeSinglePeriod.facts.opportunities.opportunities[0];
  largeSinglePeriod.facts.opportunities.opportunities = Array.from({ length: 5000 }, (_, index) => ({
    ...baseOpportunity,
    entityId: `large-opportunity-${index}`,
    name: `大体量商机${index}-${"跟进内容".repeat(20)}`,
    evidenceRefs: [`private-evidence-${index}`]
  }));
  largeSinglePeriod.facts.opportunities.reactivationCandidates = largeSinglePeriod.facts.opportunities.opportunities;
  largeSinglePeriod.facts.opportunities.summary.createdCount = 5000;
  const largeView = buildModelFactView(largeSinglePeriod);
  assert.ok(Buffer.byteLength(JSON.stringify(largeSinglePeriod), "utf8") > 5 * MAX_MODEL_FACT_VIEW_BYTES);
  assert.ok(Buffer.byteLength(JSON.stringify(largeView), "utf8") <= MAX_MODEL_FACT_VIEW_BYTES);
  assert.equal(largeView.facts.opportunities.summary.createdCount, 5000);
  assert.equal(largeView.viewCoverage.arrays["opportunities.opportunities"].sourceRows, 5000);
  assert.ok(largeView.viewCoverage.arrays["opportunities.opportunities"].includedRows <= 20);
  assert.equal(/private-evidence/.test(JSON.stringify(largeView)), false);
  assert.equal(largeView.viewCoverage.finalBytes, Buffer.byteLength(JSON.stringify(largeView), "utf8"));
  assert.equal(largeView.viewCoverage.aggregationComplete, true);
  assert.equal(Buffer.byteLength(utf8Prefix("经营🚀".repeat(100), 100), "utf8") <= 100, true);
  assert.equal(utf8Prefix("经营🚀", 0), "");
  assert.equal(Buffer.byteLength(utf8Prefix("经营🚀", 2), "utf8") <= 2, true);
  const incompleteAggregateView = buildModelFactView({
    mode: "xbb-live-readonly-multi-period-aggregate",
    status: "ready",
    scope: { months: ["2026-01", "2026-02"] },
    provenance: { live: true, readOnly: true },
    facts: { performance: { summary: { total: 1 } } },
    limitations: [],
    integrity: { factPackSha256: "test-incomplete" }
  });
  assert.equal(incompleteAggregateView.viewCoverage.aggregationComplete, false);

  const performanceWithoutLinesSource = emptyBusinessRecords(source);
  performanceWithoutLinesSource.records.performance = [
    record("performance", "no-lines", {
      date_1: shanghaiTimestamp("2026-01-06"), text_63: "公司A", num_1: 999
    })
  ];
  const performanceWithoutLines = buildFactPack(sealSource(performanceWithoutLinesSource), { domains: "performance" });
  assert.equal(performanceWithoutLines.facts.performance.summary.total, 0);
  assert.deepEqual(performanceWithoutLines.facts.performance.ranking, []);
  assert.deepEqual(performanceWithoutLines.facts.performance.dailyTrend, []);

  const missingCategorySource = emptyBusinessRecords(source);
  missingCategorySource.records.performance = [
    record("performance", "missing-category", {
      date_1: shanghaiTimestamp("2026-01-07"),
      text_63: "公司A",
      array_4: [{ text_1: "高管课程", num_3: 1, num_5: 500 }]
    })
  ];
  const missingCategory = buildFactPack(sealSource(missingCategorySource), { domains: "performance" });
  assert.equal(missingCategory.facts.performance.summary.total, 500);
  assert.equal(missingCategory.facts.performance.summary.course, 0);
  assert.equal(missingCategory.facts.performance.summary.consulting, 0);
  assert.equal(missingCategory.facts.performance.summary.other, 500);
  assert.equal(missingCategory.facts.performance.ranking[0].otherShare, 100);

  const oppOrderWithoutLinesSource = emptyBusinessRecords(source);
  oppOrderWithoutLinesSource.records.product = [
    record("product", "fallback-ticket", { text_1: "OPP门票", text_6: "OPP", text_15: "OPP" })
  ];
  oppOrderWithoutLinesSource.records.oppOrder = [
    record("oppOrder", "no-lines", {
      date_1: shanghaiTimestamp("2026-01-07"), text_31: "公司A", text_3: "OPP门票",
      text_10: rel("fallback-ticket"), num_1: 99, num_5: 999
    })
  ];
  const oppOrderWithoutLines = buildFactPack(sealSource(oppOrderWithoutLinesSource), { domains: "product-sales" });
  assert.equal(oppOrderWithoutLines.facts.productSales.summary.oppOrderQuantity, 0);
  assert.equal(oppOrderWithoutLines.facts.productSales.summary.oppOrderRevenue, 0);
  assert.equal(oppOrderWithoutLines.facts.productSales.summary.ticketCount, 0);
  assert.deepEqual(oppOrderWithoutLines.facts.productSales.ticketRanking, []);
  assert.deepEqual(oppOrderWithoutLines.facts.productSales.companyProductMix, []);

  const validatedFlatOppSource = emptyBusinessRecords(source);
  validatedFlatOppSource.fieldCatalog = {
    oppOrder: {
      text_3: { label: "产品名称", options: {} },
      num_1: { label: "产品销量", options: {} },
      num_5: { label: "已收金额", options: {} },
      text_6: { label: "所属公司", options: {} }
    }
  };
  validatedFlatOppSource.records.oppOrder = [
    record("oppOrder", "validated-flat-ticket", {
      date_1: shanghaiTimestamp("2026-01-07"), text_6: "公司A", text_3: "VIP门票", num_1: 4, num_5: 800
    })
  ];
  const validatedFlatOpp = buildFactPack(sealSource(validatedFlatOppSource), { domains: "product-sales" });
  assert.equal(validatedFlatOpp.facts.productSales.summary.oppOrderQuantity, 4);
  assert.equal(validatedFlatOpp.facts.productSales.summary.ticketCount, 4);
  assert.equal(validatedFlatOpp.facts.productSales.summary.oppOrdersWithProductLines, 0);
  assert.equal(validatedFlatOpp.facts.productSales.summary.oppOrdersWithValidatedFlatProduct, 1);
  assert.equal(validatedFlatOpp.facts.productSales.summary.oppOrdersWithoutSupportedProductShape, 0);
  assert.deepEqual(validatedFlatOpp.facts.productSales.ticketRanking.map((row) => [row.company, row.ticketCount]), [["公司A", 4]]);

  const namedBookingRelationSource = JSON.parse(JSON.stringify(source));
  namedBookingRelationSource.records.booking = [
    record("booking", "named-course-relation", {
      text_5: { id: "rel_c1", name: "交付一班" }, text_22: "老板", text_36: "客户企业1"
    })
  ];
  const namedBookingRelation = buildFactPack(sealSource(namedBookingRelationSource), { domains: "courses" });
  assert.equal(namedBookingRelation.facts.courses.summary.bookedCustomers, 1);
  assert.equal(namedBookingRelation.facts.courses.summary.students, 1);
  assert.equal(namedBookingRelation.facts.courses.summary.bosses, 1);
  assert.equal(namedBookingRelation.facts.courses.courses[0].positionBreakdown.find((row) => row.position === "老板").count, 1);

  const productRankingSource = emptyBusinessRecords(source);
  productRankingSource.records.oppOrder = [
    record("oppOrder", "rank-oo-a", {
      date_1: shanghaiTimestamp("2026-01-08"),
      text_31: "公司A",
      array_4: [
        { text_1: "VIP门票", num_3: 6, num_5: 600 },
        { text_1: "OPP门票", num_3: 2, num_5: 400 }
      ]
    }),
    record("oppOrder", "rank-oo-b", {
      date_1: shanghaiTimestamp("2026-01-09"),
      text_31: "公司B",
      array_4: [{ text_1: "VIP门票", num_3: 3, num_5: 300 }]
    }),
    record("oppOrder", "rank-oo-c", {
      date_1: shanghaiTimestamp("2026-01-10"),
      text_31: "公司C",
      array_4: [{ text_1: "开源增长营", num_3: 20, num_5: 2000 }]
    })
  ];
  productRankingSource.records.performance = [
    record("performance", "rank-pf-a", {
      date_1: shanghaiTimestamp("2026-01-11"),
      text_63: "公司A",
      array_4: [{ text_10: "课程", text_1: "商业操盘", num_3: 1, num_5: 100 }]
    }),
    record("performance", "rank-pf-b", {
      date_1: shanghaiTimestamp("2026-01-12"),
      text_63: "公司B",
      array_4: [
        { text_10: "课程", text_1: "商业操盘", num_3: 5, num_5: 500 },
        { text_10: "课程", text_1: "商业操盘复训", num_3: 4, num_5: 400 }
      ]
    })
  ];
  const productRankingPack = buildFactPack(sealSource(productRankingSource), { domains: "product-sales" });
  assert.deepEqual(productRankingPack.facts.productSales.ticketRanking.map((row) => [row.company, row.ticketCount]), [
    ["公司C", 20],
    ["公司A", 8],
    ["公司B", 3]
  ]);
  assert.deepEqual(productRankingPack.facts.productSales.commercialRanking.map((row) => [
    row.company,
    row.commercialCount,
    row.commercialInitialCount,
    row.commercialRetrainingCount
  ]), [
    ["公司B", 9, 5, 4],
    ["公司A", 1, 1, 0]
  ]);
  assert.equal(productRankingPack.facts.productSales.ticketRanking.some((row) => row.company === "公司C"), true);
  assert.equal(productRankingPack.facts.productSales.commercialRanking.some((row) => row.company === "公司C"), false);
  const companyAOppMix = productRankingPack.facts.productSales.companyProductMix.filter((row) => row.company === "公司A" && row.source === "oppOrder");
  assert.equal(companyAOppMix.length, 2);
  const vipTicketMix = companyAOppMix.find((row) => row.product === "VIP门票");
  const oppTicketMix = companyAOppMix.find((row) => row.product === "OPP门票");
  assert.deepEqual({ quantity: vipTicketMix.quantity, revenue: vipTicketMix.revenue }, { quantity: 6, revenue: 600 });
  assertApproximately(vipTicketMix.quantityShare, 75);
  assertApproximately(vipTicketMix.revenueShare, 60);
  assertApproximately(oppTicketMix.quantityShare, 25);
  assertApproximately(oppTicketMix.revenueShare, 40);
  assertApproximately(companyAOppMix.reduce((total, row) => total + row.quantityShare, 0), 100);
  assertApproximately(companyAOppMix.reduce((total, row) => total + row.revenueShare, 0), 100);
  assert.equal(productRankingPack.facts.productSales.companyProductMix.filter((row) => row.product === "VIP门票").length, 2);

  const crossMonthCourseSource = emptyBusinessRecords(source);
  crossMonthCourseSource.records.course = [
    record("course", "cross-c1", { date_1: shanghaiTimestamp("2026-01-20"), text_1: "一月课程", text_5: "公司A", text_10: "课程" })
  ];
  crossMonthCourseSource.records.booking = [
    record("booking", "cross-b1", { text_5: rel("cross-c1"), text_22: "老板", text_36: "客户企业1" }),
    record("booking", "cross-b2", { text_5: rel("cross-c1"), text_22: "员工", text_36: "客户企业2" })
  ];
  crossMonthCourseSource.records.performance = [
    record("performance", "cross-order-same-month", {
      date_1: shanghaiTimestamp("2026-01-25"),
      text_63: "公司A",
      text_28: rel("cross-c1"),
      num_1: 500,
      array_4: [{ text_10: "课程", text_1: "一月课程", num_3: 1, num_5: 200 }]
    })
  ];
  crossMonthCourseSource.records.courseOrders = [
    record("courseOrders", "cross-order-same-month", {
      date_1: shanghaiTimestamp("2026-01-25"), text_28: rel("cross-c1"), num_1: 500
    }),
    record("courseOrders", "cross-order-next-month", {
      date_1: shanghaiTimestamp("2026-02-03"), text_28: rel("cross-c1"), num_1: 800
    })
  ];
  const crossMonthCoursePack = buildFactPack(sealSource(crossMonthCourseSource), { domains: "performance,courses" });
  assert.equal(crossMonthCoursePack.facts.performance.summary.total, 200);
  assert.equal(crossMonthCoursePack.facts.courses.summary.dealOrders, 2);
  assert.equal(crossMonthCoursePack.facts.courses.summary.dealAmount, 1300);
  assert.equal(crossMonthCoursePack.facts.courses.summary.conversionRate, 100);
  assert.equal(crossMonthCoursePack.facts.courses.courses[0].dealAmount, 1300);

  const positionSource = JSON.parse(JSON.stringify(source));
  positionSource.records.booking = [
    record("booking", "position-b1", { text_5: rel("c1"), text_22: "老板", text_36: "客户企业1" }),
    record("booking", "position-b2", { text_5: rel("c1"), text_22: "老板", text_36: "客户企业2" }),
    record("booking", "position-b3", { text_5: rel("c1"), text_22: "老板助理", text_36: "客户企业3" }),
    record("booking", "position-b4", { text_5: rel("c1"), text_22: "总经理", text_36: "客户企业4" }),
    record("booking", "position-b5", { text_5: rel("c1"), text_36: "客户企业5" })
  ];
  const positionPack = buildFactPack(sealSource(positionSource), { domains: "courses" });
  assert.equal(positionPack.facts.courses.summary.students, 5);
  assert.equal(positionPack.facts.courses.summary.bosses, 2);
  const overallPositions = positionPack.facts.courses.positionBreakdown;
  const coursePositions = positionPack.facts.courses.courses[0].positionBreakdown;
  assert.deepEqual(Object.fromEntries(overallPositions.map((row) => [row.position, row.count])), {
    老板: 2,
    老板助理: 1,
    总经理: 1,
    未填写: 1
  });
  assert.deepEqual(Object.fromEntries(coursePositions.map((row) => [row.position, row.count])), {
    老板: 2,
    老板助理: 1,
    总经理: 1,
    未填写: 1
  });
  assertApproximately(overallPositions.reduce((total, row) => total + row.share, 0), 100);
  assertApproximately(coursePositions.find((row) => row.position === "老板").share, 40);

  const deliveryWithoutRelationsSource = JSON.parse(JSON.stringify(source));
  deliveryWithoutRelationsSource.records.deliveryBooking = [];
  const deliveryWithoutRelations = buildFactPack(sealSource(deliveryWithoutRelationsSource), { domains: "delivery" });
  assert.equal(deliveryWithoutRelations.facts.delivery.summary.deliveryCourseCount, 1);
  assert.equal(deliveryWithoutRelations.facts.delivery.summary.invitations, 0);
  assert.equal(deliveryWithoutRelations.facts.delivery.summary.bosses, 0);
  assert.equal(deliveryWithoutRelations.facts.delivery.summary.students, 0);
  assert.equal(deliveryWithoutRelations.facts.delivery.summary.attributedPaidAmount, 0);
  assert.deepEqual(deliveryWithoutRelations.facts.delivery.companies, []);
  assert.equal(deliveryWithoutRelations.facts.delivery.courses[0].invitations, 0);
  assert.equal(deliveryWithoutRelations.facts.delivery.courses[0].bosses, 0);
  assert.equal(JSON.stringify(deliveryWithoutRelations.facts.delivery).includes("booking_b1"), false);

  const deliveryRoleSource = JSON.parse(JSON.stringify(source));
  deliveryRoleSource.records.deliveryBooking = [
    record("deliveryBooking", "delivery-role", {
      date_3: shanghaiTimestamp("2026-01-18"), text_2: rel("c1"), text_7: "业绩订单", text_8: rel("order-role"),
      text_26: "公司A", num_1: 2, num_2: 3, num_3: 100
    })
  ];
  const deliveryRolePack = buildFactPack(sealSource(deliveryRoleSource), { domains: "delivery" });
  assert.equal(deliveryRolePack.facts.delivery.summary.invitations, 1);
  assert.equal(deliveryRolePack.facts.delivery.summary.bosses, 2);
  assert.equal(deliveryRolePack.facts.delivery.summary.students, 3);
  assert.equal(deliveryRolePack.facts.delivery.courses[0].bosses, 2);
  assert.equal(deliveryRolePack.facts.delivery.dailyTrend[0].bosses, 2);

  const deliveryCompanyScopeSource = JSON.parse(JSON.stringify(source));
  deliveryCompanyScopeSource.records.deliveryBooking = [
    record("deliveryBooking", "delivery-company-a", {
      date_3: shanghaiTimestamp("2026-01-18"), text_2: rel("c1"), text_7: "业绩订单", text_8: rel("order-a"),
      text_26: "公司A", num_1: 1, num_2: 2, num_3: 100
    }),
    record("deliveryBooking", "delivery-company-b", {
      date_3: shanghaiTimestamp("2026-01-18"), text_2: rel("c1"), text_7: "业绩订单", text_8: rel("order-b"),
      text_26: "公司B", num_1: 3, num_2: 4, num_3: 900
    })
  ];
  const deliveryCompanyScope = buildFactPack(sealSource(deliveryCompanyScopeSource), { domains: "delivery", company: "公司B" });
  assert.equal(deliveryCompanyScope.status, "ready");
  assert.equal(deliveryCompanyScope.facts.delivery.summary.invitations, 1);
  assert.equal(deliveryCompanyScope.facts.delivery.summary.bosses, 3);
  assert.equal(deliveryCompanyScope.facts.delivery.summary.students, 4);
  assert.equal(deliveryCompanyScope.facts.delivery.summary.attributedPaidAmount, 900);
  assert.equal(deliveryCompanyScope.facts.delivery.courses[0].invitations, 1);
  assert.equal(deliveryCompanyScope.facts.delivery.courses[0].bosses, 3);
  assert.equal(deliveryCompanyScope.facts.delivery.courses[0].students, 4);
  assert.equal(deliveryCompanyScope.facts.delivery.courses[0].attributedPaidAmount, 900);
  assert.equal(deliveryCompanyScope.facts.delivery.courses[0].amountScope, "selected-company-attribution");
  for (const field of ["dealOrders", "courseDealAmount", "coursePaidAmount"]) {
    assert.equal(Object.hasOwn(deliveryCompanyScope.facts.delivery.courses[0], field), false);
  }

  const zeroActivitySource = emptyBusinessRecords(source);
  zeroActivitySource.records.user = source.records.user.slice();
  const zeroPerson = buildFactPack(sealSource(zeroActivitySource), { domains: "opportunities", person: "销售乙" });
  assert.equal(zeroPerson.status, "ready");
  assert.equal(zeroPerson.scope.person.name, "销售乙");
  assert.equal(zeroPerson.facts.opportunities.summary.createdCount, 0);
  assert.equal(zeroPerson.facts.opportunities.summary.expectedAmount, 0);
  const zeroCompany = buildFactPack(sealSource(zeroActivitySource), { domains: "courses", company: "公司A" });
  assert.equal(zeroCompany.status, "ready");
  assert.equal(zeroCompany.facts.courses.summary.courseCount, 0);

  const directFollowSource = emptyBusinessRecords(source);
  directFollowSource.records.user = source.records.user.slice(0, 1);
  directFollowSource.records.opportunity = [
    record("opportunity", "direct-op1", {
      creatorId: rel("u1"), text_1: "真实直连商机", text_3: rel("shared-customer"), text_11: "公司A", text_12: "高", text_17: "解决方案", num_1: 1000
    }, { addTime: shanghaiTimestamp("2026-01-02") }),
    record("opportunity", "direct-op2", {
      creatorId: rel("u1"), text_1: "同客户其他商机", text_3: rel("shared-customer"), text_11: "公司A", text_12: "高", text_17: "解决方案", num_1: 900
    }, { addTime: shanghaiTimestamp("2026-01-03") })
  ];
  directFollowSource.records.follow = [
    record("follow", "direct-f1", {
      date_1: shanghaiTimestamp("2026-01-08"), text_1: rel("shared-customer"), text_5: rel("direct-op1"),
      text_6: "已经和老板确认需求，下周继续安排方案沟通并确认下一步。"
    })
  ];
  const directFollowPack = buildFactPack(sealSource(directFollowSource), { domains: "opportunities" });
  const directlyFollowed = directFollowPack.facts.opportunities.opportunities.find((row) => row.entityId === "rel_direct-op1");
  const sameCustomerOnly = directFollowPack.facts.opportunities.opportunities.find((row) => row.entityId === "rel_direct-op2");
  assert.equal(directlyFollowed.signals.followCount, 1);
  assert.equal(sameCustomerOnly.signals.followCount, 0);
  assert.equal(sameCustomerOnly.evidenceRefs.includes("follow_direct-f1"), false);
  assert.equal(directFollowPack.facts.opportunities.summary.followCount, 1);

  const exact = buildFactPack(source, { domains: "courses,opportunities", company: "公司A", person: "销售甲" });
  assert.equal(exact.status, "ready");
  assert.equal(exact.scope.company, "公司A");
  assert.equal(exact.scope.person.name, "销售甲");

  const ambiguous = buildFactPack(source, { domains: "performance", company: "公司" });
  assert.equal(ambiguous.status, "needs_disambiguation");
  assert.ok(ambiguous.entityResolution.company.candidates.length >= 2);
  assert.deepEqual(ambiguous.facts, {});

  const secondSource = JSON.parse(JSON.stringify(source));
  secondSource.month = "2026-02";
  secondSource.range = { month: "2026-02", start: 1769875200, end: 1772294399, startLabel: "2026-02-01", endLabel: "2026-02-28" };
  secondSource.refreshedAt = "2026-02-28T10:00:00.000Z";
  const secondsInJanuary = 31 * 86400;
  for (const rows of Object.values(secondSource.records)) {
    for (const row of rows) {
      if (Number.isFinite(row.addTime)) row.addTime += secondsInJanuary;
      for (const attr of ["date_1", "date_2", "date_3"]) {
        if (Number.isFinite(row.fields?.[attr])) row.fields[attr] += secondsInJanuary;
      }
    }
  }
  const secondPack = buildFactPack(sealSource(secondSource), { domains: "all" });
  const annual = buildMultiPeriodFactPack([pack, secondPack], { domains: ["all"] });
  assert.equal(annual.mode, "xbb-live-readonly-multi-period-aggregate");
  assert.equal(annual.facts.performance.summary.total, 980);
  assert.equal(annual.facts.performance.monthlyTrend.length, 2);
  assert.equal(annual.facts.performance.ranking.find((row) => row.company === "公司A").total, 820);
  assert.deepEqual(annual.facts.productSales.ticketRanking.map((row) => [row.company, row.ticketCount]), [["公司A", 6]]);
  assert.deepEqual(annual.facts.productSales.commercialRanking.map((row) => [
    row.company,
    row.commercialCount,
    row.commercialInitialCount,
    row.commercialRetrainingCount
  ]), [["公司A", 6, 4, 2]]);
  assertApproximately(
    annual.facts.productSales.companyProductMix
      .filter((row) => row.company === "公司A" && row.source === "oppOrder")
      .reduce((total, row) => total + row.quantityShare, 0),
    100
  );
  assert.deepEqual(Object.fromEntries(annual.facts.courses.positionBreakdown.map((row) => [row.position, row.count])), { 老板: 2, 员工: 2 });
  assertApproximately(annual.facts.courses.positionBreakdown.reduce((total, row) => total + row.share, 0), 100);
  assert.equal(annual.facts.opportunities.summary.createdCount, 2);
  assert.equal(Object.hasOwn(annual, "periods"), false);
  assert.ok(Buffer.byteLength(JSON.stringify(annual), "utf8") < MAX_AGGREGATE_BYTES);
  assert.equal(assertSafeFactPack(annual), annual);

  const januaryCompanyPack = buildFactPack(source, { domains: "performance", company: "公司A" });
  const februaryNoActivitySource = emptyBusinessRecords(secondSource);
  const februaryNoActivityPack = buildFactPack(sealSource(februaryNoActivitySource), { domains: "performance", company: "公司A" });
  assert.equal(januaryCompanyPack.status, "ready");
  assert.equal(februaryNoActivityPack.status, "needs_disambiguation");
  assert.equal(februaryNoActivityPack.entityResolution.company.status, "not_found");
  const companyWithZeroMonth = buildMultiPeriodFactPack(
    [januaryCompanyPack, februaryNoActivityPack],
    { domains: ["performance"], company: "公司A" }
  );
  assert.equal(companyWithZeroMonth.status, "ready");
  assert.equal(companyWithZeroMonth.entityResolution.company.status, "resolved");
  assert.deepEqual(companyWithZeroMonth.entityResolution.company.crossPeriodResolution, {
    status: "resolved_with_zero_activity_months",
    resolvedMonths: ["2026-01"],
    zeroActivityMonths: ["2026-02"]
  });
  assert.deepEqual(
    companyWithZeroMonth.facts.performance.monthlyTrend.map((row) => [row.month, row.total]),
    [["2026-01", januaryCompanyPack.facts.performance.summary.total], ["2026-02", 0]]
  );
  assert.equal(companyWithZeroMonth.facts.performance.summary.total, januaryCompanyPack.facts.performance.summary.total);
  assert.match(companyWithZeroMonth.limitations.join("\n"), /zeroActivityMonths.*零值.*完整月度趋势/);
  assert.equal(assertSafeFactPack(companyWithZeroMonth), companyWithZeroMonth);

  const januaryNotFoundPack = buildFactPack(sealSource(emptyBusinessRecords(source)), { domains: "performance", company: "不存在公司" });
  const februaryNotFoundPack = buildFactPack(sealSource(emptyBusinessRecords(secondSource)), { domains: "performance", company: "不存在公司" });
  const allMonthsNotFound = buildMultiPeriodFactPack(
    [januaryNotFoundPack, februaryNotFoundPack],
    { domains: ["performance"], company: "不存在公司" }
  );
  assert.equal(allMonthsNotFound.status, "needs_disambiguation");
  assert.equal(allMonthsNotFound.entityResolution.company.status, "not_found");
  assert.deepEqual(allMonthsNotFound.facts, {});

  const februaryCompanyBPack = buildFactPack(secondSource, { domains: "performance", company: "公司B" });
  const conflictingCompany = buildMultiPeriodFactPack(
    [januaryCompanyPack, februaryCompanyBPack],
    { domains: ["performance"], company: "公司" }
  );
  assert.equal(conflictingCompany.status, "needs_disambiguation");
  assert.equal(conflictingCompany.entityResolution.company.status, "needs_disambiguation");
  assert.equal(conflictingCompany.entityResolution.company.crossPeriodResolution.status, "conflicting_resolutions");
  assert.equal(conflictingCompany.entityResolution.company.candidates.some((row) => row.name === "公司A"), true);
  assert.equal(conflictingCompany.entityResolution.company.candidates.some((row) => row.name === "公司B"), true);
  assert.deepEqual(conflictingCompany.facts, {});

  const ambiguousAcrossMonths = buildMultiPeriodFactPack(
    [ambiguous, februaryNoActivityPack],
    { domains: ["performance"], company: "公司" }
  );
  assert.equal(ambiguousAcrossMonths.status, "needs_disambiguation");
  assert.equal(ambiguousAcrossMonths.entityResolution.company.status, "needs_disambiguation");
  assert.deepEqual(ambiguousAcrossMonths.facts, {});

  const secondDeliveryCompanySource = JSON.parse(JSON.stringify(deliveryCompanyScopeSource));
  secondDeliveryCompanySource.month = "2026-02";
  secondDeliveryCompanySource.range = { month: "2026-02", start: 1769875200, end: 1772294399, startLabel: "2026-02-01", endLabel: "2026-02-28" };
  secondDeliveryCompanySource.refreshedAt = "2026-02-28T10:00:00.000Z";
  for (const rows of Object.values(secondDeliveryCompanySource.records)) {
    for (const row of rows) {
      if (Number.isFinite(row.addTime)) row.addTime += secondsInJanuary;
      for (const attr of ["date_1", "date_2", "date_3"]) {
        if (Number.isFinite(row.fields?.[attr])) row.fields[attr] += secondsInJanuary;
      }
    }
  }
  const secondDeliveryCompanyPack = buildFactPack(sealSource(secondDeliveryCompanySource), { domains: "delivery", company: "公司B" });
  const deliveryCompanyAggregate = buildMultiPeriodFactPack(
    [deliveryCompanyScope, secondDeliveryCompanyPack],
    { domains: ["delivery"], company: "公司B" }
  );
  assert.equal(deliveryCompanyAggregate.facts.delivery.summary.invitations, 2);
  assert.equal(deliveryCompanyAggregate.facts.delivery.summary.attributedPaidAmount, 1800);
  assert.equal(deliveryCompanyAggregate.facts.delivery.courseHighlights.every((row) => row.invitations === 1 && row.bosses === 3), true);
  assert.equal(deliveryCompanyAggregate.facts.delivery.courseHighlights.some((row) => Object.hasOwn(row, "coursePaidAmount")), false);

  assert.equal(findSensitiveFactValue({ integrity: { factPackSha256: "hash_13800138000" }, amount: 13800138000 }), null);
  assert.doesNotThrow(() => assertNoSensitiveFactValues({ evidenceRef: "record_13800138000", amount: 13800138000 }));
  assert.throws(() => assertNoSensitiveFactValues({ company: "客户13800138000" }), /隐私扫描/);
  assert.throws(() => assertNoSensitiveFactValues({ note: "owner@example.com" }), /隐私扫描/);
  assert.deepEqual([...collectionsForDomains("performance")].sort(), ["performance", "product"]);
  assert.deepEqual([...collectionsForDomains("courses")].sort(), ["booking", "course", "courseOrders", "deliveryBooking"]);
  assert.deepEqual([...collectionsForDomains("delivery")].sort(), ["course", "courseOrders", "deliveryBooking"]);
  assert.deepEqual([...collectionsForDomains(["opportunities"])].sort(), ["follow", "opportunity", "user"]);
  assert.equal(runnerTimeoutMs(1), 300000);
  assert.equal(runnerTimeoutMs(9), 540000);
  assert.equal(runnerTimeoutMs(12), 720000);
  assert.equal(runnerTimeoutMs(120), 900000);
  assert.equal(DEFAULT_MAX_CONCURRENT_QUERIES, 1, "默认只能启动一个不同范围的真实查询，避免突破 API 节流");
  assert.equal(DEFAULT_QUERY_QUEUE_TTL_MS, 12 * 60 * 1000, "默认排队窗口必须覆盖年度冷查询时长");
  assert.match(String(terminateWindowsProcessTree), /\["\/PID", String\(pid\), "\/T", "\/F"\]/, "Windows 回收必须覆盖 PowerShell 完整进程树");
  assert.equal(QUERY_XBB_INPUT_SCHEMA.properties.months.maxItems, 120);
  assert.throws(() => buildMultiPeriodFactPack(Array.from({ length: 121 }, () => pack)), /120/);
  const runnerSource = fs.readFileSync(path.join(__dirname, "..", "skills", "xbb-executive-analyst", "scripts", "query-xbb.ps1"), "utf8");
  assert.match(runnerSource, /source-v6-\$tenantFingerprint-/);
  assert.match(runnerSource, /baseUrl[\s\S]+corpid[\s\S]+tenantFingerprint/);

  const annualPlan = { months: ["2026-01", "2026-02", "2026-03"], domains: ["performance"] };
  assert.equal(monthsLabel(annualPlan.months), "2026年1—3月");
  assert.deepEqual(normalizeRunnerProgressEvent({ stage: "month_completed", month: "2026-02", index: 2, completed: 2, total: 3, source: "live", secret: "ignored" }), {
    stage: "month_completed", month: "2026-02", index: 2, completed: 2, total: 3, source: "live"
  });
  assert.equal(normalizeRunnerProgressEvent({ stage: "invented", month: "2026-02" }), null);
  const readableProgress = formatQueryProgress(annualPlan, { stage: "month_started", month: "2026-03", index: 3, completed: 2, total: 3 }, { scope: "all" });
  assert.match(readableProgress, /2026年1—3月/);
  assert.match(readableProgress, /已完成 2\/3/);
  assert.match(readableProgress, /公司排名/);

  const gatewayRoot = fs.mkdtempSync(path.join(os.tmpdir(), "xbb-progress-test-"));
  try {
    const runner = path.join(gatewayRoot, "query-xbb.ps1");
    fs.writeFileSync(runner, "# test runner\n", "utf8");
    const firstProgressEvents = [];
    const secondProgressEvents = [];
    let executionCount = 0;
    const gateway = createToolGateway({
      runner,
      powershell: "powershell-test",
      progressPollMs: 10,
      execFile: async (_command, args) => {
        executionCount += 1;
        const outputPath = args[args.indexOf("-OutputPath") + 1];
        const progressPath = args[args.indexOf("-ProgressPath") + 1];
        fs.writeFileSync(progressPath, `${JSON.stringify({ stage: "run_started", completed: 0, total: 1 })}\n`, "utf8");
        await new Promise((resolve) => setTimeout(resolve, 15));
        fs.appendFileSync(progressPath, `${JSON.stringify({ stage: "month_completed", month: "2026-01", index: 1, completed: 1, total: 1, source: "live" })}\n`, "utf8");
        fs.writeFileSync(outputPath, `${JSON.stringify(pack)}\n`, "utf8");
        return { stdout: "", stderr: "" };
      }
    });
    const firstQuery = gateway({ months: ["2026-01"], domains: ["all"] }, { scope: "all" }, {
      onProgress: async (event) => firstProgressEvents.push(event)
    });
    const secondQuery = gateway({ months: ["2026-01"], domains: ["all"] }, { scope: "all" }, {
      onProgress: async (event) => secondProgressEvents.push(event)
    });
    const [firstGatewayPack, secondGatewayPack] = await Promise.all([firstQuery, secondQuery]);
    assert.equal(executionCount, 1);
    assert.equal(firstGatewayPack.integrity.factPackSha256, pack.integrity.factPackSha256);
    assert.equal(secondGatewayPack.integrity.factPackSha256, pack.integrity.factPackSha256);
    assert.deepEqual(firstProgressEvents.map((event) => event.stage), ["run_started", "month_completed", "validating", "query_ready"]);
    assert.deepEqual(secondProgressEvents.map((event) => event.stage), ["run_started", "month_completed", "validating", "query_ready"]);
    const alreadyAborted = new AbortController();
    alreadyAborted.abort(new Error("cancelled before subscribe"));
    await assert.rejects(
      gateway({ months: ["2026-01"], domains: ["all"] }, { scope: "all" }, { signal: alreadyAborted.signal }),
      /cancelled before subscribe/
    );
    assert.equal(executionCount, 1, "预先取消的订阅不得创建或污染 single-flight 项");
    await gateway({ months: ["2026-01"], domains: ["all"] }, { scope: "all" });
    assert.equal(executionCount, 2, "预先取消后相同 key 必须仍可正常执行");

    let retryExecutionCount = 0;
    const retryGateway = createToolGateway({
      runner,
      powershell: "powershell-test",
      progressPollMs: 10,
      execFile: async (_command, args) => {
        retryExecutionCount += 1;
        if (retryExecutionCount === 1) throw new Error("temporary socket reset");
        const outputPath = args[args.indexOf("-OutputPath") + 1];
        fs.writeFileSync(outputPath, `${JSON.stringify(pack)}\n`, "utf8");
        return { stdout: "", stderr: "" };
      }
    });
    const retryPack = await retryGateway({ months: ["2026-01"], domains: ["all"] }, { scope: "all" });
    assert.equal(retryExecutionCount, 2);
    assert.equal(retryPack.integrity.factPackSha256, pack.integrity.factPackSha256);

    const fifoStarts = [];
    const fifoReleases = [];
    const fifoGateway = createToolGateway({
      runner,
      powershell: "powershell-test",
      maxConcurrentQueries: 2,
      maxQueuedQueries: 4,
      queueTtlMs: 1000,
      execFile: async (_command, args, options) => new Promise((resolve, reject) => {
        const company = args.includes("-Company") ? args[args.indexOf("-Company") + 1] : "group";
        const outputPath = args[args.indexOf("-OutputPath") + 1];
        fifoStarts.push(company);
        const finish = () => {
          fs.writeFileSync(outputPath, `${JSON.stringify(pack)}\n`, "utf8");
          resolve({ stdout: "", stderr: "" });
        };
        fifoReleases.push(finish);
        options.signal?.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      })
    });
    const fifoA = fifoGateway({ months: ["2026-01"], domains: ["all"], company: "公司A" }, { scope: "all" });
    const fifoB = fifoGateway({ months: ["2026-01"], domains: ["all"], company: "公司B" }, { scope: "all" });
    const fifoC = fifoGateway({ months: ["2026-01"], domains: ["all"], company: "公司C" }, { scope: "all" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(fifoStarts, ["公司A", "公司B"]);
    fifoReleases[0]();
    await fifoA;
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(fifoStarts, ["公司A", "公司B", "公司C"], "不同查询必须按有界 FIFO 启动");
    fifoReleases[1]();
    fifoReleases[2]();
    await Promise.all([fifoB, fifoC]);

    let sharedRunnerSignal;
    let finishSharedRunner;
    const sharedGateway = createToolGateway({
      runner,
      powershell: "powershell-test",
      maxConcurrentQueries: 1,
      execFile: async (_command, args, options) => new Promise((resolve, reject) => {
        sharedRunnerSignal = options.signal;
        const outputPath = args[args.indexOf("-OutputPath") + 1];
        finishSharedRunner = () => {
          fs.writeFileSync(outputPath, `${JSON.stringify(pack)}\n`, "utf8");
          resolve({ stdout: "", stderr: "" });
        };
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      })
    });
    const firstSubscriber = new AbortController();
    const secondSubscriber = new AbortController();
    const sharedFirst = sharedGateway({ months: ["2026-01"], domains: ["all"] }, { scope: "all" }, { signal: firstSubscriber.signal });
    const sharedSecond = sharedGateway({ months: ["2026-01"], domains: ["all"] }, { scope: "all" }, { signal: secondSubscriber.signal });
    await new Promise((resolve) => setImmediate(resolve));
    firstSubscriber.abort(new Error("first subscriber left"));
    await assert.rejects(sharedFirst, /first subscriber left/);
    assert.equal(sharedRunnerSignal.aborted, false, "仍有订阅者时不得取消 single-flight runner");
    finishSharedRunner();
    assert.equal((await sharedSecond).integrity.factPackSha256, pack.integrity.factPackSha256);

    let abandonedRunnerSignal;
    const abandonedGateway = createToolGateway({
      runner,
      powershell: "powershell-test",
      maxConcurrentQueries: 1,
      execFile: async (_command, _args, options) => new Promise((_resolve, reject) => {
        abandonedRunnerSignal = options.signal;
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      })
    });
    const abandonedSubscriber = new AbortController();
    const abandonedQuery = abandonedGateway({ months: ["2026-01"], domains: ["all"] }, { scope: "all" }, { signal: abandonedSubscriber.signal });
    await new Promise((resolve) => setImmediate(resolve));
    abandonedSubscriber.abort(new Error("last subscriber left"));
    await assert.rejects(abandonedQuery, /last subscriber left/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(abandonedRunnerSignal.aborted, true, "最后订阅者退出必须取消 runner");

    let windowsTreePid = null;
    let windowsDirectKillCalled = false;
    let rejectWindowsRunner;
    const windowsAbort = new AbortController();
    const windowsRunner = (_command, _args, options) => {
      assert.equal(Object.hasOwn(options, "signal"), false, "Windows runner 必须由进程树回收器统一取消");
      const promise = new Promise((_resolve, reject) => { rejectWindowsRunner = reject; });
      promise.child = {
        pid: 43210,
        kill: () => {
          windowsDirectKillCalled = true;
          rejectWindowsRunner(new Error("runner killed"));
          return true;
        }
      };
      return promise;
    };
    const windowsExecution = runRunnerProcess(windowsRunner, "powershell.exe", ["runner.ps1"], {
      platform: "win32",
      enforceWindowsProcessTree: true,
      signal: windowsAbort.signal,
      timeoutMs: 1000,
      processTreeTerminator: async (pid) => { windowsTreePid = pid; }
    });
    windowsAbort.abort(new Error("active cancelled"));
    await assert.rejects(windowsExecution, /active cancelled/);
    assert.equal(windowsTreePid, 43210, "Windows 取消必须对 PowerShell PID 执行 taskkill /T 语义");
    assert.equal(windowsDirectKillCalled, true, "进程树回收后仍应尝试终止直接子进程作为兜底");

    if (process.platform === "win32") {
      const realTreeScript = path.join(gatewayRoot, "verify-process-tree.ps1");
      const realTreePidPath = path.join(gatewayRoot, "verify-process-tree.pid");
      const escapedPidPath = realTreePidPath.replace(/'/g, "''");
      fs.writeFileSync(realTreeScript, [
        "$ErrorActionPreference = 'Stop'",
        "$child = Start-Process -FilePath 'ping.exe' -ArgumentList @('-t', '127.0.0.1') -WindowStyle Hidden -PassThru",
        `[IO.File]::WriteAllText('${escapedPidPath}', [string]$child.Id)`,
        "Wait-Process -Id $child.Id"
      ].join("\r\n"), "utf8");
      const realTreeAbort = new AbortController();
      const realExecFile = util.promisify(childProcess.execFile);
      const realExecutionOutcome = runRunnerProcess(
        realExecFile,
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", realTreeScript],
        {
          platform: "win32",
          enforceWindowsProcessTree: true,
          signal: realTreeAbort.signal,
          timeoutMs: 5000,
          windowsHide: true,
          encoding: "utf8"
        }
      ).then((value) => ({ value }), (error) => ({ error }));
      for (let attempt = 0; attempt < 100 && !fs.existsSync(realTreePidPath); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (!fs.existsSync(realTreePidPath)) {
        realTreeAbort.abort(new Error("process tree setup failed"));
        const outcome = await realExecutionOutcome;
        assert.fail(`Windows 进程树测试未能启动子进程：${outcome.error?.message || "unknown"}`);
      }
      const realTreeChildPid = Number(fs.readFileSync(realTreePidPath, "utf8").trim());
      assert.ok(Number.isInteger(realTreeChildPid) && realTreeChildPid > 0);
      realTreeAbort.abort(new Error("real process tree cancelled"));
      const realTreeOutcome = await realExecutionOutcome;
      assert.match(realTreeOutcome.error?.message || "", /real process tree cancelled/);
      const isRealTreeChildAlive = () => {
        try { process.kill(realTreeChildPid, 0); return true; } catch { return false; }
      };
      for (let attempt = 0; attempt < 100 && isRealTreeChildAlive(); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (isRealTreeChildAlive()) {
        childProcess.spawnSync("taskkill.exe", ["/PID", String(realTreeChildPid), "/T", "/F"], { windowsHide: true });
      }
      assert.equal(isRealTreeChildAlive(), false, "Abort 后不得遗留 PowerShell 启动的 exporter 类子进程");
    }

    const queuedCancellationStarts = [];
    const queuedCancellationReleases = new Map();
    const queuedCancellationGateway = createToolGateway({
      runner,
      powershell: "powershell-test",
      maxConcurrentQueries: 1,
      maxQueuedQueries: 1,
      queueTtlMs: 1000,
      execFile: async (_command, args, options) => new Promise((resolve, reject) => {
        const company = args[args.indexOf("-Company") + 1];
        const outputPath = args[args.indexOf("-OutputPath") + 1];
        queuedCancellationStarts.push(company);
        queuedCancellationReleases.set(company, () => {
          fs.writeFileSync(outputPath, `${JSON.stringify(pack)}\n`, "utf8");
          resolve({ stdout: "", stderr: "" });
        });
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      })
    });
    const cancellationBlocker = queuedCancellationGateway(
      { months: ["2026-01"], domains: ["all"], company: "取消队首" },
      { scope: "all" }
    );
    const queuedCancellation = new AbortController();
    const cancelledWhileQueued = queuedCancellationGateway(
      { months: ["2026-01"], domains: ["all"], company: "排队取消" },
      { scope: "all" },
      { signal: queuedCancellation.signal }
    );
    queuedCancellation.abort(new Error("queued subscriber left"));
    await assert.rejects(cancelledWhileQueued, /queued subscriber left/);
    const replacementAfterCancellation = queuedCancellationGateway(
      { months: ["2026-01"], domains: ["all"], company: "取消后接替" },
      { scope: "all" }
    );
    assert.deepEqual(queuedCancellationStarts, ["取消队首"], "已取消的排队项不得启动 runner");
    queuedCancellationReleases.get("取消队首")();
    await cancellationBlocker;
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(queuedCancellationStarts, ["取消队首", "取消后接替"]);
    queuedCancellationReleases.get("取消后接替")();
    await replacementAfterCancellation;

    let releaseQueueBlocker;
    const queueGateway = createToolGateway({
      runner,
      powershell: "powershell-test",
      maxConcurrentQueries: 1,
      maxQueuedQueries: 1,
      queueTtlMs: 20,
      execFile: async (_command, args, options) => new Promise((resolve, reject) => {
        const outputPath = args[args.indexOf("-OutputPath") + 1];
        releaseQueueBlocker = () => {
          fs.writeFileSync(outputPath, `${JSON.stringify(pack)}\n`, "utf8");
          resolve({ stdout: "", stderr: "" });
        };
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      })
    });
    const queueBlocker = queueGateway({ months: ["2026-01"], domains: ["all"], company: "队首" }, { scope: "all" });
    const queuedTimeout = queueGateway({ months: ["2026-01"], domains: ["all"], company: "排队" }, { scope: "all" });
    await assert.rejects(
      queueGateway({ months: ["2026-01"], domains: ["all"], company: "超限" }, { scope: "all" }),
      (error) => error?.code === "XBB_QUERY_QUEUE_FULL"
    );
    const keepQueueTimerAlive = setTimeout(() => {}, 1000);
    await assert.rejects(queuedTimeout, (error) => error?.code === "XBB_QUERY_QUEUE_TIMEOUT");
    clearTimeout(keepQueueTimerAlive);
    releaseQueueBlocker();
    await queueBlocker;
  } finally {
    fs.rmSync(gatewayRoot, { recursive: true, force: true });
  }

  process.stdout.write(`${JSON.stringify({ success: true, checks: 164, factPackSha256: pack.integrity.factPackSha256 })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
