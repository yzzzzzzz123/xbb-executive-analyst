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
  ISOLATION_SERVICE,
  ISOLATION_TOKEN_PATTERN,
  RUNNER_ISOLATION_ERROR_CODE,
  clearRunnerIsolationMarker,
  createRunnerIsolationMarker,
  defaultGatewayWorkRoot,
  parseRecoveryResult,
  readRunnerIsolationMarker,
  recoverRunnerIsolation,
  recoverRunnerIsolationForTest,
  runnerIsolationDirectory
} = require("../shared/xbb/runner-isolation.js");
const {
  DEFAULT_MAX_CONCURRENT_QUERIES,
  DEFAULT_MAX_QUEUED_QUERIES,
  DEFAULT_PROCESS_TREE_TERMINATION_DEADLINE_MS,
  DEFAULT_QUERY_QUEUE_TTL_MS,
  GATEWAY_FAIL_CLOSED_CODE,
  PROCESS_TREE_UNCONFIRMED_CODE,
  RUNNER_EXECUTION_ERROR_CODE,
  assertSafeFactPack,
  createToolGateway,
  createToolGatewayForTest,
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
  assert.equal(DEFAULT_MAX_QUEUED_QUERIES, 32, "默认真实查询排队上限不得被放大");
  assert.ok(DEFAULT_QUERY_QUEUE_TTL_MS > runnerTimeoutMs(120), "默认排队窗口必须覆盖前一个 runner 的最长单次执行");
  assert.ok(DEFAULT_QUERY_QUEUE_TTL_MS < 20 * 60 * 1000, "默认排队窗口必须服从 Agent 的 20 分钟绝对截止");
  assert.ok(DEFAULT_PROCESS_TREE_TERMINATION_DEADLINE_MS <= 60 * 1000, "进程树确认必须有短而有限的硬截止");
  assert.equal(await terminateWindowsProcessTree(2147483646), false,
    "仅凭 PID 的默认 Windows 回收器必须 fail-closed，不能冒险终止已复用进程");
  assert.equal(QUERY_XBB_INPUT_SCHEMA.properties.months.maxItems, 120);
  assert.throws(() => buildMultiPeriodFactPack(Array.from({ length: 121 }, () => pack)), /120/);
  const runnerSource = fs.readFileSync(path.join(__dirname, "..", "skills", "xbb-executive-analyst", "scripts", "query-xbb.ps1"), "utf8");
  assert.match(runnerSource, /source-v6-\$tenantFingerprint-/);
  assert.match(runnerSource, /baseUrl[\s\S]+corpid[\s\S]+tenantFingerprint/);
  assert.match(runnerSource, /\[string\]\$IsolationToken/);
  assert.match(runnerSource, /run-\$IsolationToken/);
  assert.match(runnerSource, /--isolation-token', \$IsolationToken/);
  assert.match(runnerSource, /\[switch\]\$RequestFromStdin/);
  assert.match(runnerSource, /\$builderRequest\s*\|\s*&\s*\$nodePath/);
  assert.doesNotMatch(runnerSource, /(?:source|facts)-\$selectedMonth/,
    "传给 Node 的临时路径不得编码月份");
  assert.doesNotMatch(runnerSource, /\$arguments\s*=\s*@\([^\r\n]+--domains/,
    "builder 子进程命令行不得携带 domains/company/person");
  const exporterPowerShellSource = fs.readFileSync(path.join(__dirname, "..", "shared", "xbb", "export-live-data.ps1"), "utf8");
  assert.match(exporterPowerShellSource, /\$extractRequest\s*\|\s*&\s*node/);
  assert.doesNotMatch(exporterPowerShellSource, /\$extractorArguments\s*=\s*@\([^\r\n]+--(?:month|domains)/,
    "exporter Node 命令行不得携带 month/domains");
  for (const childName of ["export-live-data.js", "build-fact-pack.js", "aggregate-multi-period.js"]) {
    const childPath = path.join(__dirname, "..", "shared", "xbb", childName);
    const childSource = fs.readFileSync(childPath, "utf8");
    assert.match(childSource, /--isolation-token/);
    assert.match(childSource, /\^\[a-f0-9\]\{64\}\$/);
    const requiredPaths = childName === "export-live-data.js"
      ? ["--output", path.join(os.tmpdir(), "unused-source.json")]
      : childName === "build-fact-pack.js"
        ? ["--source", path.join(os.tmpdir(), "unused-source.json"), "--output", path.join(os.tmpdir(), "unused-pack.json")]
        : ["--input", path.join(os.tmpdir(), "unused-aggregate.json"), "--output", path.join(os.tmpdir(), "unused-pack.json")];
    const invalidTokenRun = childProcess.spawnSync(process.execPath, [childPath, ...requiredPaths, "--isolation-token", "not-a-token"], {
      encoding: "utf8", windowsHide: true
    });
    assert.notEqual(invalidTokenRun.status, 0, `${childName} 必须拒绝无效 isolation token`);
    assert.match(invalidTokenRun.stderr, /isolation token/);
    const missingValueRun = childProcess.spawnSync(process.execPath, [childPath, "--isolation-token"], {
      encoding: "utf8", windowsHide: true
    });
    assert.notEqual(missingValueRun.status, 0);
    assert.match(missingValueRun.stderr, /参数缺少值/);
    const duplicateOutputRun = childProcess.spawnSync(process.execPath,
      [childPath, ...requiredPaths, "--output", path.join(os.tmpdir(), "duplicate-output.json"), "--isolation-token", "b".repeat(64)], {
        encoding: "utf8", windowsHide: true
      });
    assert.notEqual(duplicateOutputRun.status, 0);
    assert.match(duplicateOutputRun.stderr, /参数不能重复/);
    if (childName !== "aggregate-multi-period.js") {
      assert.match(childSource, /--request-stdin/);
      const forbiddenScopeArguments = childName === "export-live-data.js"
        ? ["--month", "2026-01"]
        : ["--domains", "all"];
      const mixedScopeRun = childProcess.spawnSync(process.execPath,
        [childPath, ...requiredPaths, "--request-stdin", ...forbiddenScopeArguments, "--isolation-token", "b".repeat(64)], {
          encoding: "utf8", windowsHide: true, input: "{}\n"
        });
      assert.notEqual(mixedScopeRun.status, 0);
      assert.match(mixedScopeRun.stderr, /不能与/);
    }
  }

  const isolationUnitRoot = fs.mkdtempSync(path.join(os.tmpdir(), "xbb-isolation-unit-"));
  try {
    const serviceLeasePath = path.join(isolationUnitRoot, "runtime", "service-lease.json");
    const fixedToken = "a".repeat(64);
    const isolationProjectRoot = path.resolve(__dirname, "..");
    const isolationRunner = path.join(isolationProjectRoot, "skills", "xbb-executive-analyst", "scripts", "query-xbb.ps1");
    fs.mkdirSync(defaultGatewayWorkRoot(), { recursive: true });
    const gatewayWorkDirectory = fs.mkdtempSync(path.join(defaultGatewayWorkRoot(), "request-"));
    const marker = createRunnerIsolationMarker({
      serviceLeasePath,
      projectRoot: isolationProjectRoot,
      runner: isolationRunner,
      runRoot: path.join(isolationUnitRoot, "runs"),
      gatewayWorkDirectory,
      token: fixedToken,
      now: () => 1788499200000
    });
    assert.equal(marker.directory, runnerIsolationDirectory(serviceLeasePath));
    assert.equal(fs.existsSync(marker.markerPath), true);
    const markerPayload = JSON.parse(fs.readFileSync(marker.markerPath, "utf8"));
    assert.deepEqual(Object.keys(markerPayload).sort(), [
      "childScriptPaths", "createdAtMs", "gatewayWorkDirectory", "projectRoot", "queryScriptPath", "rootProcess", "runRoot", "schemaVersion", "service", "token"
    ]);
    assert.equal(markerPayload.service, ISOLATION_SERVICE);
    assert.equal(markerPayload.schemaVersion, "2.0");
    assert.equal(markerPayload.token, fixedToken);
    assert.equal(markerPayload.rootProcess, null);
    assert.equal(markerPayload.queryScriptPath, fs.realpathSync.native(isolationRunner));
    assert.equal(markerPayload.gatewayWorkDirectory, fs.realpathSync.native(gatewayWorkDirectory));
    assert.equal(markerPayload.childScriptPaths.length, 3);
    assert.equal(JSON.stringify(markerPayload).includes("2026-"), false, "隔离标记不得保存查询月份或其他经营范围");
    for (const forbiddenKey of ["months", "domains", "company", "person", "credentials", "apiToken", "facts"]) {
      assert.equal(Object.hasOwn(markerPayload, forbiddenKey), false, `隔离标记不得保存 ${forbiddenKey}`);
    }
    clearRunnerIsolationMarker(marker);
    assert.equal(fs.existsSync(marker.markerPath), false);
    fs.rmSync(gatewayWorkDirectory, { recursive: true, force: true });

    assert.deepEqual(parseRecoveryResult('{"success":true,"markersRecovered":2,"processesTerminated":3,"runDirectoriesRemoved":4}\n'), {
      status: "recovered", markersRecovered: 2, processesTerminated: 3, runDirectoriesRemoved: 4
    });
    await assert.rejects(
      recoverRunnerIsolation({ platform: "linux", serviceLeasePath, projectRoot: path.resolve(__dirname, "..") }),
      /platform 覆盖已禁用/
    );
    assert.deepEqual(await recoverRunnerIsolationForTest({ testOnlyPlatform: "linux", execFile: async () => ({}), serviceLeasePath, projectRoot: path.resolve(__dirname, "..") }), {
      status: "not_applicable", markersRecovered: 0, processesTerminated: 0, runDirectoriesRemoved: 0
    });
    let recoveryInvocation = null;
    const startupRecovery = await recoverRunnerIsolationForTest({
      testOnlyPlatform: "win32",
      serviceLeasePath,
      projectRoot: path.resolve(__dirname, ".."),
      execFile: async (command, args, options) => {
        recoveryInvocation = { command, args, options };
        return { stdout: '{"success":true,"markersRecovered":0,"processesTerminated":0,"runDirectoriesRemoved":0}\n' };
      }
    });
    assert.equal(startupRecovery.markersRecovered, 0);
    assert.equal(recoveryInvocation.command, "powershell.exe");
    assert.equal(recoveryInvocation.args.includes("-IsolationToken"), false, "新代际启动恢复必须扫描全部无业务标记");
    assert.equal(recoveryInvocation.args[recoveryInvocation.args.indexOf("-MarkerDirectory") + 1], runnerIsolationDirectory(serviceLeasePath));
    await assert.rejects(recoverRunnerIsolationForTest({
      testOnlyPlatform: "win32",
      serviceLeasePath,
      projectRoot: path.resolve(__dirname, ".."),
      isolationToken: fixedToken,
      execFile: async () => ({ stdout: '{"success":true,"markersRecovered":0,"processesTerminated":0,"runDirectoriesRemoved":0}\n' })
    }), (error) => error?.code === RUNNER_ISOLATION_ERROR_CODE);
  } finally {
    fs.rmSync(isolationUnitRoot, { recursive: true, force: true });
  }

  if (process.platform === "win32") {
    const bindingTestRoot = fs.mkdtempSync(path.join(os.tmpdir(), "xbb-root-binding-test-"));
    const previousTemp = process.env.TEMP;
    const previousTmp = process.env.TMP;
    try {
      // Exercise the same short TEMP path used by Windows CI when 8.3 names are
      // enabled. PowerShell GetFullPath expands it; Node path.resolve does not.
      const shortTempRoot = childProcess.execFileSync("powershell.exe", [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
        "(New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:XBB_TEST_TEMP_ROOT).ShortPath"
      ], { env: { ...process.env, XBB_TEST_TEMP_ROOT: bindingTestRoot }, encoding: "utf8", windowsHide: true, timeout: 10000 }).trim();
      assert.equal(fs.realpathSync.native(shortTempRoot), fs.realpathSync.native(bindingTestRoot));
      process.env.TEMP = shortTempRoot;
      process.env.TMP = shortTempRoot;
      fs.mkdirSync(defaultGatewayWorkRoot(), { recursive: true });
      const bindingWorkDirectory = fs.mkdtempSync(path.join(defaultGatewayWorkRoot(), "request-"));
      const bindingRunner = path.resolve(__dirname, "..", "skills", "xbb-executive-analyst", "scripts", "query-xbb.ps1");
      const bindingOutput = path.join(bindingWorkDirectory, "fact-pack.json");
      const bindingMarker = createRunnerIsolationMarker({
        serviceLeasePath: path.join(bindingTestRoot, "service-lease.json"),
        projectRoot: path.resolve(__dirname, ".."),
        runner: bindingRunner,
        gatewayWorkDirectory: bindingWorkDirectory
      });
      try {
        const markerBeforeBinding = readRunnerIsolationMarker(bindingMarker.markerPath);
        assert.equal(markerBeforeBinding.gatewayWorkDirectory, fs.realpathSync.native(bindingWorkDirectory));
        assert.equal(markerBeforeBinding.rootProcess, null);
        const markerText = fs.readFileSync(bindingMarker.markerPath, "utf8");
        fs.writeFileSync(bindingMarker.markerPath, JSON.stringify({ ...markerBeforeBinding,
          gatewayWorkDirectory: path.join(fs.realpathSync.native(bindingTestRoot), "outside", "request-invalid")
        }), "utf8");
        assert.throws(() => readRunnerIsolationMarker(bindingMarker.markerPath), (error) => error?.code === RUNNER_ISOLATION_ERROR_CODE,
          "短路径兼容不得接受固定临时根之外的伪造目录");
        fs.writeFileSync(bindingMarker.markerPath, markerText, "utf8");
        process.env.TEMP = path.join(bindingTestRoot, "missing-temp");
        process.env.TMP = process.env.TEMP;
        assert.throws(() => readRunnerIsolationMarker(bindingMarker.markerPath), (error) => error?.code === RUNNER_ISOLATION_ERROR_CODE,
          "固定临时根不存在时必须继续失败关闭");
        assert.equal(fs.existsSync(defaultGatewayWorkRoot()), false, "只读标记校验不得创建缺失根目录");
        process.env.TEMP = shortTempRoot;
        process.env.TMP = shortTempRoot;
        const bindingArgs = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", bindingRunner,
          "-OutputPath", bindingOutput, "-RequestFromStdin", "-IsolationToken", bindingMarker.token,
          "-IsolationMarkerPath", bindingMarker.markerPath];
        const bindingScope = { months: ["2099-01"], domains: ["all"], company: null, person: null, forceRefresh: false };
        for (const businessValue of ["2099-01", "all"]) assert.equal(bindingArgs.includes(businessValue), false);
        await assert.rejects(runRunnerProcess(util.promisify(childProcess.execFile), "powershell.exe", bindingArgs, {
          platform: "linux",
          windowsHide: true,
          encoding: "utf8",
          timeoutMs: 10000,
          stdinText: `${JSON.stringify(bindingScope)}\n`
        }));
        const boundMarker = readRunnerIsolationMarker(bindingMarker.markerPath);
        assert.equal(Number.isInteger(boundMarker.rootProcess?.pid), true,
          "真实 Windows PowerShell runner 必须从无业务 argv 严格绑定 root PID/creation/exe");
      } finally {
        clearRunnerIsolationMarker(bindingMarker);
      }
    } finally {
      if (previousTemp === undefined) delete process.env.TEMP; else process.env.TEMP = previousTemp;
      if (previousTmp === undefined) delete process.env.TMP; else process.env.TMP = previousTmp;
      fs.rmSync(bindingTestRoot, { recursive: true, force: true });
    }
  }

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
    const productionRunner = path.resolve(__dirname, "..", "skills", "xbb-executive-analyst", "scripts", "query-xbb.ps1");
    const bindTestIsolationRoot = (args, pid) => {
      const markerPath = args[args.indexOf("-IsolationMarkerPath") + 1];
      const markerPayload = JSON.parse(fs.readFileSync(markerPath, "utf8"));
      assert.equal(markerPayload.rootProcess, null);
      markerPayload.rootProcess = {
        pid,
        creationToken: String(638925120000000000n + BigInt(pid)),
        createdAtMs: markerPayload.createdAtMs + 1,
        executablePath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
      };
      fs.writeFileSync(markerPath, `${JSON.stringify(markerPayload)}\n`, "utf8");
      return markerPath;
    };
    assert.throws(() => createToolGateway({
      projectRoot: path.resolve(__dirname, ".."), runner: productionRunner, platform: "win32"
    }), /platform 覆盖已禁用/);
    assert.throws(() => createToolGateway({
      projectRoot: path.resolve(__dirname, ".."), runner: productionRunner, testOnlyPlatform: "linux"
    }), /testOnlyPlatform 只能通过测试专用 gateway/);
    assert.throws(() => createToolGatewayForTest({
      projectRoot: path.resolve(__dirname, ".."), runner: productionRunner, testOnlyPlatform: "win32", execFile: async () => ({})
    }), /fully-qualified serviceLeasePath/);
    assert.throws(() => createToolGatewayForTest({
      projectRoot: path.resolve(__dirname, ".."), runner: productionRunner, testOnlyPlatform: "win32", serviceLeasePath: "runtime\\service-lease.json", execFile: async () => ({})
    }), /fully-qualified serviceLeasePath/);
    const isolationLeasePath = path.join(gatewayRoot, "runtime", "service-lease.json");
    let isolationToken = null;
    let markerObservedBeforeSpawn = false;
    let normalRecoveryCalls = 0;
    const isolatedGateway = createToolGatewayForTest({
      projectRoot: path.resolve(__dirname, ".."),
      runner: productionRunner,
      powershell: "powershell-test",
      testOnlyPlatform: "win32",
      serviceLeasePath: isolationLeasePath,
      isolationMarkerRecoverer: async (marker, recoveryOptions) => {
        normalRecoveryCalls += 1;
        assert.equal(marker.token, isolationToken);
        assert.equal(fs.existsSync(marker.markerPath), true, "正常完成后的 CIM 确认必须发生在清 marker 之前");
        if (recoveryOptions?.confirmationOnly) {
          assert.equal(fs.existsSync(readRunnerIsolationMarker(marker.markerPath).gatewayWorkDirectory), true);
          return;
        }
        const payload = readRunnerIsolationMarker(marker.markerPath);
        fs.rmSync(payload.gatewayWorkDirectory, { recursive: true, force: true });
        clearRunnerIsolationMarker(marker); // 测试替身代表“严格候选已二次确认为零且临时目录已清理”。
      },
      execFile: (_command, args, options) => {
        isolationToken = args[args.indexOf("-IsolationToken") + 1];
        assert.match(isolationToken, ISOLATION_TOKEN_PATTERN);
        for (const forbiddenSwitch of ["-Month", "-Domains", "-Company", "-Person", "-ForceRefresh"]) {
          assert.equal(args.includes(forbiddenSwitch), false, `Windows runner argv 不得包含 ${forbiddenSwitch}`);
        }
        assert.equal(args.includes("-RequestFromStdin"), true);
        assert.deepEqual(JSON.parse(options.stdinText), {
          months: ["2026-01"], domains: ["all"], company: null, person: null, forceRefresh: false
        });
        const markerPath = args[args.indexOf("-IsolationMarkerPath") + 1];
        markerObservedBeforeSpawn = fs.existsSync(markerPath);
        assert.equal(JSON.parse(fs.readFileSync(markerPath, "utf8")).rootProcess, null, "marker-before-spawn 阶段不得伪造根进程身份");
        bindTestIsolationRoot(args, 46001);
        const outputPath = args[args.indexOf("-OutputPath") + 1];
        fs.writeFileSync(outputPath, `${JSON.stringify(pack)}\n`, "utf8");
        const execution = Promise.resolve({ stdout: "", stderr: "" });
        execution.child = { pid: 46001, kill: () => true };
        return execution;
      }
    });
    await isolatedGateway({ months: ["2026-01"], domains: ["all"] }, { scope: "all" });
    assert.equal(markerObservedBeforeSpawn, true, "随机隔离标记必须先于 Windows runner spawn 原子持久化");
    assert.equal(normalRecoveryCalls, 2);
    assert.equal(fs.readdirSync(runnerIsolationDirectory(isolationLeasePath)).filter((name) => name.endsWith(".json")).length, 0);

    let cleanupFailureMarker = null;
    let cleanupFailureNotified = 0;
    const cleanupFailureGateway = createToolGatewayForTest({
      projectRoot: path.resolve(__dirname, ".."),
      runner: productionRunner,
      powershell: "powershell-test",
      testOnlyPlatform: "win32",
      serviceLeasePath: path.join(gatewayRoot, "cleanup-failure-runtime", "service-lease.json"),
      onIsolationFailure: () => { cleanupFailureNotified += 1; },
      isolationMarkerRecoverer: async (marker, recoveryOptions) => {
        cleanupFailureMarker = marker;
        if (recoveryOptions?.confirmationOnly) return;
        throw new Error(`injected gateway directory cleanup failure ${marker.token} 清理机密公司`);
      },
      execFile: (_command, args) => {
        bindTestIsolationRoot(args, 46002);
        const outputPath = args[args.indexOf("-OutputPath") + 1];
        fs.writeFileSync(outputPath, `${JSON.stringify(pack)}\n`, "utf8");
        const execution = Promise.resolve({ stdout: "", stderr: "" });
        execution.child = { pid: 46002, kill: () => true };
        return execution;
      }
    });
    await assert.rejects(cleanupFailureGateway(
      { months: ["2026-01"], domains: ["all"], company: "清理机密公司" }, { scope: "all" }
    ), (error) => {
      assert.equal(error?.code, RUNNER_ISOLATION_ERROR_CODE);
      for (const secret of [cleanupFailureMarker.token, "清理机密公司"]) {
        assert.equal(error.message.includes(secret), false);
        assert.equal(JSON.stringify(error).includes(secret), false);
      }
      assert.equal(error.cause?.message.includes(cleanupFailureMarker.token), true);
      return true;
    });
    assert.equal(cleanupFailureNotified, 1, "gateway work directory 清理失败必须触发生命周期 fail-close");
    const cleanupFailurePayload = readRunnerIsolationMarker(cleanupFailureMarker.markerPath);
    assert.equal(fs.existsSync(cleanupFailureMarker.markerPath), true, "目录清理失败必须保留 marker");
    assert.equal(fs.existsSync(cleanupFailurePayload.gatewayWorkDirectory), true, "目录清理失败不得伪装已删除明文事实目录");
    fs.rmSync(cleanupFailurePayload.gatewayWorkDirectory, { recursive: true, force: true });
    clearRunnerIsolationMarker(cleanupFailureMarker);

    const firstProgressEvents = [];
    const secondProgressEvents = [];
    let executionCount = 0;
    const gateway = createToolGatewayForTest({
      runner,
      powershell: "powershell-test",
      testOnlyPlatform: "linux",
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
    const retryGateway = createToolGatewayForTest({
      runner,
      powershell: "powershell-test",
      testOnlyPlatform: "linux",
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

    const hiddenRunnerToken = "c".repeat(64);
    const hiddenRunnerScope = "绝密公司";
    const safeFailureGateway = createToolGatewayForTest({
      runner,
      powershell: "powershell-test",
      testOnlyPlatform: "linux",
      execFile: async (_command, args, options) => {
        assert.equal(args.includes(hiddenRunnerScope), false);
        assert.equal(args.includes("2026-01"), false);
        assert.equal(JSON.parse(options.stdinText).company, hiddenRunnerScope);
        throw new Error(`raw runner failure ${hiddenRunnerToken} ${hiddenRunnerScope} 2026-01`);
      }
    });
    await assert.rejects(
      safeFailureGateway({ months: ["2026-01"], domains: ["all"], company: hiddenRunnerScope }, { scope: "all" }),
      (error) => {
        assert.equal(error?.code, RUNNER_EXECUTION_ERROR_CODE);
        assert.match(error.message, /实时销帮帮查询执行失败/);
        assert.equal(error.cause?.message.includes(hiddenRunnerToken), true, "原始错误只能保留为内部 cause");
        for (const secret of [hiddenRunnerToken, hiddenRunnerScope, "2026-01"]) {
          assert.equal(error.message.includes(secret), false);
          assert.equal(JSON.stringify(error).includes(secret), false);
        }
        return true;
      }
    );

    const fifoStarts = [];
    const fifoReleases = [];
    const fifoGateway = createToolGatewayForTest({
      runner,
      powershell: "powershell-test",
      testOnlyPlatform: "linux",
      maxConcurrentQueries: 2,
      maxQueuedQueries: 4,
      queueTtlMs: 1000,
      execFile: async (_command, args, options) => new Promise((resolve, reject) => {
        const company = JSON.parse(options.stdinText).company || "group";
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
    const sharedGateway = createToolGatewayForTest({
      runner,
      powershell: "powershell-test",
      testOnlyPlatform: "linux",
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
    const abandonedGateway = createToolGatewayForTest({
      runner,
      powershell: "powershell-test",
      testOnlyPlatform: "linux",
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
      processTreeTerminator: async (pid) => { windowsTreePid = pid; return true; }
    });
    windowsAbort.abort(new Error("active cancelled"));
    await assert.rejects(windowsExecution, /active cancelled/);
    assert.equal(windowsTreePid, 43210, "Windows 取消必须对 PowerShell PID 执行 taskkill /T 语义");
    assert.equal(windowsDirectKillCalled, false, "已验证回收后不得再用可能复用的 ChildProcess PID 补杀");

    const confirmedIsolationLease = path.join(gatewayRoot, "confirmed-runtime", "service-lease.json");
    const confirmedAbort = new AbortController();
    let markConfirmedRunnerStarted;
    const confirmedRunnerStarted = new Promise((resolve) => { markConfirmedRunnerStarted = resolve; });
    let markConfirmedRecoveryDone;
    const confirmedRecoveryDone = new Promise((resolve) => { markConfirmedRecoveryDone = resolve; });
    let confirmedMarkerPath = null;
    const confirmedIsolationGateway = createToolGatewayForTest({
      projectRoot: path.resolve(__dirname, ".."),
      runner: productionRunner,
      powershell: "powershell-test",
      testOnlyPlatform: "win32",
      serviceLeasePath: confirmedIsolationLease,
      enforceWindowsProcessTree: true,
      processTreeTerminator: async () => true,
      isolationMarkerRecoverer: async (marker) => {
        try {
          confirmedMarkerPath = marker.markerPath;
          assert.equal(fs.existsSync(marker.markerPath), true);
          const payload = readRunnerIsolationMarker(marker.markerPath);
          fs.rmSync(payload.gatewayWorkDirectory, { recursive: true, force: true });
          clearRunnerIsolationMarker(marker);
          markConfirmedRecoveryDone(null);
        } catch (error) {
          markConfirmedRecoveryDone(error);
          throw error;
        }
      },
      execFile: (_command, args) => {
        bindTestIsolationRoot(args, 43213);
        const pending = new Promise(() => {});
        pending.child = { pid: 43213, kill: () => true };
        markConfirmedRunnerStarted();
        return pending;
      }
    });
    const confirmedCancellation = confirmedIsolationGateway(
      { months: ["2026-01"], domains: ["all"] },
      { scope: "all" },
      { signal: confirmedAbort.signal }
    );
    await confirmedRunnerStarted;
    confirmedAbort.abort(new Error("confirmed tree cancelled"));
    await assert.rejects(confirmedCancellation, /confirmed tree cancelled/);
    const confirmedRecoveryError = await confirmedRecoveryDone;
    if (confirmedRecoveryError) throw confirmedRecoveryError;
    assert.equal(fs.existsSync(confirmedMarkerPath), false, "整树终止确认并再次核验无候选后必须清理 token 标记");

    for (const [label, terminator] of [
      ["false", async () => false],
      ["exception", async () => { throw new Error("taskkill unavailable"); }],
      ["deadline", async () => new Promise(() => {})]
    ]) {
      let unsafeDirectKillCalled = false;
      const unsafeAbort = new AbortController();
      const unsafeRunner = () => {
        const pending = new Promise(() => {});
        pending.child = { pid: 43211, kill: () => { unsafeDirectKillCalled = true; return true; } };
        return pending;
      };
      const startedAt = Date.now();
      const unsafeExecution = runRunnerProcess(unsafeRunner, "powershell.exe", ["runner.ps1"], {
        platform: "win32",
        enforceWindowsProcessTree: true,
        signal: unsafeAbort.signal,
        timeoutMs: 1000,
        processTreeTerminationDeadlineMs: 20,
        processTreeTerminator: terminator
      });
      unsafeAbort.abort(new Error(`unsafe ${label}`));
      await assert.rejects(unsafeExecution, (error) => error?.code === PROCESS_TREE_UNCONFIRMED_CODE);
      assert.ok(Date.now() - startedAt < 500, `${label} 回收失败不得永久占住调用 Promise`);
      assert.equal(unsafeDirectKillCalled, false, `${label} 未确认整树回收时不得只杀父进程并伪装成功`);
    }
    const untrackedWindowsRunner = new Promise(() => {});
    await assert.rejects(
      runRunnerProcess(() => untrackedWindowsRunner, "powershell.exe", ["runner.ps1"], {
        platform: "win32",
        enforceWindowsProcessTree: true,
        timeoutMs: 1000
      }),
      (error) => error?.code === PROCESS_TREE_UNCONFIRMED_CODE
    );

    const failClosedStarts = [];
    let isolationFailureCalls = 0;
    let unsafeIsolationRecoveryCalls = 0;
    let peerIsolationRecoveryCalls = 0;
    let peerDirectKillCalled = false;
    const tokenCompanies = new Map();
    const failClosedAbort = new AbortController();
    const unsafeIsolationLease = path.join(gatewayRoot, "unsafe-runtime", "service-lease.json");
    const failClosedGateway = createToolGatewayForTest({
      projectRoot: path.resolve(__dirname, ".."),
      runner: productionRunner,
      powershell: "powershell-test",
      testOnlyPlatform: "win32",
      serviceLeasePath: unsafeIsolationLease,
      enforceWindowsProcessTree: true,
      maxConcurrentQueries: 2,
      maxQueuedQueries: 2,
      queueTtlMs: 1000,
      processTreeTerminationDeadlineMs: 20,
      isolationMarkerRecoverer: async (marker) => {
        const company = tokenCompanies.get(marker.token);
        if (company === "不确定回收") {
          unsafeIsolationRecoveryCalls += 1;
          throw new Error("injected CIM uncertainty");
        }
        peerIsolationRecoveryCalls += 1;
        const payload = readRunnerIsolationMarker(marker.markerPath);
        fs.rmSync(payload.gatewayWorkDirectory, { recursive: true, force: true });
        clearRunnerIsolationMarker(marker);
      },
      onIsolationFailure: (error) => {
        isolationFailureCalls += 1;
        assert.equal(error?.code, PROCESS_TREE_UNCONFIRMED_CODE);
        throw new Error("lifecycle callback failed");
      },
      execFile: (_command, args, options) => {
        const company = JSON.parse(options.stdinText).company;
        failClosedStarts.push(company);
        const token = args[args.indexOf("-IsolationToken") + 1];
        tokenCompanies.set(token, company);
        const pid = company === "不确定回收" ? 43212 : 43214;
        bindTestIsolationRoot(args, pid);
        const pending = new Promise(() => {});
        pending.child = { pid, kill: () => { if (company === "并行运行中") peerDirectKillCalled = true; return true; } };
        return pending;
      }
    });
    const unsafeActive = failClosedGateway(
      { months: ["2026-01"], domains: ["all"], company: "不确定回收" },
      { scope: "all" },
      { signal: failClosedAbort.signal }
    );
    const parallelActive = failClosedGateway(
      { months: ["2026-01"], domains: ["all"], company: "并行运行中" },
      { scope: "all" }
    );
    const blockedFollower = failClosedGateway(
      { months: ["2026-01"], domains: ["all"], company: "禁止启动" },
      { scope: "all" }
    );
    await new Promise((resolve) => setImmediate(resolve));
    failClosedAbort.abort(new Error("caller deadline"));
    await assert.rejects(unsafeActive, /caller deadline/);
    await assert.rejects(parallelActive, (error) => error?.code === GATEWAY_FAIL_CLOSED_CODE);
    await assert.rejects(blockedFollower, (error) => error?.code === GATEWAY_FAIL_CLOSED_CODE);
    await assert.rejects(
      failClosedGateway({ months: ["2026-01"], domains: ["all"], company: "关闭后新请求" }, { scope: "all" }),
      (error) => error?.code === GATEWAY_FAIL_CLOSED_CODE
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(failClosedStarts, ["不确定回收", "并行运行中"], "失败关闭后不得释放槽位启动排队 runner");
    assert.equal(isolationFailureCalls, 1, "首次失败关闭必须且只能通知一次生命周期回调，回调异常不得掩盖隔离错误");
    assert.equal(unsafeIsolationRecoveryCalls, 1, "取消时必须尝试 token recovery，但不确定结果不得清理 marker");
    assert.equal(peerIsolationRecoveryCalls, 1, "一次隔离失败必须取消并回收所有其他 running entries");
    assert.equal(peerDirectKillCalled, false, "并行 runner recovery 后不得再执行 PID-only ChildProcess.kill");
    const unsafeMarkers = fs.readdirSync(runnerIsolationDirectory(unsafeIsolationLease)).filter((name) => name.endsWith(".json"));
    assert.equal(unsafeMarkers.length, 1, "未确认终止必须保留唯一随机 token 标记供新代际恢复");
    assert.match(unsafeMarkers[0], /^[a-f0-9]{64}\.json$/);

    const queuedCancellationStarts = [];
    const queuedCancellationReleases = new Map();
    const queuedCancellationGateway = createToolGatewayForTest({
      runner,
      powershell: "powershell-test",
      testOnlyPlatform: "linux",
      maxConcurrentQueries: 1,
      maxQueuedQueries: 1,
      queueTtlMs: 1000,
      execFile: async (_command, args, options) => new Promise((resolve, reject) => {
        const company = JSON.parse(options.stdinText).company;
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
    const queueGateway = createToolGatewayForTest({
      runner,
      powershell: "powershell-test",
      testOnlyPlatform: "linux",
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

  process.stdout.write(`${JSON.stringify({ success: true, checks: 183, factPackSha256: pack.integrity.factPackSha256 })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
