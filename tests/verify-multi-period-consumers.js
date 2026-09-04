"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { validateSpec } = require("../skills/xbb-executive-chart/scripts/chart-contract.js");
const { buildThreadInstructions } = require("../shared/codex/thread-instructions.js");
const { assertSafeFactPack } = require("../shared/xbb/tool-gateway.js");
const { buildMultiPeriodFactPack, MAX_AGGREGATE_BYTES } = require("../shared/xbb/aggregate-multi-period.js");

const projectRoot = path.resolve(__dirname, "..");
const months = Array.from({ length: 8 }, (_, index) => `2026-${String(index + 1).padStart(2, "0")}`);
const companies = Array.from({ length: 64 }, (_, index) => `公司${String(index + 1).padStart(3, "0")}`);

function sum(rows, field) {
  return rows.reduce((total, row) => total + Number(row[field] || 0), 0);
}

function performanceFact(monthIndex) {
  const ranking = companies.map((company, index) => {
    const total = 100000 + monthIndex * 1000 + (companies.length - index) * 100;
    const course = total * 0.6;
    const consulting = total * 0.3;
    const other = total - course - consulting;
    return { rank: index + 1, company, total, course, consulting, other, courseShare: 60, consultingShare: 30, otherShare: 10 };
  });
  const summary = {
    total: sum(ranking, "total"),
    course: sum(ranking, "course"),
    consulting: sum(ranking, "consulting"),
    other: sum(ranking, "other"),
    sourceOrderCount: 600,
    ordersWithProductLines: 600
  };
  return { definitions: { total: "售价小计", category: "产品明细分类" }, summary, ranking };
}

function productSalesFact(month, monthIndex) {
  const ranking = companies.map((company, index) => ({
    company,
    oppOrderQuantity: 30 + index,
    oppOrderRevenue: 30000 + index * 100,
    ticketCount: 20 + index,
    commercialCount: 5 + index % 4,
    commercialInitialCount: 3 + index % 3,
    commercialRetrainingCount: 2 + index % 2,
    openOppQuantity: 30 + index,
    openOppRevenue: 30000 + index * 100,
    openPerformanceQuantity: 5 + index % 4,
    openPerformanceRevenue: 5000 + index * 50,
    unclassifiedOppQuantity: 0,
    unclassifiedOppRevenue: 0,
    unclassifiedPerformanceQuantity: 0,
    unclassifiedPerformanceRevenue: 0
  }));
  const companyProductMix = companies.flatMap((company, companyIndex) => Array.from({ length: 4 }, (_, productIndex) => ({
    company,
    source: "oppOrder",
    product: `${month}-产品${String(productIndex + 1).padStart(2, "0")}`,
    quantity: 10 + companyIndex + productIndex,
    revenue: 10000 + companyIndex * 100 + productIndex * 10,
    quantityShare: 25,
    revenueShare: 25
  })));
  const products = Array.from({ length: 120 }, (_, index) => ({
    source: "oppOrder",
    product: `${month}-集团产品${String(index + 1).padStart(3, "0")}`,
    category: "开源产品",
    frontBack: "前端",
    isTicket: true,
    isCommercial: false,
    isOpen: true,
    quantity: 120 - index + monthIndex,
    revenue: (120 - index + monthIndex) * 1000
  }));
  const numericFields = Object.keys(ranking[0]).filter((field) => field !== "company");
  const summary = Object.fromEntries(numericFields.map((field) => [field, sum(ranking, field)]));
  Object.assign(summary, {
    sourceOppOrderCount: 600,
    oppOrdersWithProductLines: 600,
    oppOrdersWithValidatedFlatProduct: 0,
    oppOrdersWithoutSupportedProductShape: 0
  });
  return {
    definitions: { ticket: "OPP订单销量", commercial: "商业操盘产品明细销量" },
    summary,
    ranking,
    products,
    companyProductMix
  };
}

function coursesFact(month, monthIndex) {
  const companyRows = companies.map((company, index) => ({
    company,
    courseCount: 2 + index % 3,
    bookedCustomers: 20 + index,
    bosses: 5 + index % 5,
    firms: 0,
    dealOrders: 4 + index % 4,
    dealAmount: 40000 + index * 500,
    conversionRate: 20
  }));
  const courses = Array.from({ length: 80 }, (_, index) => ({
    name: `${month}-经营课程${String(index + 1).padStart(3, "0")}`,
    type: "课程",
    status: "已结束",
    date: `${month}-${String(index % 28 + 1).padStart(2, "0")}`,
    primaryCompany: companies[index % companies.length],
    bookedCustomers: 30 + index,
    firms: 0,
    bosses: 8 + index % 5,
    students: 30 + index,
    dealOrders: 6 + index % 3,
    dealAmount: 60000 + index * 1000 + monthIndex,
    paidAmount: 50000 + index * 800,
    conversionRate: 20,
    positionBreakdown: [{ position: "老板", count: 8 }, { position: "高管", count: 12 }, { position: "未填写", count: 10 }]
  }));
  return {
    definitions: { conversionRate: "关联订单数÷约课记录数" },
    summary: {
      courseCount: sum(companyRows, "courseCount"), bookedCustomers: sum(companyRows, "bookedCustomers"),
      firms: 0, bosses: sum(companyRows, "bosses"), students: sum(companyRows, "bookedCustomers"),
      dealOrders: sum(companyRows, "dealOrders"), dealAmount: sum(companyRows, "dealAmount"), paidAmount: 0
    },
    companies: companyRows,
    courses,
    positionBreakdown: [{ position: "老板", count: 480 }, { position: "高管", count: 720 }, { position: "未填写", count: 600 }]
  };
}

function deliveryFact(month, monthIndex) {
  const companyRows = companies.map((company, index) => ({
    company,
    invitations: 20 + index,
    bosses: 5 + index % 5,
    students: 20 + index,
    courseCount: 2 + index % 3,
    attributedPaidAmount: 20000 + index * 300,
    unlinkedPaidRecordCount: index % 2
  }));
  const courses = Array.from({ length: 80 }, (_, index) => ({
    name: `${month}-交付课程${String(index + 1).padStart(3, "0")}`,
    date: `${month}-${String(index % 28 + 1).padStart(2, "0")}`,
    invitations: 30 + index,
    bosses: 10 + index % 4,
    students: 30 + index,
    attributedPaidAmount: 50000 + index * 800 + monthIndex,
    unlinkedPaidRecordCount: index % 2,
    dealOrders: 5 + index % 3,
    courseDealAmount: 70000 + index * 900,
    coursePaidAmount: 60000 + index * 800,
    companies: [{
      company: companies[index % companies.length], invitations: 30 + index, bosses: 10 + index % 4,
      students: 30 + index, attributedPaidAmount: 50000 + index * 800 + monthIndex,
      unlinkedPaidRecordCount: index % 2
    }]
  }));
  return {
    definitions: { attributedPaidAmount: "可追溯关联回款归集" },
    summary: {
      deliveryCourseCount: courses.length, invitations: sum(companyRows, "invitations"), bosses: sum(companyRows, "bosses"),
      students: sum(companyRows, "students"), attributedPaidAmount: sum(companyRows, "attributedPaidAmount"),
      unlinkedPaidRecordCount: sum(companyRows, "unlinkedPaidRecordCount")
    },
    companies: companyRows,
    courses
  };
}

function opportunitiesFact(month, monthIndex) {
  const people = companies.map((company, index) => ({
    person: { id: `employee-${String(index + 1).padStart(3, "0")}`, name: `销售${String(index + 1).padStart(3, "0")}`, company },
    createdCount: 10 + index,
    expectedAmount: 100000 + index * 1000,
    wins: 2 + index % 3,
    wonAmount: 20000 + index * 500,
    winsWithoutWonAmount: 0,
    active: 6 + index % 4,
    forgottenCandidates: 2 + index % 2
  }));
  const reactivationCandidates = Array.from({ length: 80 }, (_, index) => ({
    entityId: `${month}-opportunity-${String(index + 1).padStart(3, "0")}`,
    creator: people[index % people.length].person,
    customerName: `客户企业${String(index + 1).padStart(3, "0")}`,
    name: `${month}-增长商机${String(index + 1).padStart(3, "0")}`,
    createdDate: `${month}-${String(index % 28 + 1).padStart(2, "0")}`,
    stage: "解决方案",
    willingness: "高",
    expectedAmount: 200000 + index * 1000 + monthIndex,
    wonAmount: 0,
    wonAmountKnown: false,
    signals: {
      active: true, followCount: 2, meaningfulFollowCount: 1, latestFollowDate: `${month}-01`,
      staleDays: 20 + index, hasNextAction: false, hasDecisionSignal: index % 2 === 0, forgottenCandidate: true
    }
  }));
  return {
    definitions: { forgottenCandidate: "透明规则识别的重新激活候选" },
    summary: {
      createdCount: sum(people, "createdCount"), expectedAmount: sum(people, "expectedAmount"), wins: sum(people, "wins"),
      wonAmount: sum(people, "wonAmount"), winsWithoutWonAmount: 0, lost: 30, active: sum(people, "active"),
      followCount: 500, withNextAction: 100, withDecisionSignal: 120, staleAtLeast14Days: 160,
      forgottenCandidates: reactivationCandidates.length
    },
    stages: [
      { stage: "发现需求", count: 300, expectedAmount: 3000000, wonAmount: 0 },
      { stage: "确认需求", count: 220, expectedAmount: 2500000, wonAmount: 0 },
      { stage: "解决方案", count: 160, expectedAmount: 2000000, wonAmount: 0 },
      { stage: "赢单", count: 80, expectedAmount: 1000000, wonAmount: 800000 }
    ],
    people,
    reactivationCandidates,
    opportunities: reactivationCandidates.map((row) => ({ entityId: row.entityId }))
  };
}

function period(month, monthIndex) {
  return {
    status: "ready",
    scope: {
      month,
      range: { startLabel: `${month}-01`, endLabel: `${month}-28` },
      refreshedAt: `${month}-28T10:00:00.000Z`,
      domains: ["all"],
      currentMonthPartial: false
    },
    entityResolution: {
      company: { status: "not_requested", input: "", resolved: null, candidates: [] },
      person: { status: "not_requested", input: "", resolved: null, candidates: [] }
    },
    provenance: {
      live: true,
      readOnly: true,
      dataSource: "xbb-openapi",
      sourceMode: "live-readonly-source",
      sourceRefreshedAt: `${month}-28T10:00:00.000Z`,
      sourceRecordsSha256: `sha256-${month}`,
      recordCounts: { performance: 600, oppOrder: 600, course: 80, booking: 1800, deliveryBooking: 1200, opportunity: 800, follow: 5000, user: 500 },
      formIds: { performance: 5614255, oppOrder: 6707824, course: 7452529, opportunity: 5614253 },
      telephoneFieldsExported: false,
      credentialFieldsExported: false
    },
    facts: {
      performance: performanceFact(monthIndex),
      productSales: productSalesFact(month, monthIndex),
      courses: coursesFact(month, monthIndex),
      delivery: deliveryFact(month, monthIndex),
      opportunities: opportunitiesFact(month, monthIndex)
    }
  };
}

const inputPeriods = months.map(period);
assert.ok(Buffer.byteLength(JSON.stringify(inputPeriods), "utf8") > MAX_AGGREGATE_BYTES * 10, "压力输入应显著大于模型事实包预算");

const annual = buildMultiPeriodFactPack(inputPeriods, { domains: ["all"] });
assert.equal(annual.status, "ready");
assert.deepEqual(annual.scope.months, months);
assert.equal(annual.scope.range.startLabel, "2026-01-01");
assert.equal(annual.scope.range.endLabel, "2026-08-28");
assert.ok(Buffer.byteLength(JSON.stringify(annual), "utf8") <= MAX_AGGREGATE_BYTES);
assert.equal(assertSafeFactPack(annual), annual);
assert.equal(Array.isArray(annual.periods), false);
assert.deepEqual(Object.keys(annual.compaction).sort(), ["applied", "budgetBytes", "finalBytes", "initialBytes", "trimmedPaths"].sort());
assert.equal(annual.compaction.applied, true);
assert.equal(annual.compaction.budgetBytes, MAX_AGGREGATE_BYTES);
assert.ok(annual.compaction.initialBytes > annual.compaction.finalBytes);
assert.ok(annual.compaction.finalBytes <= annual.compaction.budgetBytes);
assert.ok(annual.compaction.trimmedPaths.length >= 1);

for (const domain of ["performance", "productSales", "courses", "delivery", "opportunities"]) {
  assert.ok(annual.facts[domain]?.summary, `${domain} 必须保留年度汇总`);
  assert.deepEqual(annual.facts[domain].monthlyTrend.map((row) => row.month), months, `${domain} 必须保留全部月份趋势`);
  assert.equal(annual.facts[domain].detailCoverage.aggregationComplete, true, `${domain} 必须明确管理汇总完整`);
  assert.equal(typeof annual.facts[domain].detailCoverage.sizeCompacted, "boolean");
}

assert.equal(annual.facts.performance.summary.total, inputPeriods.reduce((total, row) => total + row.facts.performance.summary.total, 0));
assert.ok(annual.facts.performance.ranking.length >= 10);
assert.ok(annual.facts.productSales.ticketRanking.length >= 10);
assert.ok(annual.facts.productSales.commercialRanking.length >= 10);
assert.ok(annual.facts.productSales.products.length >= 1);
assert.ok(annual.facts.productSales.companyProductMix.length >= 1);
assert.ok(annual.facts.courses.companies.length >= 10);
assert.equal(annual.facts.courses.positionBreakdown.length, 3);
assert.ok(annual.facts.courses.courseHighlights.length >= 1);
assert.ok(annual.facts.delivery.companies.length >= 10);
assert.ok(annual.facts.delivery.courseHighlights.length >= 1);
assert.equal(annual.facts.opportunities.stages.length, 4);
assert.ok(annual.facts.opportunities.people.length >= 10);
assert.ok(annual.facts.opportunities.reactivationCandidates.length >= 1);
assert.equal(annual.compaction.trimmedPaths.includes("facts.courses.positionBreakdown"), false);
assert.equal(annual.compaction.trimmedPaths.includes("facts.opportunities.stages"), false);

assert.equal(annual.facts.productSales.detailCoverage.productRowsIncluded, annual.facts.productSales.products.length);
assert.equal(annual.facts.productSales.detailCoverage.companyProductMixRowsIncluded, annual.facts.productSales.companyProductMix.length);
assert.equal(annual.facts.courses.detailCoverage.courseHighlightsIncluded, annual.facts.courses.courseHighlights.length);
assert.equal(annual.facts.delivery.detailCoverage.courseHighlightsIncluded, annual.facts.delivery.courseHighlights.length);
assert.equal(annual.facts.opportunities.detailCoverage.reactivationCandidatesIncluded, annual.facts.opportunities.reactivationCandidates.length);

const annualTrendChart = validateSpec({
  type: "line",
  title: "2026年1—8月集团业绩趋势",
  subtitle: "集团全部公司｜管理汇总覆盖全部8个月",
  insight: "8月集团业绩高于1月",
  note: "逐月审计明细和业务原始列表不是本图的数据来源",
  categories: annual.facts.performance.monthlyTrend.map((row) => `${Number(row.month.slice(5))}月`),
  series: [{ name: "业绩", values: annual.facts.performance.monthlyTrend.map((row) => row.total) }],
  valueFormat: "money",
  unit: ""
});
assert.equal(annualTrendChart.categories.length, 8);

const instructions = buildThreadInstructions();
assert.match(instructions, /aggregationComplete=true/);
assert.match(instructions, /不得声称‘超过大小限制所以无法分析’/);
const responsePolicy = fs.readFileSync(path.join(projectRoot, "skills/xbb-executive-analyst/references/response-policy.md"), "utf8");
const chartSkill = fs.readFileSync(path.join(projectRoot, "skills/xbb-executive-chart/SKILL.md"), "utf8");
assert.match(responsePolicy, /必须完成管理分析/);
assert.match(responsePolicy, /不能.*超过大小限制无法分析/);
assert.match(chartSkill, /逐月 `provenance` 审计明细.*不是成图前提/);

process.stdout.write(`${JSON.stringify({ success: true, months: months.length, inputBytes: Buffer.byteLength(JSON.stringify(inputPeriods), "utf8"), outputBytes: Buffer.byteLength(JSON.stringify(annual), "utf8") })}\n`);
