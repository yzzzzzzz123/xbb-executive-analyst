"use strict";

const PERFORMANCE_DATA_START_MONTH = "2026-01";
const MAX_QUERY_MONTHS = 120;
const MIN_QUERY_YEAR = 1900;

function monthLabel(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function shiftMonth(date, offset) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + offset, 1));
}

function shanghaiMonth(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit"
  }).formatToParts(now);
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  return new Date(Date.UTC(year, month - 1, 1));
}

function parseCanonicalMonth(value) {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(String(value));
  if (!match) throw new Error("月份必须使用 YYYY-MM 格式。");
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (year < MIN_QUERY_YEAR || year > 9999) {
    throw new Error(`月份年份必须在 ${MIN_QUERY_YEAR} 至 9999 之间。`);
  }
  return { year, month, value: `${year}-${String(month).padStart(2, "0")}` };
}

function validateRequestedMonths(months, now = new Date()) {
  const currentMonth = monthLabel(shanghaiMonth(now));
  return months.map((month) => {
    const parsed = parseCanonicalMonth(month);
    if (parsed.value > currentMonth) throw new Error(`不能查询晚于当前上海月份 ${currentMonth} 的月份。`);
    return parsed.value;
  });
}

function monthsBetween(startMonth, endMonth) {
  const startParts = parseCanonicalMonth(startMonth);
  const endParts = parseCanonicalMonth(endMonth);
  const startYear = startParts.year;
  const startNumber = startParts.month;
  const endYear = endParts.year;
  const endNumber = endParts.month;
  const start = new Date(Date.UTC(startYear, startNumber - 1, 1));
  const end = new Date(Date.UTC(endYear, endNumber - 1, 1));
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) throw new Error("月份超出可处理的日期范围。");
  if (start > end) throw new Error("时间范围的开始月份不能晚于结束月份。");
  const months = [];
  for (let cursor = start; cursor <= end; cursor = shiftMonth(cursor, 1)) {
    months.push(monthLabel(cursor));
    if (months.length > MAX_QUERY_MONTHS) throw new Error(`一次最多查询 ${MAX_QUERY_MONTHS} 个月，请缩小时间范围。`);
  }
  return months;
}

function hasExplicitPeriod(question) {
  const text = String(question || "");
  return /(?<!\d)\d{4}\s*(?:年|[-/.])\s*\d{1,2}\s*月?|(?<!\d)\d{4}\s*年(?:度|全年)?|(?:近|最近|过去)\s*\d+\s*个?(?:自然)?月|(?<!\d)\d{1,2}\s*月?\s*(?:-|—|~|～|至|到)\s*\d{1,2}\s*月|本月|这个月|当月|当前月|上(?:个)?月|今年|本年|全年|整年|一整年|年度/.test(text);
}

function isDefaultGroupPerformanceRanking(question, domains) {
  const text = String(question || "").replace(/\s+/g, "");
  return domains.includes("performance")
    && /集团/.test(text)
    && /业绩/.test(text)
    && /排名|排行/.test(text)
    && /课程/.test(text)
    && /咨询/.test(text)
    && !hasExplicitPeriod(text);
}

function restrictPerformanceMonths(months, domains) {
  if (!domains.some((domain) => domain === "performance" || domain === "product-sales")) return months;
  if (months.some((month) => month < PERFORMANCE_DATA_START_MONTH)) {
    throw new Error(`业绩订单和 OPP 订单的已确认数据范围从 ${PERFORMANCE_DATA_START_MONTH} 开始，不能混入更早月份。`);
  }
  return months;
}

function parseMonths(question, now = new Date()) {
  const text = String(question || "");
  const current = shanghaiMonth(now);
  const currentMonth = monthLabel(current);
  const months = [];

  // 先识别宽松的显式日期外形，避免“13 月”等错误被当成未写期间并静默回落到本月。
  for (const match of text.matchAll(/(?<!\d)(\d{4})\s*(?:年|[-/.])\s*(\d{1,2})\s*月?/g)) {
    parseCanonicalMonth(`${match[1]}-${String(Number(match[2])).padStart(2, "0")}`);
  }

  const chineseRange = /(?<!\d)(\d{4})\s*年\s*(\d{1,2})\s*月?\s*(?:-|至|到|—|~|～)\s*(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月/.exec(text);
  const numericRange = /(?<!\d)(\d{4})\s*[-/.]\s*(\d{1,2})\s*(?:-|至|到|—|~|～)\s*(\d{4})\s*[-/.]\s*(\d{1,2})(?!\d)/.exec(text);
  if (chineseRange || numericRange) {
    const match = chineseRange || numericRange;
    const startYear = Number(match[1]);
    const startNumber = Number(match[2]);
    const endYear = Number(match[3] || match[1]);
    const endNumber = Number(match[4]);
    const rangeMonths = monthsBetween(
      `${startYear}-${String(startNumber).padStart(2, "0")}`,
      `${endYear}-${String(endNumber).padStart(2, "0")}`
    );
    return validateRequestedMonths(rangeMonths, now);
  }

  const since = /(?<!\d)(\d{4})\s*(?:年|[-/.])\s*(\d{1,2})\s*月?\s*(?:以来|以后|之后|起|至今)/.exec(text);
  if (since) {
    const startMonth = `${since[1]}-${String(Number(since[2])).padStart(2, "0")}`;
    parseCanonicalMonth(startMonth);
    if (startMonth > currentMonth) throw new Error(`时间范围的开始月份不能晚于当前上海月份 ${currentMonth}。`);
    return validateRequestedMonths(monthsBetween(startMonth, currentMonth), now);
  }

  for (const match of text.matchAll(/(?<!\d)(\d{4})\s*(?:年|[-/.])\s*(\d{1,2})\s*月?/g)) {
    const parsed = parseCanonicalMonth(`${match[1]}-${String(Number(match[2])).padStart(2, "0")}`);
    months.push(parsed.value);
  }

  const range = /(?<!\d)(\d{1,2})\s*月?\s*(?:-|—|~|～|至|到)\s*(\d{1,2})\s*月/.exec(text);
  if (!months.length && range) {
    const start = Number(range[1]);
    const end = Number(range[2]);
    if (start < 1 || start > 12 || end < 1 || end > 12) throw new Error("月份必须在 1 至 12 之间。");
    if (end < start) throw new Error("未写年份的跨年范围不明确，请同时写明开始年份和结束年份。");
    for (let month = start; month <= end; month += 1) months.push(`${current.getUTCFullYear()}-${String(month).padStart(2, "0")}`);
  }

  const recent = /(?:近|最近|过去)\s*(\d+)\s*个?(?:自然)?月/.exec(text);
  if (!months.length && recent) {
    const count = Number(recent[1]);
    if (count < 1 || count > MAX_QUERY_MONTHS) throw new Error(`一次最多查询 ${MAX_QUERY_MONTHS} 个月，请缩小时间范围。`);
    for (let offset = 1 - count; offset <= 0; offset += 1) months.push(monthLabel(shiftMonth(current, offset)));
  }

  const explicitYear = /(?<!\d)(\d{4})\s*年(?:度|全年)?/.exec(text);
  if (!months.length && explicitYear) {
    const year = Number(explicitYear[1]);
    if (year < MIN_QUERY_YEAR || year > 9999) throw new Error(`月份年份必须在 ${MIN_QUERY_YEAR} 至 9999 之间。`);
    if (year > current.getUTCFullYear()) throw new Error(`不能查询晚于当前上海月份 ${currentMonth} 的月份。`);
    const lastMonth = year === current.getUTCFullYear() ? current.getUTCMonth() + 1 : 12;
    for (let month = 1; month <= lastMonth; month += 1) months.push(`${year}-${String(month).padStart(2, "0")}`);
  }
  if (!months.length && /今年|本年|全年|整年|一整年|年度/.test(text)) {
    for (let month = 1; month <= current.getUTCMonth() + 1; month += 1) months.push(`${current.getUTCFullYear()}-${String(month).padStart(2, "0")}`);
  }
  if (!months.length && /上(?:个)?月/.test(text)) months.push(monthLabel(shiftMonth(current, -1)));
  if (!months.length) months.push(monthLabel(current));
  const unique = [...new Set(months)];
  if (unique.length > MAX_QUERY_MONTHS) throw new Error(`一次最多查询 ${MAX_QUERY_MONTHS} 个月，请缩小时间范围。`);
  return validateRequestedMonths(unique, now);
}

function routeDomains(question) {
  const text = String(question || "").replace(/\s+/g, "");
  const domains = [];
  const deliveryIntent = /交付课程|交付邀约|邀约情况|受邀|到场|业绩分配/.test(text);
  if (/商机|赢单|输单|预计成交|跟进质量|遗忘|重新激活|商机阶段/.test(text)) domains.push("opportunities");
  if (/门票|商业操盘|开源产品|产品成交/.test(text)) domains.push("product-sales");
  if (deliveryIntent) domains.push("delivery");
  if (/开了?多少(?:堂|门)?课|开课|堂课|每堂课|成(?:交|家)率|参课|参训/.test(text)) domains.push("courses");
  if (/业绩|收入|课程.{0,8}咨询|咨询.{0,8}课程|课程占比|咨询占比/.test(text)
      && !(deliveryIntent && /业绩分配|成交业绩/.test(text))) domains.push("performance");
  return [...new Set(domains)];
}

function isSchemaOnlyQuestion(question) {
  const text = String(question || "").replace(/\s+/g, "").toLocaleLowerCase("zh-CN");
  const mentionsSchema = /表单|字段|formid|模板id|字段id|text_\d+|num_\d+|date_\d+|array_\d+/.test(text);
  if (!mentionsSchema) return false;
  // 明确要求经营数字、时间范围或比较时仍应实时取数；纯字段/表单说明直接使用
  // 受版本约束的 Skill RAG，省掉一次没有价值的 CRM 查询。
  return !/本月|这个月|当月|当前月|上(?:个)?月|今年|本年|全年|整年|年度|\d{4}\s*年|最近\d+个?月|多少|排名|排行|占比|金额|数量|销量|趋势|同比|环比|成交率|成家率|汇总|分析/.test(text);
}

function planFastQuery(question, now = new Date()) {
  if (isSchemaOnlyQuestion(question)) return null;
  const domains = routeDomains(question);
  if (!domains.length) return null;
  const currentMonth = monthLabel(shanghaiMonth(now));
  const requestedMonths = isDefaultGroupPerformanceRanking(question, domains)
    ? monthsBetween(PERFORMANCE_DATA_START_MONTH, currentMonth)
    : parseMonths(question, now);
  const months = restrictPerformanceMonths(requestedMonths, domains);
  return Object.freeze({ months: Object.freeze(months), domains: Object.freeze(domains) });
}

function chooseTurnEffort(question, defaultEffort = "medium") {
  const text = String(question || "").replace(/\s+/g, "");
  const domains = routeDomains(text);
  const needsDeepAnalysis = domains.includes("opportunities")
    || /原因|为什么|归因|风险|预测|质量|异常|诊断|建议|重新激活|遗忘/.test(text);
  if (needsDeepAnalysis) return defaultEffort;
  if (domains.length || /^(你好|您好|在吗|你是谁|能做什么)[？?！!。.]?$/.test(text)) return "none";
  return defaultEffort;
}

module.exports = {
  MAX_QUERY_MONTHS,
  MIN_QUERY_YEAR,
  PERFORMANCE_DATA_START_MONTH,
  chooseTurnEffort,
  hasExplicitPeriod,
  isSchemaOnlyQuestion,
  isDefaultGroupPerformanceRanking,
  monthLabel,
  monthsBetween,
  parseMonths,
  planFastQuery,
  restrictPerformanceMonths,
  routeDomains,
  shanghaiMonth,
  shiftMonth,
  validateRequestedMonths
};
