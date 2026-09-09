"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { assertNoSensitiveFactValues } = require("../security/fact-privacy.js");

const MAX_RANKING_ROWS = 100;
const MAX_DETAIL_ROWS = 20;
const MAX_PRODUCT_ROWS = 50;
const MAX_PERIOD_MONTHS = 120;
const MAX_AGGREGATE_BYTES = 128 * 1024;
const MIN_INCLUDED_ROWS = 1;
const MIN_MANAGEMENT_ROWS = 10;

const MONTHLY_TREND_FIELDS = Object.freeze({
  performance: ["month", "total", "course", "consulting", "other"],
  productSales: ["month", "ticketCount", "commercialCount", "commercialInitialCount", "commercialRetrainingCount", "openOppQuantity", "openOppRevenue"],
  courses: ["month", "courseCount", "bookedCustomers", "bosses", "dealOrders", "dealAmount"],
  delivery: ["month", "deliveryCourseCount", "invitations", "bosses", "students", "attributedPaidAmount"],
  opportunities: ["month", "createdCount", "expectedAmount", "wins", "wonAmount", "active", "forgottenCandidates"]
});

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function percentage(part, total) {
  return total ? Math.round((number(part) / number(total)) * 10000) / 100 : 0;
}

function monthOf(period) {
  return String(period?.scope?.month || "");
}

function uniqueBy(rows, keyOf) {
  const output = [];
  const seen = new Set();
  for (const row of rows) {
    const key = keyOf(row);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(row);
  }
  return output;
}

function mergeRows(rows, keyOf, labelFields, numericFields) {
  const grouped = new Map();
  for (const row of rows.filter(Boolean)) {
    const key = keyOf(row);
    if (!key) continue;
    if (!grouped.has(key)) {
      const base = {};
      for (const field of labelFields) base[field] = row[field];
      for (const field of numericFields) base[field] = 0;
      grouped.set(key, base);
    }
    const target = grouped.get(key);
    for (const field of numericFields) target[field] += number(row[field]);
  }
  return [...grouped.values()];
}

function monthlySummary(periods, factKey, fields) {
  return periods.map((period) => {
    const summary = period.facts?.[factKey]?.summary || {};
    const row = { month: monthOf(period) };
    for (const field of fields) row[field] = number(summary[field]);
    return row;
  });
}

function compactPerformance(periods) {
  const facts = periods.map((period) => period.facts.performance).filter(Boolean);
  if (!facts.length) return null;
  const ranking = mergeRows(facts.flatMap((fact) => fact.ranking || []), (row) => row.company, ["company"], ["total", "course", "consulting", "other"])
    .map((row) => ({
      ...row,
      courseShare: percentage(row.course, row.total),
      consultingShare: percentage(row.consulting, row.total),
      otherShare: percentage(row.other, row.total)
    }))
    .filter((row) => row.total !== 0)
    .sort((a, b) => b.total - a.total || String(a.company).localeCompare(String(b.company), "zh-CN"));
  const summary = ranking.reduce((total, row) => ({
    total: total.total + row.total,
    course: total.course + row.course,
    consulting: total.consulting + row.consulting,
    other: total.other + row.other
  }), { total: 0, course: 0, consulting: 0, other: 0 });
  const sourceOrderCount = facts.reduce((total, fact) => total + number(fact.summary?.sourceOrderCount), 0);
  const ordersWithProductLines = facts.reduce((total, fact) => total + number(fact.summary?.ordersWithProductLines), 0);
  return {
    definitions: facts[0].definitions,
    summary: {
      ...summary,
      companyCount: ranking.length,
      sourceOrderCount,
      ordersWithProductLines,
      ordersWithoutProductLines: sourceOrderCount - ordersWithProductLines,
      courseShare: percentage(summary.course, summary.total),
      consultingShare: percentage(summary.consulting, summary.total),
      otherShare: percentage(summary.other, summary.total)
    },
    ranking: ranking.slice(0, MAX_RANKING_ROWS),
    monthlyTrend: monthlySummary(periods, "performance", ["total", "course", "consulting", "other"]),
    detailCoverage: {
      aggregationComplete: true,
      sizeCompacted: false,
      companyRows: ranking.length,
      companyRowsIncluded: Math.min(ranking.length, MAX_RANKING_ROWS),
      monthlyTrendFields: ["month", "total", "course", "consulting", "other"],
      rawDailyRowsIncluded: false
    }
  };
}

const PRODUCT_FIELDS = [
  "oppOrderQuantity", "oppOrderRevenue", "ticketCount", "commercialCount", "commercialInitialCount",
  "commercialRetrainingCount", "openOppQuantity", "openOppRevenue", "openPerformanceQuantity",
  "openPerformanceRevenue", "unclassifiedOppQuantity", "unclassifiedOppRevenue",
  "unclassifiedPerformanceQuantity", "unclassifiedPerformanceRevenue"
];

function compactProductSales(periods) {
  const facts = periods.map((period) => period.facts.productSales).filter(Boolean);
  if (!facts.length) return null;
  const ranking = mergeRows(facts.flatMap((fact) => fact.ranking || []), (row) => row.company, ["company"], PRODUCT_FIELDS)
    .filter((row) => PRODUCT_FIELDS.some((field) => row[field] !== 0))
    .sort((a, b) => (b.ticketCount + b.commercialCount) - (a.ticketCount + a.commercialCount) || b.openOppRevenue - a.openOppRevenue || String(a.company).localeCompare(String(b.company), "zh-CN"));
  const summary = Object.fromEntries(PRODUCT_FIELDS.map((field) => [field, ranking.reduce((total, row) => total + number(row[field]), 0)]));
  const products = mergeRows(
    facts.flatMap((fact) => fact.products || []),
    (row) => [row.source, row.product, row.category, row.frontBack].join("\u0000"),
    ["source", "product", "category", "frontBack", "isTicket", "isCommercial", "isOpen"],
    ["quantity", "revenue"]
  ).sort((a, b) => b.quantity - a.quantity || b.revenue - a.revenue || String(a.product).localeCompare(String(b.product), "zh-CN"));
  const ticketRanking = ranking.filter((row) => row.ticketCount !== 0)
    .sort((a, b) => b.ticketCount - a.ticketCount || String(a.company).localeCompare(String(b.company), "zh-CN"))
    .map((row, index) => ({ rank: index + 1, company: row.company, ticketCount: row.ticketCount }));
  const commercialRanking = ranking.filter((row) => row.commercialCount !== 0)
    .sort((a, b) => b.commercialCount - a.commercialCount || b.commercialInitialCount - a.commercialInitialCount || String(a.company).localeCompare(String(b.company), "zh-CN"))
    .map((row, index) => ({
      rank: index + 1,
      company: row.company,
      commercialCount: row.commercialCount,
      commercialInitialCount: row.commercialInitialCount,
      commercialRetrainingCount: row.commercialRetrainingCount
    }));
  const companyProductMix = mergeRows(
    facts.flatMap((fact) => fact.companyProductMix || []),
    (row) => [row.company, row.source, row.product].join("\u0000"),
    ["company", "source", "product"],
    ["quantity", "revenue"]
  );
  const mixTotals = new Map();
  for (const row of companyProductMix) {
    const key = [row.company, row.source].join("\u0000");
    const total = mixTotals.get(key) || { quantity: 0, revenue: 0 };
    total.quantity += number(row.quantity);
    total.revenue += number(row.revenue);
    mixTotals.set(key, total);
  }
  for (const row of companyProductMix) {
    const total = mixTotals.get([row.company, row.source].join("\u0000"));
    row.quantityShare = percentage(row.quantity, total.quantity);
    row.revenueShare = percentage(row.revenue, total.revenue);
  }
  const companyRank = new Map(ranking.map((row, index) => [row.company, index]));
  companyProductMix.sort((a, b) => (companyRank.get(a.company) ?? Number.MAX_SAFE_INTEGER) - (companyRank.get(b.company) ?? Number.MAX_SAFE_INTEGER)
    || b.quantity - a.quantity
    || b.revenue - a.revenue
    || String(a.source).localeCompare(String(b.source))
    || String(a.product).localeCompare(String(b.product), "zh-CN"));
  const sourceOppOrderCount = facts.reduce((total, fact) => total + number(fact.summary?.sourceOppOrderCount), 0);
  const oppOrdersWithProductLines = facts.reduce((total, fact) => total + number(fact.summary?.oppOrdersWithProductLines), 0);
  const oppOrdersWithValidatedFlatProduct = facts.reduce((total, fact) => total + number(fact.summary?.oppOrdersWithValidatedFlatProduct), 0);
  return {
    definitions: facts[0].definitions,
    summary: {
      companyCount: ranking.length,
      ...summary,
      sourceOppOrderCount,
      oppOrdersWithProductLines,
      oppOrdersWithValidatedFlatProduct,
      oppOrdersWithoutSupportedProductShape: sourceOppOrderCount - oppOrdersWithProductLines - oppOrdersWithValidatedFlatProduct,
      oppOrdersWithoutProductLines: sourceOppOrderCount - oppOrdersWithProductLines
    },
    ranking: ranking.slice(0, MAX_RANKING_ROWS),
    ticketRanking: ticketRanking.slice(0, MAX_RANKING_ROWS),
    commercialRanking: commercialRanking.slice(0, MAX_RANKING_ROWS),
    companyProductMix: companyProductMix.slice(0, MAX_PRODUCT_ROWS),
    products: products.slice(0, MAX_PRODUCT_ROWS),
    monthlyTrend: monthlySummary(periods, "productSales", PRODUCT_FIELDS),
    detailCoverage: {
      aggregationComplete: true,
      sizeCompacted: false,
      companyRows: ranking.length,
      companyRowsIncluded: Math.min(ranking.length, MAX_RANKING_ROWS),
      ticketRankingRows: ticketRanking.length,
      ticketRankingRowsIncluded: Math.min(ticketRanking.length, MAX_RANKING_ROWS),
      commercialRankingRows: commercialRanking.length,
      commercialRankingRowsIncluded: Math.min(commercialRanking.length, MAX_RANKING_ROWS),
      productRows: products.length,
      productRowsIncluded: Math.min(products.length, MAX_PRODUCT_ROWS),
      companyProductMixRows: companyProductMix.length,
      companyProductMixRowsIncluded: Math.min(companyProductMix.length, MAX_PRODUCT_ROWS),
      monthlyTrendFields: ["month", ...PRODUCT_FIELDS],
      rawDailyRowsIncluded: false
    }
  };
}

const COURSE_FIELDS = ["courseCount", "bookedCustomers", "firms", "bosses", "students", "dealOrders", "dealAmount", "paidAmount"];

function mergePositionRows(rows) {
  const counts = new Map();
  for (const row of rows.flatMap((item) => item?.positionBreakdown || [])) {
    counts.set(row.position, (counts.get(row.position) || 0) + number(row.count));
  }
  const total = Array.from(counts.values()).reduce((sum, count) => sum + count, 0);
  return Array.from(counts.entries()).map(([position, count]) => ({
    position,
    count,
    share: percentage(count, total)
  })).sort((a, b) => b.count - a.count || String(a.position).localeCompare(String(b.position), "zh-CN"));
}

function compactCourses(periods) {
  const facts = periods.map((period) => period.facts.courses).filter(Boolean);
  if (!facts.length) return null;
  const companies = mergeRows(facts.flatMap((fact) => fact.companies || []), (row) => row.company, ["company"], ["courseCount", "bookedCustomers", "bosses", "firms", "dealOrders", "dealAmount"])
    .map((row) => ({ ...row, conversionRate: percentage(row.dealOrders, row.bookedCustomers) }))
    .sort((a, b) => b.courseCount - a.courseCount || b.dealAmount - a.dealAmount || String(a.company).localeCompare(String(b.company), "zh-CN"));
  const summary = Object.fromEntries(COURSE_FIELDS.map((field) => [field, facts.reduce((total, fact) => total + number(fact.summary?.[field]), 0)]));
  summary.conversionRate = percentage(summary.dealOrders, summary.bookedCustomers);
  summary.selectedCompany = facts[0].summary?.selectedCompany || null;
  const allCourses = facts.flatMap((fact) => (fact.courses || []).map((course) => ({
    month: String(course.date || "").slice(0, 7),
    name: course.name,
    type: course.type,
    status: course.status,
    date: course.date,
    primaryCompany: course.primaryCompany,
    bookedCustomers: number(course.bookedCustomers),
    firms: number(course.firms),
    bosses: number(course.bosses),
    students: number(course.students),
    dealOrders: number(course.dealOrders),
    dealAmount: number(course.dealAmount),
    paidAmount: number(course.paidAmount),
    conversionRate: number(course.conversionRate),
    positionBreakdown: course.positionBreakdown || []
  })));
  const highlights = allCourses.slice().sort((a, b) => b.dealAmount - a.dealAmount || b.bookedCustomers - a.bookedCustomers || String(a.date).localeCompare(String(b.date))).slice(0, MAX_DETAIL_ROWS);
  return {
    definitions: facts[0].definitions,
    summary,
    companies: companies.slice(0, MAX_RANKING_ROWS),
    positionBreakdown: mergePositionRows(facts),
    courseHighlights: highlights,
    monthlyTrend: monthlySummary(periods, "courses", COURSE_FIELDS),
    detailCoverage: {
      aggregationComplete: true,
      sizeCompacted: false,
      companyRows: companies.length,
      companyRowsIncluded: Math.min(companies.length, MAX_RANKING_ROWS),
      positionRows: mergePositionRows(facts).length,
      positionRowsIncluded: mergePositionRows(facts).length,
      courseRecords: allCourses.length,
      courseHighlightsIncluded: highlights.length,
      monthlyTrendFields: ["month", ...COURSE_FIELDS],
      rawCourseListIncluded: false,
      rawDailyRowsIncluded: false
    }
  };
}

const DELIVERY_FIELDS = ["deliveryCourseCount", "invitations", "bosses", "students", "attributedPaidAmount", "unlinkedPaidRecordCount"];

function compactDelivery(periods) {
  const facts = periods.map((period) => period.facts.delivery).filter(Boolean);
  if (!facts.length) return null;
  const selectedCompany = facts.map((fact) => fact.summary?.selectedCompany).find(Boolean) || null;
  const companies = mergeRows(facts.flatMap((fact) => fact.companies || []), (row) => row.company, ["company"], ["invitations", "bosses", "students", "courseCount", "attributedPaidAmount", "unlinkedPaidRecordCount"])
    .filter((row) => !selectedCompany || row.company === selectedCompany)
    .sort((a, b) => b.invitations - a.invitations || b.attributedPaidAmount - a.attributedPaidAmount || String(a.company).localeCompare(String(b.company), "zh-CN"));
  const summary = Object.fromEntries(DELIVERY_FIELDS.map((field) => [field, facts.reduce((total, fact) => total + number(fact.summary?.[field]), 0)]));
  summary.selectedCompany = selectedCompany;
  summary.companyCount = companies.length;
  const allCourses = facts.flatMap((fact) => (fact.courses || []).flatMap((course) => {
    const listedCompanies = Array.isArray(course.companies) ? course.companies : [];
    const scopedCompanies = selectedCompany
      ? listedCompanies.filter((row) => row.company === selectedCompany)
      : listedCompanies;
    if (selectedCompany && !scopedCompanies.length) return [];
    const hasCompanyDetails = listedCompanies.length > 0;
    const compact = {
      month: String(course.date || "").slice(0, 7),
      name: course.name,
      date: course.date,
      invitations: hasCompanyDetails ? scopedCompanies.reduce((total, row) => total + number(row.invitations), 0) : number(course.invitations),
      bosses: hasCompanyDetails ? scopedCompanies.reduce((total, row) => total + number(row.bosses), 0) : number(course.bosses),
      students: hasCompanyDetails ? scopedCompanies.reduce((total, row) => total + number(row.students), 0) : number(course.students),
      attributedPaidAmount: hasCompanyDetails ? scopedCompanies.reduce((total, row) => total + number(row.attributedPaidAmount), 0) : number(course.attributedPaidAmount),
      unlinkedPaidRecordCount: hasCompanyDetails ? scopedCompanies.reduce((total, row) => total + number(row.unlinkedPaidRecordCount), 0) : number(course.unlinkedPaidRecordCount),
      amountScope: selectedCompany ? "selected-company-attribution" : "group-course-total"
    };
    if (!selectedCompany) {
      compact.dealOrders = number(course.dealOrders);
      compact.courseDealAmount = number(course.courseDealAmount);
      compact.coursePaidAmount = number(course.coursePaidAmount);
    }
    return [compact];
  }));
  const highlights = allCourses.slice().sort((a, b) => b.invitations - a.invitations || b.attributedPaidAmount - a.attributedPaidAmount || String(a.date).localeCompare(String(b.date))).slice(0, MAX_DETAIL_ROWS);
  return {
    definitions: facts[0].definitions,
    summary,
    companies: companies.slice(0, MAX_RANKING_ROWS),
    courseHighlights: highlights,
    monthlyTrend: monthlySummary(periods, "delivery", DELIVERY_FIELDS),
    detailCoverage: {
      aggregationComplete: true,
      sizeCompacted: false,
      companyRows: companies.length,
      companyRowsIncluded: Math.min(companies.length, MAX_RANKING_ROWS),
      deliveryCourseRecords: allCourses.length,
      courseHighlightsIncluded: highlights.length,
      monthlyTrendFields: ["month", ...DELIVERY_FIELDS],
      rawCourseListIncluded: false,
      rawDailyRowsIncluded: false
    }
  };
}

const OPPORTUNITY_FIELDS = ["createdCount", "expectedAmount", "wins", "wonAmount", "winsWithoutWonAmount", "lost", "active", "followCount", "withNextAction", "withDecisionSignal", "staleAtLeast14Days", "forgottenCandidates"];

function compactOpportunityCandidate(row) {
  return {
    creator: row.creator,
    customerName: row.customerName,
    name: row.name,
    createdDate: row.createdDate,
    stage: row.stage,
    willingness: row.willingness,
    expectedAmount: number(row.expectedAmount),
    wonAmount: number(row.wonAmount),
    wonAmountKnown: Boolean(row.wonAmountKnown),
    signals: row.signals ? {
      active: Boolean(row.signals.active),
      followCount: number(row.signals.followCount),
      meaningfulFollowCount: number(row.signals.meaningfulFollowCount),
      latestFollowDate: row.signals.latestFollowDate,
      staleDays: row.signals.staleDays === null ? null : number(row.signals.staleDays),
      hasNextAction: Boolean(row.signals.hasNextAction),
      hasDecisionSignal: Boolean(row.signals.hasDecisionSignal),
      forgottenCandidate: Boolean(row.signals.forgottenCandidate)
    } : null
  };
}

function compactOpportunities(periods) {
  const facts = periods.map((period) => period.facts.opportunities).filter(Boolean);
  if (!facts.length) return null;
  const summary = Object.fromEntries(OPPORTUNITY_FIELDS.map((field) => [field, facts.reduce((total, fact) => total + number(fact.summary?.[field]), 0)]));
  summary.selectedCompany = facts[0].summary?.selectedCompany || null;
  summary.selectedPerson = facts[0].summary?.selectedPerson || null;
  const stages = mergeRows(facts.flatMap((fact) => fact.stages || []), (row) => row.stage, ["stage"], ["count", "expectedAmount", "wonAmount"])
    .sort((a, b) => b.count - a.count || b.expectedAmount - a.expectedAmount || String(a.stage).localeCompare(String(b.stage), "zh-CN"));
  const people = mergeRows(
    facts.flatMap((fact) => fact.people || []),
    (row) => row.person?.id || [row.person?.name, row.person?.company].join("\u0000"),
    ["person"],
    ["createdCount", "expectedAmount", "wins", "wonAmount", "winsWithoutWonAmount", "active", "forgottenCandidates"]
  ).sort((a, b) => b.expectedAmount - a.expectedAmount || b.createdCount - a.createdCount || String(a.person?.name).localeCompare(String(b.person?.name), "zh-CN"));
  const candidates = uniqueBy(facts.flatMap((fact) => fact.reactivationCandidates || []), (row) => row.entityId || row.evidenceRef || [row.name, row.createdDate, row.creator?.name].join("\u0000"))
    .map(compactOpportunityCandidate)
    .sort((a, b) => b.expectedAmount - a.expectedAmount || number(b.signals?.staleDays) - number(a.signals?.staleDays));
  const opportunityCount = facts.reduce((total, fact) => total + (fact.opportunities || []).length, 0);
  return {
    definitions: facts[0].definitions,
    summary,
    stages,
    people: people.slice(0, MAX_RANKING_ROWS),
    reactivationCandidates: candidates.slice(0, MAX_DETAIL_ROWS),
    monthlyTrend: monthlySummary(periods, "opportunities", OPPORTUNITY_FIELDS),
    detailCoverage: {
      aggregationComplete: true,
      sizeCompacted: false,
      stageRows: stages.length,
      stageRowsIncluded: stages.length,
      peopleRows: people.length,
      peopleRowsIncluded: Math.min(people.length, MAX_RANKING_ROWS),
      opportunityRecords: opportunityCount,
      reactivationCandidates: candidates.length,
      reactivationCandidatesIncluded: Math.min(candidates.length, MAX_DETAIL_ROWS),
      monthlyTrendFields: ["month", ...OPPORTUNITY_FIELDS],
      rawOpportunityListIncluded: false,
      followExcerptsIncluded: false,
      rawDailyRowsIncluded: false
    }
  };
}

function normalizedEntityName(value) {
  return String(value || "").trim().toLocaleLowerCase("zh-CN").replace(/[\s\-_·（）()]/g, "");
}

function entityIdentity(value) {
  const id = String(value?.id || "").trim();
  if (id) return `id:${id}`;
  const name = normalizedEntityName(value?.name);
  return name ? `name:${name}` : "";
}

function aggregateEntityResolution(periods, key) {
  const entries = periods.map((period) => ({ month: monthOf(period), row: period.entityResolution?.[key] })).filter((entry) => entry.row);
  const rows = entries.map((entry) => entry.row);
  if (!rows.length) return { status: "not_requested", input: "", resolved: null, candidates: [] };
  if (rows.every((row) => row.status === "not_requested")) return rows[0];

  const candidates = uniqueBy(
    rows.flatMap((row) => [...(row.resolved ? [row.resolved] : []), ...(row.candidates || [])]),
    (row) => entityIdentity(row)
  ).slice(0, 12);
  const resolvedEntries = entries.filter((entry) => entry.row.status === "resolved" && entry.row.resolved);
  const resolvedIdentities = new Set(resolvedEntries.map((entry) => entityIdentity(entry.row.resolved)).filter(Boolean));
  const zeroActivityEntries = entries.filter((entry) => entry.row.status === "not_found");
  const hasAmbiguity = rows.some((row) => row.status === "needs_disambiguation");
  const hasInconsistentRequest = rows.some((row) => row.status === "not_requested");
  const unsupportedStatus = rows.some((row) => !["resolved", "not_found", "needs_disambiguation", "not_requested"].includes(row.status));

  if (resolvedEntries.length && resolvedIdentities.size === 1 && zeroActivityEntries.length
      && !hasAmbiguity && !hasInconsistentRequest && !unsupportedStatus) {
    const resolved = resolvedEntries[0].row;
    return {
      ...resolved,
      candidates,
      crossPeriodResolution: {
        status: "resolved_with_zero_activity_months",
        resolvedMonths: resolvedEntries.map((entry) => entry.month),
        zeroActivityMonths: zeroActivityEntries.map((entry) => entry.month)
      }
    };
  }
  if (resolvedEntries.length && resolvedIdentities.size === 1 && !zeroActivityEntries.length
      && !hasAmbiguity && !hasInconsistentRequest && !unsupportedStatus) {
    return { ...resolvedEntries[0].row, candidates };
  }

  const unresolved = rows.find((row) => row.status === "needs_disambiguation")
    || rows.find((row) => row.status === "not_found")
    || rows[0];
  return {
    ...unresolved,
    status: resolvedIdentities.size > 1 || hasInconsistentRequest || unsupportedStatus
      ? "needs_disambiguation"
      : unresolved.status,
    resolved: null,
    candidates,
    ...(resolvedIdentities.size > 1 ? {
      crossPeriodResolution: {
        status: "conflicting_resolutions",
        resolvedMonths: resolvedEntries.map((entry) => entry.month),
        zeroActivityMonths: zeroActivityEntries.map((entry) => entry.month)
      }
    } : {})
  };
}

function periodEntityResolutionIsUsable(period, key, aggregateResolution) {
  const status = period.entityResolution?.[key]?.status;
  if (["resolved", "not_requested"].includes(status)) return true;
  return status === "not_found"
    && aggregateResolution?.status === "resolved"
    && aggregateResolution.crossPeriodResolution?.status === "resolved_with_zero_activity_months"
    && aggregateResolution.crossPeriodResolution.zeroActivityMonths.includes(monthOf(period));
}

function buildProvenance(periods) {
  const formIds = Object.assign({}, ...periods.map((period) => period.provenance?.formIds || {}));
  return {
    live: true,
    readOnly: true,
    dataSource: "xbb-openapi",
    sourceMode: "live-readonly-source",
    sourceRefreshedAt: periods.map((period) => period.provenance?.sourceRefreshedAt).filter(Boolean).sort().at(-1) || null,
    formIds,
    periods: periods.map((period) => ({
      month: monthOf(period),
      sourceRefreshedAt: period.provenance?.sourceRefreshedAt || null,
      sourceRecordsSha256: period.provenance?.sourceRecordsSha256 || null,
      recordCounts: period.provenance?.recordCounts || {}
    })),
    telephoneFieldsExported: false,
    credentialFieldsExported: false
  };
}

function canonicalFactPack(pack) {
  const canonical = {
    scope: pack.scope,
    entityResolution: pack.entityResolution,
    provenance: pack.provenance,
    facts: pack.facts,
    limitations: pack.limitations
  };
  if (pack.compaction) canonical.compaction = pack.compaction;
  return canonical;
}

function refreshIntegrity(pack) {
  pack.integrity = {
    algorithm: "sha256",
    factPackSha256: crypto.createHash("sha256").update(JSON.stringify(canonicalFactPack(pack)), "utf8").digest("hex")
  };
}

function serializedBytes(pack) {
  return Buffer.byteLength(JSON.stringify(pack), "utf8");
}

function stabilizeFinalBytes(pack) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    refreshIntegrity(pack);
    const bytes = serializedBytes(pack);
    if (pack.compaction.finalBytes === bytes) return bytes;
    pack.compaction.finalBytes = bytes;
  }
  refreshIntegrity(pack);
  return serializedBytes(pack);
}

function markTrimmed(pack, trimmedPaths, factKey, path) {
  if (!trimmedPaths.includes(path)) trimmedPaths.push(path);
  if (pack.facts?.[factKey]?.detailCoverage) pack.facts[factKey].detailCoverage.sizeCompacted = true;
}

function removeRedundantHighCardinalityDetails(pack, trimmedPaths) {
  const highlights = pack.facts?.courses?.courseHighlights || [];
  let removedPositionDetails = false;
  for (const row of highlights) {
    if (!Object.hasOwn(row, "positionBreakdown")) continue;
    delete row.positionBreakdown;
    removedPositionDetails = true;
  }
  if (removedPositionDetails) markTrimmed(pack, trimmedPaths, "courses", "facts.courses.courseHighlights[].positionBreakdown");
}

function compactProvenance(pack, trimmedPaths) {
  const periods = pack.provenance?.periods;
  if (!Array.isArray(periods)) return;
  const recordCounts = {};
  let removedHashes = false;
  let removedCounts = false;
  for (const period of periods) {
    for (const [collection, count] of Object.entries(period.recordCounts || {})) {
      recordCounts[collection] = number(recordCounts[collection]) + number(count);
    }
    if (Object.hasOwn(period, "sourceRecordsSha256")) {
      delete period.sourceRecordsSha256;
      removedHashes = true;
    }
    if (Object.hasOwn(period, "recordCounts")) {
      delete period.recordCounts;
      removedCounts = true;
    }
  }
  pack.provenance.recordCounts = recordCounts;
  if (removedHashes) trimmedPaths.push("provenance.periods[].sourceRecordsSha256");
  if (removedCounts) trimmedPaths.push("provenance.periods[].recordCounts");
}

function rowArraysForCompaction(pack, managementRankings = false) {
  const facts = pack.facts || {};
  if (!managementRankings) {
    return [
      { factKey: "courses", path: "facts.courses.courseHighlights", rows: facts.courses?.courseHighlights, included: "courseHighlightsIncluded" },
      { factKey: "delivery", path: "facts.delivery.courseHighlights", rows: facts.delivery?.courseHighlights, included: "courseHighlightsIncluded" },
      { factKey: "opportunities", path: "facts.opportunities.reactivationCandidates", rows: facts.opportunities?.reactivationCandidates, included: "reactivationCandidatesIncluded" },
      { factKey: "productSales", path: "facts.productSales.companyProductMix", rows: facts.productSales?.companyProductMix, included: "companyProductMixRowsIncluded" },
      { factKey: "productSales", path: "facts.productSales.products", rows: facts.productSales?.products, included: "productRowsIncluded" }
    ];
  }
  return [
    { factKey: "performance", path: "facts.performance.ranking", rows: facts.performance?.ranking, included: "companyRowsIncluded" },
    { factKey: "productSales", path: "facts.productSales.ranking", rows: facts.productSales?.ranking, included: "companyRowsIncluded" },
    { factKey: "productSales", path: "facts.productSales.ticketRanking", rows: facts.productSales?.ticketRanking, included: "ticketRankingRowsIncluded" },
    { factKey: "productSales", path: "facts.productSales.commercialRanking", rows: facts.productSales?.commercialRanking, included: "commercialRankingRowsIncluded" },
    { factKey: "courses", path: "facts.courses.companies", rows: facts.courses?.companies, included: "companyRowsIncluded" },
    { factKey: "delivery", path: "facts.delivery.companies", rows: facts.delivery?.companies, included: "companyRowsIncluded" },
    { factKey: "opportunities", path: "facts.opportunities.people", rows: facts.opportunities?.people, included: "peopleRowsIncluded" }
  ];
}

function trimLargestTailRow(pack, descriptors, trimmedPaths) {
  const candidates = descriptors
    .filter((item) => Array.isArray(item.rows) && item.rows.length > (item.minimumRows || MIN_INCLUDED_ROWS))
    .map((item, index) => ({ item, index, bytes: serializedBytes(item.rows.at(-1)) }))
    .sort((a, b) => b.bytes - a.bytes || a.index - b.index);
  if (!candidates.length) return false;
  const descriptor = candidates[0].item;
  descriptor.rows.pop();
  const coverage = pack.facts[descriptor.factKey].detailCoverage;
  coverage[descriptor.included] = descriptor.rows.length;
  markTrimmed(pack, trimmedPaths, descriptor.factKey, descriptor.path);
  return true;
}

function projectMonthlyTrends(pack, trimmedPaths) {
  for (const [factKey, fields] of Object.entries(MONTHLY_TREND_FIELDS)) {
    const fact = pack.facts?.[factKey];
    if (!fact || !Array.isArray(fact.monthlyTrend) || !fact.monthlyTrend.length) continue;
    const before = Object.keys(fact.monthlyTrend[0]);
    if (before.every((field) => fields.includes(field)) && fields.every((field) => before.includes(field))) continue;
    fact.monthlyTrend = fact.monthlyTrend.map((row) => Object.fromEntries(fields.filter((field) => Object.hasOwn(row, field)).map((field) => [field, row[field]])));
    fact.detailCoverage.monthlyTrendFields = fields.slice();
    markTrimmed(pack, trimmedPaths, factKey, `facts.${factKey}.monthlyTrend.fields`);
  }
}

function compactToByteBudget(pack) {
  refreshIntegrity(pack);
  const initialBytes = serializedBytes(pack);
  const trimmedPaths = [];
  pack.compaction = {
    applied: false,
    budgetBytes: MAX_AGGREGATE_BYTES,
    initialBytes,
    finalBytes: 0,
    trimmedPaths
  };
  compactProvenance(pack, trimmedPaths);
  removeRedundantHighCardinalityDetails(pack, trimmedPaths);
  let bytes = stabilizeFinalBytes(pack);
  const detailArrays = rowArraysForCompaction(pack, false);
  while (bytes > MAX_AGGREGATE_BYTES && trimLargestTailRow(pack, detailArrays, trimmedPaths)) bytes = stabilizeFinalBytes(pack);
  const managementRankings = rowArraysForCompaction(pack, true);
  for (const descriptor of managementRankings) descriptor.minimumRows = MIN_MANAGEMENT_ROWS;
  while (bytes > MAX_AGGREGATE_BYTES && trimLargestTailRow(pack, managementRankings, trimmedPaths)) bytes = stabilizeFinalBytes(pack);
  if (bytes > MAX_AGGREGATE_BYTES) {
    projectMonthlyTrends(pack, trimmedPaths);
    bytes = stabilizeFinalBytes(pack);
  }
  pack.compaction.applied = trimmedPaths.length > 0;
  bytes = stabilizeFinalBytes(pack);
  if (bytes > MAX_AGGREGATE_BYTES) throw new Error(`跨月聚合事实包仍过大（${bytes} 字节），必须缩小明细覆盖而不是截断 JSON。`);
  return pack;
}

function buildMultiPeriodFactPack(periods, scope = {}) {
  if (!Array.isArray(periods) || periods.length < 2 || periods.length > MAX_PERIOD_MONTHS) throw new Error(`跨月聚合需要 2 至 ${MAX_PERIOD_MONTHS} 个单月事实包。`);
  const sorted = periods.slice().sort((a, b) => monthOf(a).localeCompare(monthOf(b)));
  const entityResolution = {
    company: aggregateEntityResolution(sorted, "company"),
    person: aggregateEntityResolution(sorted, "person")
  };
  const entitiesUsable = Object.values(entityResolution).every((resolution) => ["resolved", "not_requested"].includes(resolution.status));
  const periodsUsable = sorted.every((period) => period.status === "ready"
    || ["company", "person"].every((key) => periodEntityResolutionIsUsable(period, key, entityResolution[key])));
  const status = entitiesUsable && periodsUsable ? "ready" : "needs_disambiguation";
  const facts = {};
  if (status === "ready") {
    const performance = compactPerformance(sorted);
    const productSales = compactProductSales(sorted);
    const courses = compactCourses(sorted);
    const delivery = compactDelivery(sorted);
    const opportunities = compactOpportunities(sorted);
    if (performance) facts.performance = performance;
    if (productSales) facts.productSales = productSales;
    if (courses) facts.courses = courses;
    if (delivery) facts.delivery = delivery;
    if (opportunities) facts.opportunities = opportunities;
  }
  const pack = {
    schemaVersion: "2.1",
    skill: "xbb-executive-analyst",
    mode: "xbb-live-readonly-multi-period-aggregate",
    status,
    scope: {
      months: sorted.map(monthOf),
      range: {
        startLabel: sorted[0].scope?.range?.startLabel || null,
        endLabel: sorted.at(-1).scope?.range?.endLabel || null
      },
      refreshedAt: sorted.map((period) => period.scope?.refreshedAt).filter(Boolean).sort().at(-1) || null,
      domains: Array.isArray(scope.domains) ? scope.domains : sorted[0].scope?.domains || [],
      company: scope.company || null,
      person: scope.person || null,
      currentMonthPartial: sorted.some((period) => period.scope?.currentMonthPartial === true)
    },
    entityResolution,
    provenance: buildProvenance(sorted),
    facts,
    limitations: [
      "跨月总额、排名、占比和月度趋势由各自然月事实确定性聚合；不让模型对截断的单月明细自行求和。",
      "年度管理指标聚合完整；逐条课程、交付和商机原始列表不进入跨月模型上下文，需要时按月份、公司或人员下钻查询。",
      "当前月若尚未结束，只统计实时刷新时点前的月累计数据。",
      ...(Object.values(entityResolution).some((resolution) => resolution.crossPeriodResolution?.status === "resolved_with_zero_activity_months")
        ? ["实体已在部分月份唯一确认；crossPeriodResolution.zeroActivityMonths 所列月份因没有该实体活动记录，按零值纳入完整月度趋势。"]
        : [])
    ]
  };
  compactToByteBudget(pack);
  assertNoSensitiveFactValues(pack);
  return pack;
}

function atomicWrite(outputPath, value) {
  const resolved = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "wx" });
    fs.renameSync(temporary, resolved);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

function parseArguments(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (["--input", "--output", "--isolation-token"].includes(key)) {
      if (index + 1 >= argv.length || String(argv[index + 1]).startsWith("--")) throw new Error(`参数缺少值：${key}`);
      if (Object.hasOwn(parsed, key.slice(2))) throw new Error(`参数不能重复：${key}`);
      parsed[key.slice(2)] = argv[index + 1];
      index += 1;
    } else {
      throw new Error(`不支持的参数：${key}`);
    }
  }
  if (!parsed.input || !parsed.output) throw new Error("必须提供 --input 和 --output。");
  if (parsed["isolation-token"] !== undefined && !/^[a-f0-9]{64}$/.test(parsed["isolation-token"])) {
    throw new Error("runner isolation token 格式无效。");
  }
  return parsed;
}

function main() {
  const args = parseArguments(process.argv.slice(2));
  const input = JSON.parse(fs.readFileSync(path.resolve(args.input), "utf8"));
  const pack = buildMultiPeriodFactPack(input.periods, input.scope);
  atomicWrite(args.output, pack);
  process.stdout.write(`${JSON.stringify({ success: true, status: pack.status, months: pack.scope.months, bytes: Buffer.byteLength(JSON.stringify(pack), "utf8"), factPackSha256: pack.integrity.factPackSha256 })}\n`);
}

if (require.main === module) {
  try { main(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}

module.exports = { MAX_AGGREGATE_BYTES, MAX_PERIOD_MONTHS, buildMultiPeriodFactPack };
