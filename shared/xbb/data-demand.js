"use strict";

// One request contract controls source dependencies and the model-facing view.
// Metrics are capabilities, not permission to load an entire business domain.
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
      || metrics.some((metric) => typeof metric !== "string" || !Object.hasOwn(METRICS, metric))) throw new Error("必须明确指定本次需要的有效指标，不能扩大取数范围。");
  const unique = [...new Set(metrics)].sort();
  const selected = [...new Set(unique.map((metric) => METRICS[metric]))].sort();
  if (domains && JSON.stringify(selected) !== JSON.stringify([...new Set(domains)].sort())) throw new Error("指标与数据域必须完全对应，不能顺带查询其他数据域。");
  return unique;
}

function specifiedCompany(question) {
  const named = [...String(question || "").matchAll(/([\p{Script=Han}A-Za-z0-9]{0,30}(?:分公司|公司))/gu)].at(-1)?.[1];
  const generic = /^(?:(?:请|查询|看下|看看|今年|本年|本月|这个月|当月|今天|今日|昨天|昨日|目前|的|\d{4}年|\d{1,2}月|\d{1,2}[日号]))*公司$/u.test(named || "");
  return named && !generic && !/集团|各个|各分|各公司|全部|所有|我们|咱们|哪个|哪家|按公司/u.test(named) ? named : null;
}

function inferMetrics(question, domains, scope = {}) {
  const text = String(question || "").replace(/\s+/g, "")
    .replace(/(?:不要|不用|无需|不需要|不看|不查)(?:查询|读取|分析|看)?(?:商机)?(?:跟进(?:记录|内容|质量)?|质量|激活(?:建议)?|预计成交金额|金额|阶段|占比|趋势)/gu, "");
  const selected = [];
  const add = (metric, condition = true) => { if (condition) selected.push(metric); };
  const rank = /排名|排行|各(?:个)?(?:分)?公司|哪个公司|哪个分公司|谁最高|哪家/u.test(text)
    || /分公司/u.test(text) && !specifiedCompany(question) && !scope.company && !scope.person;
  const mix = /占比|构成|结构|区分|拆分/u.test(text);
  if (domains.includes("performance")) {
    const broadPerformance = /业绩(?:情况|表现)?(?:怎么样|如何)|业绩(?:情况|表现|分析)(?:[。？！!?]|$)|(?:分析|看看|看下).{0,10}业绩(?:[。？！!?]|$)/u.test(text)
      && !/金额|数量|多少|几单|总数|总额|总量|只(?:要|看)|仅(?:要|看)/u.test(text)
      && !specifiedCompany(question) && !scope.company && !scope.person;
    add("performance.ranking", rank || broadPerformance);
    add("performance.total", !rank || /集团.{0,8}(?:怎么样|总|累计)|公司(?:的)?业绩怎么样|整体|总体/u.test(text));
    add("performance.mix", mix || /课程.{0,6}咨询|咨询.{0,6}课程/u.test(text));
    add("performance.trend", /趋势|走势|逐月|每月|月度|环比|同比|增长|回落/u.test(text));
  }
  if (domains.includes("product-sales")) {
    for (const [prefix, pattern] of [["tickets", /门票|开源产品/u], ["commercial", /商业操盘/u]]) {
      if (pattern.test(text)) { add(`${prefix}.ranking`); add(`${prefix}.mix`, mix); }
    }
  }
  if (domains.includes("courses")) {
    add("courses.count", /多少.{0,3}课|开课|堂课|场次|课程数/u.test(text));
    add("courses.bosses", /老板/u.test(text));
    add("courses.positions", /职位|岗位/u.test(text));
    add("courses.amount", /金额|收入|业绩|回款/u.test(text));
    add("courses.conversion", /成(?:交|家)率|转化率/u.test(text));
  }
  if (domains.includes("opportunities")) {
    add("opportunities.count", /多少|数量|个数|计数|创建/u.test(text) && (!/赢单/u.test(text) || /创建|新增/u.test(text)));
    add("opportunities.amount", /金额|预计成交/u.test(text));
    add("opportunities.wins", /赢单/u.test(text));
    add("opportunities.stages", /阶段|分布|漏斗/u.test(text));
    add("opportunities.quality", /质量|跟进|遗忘|激活|风险|有效|建议|诊断/u.test(text));
  }
  if (domains.includes("delivery")) {
    add("delivery.invitations", /邀约|受邀|到场|交付/u.test(text));
    add("delivery.amount", /金额|回款|业绩分配/u.test(text));
  }
  return validateMetrics(selected, domains);
}

function bindQueryDemand(input, question, authoritativePlan = null) {
  const { routeDomains, planFastQuery } = require("./fast-query-plan.js");
  const allowedDomains = authoritativePlan?.domains || routeDomains(question);
  if ((input.domains || []).some((domain) => !allowedDomains.includes(domain))) throw new Error("不能查询问题未涉及的数据域。");
  const periodPlan = authoritativePlan || planFastQuery(question);
  if (!periodPlan || (input.months || []).some((month) => !periodPlan.months.includes(month))) throw new Error("查询月份超出用户所问范围。");
  if ((input.date || null) !== (periodPlan.date || null)) throw new Error("查询日期必须与用户所问单日完全一致，不能遗漏日期后改查整月。");
  let allowed = inferMetrics(question, input.domains || [], input);
  for (const correction of String(question).split("\n").slice(1)) {
    if (!/只看|仅看|只要|仅要|改看|改为/u.test(correction)) continue;
    // A restrictive metric correction replaces the older metric intent when
    // it can be understood in the already authorized domain.
    try { allowed = inferMetrics(correction, input.domains || [], input); } catch { /* period/presentation correction only */ }
  }
  const metrics = input.metrics ? validateMetrics(input.metrics, input.domains) : allowed;
  if (metrics.some((metric) => !allowed.includes(metric))) throw new Error("查询超出用户所问指标，请只获取当前问题明确需要的数据。");
  if (specifiedCompany(question) && !input.company) {
    throw new Error("用户指定了公司，必须先确定 company 再查询；不得扩大为集团。");
  }
  if (input.company && !String(question).includes(input.company) && !String(question).includes(input.company.replace(/(?:区域)?(?:分)?公司$/u, ""))) throw new Error("公司筛选不属于当前用户问题，不能另查其他公司。");
  if (input.person && !String(question).includes(input.person)) throw new Error("销售人员筛选不属于当前用户问题。");
  if (!input.person && /销售(?:员|人员)?[：:]?[\p{Script=Han}]{2,4}(?:这个月|本月|当月|创建)|[\p{Script=Han}]{2,4}(?:这个月|本月|当月)创建.{0,5}商机/u.test(String(question)) && !/集团|公司|各个|所有/u.test(String(question))) throw new Error("用户指定了销售，必须先明确 person；不得读取集团商机。");
  return { ...input, metrics };
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

module.exports = { METRICS, validateMetrics, inferMetrics, bindQueryDemand, sourceCollections, sourceFields, projectFacts };
