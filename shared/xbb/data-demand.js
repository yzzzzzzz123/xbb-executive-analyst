"use strict";

// One request contract controls source dependencies and the model-facing view.
// Metrics are optional projections; omitting them returns the complete authorized domain.
const METRICS = Object.freeze({
  "performance.total": "performance", "performance.ranking": "performance", "performance.mix": "performance", "performance.trend": "performance",
  "tickets.ranking": "product-sales", "tickets.mix": "product-sales",
  "commercial.ranking": "product-sales", "commercial.mix": "product-sales",
  "courses.count": "courses", "courses.bosses": "courses", "courses.positions": "courses", "courses.amount": "courses", "courses.conversion": "courses",
  "opportunities.count": "opportunities", "opportunities.amount": "opportunities", "opportunities.wins": "opportunities", "opportunities.stages": "opportunities", "opportunities.quality": "opportunities",
  "delivery.invitations": "delivery", "delivery.amount": "delivery"
});

function validateMetrics(metrics, domains) {
  if (!Array.isArray(metrics) || !metrics.length || metrics.length > Object.keys(METRICS).length
      || metrics.some((metric) => typeof metric !== "string" || !Object.hasOwn(METRICS, metric))) throw new Error("metrics 投影包含无效指标；可省略 metrics 查询所选数据域的完整事实。");
  const unique = [...new Set(metrics)].sort();
  const selected = [...new Set(unique.map((metric) => METRICS[metric]))].sort();
  if (domains && JSON.stringify(selected) !== JSON.stringify([...new Set(domains)].sort())) throw new Error("指定 metrics 投影时，指标与数据域必须完全对应；跨域完整查询可省略 metrics。");
  return unique;
}

function sourceCollections(metrics) {
  const selected = new Set(validateMetrics(metrics));
  const collections = new Set();
  for (const metric of selected) {
    if (metric.startsWith("performance.")) collections.add("performance");
    if (metric.startsWith("tickets.")) collections.add("oppOrder");
    if (metric.startsWith("commercial.")) { collections.add("performance"); collections.add("product"); }
    if (metric.startsWith("courses.")) collections.add("course");
    if (["courses.bosses", "courses.positions", "courses.conversion"].includes(metric)) collections.add("booking");
    if (["courses.amount", "courses.conversion"].includes(metric)) collections.add("courseOrders");
    if (metric.startsWith("opportunities.")) collections.add("opportunity");
    if (metric === "opportunities.quality") collections.add("follow");
    if (metric.startsWith("delivery.")) { collections.add("course"); collections.add("deliveryBooking"); }
  }
  return collections;
}

function sourceFields(metrics) {
  const has = (metric) => metrics.includes(metric);
  const any = (prefix) => metrics.some((metric) => metric.startsWith(prefix));
  return {
    performance: ["date_1", "text_63", "array_4"],
    "performance.array_4": [...(any("performance.") ? ["num_5"] : []), ...(has("performance.mix") ? ["text_10"] : []), ...(any("commercial.") ? ["text_1", "num_3"] : [])],
    oppOrder: ["date_1", "text_31", "array_4", "text_3", "text_6", "num_1"],
    "oppOrder.array_4": ["text_1", "num_3"],
    product: ["text_1"],
    course: ["date_1", "text_1", "text_5", ...(any("delivery.") ? ["text_7"] : [])],
    booking: ["text_5", ...(has("courses.bosses") || has("courses.positions") ? ["text_22"] : [])],
    courseOrders: ["text_28", "num_1"],
    opportunity: ["creatorId", "text_11", ...(has("opportunities.amount") || has("opportunities.quality") ? ["num_1"] : []),
      ...(has("opportunities.wins") || has("opportunities.stages") || has("opportunities.quality") ? ["text_17"] : []),
      ...(has("opportunities.quality") ? ["text_1", "text_12"] : [])],
    follow: ["creatorId", "date_1", "text_5", "text_6"],
    deliveryBooking: ["text_2", "text_6", "text_7", "text_8", "text_9", ...(has("delivery.amount") ? ["num_3"] : [])]
  };
}

function pick(value, keys) {
  return Object.fromEntries(keys.filter((key) => Object.hasOwn(value || {}, key)).map((key) => [key, value[key]]));
}

function projectFacts(facts, metrics) {
  const selected = new Set(validateMetrics(metrics));
  const has = (metric) => selected.has(metric);
  const result = {};
  if ([...selected].some((m) => m.startsWith("performance.")) && facts.performance) {
    const f = facts.performance, keys = ["total", ...(has("performance.mix") ? ["course", "consulting", "other", "courseShare", "consultingShare", "otherShare"] : [])];
    const out = { definitions: pick(f.definitions, ["amount", "company", ...(has("performance.mix") ? ["mix"] : [])]), completeness: pick(f.summary, ["sourceOrderCount", "ordersWithProductLines", "ordersWithoutProductLines"]) };
    if (has("performance.total") || has("performance.mix") && !has("performance.ranking")) out.summary = pick(f.summary, keys);
    if (has("performance.ranking")) out.ranking = (f.ranking || []).map((row) => pick(row, ["company", ...keys]));
    if (has("performance.trend")) {
      if (f.monthlyTrend) out.monthlyTrend = f.monthlyTrend.map((row) => pick(row, ["month", ...keys]));
      if (f.dailyTrend) out.dailyTrend = f.dailyTrend.map((row) => pick(row, ["date", ...keys]));
    }
    result.performance = out;
  }
  if (facts.productSales && [...selected].some((m) => m.startsWith("tickets.") || m.startsWith("commercial."))) {
    const f = facts.productSales, out = { completeness: pick(f.summary, ["sourceOppOrderCount", "oppOrdersWithProductLines", "oppOrdersWithValidatedFlatProduct", "oppOrdersWithoutSupportedProductShape"]) };
    if (has("tickets.ranking")) out.ticketRanking = (f.ticketRanking || []).map((row) => pick(row, ["rank", "company", "ticketCount"]));
    if (has("commercial.ranking")) out.commercialRanking = (f.commercialRanking || []).map((row) => pick(row, ["rank", "company", "commercialInitialCount", "commercialRetrainingCount", "commercialCount"]));
    if (has("tickets.mix") || has("commercial.mix")) out.companyProductMix = (f.companyProductMix || [])
      .filter((row) => row.source === "oppOrder" ? has("tickets.mix") : has("commercial.mix") && String(row.product).includes("商业操盘"))
      .map((row) => pick(row, ["company", "source", "product", "quantity", "quantityShare"]));
    if (out.companyProductMix) for (const row of out.companyProductMix) {
      const total = out.companyProductMix.filter((item) => item.company === row.company && item.source === row.source).reduce((sum, item) => sum + item.quantity, 0);
      row.quantityShare = total > 0 ? Math.round(row.quantity / total * 10000) / 100 : 0;
    }
    result.productSales = out;
  }
  if (facts.courses && [...selected].some((m) => m.startsWith("courses."))) {
    const f = facts.courses, keys = [...(has("courses.count") ? ["courseCount"] : []), ...(has("courses.bosses") ? ["bosses"] : []),
      ...(has("courses.amount") ? ["dealAmount"] : []), ...(has("courses.conversion") ? ["dealOrders", "bookedCustomers", "conversionRate"] : [])];
    const out = { summary: pick(f.summary, keys), definitions: pick(f.definitions, keys), companies: (f.companies || []).map((row) => pick(row, ["company", ...keys])) };
    if (has("courses.positions")) out.positionBreakdown = f.positionBreakdown;
    result.courses = out;
  }
  if (facts.opportunities && [...selected].some((m) => m.startsWith("opportunities."))) {
    const f = facts.opportunities, quality = has("opportunities.quality");
    const keys = [...(has("opportunities.count") ? ["createdCount"] : []), ...(has("opportunities.amount") ? ["expectedAmount"] : []),
      ...(has("opportunities.wins") ? ["wins"] : []), ...(quality ? ["active", "followCount", "withNextAction", "withDecisionSignal", "staleAtLeast14Days", "forgottenCandidates"] : [])];
    const out = { summary: pick(f.summary, keys), definitions: pick(f.definitions, ["created", ...(has("opportunities.wins") ? ["won"] : []), ...(quality ? ["followLink", "forgottenCandidate", "qualityBoundary"] : [])]) };
    if (has("opportunities.stages") || quality) out.stages = (f.stages || []).map((row) => pick(row, ["stage", "count", ...(has("opportunities.amount") || quality ? ["expectedAmount"] : [])]));
    if (quality) {
      const details = (rows) => (rows || []).map((row) => pick(row, ["entityId", "creator", "name", "createdDate", "stage", "willingness", "expectedAmount", "signals", "followEvidence"]));
      out.opportunities = details(f.opportunities); out.reactivationCandidates = details(f.reactivationCandidates);
    }
    result.opportunities = out;
  }
  if (facts.delivery && [...selected].some((m) => m.startsWith("delivery."))) {
    const f = facts.delivery, keys = [...(has("delivery.invitations") ? ["deliveryCourseCount", "invitations", "bosses", "students"] : []), ...(has("delivery.amount") ? ["attributedPaidAmount", "unlinkedPaidRecordCount"] : [])];
    result.delivery = { definitions: f.definitions, summary: pick(f.summary, keys), companies: (f.companies || []).map((row) => pick(row, ["company", ...keys])) };
  }
  return result;
}

module.exports = { METRICS, validateMetrics, sourceCollections, sourceFields, projectFacts };
