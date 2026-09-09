"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { assertNoSensitiveFactValues } = require("../security/fact-privacy.js");

const ALLOWED_DOMAINS = new Set([
  "performance",
  "product-sales",
  "courses",
  "delivery",
  "opportunities"
]);
const COURSE_CATEGORIES = new Set([
  "opp", "考培", "训练营", "会员卡", "内训", "小巨人", "游学", "长才", "训战班",
  "认证班", "通", "班", "课程", "方案班", "商业逻辑", "工作坊"
]);
const CONSULT_CATEGORIES = new Set(["商事服务", "用工风险", "咨询", "专项", "顾问", "微咨询", "调研"]);
const ACTIVE_STAGES = new Set(["发现需求", "确认需求", "解决方案", "商务谈判"]);
const STAGE_ORDER = ["发现需求", "确认需求", "解决方案", "商务谈判", "赢单", "输单"];
const NEXT_ACTION_RE = /(明天|后天|本周|下周|\d{1,2}[月\/.\-]\d{1,2}|上午|下午|晚上|再次|回访|邀约|约见|发方案|报价|确认|安排|跟进|联系)/i;
const DECISION_RE = /(老板|法人|总经理|董事长|决策|股东|负责人|实际控制人)/i;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function asText(value) {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(asText).filter(Boolean).join("、");
  if (typeof value === "object") return asText(value.name || value.text || value.label || value.value || value.id);
  return String(value).trim();
}

function safeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function field(record, attr) {
  return record && record.fields ? record.fields[attr] : undefined;
}

function relationIds(value) {
  const rows = Array.isArray(value) ? value : value ? [value] : [];
  return rows.map((item) => {
    if (item && typeof item === "object") return asText(item.id || item.value || item.dataId);
    return asText(item);
  }).filter(Boolean);
}

function relationId(value) {
  return relationIds(value)[0] || "";
}

function entityId(record) {
  if (record && record.entityId) return record.entityId;
  const recordId = asText(record && record.recordId);
  return recordId.startsWith("record_") ? `rel_${recordId.slice(7)}` : "";
}

function recordCompany(record, ...attrs) {
  for (const attr of attrs) {
    const value = asText(field(record, attr));
    if (value) return value;
  }
  return "未标公司";
}

function groupBy(rows, keyFn) {
  const result = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!result.has(key)) result.set(key, []);
    result.get(key).push(row);
  }
  return result;
}

function sum(rows, selector) {
  return rows.reduce((total, row) => total + safeNumber(selector(row)), 0);
}

function percentage(part, total) {
  return total > 0 ? part / total * 100 : 0;
}

function hasValue(value) {
  return value !== undefined && value !== null && value !== "";
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function normalizeName(value) {
  return asText(value).toLocaleLowerCase("zh-CN").replace(/[\s\-_·（）()]/g, "");
}

function recordInSourceRange(source, record, attr) {
  let value = attr === "addTime" ? record && record.addTime : field(record, attr);
  value = Number(value);
  if (!Number.isFinite(value)) return false;
  if (value > 1e12) value = Math.floor(value / 1000);
  const start = safeNumber(source && source.range && source.range.start);
  const end = safeNumber(source && source.range && source.range.end);
  return value >= start && value <= end;
}

function localDate(timestamp) {
  const value = safeNumber(timestamp);
  if (!value) return "";
  return new Date((value > 1e12 ? value : value * 1000)).toLocaleDateString("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
}

function mostFrequent(values, fallback = "未标公司") {
  const counts = new Map();
  for (const value of values.map(asText).filter(Boolean)) counts.set(value, (counts.get(value) || 0) + 1);
  const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-CN"));
  return sorted.length ? sorted[0][0] : fallback;
}

function bookingCompany(booking) {
  const orderType = asText(field(booking, "text_7"));
  if (orderType.includes("OPP")) return recordCompany(booking, "text_25", "text_36", "text_26");
  if (orderType.includes("业绩")) return recordCompany(booking, "text_26", "text_36", "text_25");
  return recordCompany(booking, "text_26", "text_25", "text_36");
}

function categoryBusinessType(value) {
  const category = asText(value).toLocaleLowerCase("zh-CN");
  if (!category) return "其他";
  if (COURSE_CATEGORIES.has(category) || /课程|训练营|考培|会员卡|内训|游学|认证|工作坊|商业操盘/.test(category)) return "课程";
  if (CONSULT_CATEGORIES.has(category) || /咨询|顾问|专项|调研|服务/.test(category)) return "咨询";
  return "其他";
}

function classifyProduct(product, fallbackName = "", explicitCategory = "") {
  const name = asText(field(product, "text_1")) || asText(fallbackName) || "未命名产品";
  const categoryRaw = asText(explicitCategory) || asText(field(product, "text_6"));
  const category = categoryRaw.toLocaleLowerCase("zh-CN");
  const frontBack = asText(field(product, "text_15")) || "未分类";
  const classificationBasis = asText(explicitCategory)
    ? "sales-order-line-category"
    : product
      ? "product-master"
      : (asText(fallbackName) ? "business-record-product-name" : "unclassified");
  let businessType = categoryBusinessType(categoryRaw);
  if (businessType === "其他" && !categoryRaw && /(?:课程|研讨会|训练营|私训营|游学|沙龙|门票|opp|班|通$)/i.test(name)) businessType = "课程";
  else if (businessType === "其他" && !categoryRaw && /(?:咨询|顾问|专项|调研|服务)/i.test(name)) businessType = "咨询";
  const isOpen = frontBack === "前端" || frontBack === "OPP" || category === "opp" || /(门票|开源|opp)/i.test(name);
  const isTicket = /门票|票务/.test(name) || (category === "opp" && /票|opp/i.test(name));
  const isCommercial = /商业操盘/.test(name);
  const isCommercialRetraining = isCommercial && /复训/.test(name);
  return {
    name,
    category: categoryRaw || "未分类",
    frontBack,
    businessType,
    isOpen,
    isTicket,
    isCommercial,
    isCommercialInitial: isCommercial && !isCommercialRetraining,
    isCommercialRetraining,
    classificationBasis
  };
}

function subtableItems(record, attr = "array_4") {
  const value = field(record, attr);
  if (!Array.isArray(value)) return [];
  return value.filter((item) => item && typeof item === "object" && !Array.isArray(item));
}

function fieldCatalogLabel(source, collection, attr) {
  return asText(source?.fieldCatalog?.[collection]?.[attr]?.label);
}

function supportsValidatedFlatOppShape(source) {
  const productLabel = fieldCatalogLabel(source, "oppOrder", "text_3");
  const quantityLabel = fieldCatalogLabel(source, "oppOrder", "num_1");
  const companyLabel = fieldCatalogLabel(source, "oppOrder", "text_6");
  return /产品名称/.test(productLabel)
    && /产品销量|销售数量/.test(quantityLabel)
    && /所属公司/.test(companyLabel);
}

function classifyOppOrderProduct(product, fallbackName) {
  return {
    ...classifyProduct(product, fallbackName),
    isOpen: true,
    isTicket: true,
    ticketBasis: "OPP订单销售数量"
  };
}

function performanceLineRows(source, products) {
  const rows = [];
  for (const record of source.records.performance || []) {
    if (!recordInSourceRange(source, record, "date_1")) continue;
    const company = recordCompany(record, "text_63", "text_3");
    const date = localDate(field(record, "date_1"));
    const items = subtableItems(record);
    if (items.length) {
      for (const item of items) {
        const product = classifyProduct(
          products.get(relationId(item.text_1)),
          typeof item.text_1 === "object" ? asText(item.text_1 && item.text_1.name) : asText(item.text_1),
          item.text_10
        );
        product.businessType = categoryBusinessType(item.text_10);
        product.classificationBasis = hasValue(item.text_10)
          ? "sales-order-line-category"
          : "missing-sales-order-line-category";
        rows.push({
          record,
          company,
          amount: safeNumber(item.num_5),
          quantity: safeNumber(item.num_3),
          date,
          product
        });
      }
    }
  }
  return rows;
}

function oppOrderLineRows(source, products) {
  const rows = [];
  const allowValidatedFlatShape = supportsValidatedFlatOppShape(source);
  for (const record of source.records.oppOrder || []) {
    if (!recordInSourceRange(source, record, "date_1")) continue;
    const company = recordCompany(record, "text_31", "text_6");
    const date = localDate(field(record, "date_1"));
    const items = subtableItems(record);
    if (items.length) {
      for (const item of items) {
        rows.push({
          record,
          company,
          quantity: safeNumber(item.num_3),
          revenue: safeNumber(item.num_5),
          date,
          product: classifyOppOrderProduct(undefined, item.text_1),
          sourceShape: "array_4"
        });
      }
    } else if (allowValidatedFlatShape && hasValue(field(record, "text_3")) && hasValue(field(record, "num_1"))) {
      rows.push({
        record,
        company,
        quantity: safeNumber(field(record, "num_1")),
        revenue: safeNumber(field(record, "num_5")),
        date,
        product: classifyOppOrderProduct(products.get(relationId(field(record, "text_10"))), field(record, "text_3")),
        sourceShape: "validated-flat-record"
      });
    }
  }
  return rows;
}

function productMap(source) {
  return new Map((source.records.product || []).map((record) => [entityId(record), record]));
}

function userCompany(user) {
  const departments = Array.isArray(user && user.departments) ? user.departments : [];
  const preferred = departments.find((department) => /公司|集团|区域/.test(asText(department.name)));
  return asText((preferred || departments[0] || {}).name) || "未标公司";
}

function userMap(source) {
  return new Map((source.records.user || []).map((user) => [asText(user.userId), user]));
}

function productFor(record, attr, products) {
  return products.get(relationId(field(record, attr)));
}

function evidenceRefs(rows) {
  return unique(rows.map((row) => asText(row && row.evidenceRef)));
}

function dayTrend(rows, dateFn, valueFns) {
  const byDay = new Map();
  for (const row of rows) {
    const day = dateFn(row);
    if (!day) continue;
    if (!byDay.has(day)) byDay.set(day, Object.fromEntries(Object.keys(valueFns).map((key) => [key, 0])));
    const bucket = byDay.get(day);
    for (const [key, selector] of Object.entries(valueFns)) bucket[key] += safeNumber(selector(row));
  }
  return Array.from(byDay.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([date, values]) => ({ date, ...values }));
}

function positionBreakdown(bookings) {
  const positions = new Map();
  for (const booking of bookings) {
    const position = asText(field(booking, "text_22")) || "未填写";
    positions.set(position, (positions.get(position) || 0) + 1);
  }
  return Array.from(positions.entries()).map(([position, count]) => ({
    position,
    count,
    share: percentage(count, bookings.length)
  })).sort((a, b) => b.count - a.count || a.position.localeCompare(b.position, "zh-CN"));
}

function mergePositionBreakdowns(courses) {
  const counts = new Map();
  for (const course of courses) {
    for (const row of course.positionBreakdown || []) {
      counts.set(row.position, (counts.get(row.position) || 0) + safeNumber(row.count));
    }
  }
  const total = Array.from(counts.values()).reduce((sumValue, count) => sumValue + count, 0);
  return Array.from(counts.entries()).map(([position, count]) => ({
    position,
    count,
    share: percentage(count, total)
  })).sort((a, b) => b.count - a.count || a.position.localeCompare(b.position, "zh-CN"));
}

function buildCourseFacts(source) {
  const courses = source.records.course || [];
  const bookings = source.records.booking || [];
  const deliveryBookings = source.records.deliveryBooking || [];
  const performanceOrders = Object.hasOwn(source.records || {}, "courseOrders")
    ? source.records.courseOrders
    : (source.records.performance || []);
  const bookingsByCourse = groupBy(bookings, (booking) => relationId(field(booking, "text_5")) || asText(field(booking, "text_5")) || relationId(field(booking, "text_2")));
  const deliveryBookingsByCourse = groupBy(deliveryBookings, (booking) => relationId(field(booking, "text_2")));
  const ordersByCourse = groupBy(performanceOrders, (order) => relationId(field(order, "text_28")));
  return courses.map((course) => {
    const linkedBookings = unique([
      ...(bookingsByCourse.get(entityId(course)) || []),
      ...(bookingsByCourse.get(asText(course.serialNo)) || [])
    ]);
    const linkedDeliveryBookings = deliveryBookingsByCourse.get(entityId(course)) || [];
    const linkedOrders = ordersByCourse.get(entityId(course)) || [];
    const bookedCustomers = linkedBookings.length;
    const roles = positionBreakdown(linkedBookings);
    const dealOrders = linkedOrders.length;
    const organizer = recordCompany(course, "text_5");
    const inferredCompany = mostFrequent(linkedDeliveryBookings.map(bookingCompany));
    const primaryCompany = organizer !== "未标公司" ? organizer : inferredCompany;
    const dealAmount = sum(linkedOrders, (order) => field(order, "num_1"));
    const firmNames = unique(linkedBookings.map((booking) => asText(field(booking, "text_36"))));
    return {
      entityId: entityId(course),
      evidenceRef: course.evidenceRef,
      evidenceRefs: unique([course.evidenceRef, ...evidenceRefs(linkedBookings), ...evidenceRefs(linkedDeliveryBookings), ...evidenceRefs(linkedOrders)]),
      name: asText(field(course, "text_1")) || "未命名课程",
      type: asText(field(course, "text_10")) || "未分类课程",
      status: asText(field(course, "text_7")) || "未标状态",
      date: localDate(field(course, "date_1")),
      timestamp: safeNumber(field(course, "date_1")),
      primaryCompany,
      primaryCompanyBasis: organizer !== "未标公司"
        ? "课程表举办方 text_5"
        : "课程举办方缺失，回退为同一课程邀约记录中订单所属公司的众数",
      bookedCustomers,
      firms: firmNames.length,
      bosses: linkedBookings.filter((booking) => asText(field(booking, "text_22")) === "老板").length,
      students: linkedBookings.length,
      positionBreakdown: roles,
      dealOrders,
      dealAmount,
      paidAmount: safeNumber(field(course, "num_10")),
      conversionRate: percentage(dealOrders, bookedCustomers),
      conversionBasis: "关联业绩订单数 ÷ 学员约课明细数",
      linkedBookings,
      linkedDeliveryBookings,
      linkedOrders
    };
  });
}

function collectCompanyCandidates(source, courseFacts) {
  const counts = new Map();
  const add = (name, domain) => {
    const value = asText(name) || "未标公司";
    const row = counts.get(value) || { name: value, recordCount: 0, domains: new Set() };
    row.recordCount += 1;
    row.domains.add(domain);
    counts.set(value, row);
  };
  for (const row of source.records.performance || []) add(recordCompany(row, "text_63", "text_3"), "performance");
  for (const row of source.records.oppOrder || []) add(recordCompany(row, "text_31", "text_6"), "product-sales");
  for (const row of source.records.booking || []) add(bookingCompany(row), "courses");
  for (const row of source.records.deliveryBooking || []) add(bookingCompany(row), "delivery");
  for (const row of courseFacts) add(row.primaryCompany, "courses");
  for (const row of source.records.opportunity || []) add(field(row, "text_11"), "opportunities");
  for (const user of source.records.user || []) {
    const company = userCompany(user);
    if (/公司|集团|区域/.test(company)) add(company, "users");
  }
  return Array.from(counts.values()).map((row) => ({ name: row.name, recordCount: row.recordCount, domains: Array.from(row.domains).sort() }))
    .sort((a, b) => b.recordCount - a.recordCount || a.name.localeCompare(b.name, "zh-CN"));
}

function collectPersonCandidates(source) {
  const opportunities = source.records.opportunity || [];
  return (source.records.user || []).map((user) => {
    const created = opportunities.filter((row) => relationId(field(row, "creatorId")) === asText(user.userId));
    return {
      id: asText(user.userId),
      name: asText(user.name) || "未命名员工",
      company: mostFrequent(created.map((row) => asText(field(row, "text_11"))), userCompany(user)),
      createdCount: created.length,
      expectedAmount: sum(created, (row) => field(row, "num_1"))
    };
  }).sort((a, b) => b.createdCount - a.createdCount || b.expectedAmount - a.expectedAmount || a.name.localeCompare(b.name, "zh-CN"));
}

function resolveEntity(input, candidates, type) {
  if (!asText(input)) return { status: "not_requested", input: "", resolved: null, candidates: [] };
  const requested = normalizeName(input);
  let matches = candidates.filter((candidate) => normalizeName(candidate.name) === requested || normalizeName(candidate.id) === requested);
  if (!matches.length) {
    matches = candidates.filter((candidate) => {
      const name = normalizeName(candidate.name);
      return name.includes(requested) || requested.includes(name);
    });
  }
  if (matches.length === 1) return { status: "resolved", input: asText(input), resolved: matches[0], candidates: matches };
  if (matches.length > 1) return { status: "needs_disambiguation", input: asText(input), resolved: null, candidates: matches.slice(0, 12) };
  return { status: "not_found", input: asText(input), resolved: null, candidates: candidates.slice(0, 12), entityType: type };
}

function buildPerformance(source, products, company) {
  const normalized = performanceLineRows(source, products);
  const selected = company ? normalized.filter((row) => row.company === company) : normalized;
  const sourceOrders = (source.records.performance || []).filter((record) => recordInSourceRange(source, record, "date_1"));
  const scopedOrders = company
    ? sourceOrders.filter((record) => recordCompany(record, "text_63", "text_3") === company)
    : sourceOrders;
  const ordersWithProductLines = scopedOrders.filter((record) => subtableItems(record).length > 0).length;
  const ranking = Array.from(groupBy(selected, (row) => row.company).entries()).map(([name, rows]) => {
    const total = sum(rows, (row) => row.amount);
    const course = sum(rows.filter((row) => row.product.businessType === "课程"), (row) => row.amount);
    const consulting = sum(rows.filter((row) => row.product.businessType === "咨询"), (row) => row.amount);
    const other = total - course - consulting;
    return {
      company: name,
      total,
      course,
      consulting,
      other,
      courseShare: percentage(course, total),
      consultingShare: percentage(consulting, total),
      otherShare: percentage(other, total),
      evidenceRefs: evidenceRefs(rows.map((row) => row.record))
    };
  }).filter((row) => row.total !== 0).sort((a, b) => b.total - a.total || a.company.localeCompare(b.company, "zh-CN"));
  const total = sum(ranking, (row) => row.total);
  const course = sum(ranking, (row) => row.course);
  const consulting = sum(ranking, (row) => row.consulting);
  const other = total - course - consulting;
  return {
    definitions: {
      amount: "仅汇总业绩订单 5614255 产品明细 array_4.num_5（售价小计），按签订日期 date_1 归月；没有产品明细的订单不使用合同金额替代",
      company: "业绩订单所属公司 text_63",
      mix: "只使用产品明细分类 array_4.text_10 区分课程、咨询和其他；分类缺失或无法归类时计入其他，不使用产品名称猜测"
    },
    summary: {
      total,
      companyCount: ranking.length,
      sourceOrderCount: scopedOrders.length,
      ordersWithProductLines,
      ordersWithoutProductLines: scopedOrders.length - ordersWithProductLines,
      course,
      consulting,
      other,
      courseShare: percentage(course, total),
      consultingShare: percentage(consulting, total),
      otherShare: percentage(other, total)
    },
    ranking,
    dailyTrend: dayTrend(selected, (row) => row.date, {
      total: (row) => row.amount,
      course: (row) => row.product.businessType === "课程" ? row.amount : 0,
      consulting: (row) => row.product.businessType === "咨询" ? row.amount : 0,
      other: (row) => row.product.businessType === "其他" ? row.amount : 0
    })
  };
}

function buildProductSales(source, products, company) {
  const rows = [];
  for (const row of oppOrderLineRows(source, products)) rows.push({ ...row, source: "oppOrder" });
  for (const row of performanceLineRows(source, products)) rows.push({ ...row, source: "performance", revenue: row.amount });
  const selected = company ? rows.filter((row) => row.company === company) : rows;
  const ranking = Array.from(groupBy(selected, (row) => row.company).entries()).map(([name, companyRows]) => {
    const oppRows = companyRows.filter((row) => row.source === "oppOrder");
    const performanceRows = companyRows.filter((row) => row.source === "performance");
    const unclassifiedOppRows = oppRows.filter((row) => row.product.name === "未命名产品");
    const unclassifiedPerformanceRows = performanceRows.filter((row) => !row.product.isCommercial && !row.product.isOpen);
    return {
      company: name,
      oppOrderQuantity: sum(oppRows, (row) => row.quantity),
      oppOrderRevenue: sum(oppRows, (row) => row.revenue),
      ticketCount: sum(oppRows.filter((row) => row.product.isTicket), (row) => row.quantity),
      commercialCount: sum(performanceRows.filter((row) => row.product.isCommercial), (row) => row.quantity),
      commercialInitialCount: sum(performanceRows.filter((row) => row.product.isCommercialInitial), (row) => row.quantity),
      commercialRetrainingCount: sum(performanceRows.filter((row) => row.product.isCommercialRetraining), (row) => row.quantity),
      openOppQuantity: sum(oppRows.filter((row) => row.product.isOpen), (row) => row.quantity),
      openOppRevenue: sum(oppRows.filter((row) => row.product.isOpen), (row) => row.revenue),
      openPerformanceQuantity: sum(performanceRows.filter((row) => row.product.isOpen), (row) => row.quantity),
      openPerformanceRevenue: sum(performanceRows.filter((row) => row.product.isOpen), (row) => row.revenue),
      unclassifiedOppQuantity: sum(unclassifiedOppRows, (row) => row.quantity),
      unclassifiedOppRevenue: sum(unclassifiedOppRows, (row) => row.revenue),
      unclassifiedPerformanceQuantity: sum(unclassifiedPerformanceRows, (row) => row.quantity),
      unclassifiedPerformanceRevenue: sum(unclassifiedPerformanceRows, (row) => row.revenue),
      evidenceRefs: evidenceRefs(companyRows.map((row) => row.record))
    };
  }).filter((row) => Object.entries(row).some(([key, value]) => key !== "company" && key !== "evidenceRefs" && safeNumber(value) !== 0))
    .sort((a, b) => (b.ticketCount + b.commercialCount) - (a.ticketCount + a.commercialCount) || b.openOppRevenue - a.openOppRevenue || a.company.localeCompare(b.company, "zh-CN"));
  const productRows = Array.from(groupBy(selected.filter((row) => row.product.isOpen || row.product.isTicket || row.product.isCommercial), (row) => `${row.source}\u0000${row.product.name}`).entries()).map(([key, productSales]) => {
    const [sourceName, name] = key.split("\u0000");
    return {
      source: sourceName,
      product: name,
      category: productSales[0].product.category,
      frontBack: productSales[0].product.frontBack,
      isTicket: productSales[0].product.isTicket,
      isCommercial: productSales[0].product.isCommercial,
      isOpen: productSales[0].product.isOpen,
      quantity: sum(productSales, (row) => row.quantity),
      revenue: sum(productSales, (row) => row.revenue),
      evidenceRefs: evidenceRefs(productSales.map((row) => row.record))
    };
  }).sort((a, b) => b.quantity - a.quantity || b.revenue - a.revenue || a.product.localeCompare(b.product, "zh-CN"));
  const ticketRanking = ranking.filter((row) => row.ticketCount !== 0)
    .sort((a, b) => b.ticketCount - a.ticketCount || a.company.localeCompare(b.company, "zh-CN"))
    .map((row, index) => ({ rank: index + 1, company: row.company, ticketCount: row.ticketCount }));
  const commercialRanking = ranking.filter((row) => row.commercialCount !== 0)
    .sort((a, b) => b.commercialCount - a.commercialCount || b.commercialInitialCount - a.commercialInitialCount || a.company.localeCompare(b.company, "zh-CN"))
    .map((row, index) => ({
      rank: index + 1,
      company: row.company,
      commercialCount: row.commercialCount,
      commercialInitialCount: row.commercialInitialCount,
      commercialRetrainingCount: row.commercialRetrainingCount
    }));
  const mixRows = Array.from(groupBy(
    selected.filter((row) => row.product.isOpen || row.product.isTicket || row.product.isCommercial),
    (row) => `${row.company}\u0000${row.source}\u0000${row.product.name}`
  ).entries()).map(([key, productSales]) => {
    const [companyName, sourceName, name] = key.split("\u0000");
    return {
      company: companyName,
      source: sourceName,
      product: name,
      quantity: sum(productSales, (row) => row.quantity),
      revenue: sum(productSales, (row) => row.revenue)
    };
  });
  const mixTotals = new Map();
  for (const row of mixRows) {
    const key = `${row.company}\u0000${row.source}`;
    const totalRow = mixTotals.get(key) || { quantity: 0, revenue: 0 };
    totalRow.quantity += row.quantity;
    totalRow.revenue += row.revenue;
    mixTotals.set(key, totalRow);
  }
  const companyProductMix = mixRows.map((row) => {
    const totalRow = mixTotals.get(`${row.company}\u0000${row.source}`);
    return {
      ...row,
      quantityShare: percentage(row.quantity, totalRow.quantity),
      revenueShare: percentage(row.revenue, totalRow.revenue)
    };
  }).sort((a, b) => a.company.localeCompare(b.company, "zh-CN") || a.source.localeCompare(b.source) || b.quantity - a.quantity || b.revenue - a.revenue || a.product.localeCompare(b.product, "zh-CN"));
  const sourceOppOrders = (source.records.oppOrder || []).filter((record) => recordInSourceRange(source, record, "date_1"));
  const scopedOppOrders = company
    ? sourceOppOrders.filter((record) => recordCompany(record, "text_31", "text_6") === company)
    : sourceOppOrders;
  const oppOrdersWithProductLines = scopedOppOrders.filter((record) => subtableItems(record).length > 0).length;
  const oppOrdersWithValidatedFlatProduct = selected
    .filter((row) => row.source === "oppOrder" && row.sourceShape === "validated-flat-record")
    .length;
  return {
    definitions: {
      ticket: "按需求清单，将 OPP 订单 6707824 的销售数量作为成交门票数量；具体门票/开源产品名称在 products 与 companyProductMix 中拆分",
      commercial: "仅统计业绩订单产品明细中名称明确包含商业操盘的销量；商业操盘与商业操盘复训分别汇总",
      openProduct: "OPP 订单表内的产品按开源产品统计并按产品名称拆分；业绩订单仍只在产品主数据或名称明确支持时计入开源产品",
      nameFallback: "产品主数据没有返回记录时，只用业务记录中明确出现的门票、商业操盘、OPP/开源等产品名关键词；未命中仍为未分类",
      oppOrderShape: "优先使用需求清单中的产品子表 array_4；仅当实时字段目录同时确认 text_3=产品名称、num_1=产品销量/销售数量、text_6=所属公司时，兼容当前生产表的一产品一记录扁平结构",
      crossForm: "OPP 订单与业绩回款缺少统一订单主键，分别呈现，不相加冒充去重成交额"
    },
    summary: {
      companyCount: ranking.length,
      oppOrderQuantity: sum(ranking, (row) => row.oppOrderQuantity),
      oppOrderRevenue: sum(ranking, (row) => row.oppOrderRevenue),
      ticketCount: sum(ranking, (row) => row.ticketCount),
      commercialCount: sum(ranking, (row) => row.commercialCount),
      commercialInitialCount: sum(ranking, (row) => row.commercialInitialCount),
      commercialRetrainingCount: sum(ranking, (row) => row.commercialRetrainingCount),
      openOppQuantity: sum(ranking, (row) => row.openOppQuantity),
      openOppRevenue: sum(ranking, (row) => row.openOppRevenue),
      openPerformanceQuantity: sum(ranking, (row) => row.openPerformanceQuantity),
      openPerformanceRevenue: sum(ranking, (row) => row.openPerformanceRevenue),
      unclassifiedOppQuantity: sum(ranking, (row) => row.unclassifiedOppQuantity),
      unclassifiedOppRevenue: sum(ranking, (row) => row.unclassifiedOppRevenue),
      unclassifiedPerformanceQuantity: sum(ranking, (row) => row.unclassifiedPerformanceQuantity),
      unclassifiedPerformanceRevenue: sum(ranking, (row) => row.unclassifiedPerformanceRevenue),
      sourceOppOrderCount: scopedOppOrders.length,
      oppOrdersWithProductLines,
      oppOrdersWithValidatedFlatProduct,
      oppOrdersWithoutSupportedProductShape: scopedOppOrders.length - oppOrdersWithProductLines - oppOrdersWithValidatedFlatProduct,
      oppOrdersWithoutProductLines: scopedOppOrders.length - oppOrdersWithProductLines
    },
    ranking,
    ticketRanking,
    commercialRanking,
    companyProductMix,
    products: productRows,
    dailyTrend: dayTrend(selected, (row) => row.date, {
      ticketCount: (row) => row.source === "oppOrder" && row.product.isTicket ? row.quantity : 0,
      commercialCount: (row) => row.source === "performance" && row.product.isCommercial ? row.quantity : 0,
      openOppRevenue: (row) => row.source === "oppOrder" && row.product.isOpen ? row.revenue : 0,
      openPerformanceRevenue: (row) => row.source === "performance" && row.product.isOpen ? row.revenue : 0
    })
  };
}

function buildCourses(courseFacts, company) {
  const selected = company ? courseFacts.filter((row) => row.primaryCompany === company) : courseFacts;
  const courses = selected.map((row) => ({
    evidenceRef: row.evidenceRef,
    evidenceRefs: row.evidenceRefs,
    name: row.name,
    type: row.type,
    status: row.status,
    date: row.date,
    primaryCompany: row.primaryCompany,
    primaryCompanyBasis: row.primaryCompanyBasis,
    bookedCustomers: row.bookedCustomers,
    firms: row.firms,
    bosses: row.bosses,
    students: row.students,
    positionBreakdown: row.positionBreakdown,
    dealOrders: row.dealOrders,
    dealAmount: row.dealAmount,
    paidAmount: row.paidAmount,
    conversionRate: row.conversionRate,
    conversionBasis: row.conversionBasis
  })).sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name, "zh-CN"));
  const companies = Array.from(groupBy(selected, (row) => row.primaryCompany).entries()).map(([name, rows]) => ({
    company: name,
    courseCount: rows.length,
    bookedCustomers: sum(rows, (row) => row.bookedCustomers),
    bosses: sum(rows, (row) => row.bosses),
    firms: sum(rows, (row) => row.firms),
    dealOrders: sum(rows, (row) => row.dealOrders),
    dealAmount: sum(rows, (row) => row.dealAmount),
    conversionRate: percentage(sum(rows, (row) => row.dealOrders), sum(rows, (row) => row.bookedCustomers)),
    positionBreakdown: mergePositionBreakdowns(rows),
    evidenceRefs: unique(rows.flatMap((row) => row.evidenceRefs))
  })).sort((a, b) => b.courseCount - a.courseCount || b.dealAmount - a.dealAmount || a.company.localeCompare(b.company, "zh-CN"));
  const bookedCustomers = sum(courses, (row) => row.bookedCustomers);
  const dealOrders = sum(courses, (row) => row.dealOrders);
  return {
    definitions: {
      courseCount: "课程开始日期落在所选月份的课程记录数",
      company: "优先按课程表举办方 text_5 归属；举办方缺失时才回退为同课邀约订单所属公司的众数",
      conversionRate: "关联业绩订单数 ÷ 学员约课明细数；缺少任一可靠关联时保持为 0 并说明数据边界，不使用课程表旧汇总字段补算",
      bosses: "学员约课明细 7642173 中职位 text_22 严格等于老板的记录数",
      positionBreakdown: "按学员约课明细职位 text_22 的已解码名称计数并计算占比；空值单列未填写",
      firms: "约课记录存在客户公司字段时去重；该字段缺失时不推测企业数",
      dealAmount: "业绩订单 5614255 中对应课程 text_28 关联当前课程后汇总合同金额 num_1；按课程关系取数，不限制订单必须在课程当月签订"
    },
    summary: {
      selectedCompany: company || null,
      courseCount: courses.length,
      bookedCustomers,
      firms: sum(courses, (row) => row.firms),
      bosses: sum(courses, (row) => row.bosses),
      students: sum(courses, (row) => row.students),
      dealOrders,
      dealAmount: sum(courses, (row) => row.dealAmount),
      paidAmount: sum(courses, (row) => row.paidAmount),
      conversionRate: percentage(dealOrders, bookedCustomers)
    },
    companies,
    positionBreakdown: mergePositionBreakdowns(selected),
    courses,
    dailyTrend: dayTrend(courses, (row) => row.date, {
      courseCount: () => 1,
      bookedCustomers: (row) => row.bookedCustomers,
      bosses: (row) => row.bosses,
      dealOrders: (row) => row.dealOrders,
      dealAmount: (row) => row.dealAmount
    })
  };
}

function buildDelivery(courseFacts, company) {
  const deliveryCourses = courseFacts.filter((course) => course.type.includes("交付课程"));
  const companyMap = new Map();
  const courseRows = [];
  const ensureBucket = (map, key) => {
    if (!map.has(key)) {
      map.set(key, {
        company: key,
        invitations: 0,
        bosses: 0,
        students: 0,
        courses: new Set(),
        seenOrders: new Set(),
        attributedPaidAmount: 0,
        unlinkedPaidRecordCount: 0,
        evidenceRefs: []
      });
    }
    return map.get(key);
  };
  const serializeCompany = (row, includeCourseCount = false) => ({
    company: row.company,
    invitations: row.invitations,
    bosses: row.bosses,
    students: row.students,
    ...(includeCourseCount ? { courseCount: row.courses.size } : {}),
    attributedPaidAmount: row.attributedPaidAmount,
    unlinkedPaidRecordCount: row.unlinkedPaidRecordCount,
    evidenceRefs: unique(row.evidenceRefs)
  });
  for (const course of deliveryCourses) {
    const perCourse = new Map();
    const deliveryBookings = course.linkedDeliveryBookings;
    for (const booking of deliveryBookings) {
      const bookingOwner = bookingCompany(booking);
      const amount = safeNumber(field(booking, "num_3"));
      const orderId = relationId(field(booking, "text_8")) || relationId(field(booking, "text_9"));
      for (const bucket of [ensureBucket(companyMap, bookingOwner), ensureBucket(perCourse, bookingOwner)]) {
        bucket.invitations += 1;
        bucket.bosses += safeNumber(field(booking, "num_1"));
        bucket.students += safeNumber(field(booking, "num_2"));
        bucket.courses.add(course.entityId);
        bucket.evidenceRefs.push(booking.evidenceRef);
        if (orderId && !bucket.seenOrders.has(orderId)) {
          bucket.attributedPaidAmount += amount;
          bucket.seenOrders.add(orderId);
        } else if (!orderId && amount !== 0) {
          bucket.unlinkedPaidRecordCount += 1;
        }
      }
    }
    const allCompanies = Array.from(perCourse.values()).map((row) => serializeCompany(row))
      .sort((a, b) => b.invitations - a.invitations || b.attributedPaidAmount - a.attributedPaidAmount || a.company.localeCompare(b.company, "zh-CN"));
    const scopedCompanies = company ? allCompanies.filter((row) => row.company === company) : allCompanies;
    if (company && !scopedCompanies.length) continue;
    const courseRow = {
      evidenceRef: course.evidenceRef,
      name: course.name,
      date: course.date,
      invitations: sum(scopedCompanies, (row) => row.invitations),
      bosses: sum(scopedCompanies, (row) => row.bosses),
      students: sum(scopedCompanies, (row) => row.students),
      attributedPaidAmount: sum(scopedCompanies, (row) => row.attributedPaidAmount),
      unlinkedPaidRecordCount: sum(scopedCompanies, (row) => row.unlinkedPaidRecordCount),
      amountScope: company ? "selected-company-attribution" : "group-course-total",
      companies: scopedCompanies
    };
    if (!company) {
      courseRow.dealOrders = course.dealOrders;
      courseRow.courseDealAmount = course.dealAmount;
      courseRow.coursePaidAmount = course.paidAmount;
    }
    courseRows.push(courseRow);
  }
  let companies = Array.from(companyMap.values()).map((row) => serializeCompany(row, true))
    .sort((a, b) => b.invitations - a.invitations || b.attributedPaidAmount - a.attributedPaidAmount || a.company.localeCompare(b.company, "zh-CN"));
  if (company) companies = companies.filter((row) => row.company === company);
  const selectedCourses = courseRows.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name, "zh-CN"));
  return {
    definitions: {
      deliveryCourse: "课程类型包含交付课程且课程开始日期落在所选月份",
      invitation: "仅统计交付邀约关联表 7452855 中通过课程字段 text_2 关联当月交付课程的记录，不回退普通学员约课表",
      company: "按约课记录关联订单所属公司归集",
      attributedPaidAmount: "同一公司内仅对存在关联订单 ID 的记录去重汇总 num_3；不是财务分润或正式业绩分配",
      courseTotals: "dealOrders、courseDealAmount、coursePaidAmount 是全集团课程总量，仅在未指定公司时输出；指定公司时只输出该公司的 attributedPaidAmount，不能把课程总额解释成该公司金额",
      unlinkedPaidRecordCount: "num_3 非零但没有可用于去重归属的关联订单 ID 的专用交付记录数；金额不计入 attributedPaidAmount"
    },
    summary: {
      selectedCompany: company || null,
      deliveryCourseCount: selectedCourses.length,
      companyCount: companies.length,
      invitations: sum(companies, (row) => row.invitations),
      bosses: sum(companies, (row) => row.bosses),
      students: sum(companies, (row) => row.students),
      attributedPaidAmount: sum(companies, (row) => row.attributedPaidAmount),
      unlinkedPaidRecordCount: sum(companies, (row) => row.unlinkedPaidRecordCount)
    },
    companies,
    courses: selectedCourses,
    dailyTrend: dayTrend(selectedCourses, (row) => row.date, {
      courseCount: () => 1,
      invitations: (row) => row.invitations,
      bosses: (row) => row.bosses,
      students: (row) => row.students,
      attributedPaidAmount: (row) => row.attributedPaidAmount,
      unlinkedPaidRecordCount: (row) => row.unlinkedPaidRecordCount
    })
  };
}

function latestTimestamp(rows) {
  return rows.reduce((latest, row) => Math.max(latest, safeNumber(field(row, "date_1"))), 0);
}

function opportunityFact(opportunity, follows, users, asOf) {
  const creatorId = relationId(field(opportunity, "creatorId"));
  const user = users.get(creatorId);
  const stage = asText(field(opportunity, "text_17")) || "未标阶段";
  const willingness = asText(field(opportunity, "text_12")) || "未标意愿";
  const latestFollow = latestTimestamp(follows);
  const baseline = latestFollow || safeNumber(opportunity.addTime);
  const staleDays = baseline ? Math.max(0, Math.floor((asOf - baseline) / 86400)) : null;
  const contents = follows.map((follow) => asText(field(follow, "text_6"))).filter(Boolean);
  const meaningfulFollowCount = contents.filter((content) => content.replace(/\s/g, "").length >= 20).length;
  const hasNextAction = contents.some((content) => NEXT_ACTION_RE.test(content));
  const hasDecisionSignal = contents.some((content) => DECISION_RE.test(content));
  const expectedAmount = safeNumber(field(opportunity, "num_1"));
  const wonAmountRaw = field(opportunity, "num_14");
  const wonAmountKnown = hasValue(wonAmountRaw) && Number.isFinite(Number(wonAmountRaw));
  const active = ACTIVE_STAGES.has(stage);
  const effectiveSignal = /(中|高)/.test(willingness) || meaningfulFollowCount > 0;
  const forgottenCandidate = active && expectedAmount > 0 && effectiveSignal && staleDays !== null && staleDays >= 14;
  const latestCustomerName = follows.slice().sort((a, b) => safeNumber(field(b, "date_1")) - safeNumber(field(a, "date_1")));
  return {
    evidenceRef: opportunity.evidenceRef,
    evidenceRefs: unique([opportunity.evidenceRef, ...evidenceRefs(follows)]),
    entityId: entityId(opportunity),
    creator: {
      id: creatorId,
      name: asText(user && user.name) || "创建人未标记",
      company: recordCompany(opportunity, "text_11") !== "未标公司" ? recordCompany(opportunity, "text_11") : userCompany(user)
    },
    ownerIds: relationIds(field(opportunity, "ownerId")),
    customerId: relationId(field(opportunity, "text_3")),
    customerName: asText(field(latestCustomerName[0], "text_10")) || "客户名称未标",
    name: asText(field(opportunity, "text_1")) || "未命名商机",
    createdDate: localDate(opportunity.addTime),
    stage,
    willingness,
    expectedAmount,
    wonAmount: wonAmountKnown ? Number(wonAmountRaw) : 0,
    wonAmountKnown,
    industry: asText(field(opportunity, "text_2")) || "未标行业",
    nature: asText(field(opportunity, "text_24")) || "未标性质",
    scale: asText(field(opportunity, "text_20")) || "未标规模",
    source: asText(field(opportunity, "text_23")) || "未标来源",
    relatedProducts: asText(field(opportunity, "array_1")),
    signals: {
      active,
      followCount: follows.length,
      meaningfulFollowCount,
      latestFollowDate: localDate(latestFollow),
      staleDays,
      hasNextAction,
      hasDecisionSignal,
      effectiveSignal,
      forgottenCandidate
    },
    followEvidence: follows.slice().sort((a, b) => safeNumber(field(b, "date_1")) - safeNumber(field(a, "date_1"))).slice(0, 3).map((follow) => ({
      evidenceRef: follow.evidenceRef,
      date: localDate(field(follow, "date_1")),
      excerpt: asText(field(follow, "text_6")).replace(/\s+/g, " ").slice(0, 240)
    }))
  };
}

function buildOpportunities(source, company, person) {
  const opportunities = source.records.opportunity || [];
  const follows = source.records.follow || [];
  const users = userMap(source);
  const directFollows = groupBy(follows.filter((follow) => relationId(field(follow, "text_5"))), (follow) => relationId(field(follow, "text_5")));
  const current = Math.floor(Date.now() / 1000);
  const rangeStart = safeNumber(source.range && source.range.start);
  const rangeEnd = safeNumber(source.range && source.range.end);
  const asOf = Math.min(Math.max(current, rangeStart), rangeEnd);
  let rows = opportunities.map((opportunity) => {
    const related = directFollows.get(entityId(opportunity)) || [];
    return opportunityFact(opportunity, related, users, asOf);
  });
  if (person) rows = rows.filter((row) => row.creator.id === person.id);
  if (company) rows = rows.filter((row) => row.creator.company === company);
  const stages = Array.from(groupBy(rows, (row) => row.stage).entries()).map(([stage, stageRows]) => ({
    stage,
    count: stageRows.length,
    expectedAmount: sum(stageRows, (row) => row.expectedAmount),
    wonAmount: sum(stageRows, (row) => row.wonAmount),
    evidenceRefs: unique(stageRows.flatMap((row) => row.evidenceRefs))
  })).sort((a, b) => {
    const ai = STAGE_ORDER.indexOf(a.stage);
    const bi = STAGE_ORDER.indexOf(b.stage);
    return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi) || b.count - a.count;
  });
  const people = Array.from(groupBy(rows, (row) => row.creator.id || "unknown").values()).map((personRows) => ({
    person: personRows[0].creator,
    createdCount: personRows.length,
    expectedAmount: sum(personRows, (row) => row.expectedAmount),
    wins: personRows.filter((row) => row.stage === "赢单").length,
    wonAmount: sum(personRows.filter((row) => row.stage === "赢单"), (row) => row.wonAmount),
    winsWithoutWonAmount: personRows.filter((row) => row.stage === "赢单" && !row.wonAmountKnown).length,
    active: personRows.filter((row) => row.signals.active).length,
    forgottenCandidates: personRows.filter((row) => row.signals.forgottenCandidate).length,
    evidenceRefs: unique(personRows.flatMap((row) => row.evidenceRefs))
  })).sort((a, b) => b.expectedAmount - a.expectedAmount || b.createdCount - a.createdCount || a.person.name.localeCompare(b.person.name, "zh-CN"));
  const forgotten = rows.filter((row) => row.signals.forgottenCandidate).sort((a, b) => b.expectedAmount - a.expectedAmount || (b.signals.staleDays || 0) - (a.signals.staleDays || 0));
  return {
    definitions: {
      created: "商机 addTime 落在所选月份，并按 creatorId 归属创建人",
      expectedAmount: "商机预计金额 num_1",
      won: "商机阶段 text_17 为赢单",
      wonAmount: "赢单金额只汇总商机 num_14；字段缺失时不使用预计成交金额替代",
      followLink: "跟进业务目标类型为 301（销售机会）；先取得商机，再按 text_5 的实际商机 ID 与 date_1 查询跟进并直连，不按客户回退",
      forgottenCandidate: "活动阶段、预计金额大于 0、有中高意愿或有效跟进证据，并且至少 14 天未跟进",
      qualityBoundary: "只提供可解释信号，不计算加权质量分或预测成交概率"
    },
    summary: {
      selectedCompany: company || null,
      selectedPerson: person || null,
      createdCount: rows.length,
      expectedAmount: sum(rows, (row) => row.expectedAmount),
      wins: rows.filter((row) => row.stage === "赢单").length,
      wonAmount: sum(rows.filter((row) => row.stage === "赢单"), (row) => row.wonAmount),
      winsWithoutWonAmount: rows.filter((row) => row.stage === "赢单" && !row.wonAmountKnown).length,
      lost: rows.filter((row) => row.stage === "输单").length,
      active: rows.filter((row) => row.signals.active).length,
      followCount: sum(rows, (row) => row.signals.followCount),
      withNextAction: rows.filter((row) => row.signals.hasNextAction).length,
      withDecisionSignal: rows.filter((row) => row.signals.hasDecisionSignal).length,
      staleAtLeast14Days: rows.filter((row) => row.signals.active && row.signals.staleDays !== null && row.signals.staleDays >= 14).length,
      forgottenCandidates: forgotten.length
    },
    stages,
    people,
    reactivationCandidates: forgotten,
    opportunities: rows.sort((a, b) => b.expectedAmount - a.expectedAmount || (b.signals.staleDays || 0) - (a.signals.staleDays || 0)),
    dailyTrend: dayTrend(rows, (row) => row.createdDate, {
      createdCount: () => 1,
      expectedAmount: (row) => row.expectedAmount,
      wins: (row) => row.stage === "赢单" ? 1 : 0
    })
  };
}

function validateSource(source) {
  if (!source || source.mode !== "live-readonly-source") throw new Error("来源包不是实时只读销帮帮来源");
  if (!source.privacy || source.privacy.telephoneFieldsExported !== false || source.privacy.credentialFieldsExported !== false) {
    throw new Error("来源包隐私边界不完整");
  }
  if (!source.records || !source.integrity || !source.integrity.recordsSha256) throw new Error("来源包缺少记录或完整性信息");
  const actual = crypto.createHash("sha256").update(JSON.stringify(source.records), "utf8").digest("hex");
  if (actual !== source.integrity.recordsSha256) throw new Error("来源包记录哈希校验失败");
}

function normalizeDomains(value) {
  const requested = Array.isArray(value) ? value : asText(value).split(",");
  const domains = unique(requested.map((item) => asText(item)).filter(Boolean));
  if (!domains.length || domains.includes("all")) return Array.from(ALLOWED_DOMAINS);
  for (const domain of domains) if (!ALLOWED_DOMAINS.has(domain)) throw new Error(`不支持的数据域：${domain}`);
  return domains;
}

function buildFactPack(source, options = {}) {
  validateSource(source);
  const domains = normalizeDomains(options.domains || "all");
  const products = productMap(source);
  const courseFacts = buildCourseFacts(source);
  const companyCandidates = collectCompanyCandidates(source, courseFacts);
  const personCandidates = collectPersonCandidates(source);
  const companyResolution = resolveEntity(options.company, companyCandidates, "company");
  const personResolution = resolveEntity(options.person, personCandidates, "person");
  const needsChoice = [companyResolution, personResolution].some((item) => item.status === "needs_disambiguation" || item.status === "not_found");
  const pack = {
    schemaVersion: "1.1",
    skill: "xbb-executive-analyst",
    mode: "xbb-live-readonly-fact-pack",
    status: needsChoice ? "needs_disambiguation" : "ready",
    scope: {
      month: source.month,
      range: clone(source.range),
      refreshedAt: source.refreshedAt,
      domains,
      company: companyResolution.resolved ? companyResolution.resolved.name : null,
      person: personResolution.resolved ? clone(personResolution.resolved) : null,
      currentMonthPartial: source.month === new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit" }).format(new Date()).slice(0, 7)
    },
    entityResolution: {
      company: companyResolution,
      person: personResolution
    },
    provenance: {
      live: true,
      readOnly: true,
      dataSource: source.provenance.dataSource,
      sourceMode: source.mode,
      sourceRefreshedAt: source.refreshedAt,
      sourceRecordsSha256: source.integrity.recordsSha256,
      formIds: clone(source.provenance.formIds),
      recordCounts: clone(source.provenance.recordCounts),
      telephoneFieldsExported: false,
      credentialFieldsExported: false
    },
    facts: {},
    limitations: [
      "结论仅覆盖所选月份及来源包刷新时点前的只读销帮帮记录。",
      "没有来源字段或关联主键支持的业务判断必须标记为无法确认，不能用模型推测补齐。"
    ]
  };
  if (!needsChoice) {
    const company = companyResolution.resolved ? companyResolution.resolved.name : null;
    const person = personResolution.resolved;
    if (domains.includes("performance")) pack.facts.performance = buildPerformance(source, products, company);
    if (domains.includes("product-sales")) pack.facts.productSales = buildProductSales(source, products, company);
    if (domains.includes("courses")) pack.facts.courses = buildCourses(courseFacts, company);
    if (domains.includes("delivery")) pack.facts.delivery = buildDelivery(courseFacts, company);
    if (domains.includes("opportunities")) pack.facts.opportunities = buildOpportunities(source, company, person);
  }
  const canonical = JSON.stringify({ scope: pack.scope, entityResolution: pack.entityResolution, provenance: pack.provenance, facts: pack.facts, limitations: pack.limitations });
  pack.integrity = { algorithm: "sha256", factPackSha256: crypto.createHash("sha256").update(canonical, "utf8").digest("hex") };
  assertNoSensitiveFactValues(pack);
  return pack;
}

function parseArguments(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--request-stdin") {
      if (parsed["request-stdin"] === true) throw new Error("--request-stdin 不能重复提供");
      parsed["request-stdin"] = true;
    } else if (["--source", "--output", "--domains", "--company", "--person", "--isolation-token"].includes(key)) {
      if (index + 1 >= argv.length || String(argv[index + 1]).startsWith("--")) throw new Error(`参数缺少值：${key}`);
      if (Object.hasOwn(parsed, key.slice(2))) throw new Error(`参数不能重复：${key}`);
      parsed[key.slice(2)] = argv[index + 1];
      index += 1;
    } else {
      throw new Error(`不支持的参数：${key}`);
    }
  }
  if (!parsed.source || !parsed.output) throw new Error("必须提供 --source 和 --output");
  if (parsed["request-stdin"] && ["domains", "company", "person"].some((key) => parsed[key] !== undefined)) {
    throw new Error("--request-stdin 不能与业务范围命令行参数同时使用");
  }
  if (parsed["isolation-token"] !== undefined && !/^[a-f0-9]{64}$/.test(parsed["isolation-token"])) {
    throw new Error("runner isolation token 格式无效。");
  }
  return parsed;
}

function readScopeRequestFromStdin() {
  const raw = fs.readFileSync(0);
  if (!raw.length || raw.length > 8192) throw new Error("stdin 查询范围缺失或超过安全大小");
  let request;
  try { request = JSON.parse(raw.toString("utf8")); } catch (_) { throw new Error("stdin 查询范围不是有效 JSON"); }
  if (!request || typeof request !== "object" || Array.isArray(request)
      || JSON.stringify(Object.keys(request).sort()) !== JSON.stringify(["company", "domains", "person"])) {
    throw new Error("stdin 查询范围不符合精确 schema");
  }
  if (!Array.isArray(request.domains) || request.domains.some((value) => typeof value !== "string")
      || (request.company !== null && typeof request.company !== "string")
      || (request.person !== null && typeof request.person !== "string")) {
    throw new Error("stdin 查询范围字段类型无效");
  }
  return {
    domains: request.domains.join(","),
    company: request.company || undefined,
    person: request.person || undefined
  };
}

function atomicWrite(outputPath, value) {
  const resolved = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "wx" });
    fs.renameSync(temporary, resolved);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch (_) { /* no temporary file */ }
    throw error;
  }
  return resolved;
}

function main() {
  const args = parseArguments(process.argv.slice(2));
  if (args["request-stdin"]) Object.assign(args, readScopeRequestFromStdin());
  const source = JSON.parse(fs.readFileSync(path.resolve(args.source), "utf8"));
  const pack = buildFactPack(source, args);
  const output = atomicWrite(args.output, pack);
  process.stdout.write(`${JSON.stringify({ success: true, status: pack.status, month: pack.scope.month, domains: pack.scope.domains, refreshedAt: pack.scope.refreshedAt, output, factPackSha256: pack.integrity.factPackSha256 })}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error && error.message ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  buildFactPack,
  classifyProduct,
  normalizeDomains,
  resolveEntity
};
