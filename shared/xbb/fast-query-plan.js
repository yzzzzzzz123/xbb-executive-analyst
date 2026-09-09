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
  if (/(?<!\d)\d{1,2}\s*月\s*(?:和|与|及|、|,|，)\s*\d{1,2}\s*月/u.test(text)) return true;
  return /(?<!\d)\d{4}\s*(?:年|[-/.])\s*\d{1,2}\s*月?|(?<!\d)\d{4}\s*年(?:度|全年)?|(?:近|最近|过去)\s*\d+\s*个?(?:自然)?月|(?<!\d)\d{1,2}\s*月?\s*(?:-|—|~|～|至|到)\s*\d{1,2}\s*月|(?:去年|明年)\s*\d{1,2}\s*月|本月|这个月|当月|当前月|上(?:个)?月|今年|本年|全年|整年|一整年|年度/.test(text);
}

function isDefaultGroupPerformanceRanking(question, domains) {
  const text = String(question || "").replace(/\s+/g, "");
  return domains.includes("performance")
    && /集团/.test(text)
    && /业绩/.test(text)
    && /排名|排行/.test(text)
    && /课程/.test(text)
    && /咨询/.test(text)
    && !hasExplicitPeriod(text)
    // A bare calendar month overrides the default full performance window. It
    // remains distinct from a year-qualified period so prestart corrections can
    // still inherit their existing year rather than silently changing it.
    && !/(?<!\d)\d+\s*月/u.test(text);
}

function restrictPerformanceMonths(months, domains) {
  if (!domains.some((domain) => domain === "performance" || domain === "product-sales")) return months;
  if (months.some((month) => month < PERFORMANCE_DATA_START_MONTH)) {
    throw new Error(`业绩订单和 OPP 订单的已确认数据范围从 ${PERFORMANCE_DATA_START_MONTH} 开始，不能混入更早月份。`);
  }
  return months;
}

function parseMonths(question, now = new Date()) {
  const current = shanghaiMonth(now);
  // Normalize only a relative year immediately qualifying a numeric month/range;
  // reuse the existing explicit-date parser and its future / coverage checks.
  const text = String(question || "").replace(/(去年|今年|本年|明年)\s*(?=\d{1,2}\s*(?:月|[-—~～至到]))/gu, (_match, label) =>
    `${current.getUTCFullYear() + (label === "去年" ? -1 : label === "明年" ? 1 : 0)}年`);
  const currentMonth = monthLabel(current);
  const months = [];
  if (/(?<!\d)\d+\s*(?:、|,|，|和|与|及)\s*\d+\s*月/u.test(text)) {
    throw new Error("并列月份请逐个写明月份，例如 8月和9月；不能省略月份单位后猜测查询范围。");
  }

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

  const explicitMonthSpans = [];
  for (const match of text.matchAll(/(?<!\d)(\d{4})\s*(?:年|[-/.])\s*(\d{1,2})\s*月?/g)) {
    const parsed = parseCanonicalMonth(`${match[1]}-${String(Number(match[2])).padStart(2, "0")}`);
    months.push(parsed.value);
    explicitMonthSpans.push({ start: match.index, end: match.index + match[0].length });
  }
  if (months.length && [...text.matchAll(/(?<!\d)\d+\s*月/gu)].some((match) =>
    !explicitMonthSpans.some((span) => match.index >= span.start && match.index + match[0].length <= span.end))) {
    throw new Error("混合年份的并列月份请为每个月写明年份，例如 2026年8月和2026年9月；本次未猜测查询范围。");
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
  if (!months.length && !recent) {
    // "8月" means August of the current Shanghai year, never the current month
    // or an inferred previous year. Reject invalid/future values normally.
    const year = explicitYear ? Number(explicitYear[1]) : current.getUTCFullYear();
    for (const match of text.matchAll(/(?<!\d)(\d+)\s*月/gu)) {
      months.push(parseCanonicalMonth(`${year}-${String(Number(match[1])).padStart(2, "0")}`).value);
    }
  }
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

const DOMAIN_SCOPE_ALIASES = new Map([
  ["业绩", "performance"],
  ["经营业绩", "performance"],
  ["收入", "performance"],
  ["收入结构", "performance"],
  ["产品", "product-sales"],
  ["产品销售", "product-sales"],
  ["产品成交", "product-sales"],
  ["开源产品", "product-sales"],
  ["门票", "product-sales"],
  ["商业操盘", "product-sales"],
  ["商业操盘复训", "product-sales"],
  ["课程", "courses"],
  ["开课", "courses"],
  ["参课", "courses"],
  ["参训", "courses"],
  ["课程成交率", "courses"],
  ["课程成家率", "courses"],
  ["交付", "delivery"],
  ["课程交付", "delivery"],
  ["交付课程", "delivery"],
  ["交付邀约", "delivery"],
  ["邀约", "delivery"],
  ["业绩分配", "delivery"],
  ["成交业绩分配", "delivery"],
  ["商机", "opportunities"],
  ["销售机会", "opportunities"],
  ["商机阶段", "opportunities"],
  ["商机跟进", "opportunities"],
  ["跟进记录", "opportunities"],
  ["跟进质量", "opportunities"],
  ["商机质量", "opportunities"]
]);

function normalizeDomainScopePart(value) {
  let text = String(value || "").replace(/\s+/g, "");
  text = text.replace(/^(?:关于|有关|针对)/, "");
  text = text.replace(/(?:即可|就行|就好)$/, "");
  text = text.replace(/(?:相关)?(?:的数据|数据|情况|分析|部分|板块|模块|维度|主题|指标|排名|排行)$/, "");
  return text;
}

function parseDomainScope(value) {
  const parts = String(value || "")
    .replace(/\s+/g, "")
    .split(/(?:、|\/|以及|还有|和|与|及)/)
    .map(normalizeDomainScopePart)
    .filter(Boolean);
  if (!parts.length) return [];
  const domains = parts.map((part) => DOMAIN_SCOPE_ALIASES.get(part));
  // 限定为可完整识别的短域名，避免把“排除业绩异常”等业务描述误解为
  // “不要查询业绩域”。
  if (domains.some((domain) => !domain)) return [];
  return [...new Set(domains)];
}

function explicitDomainSwitches(question) {
  const text = String(question || "").replace(/\s+/g, "");
  const switches = [];
  const pattern = /(?:^|[，,；;。！？!?\n])(?:请|麻烦|帮我|本次|这次|此次|本轮|本月|这个月|当月|今年|本年|先|暂时)*(?:不要看|不用看|无需看|不看|别看|排除|不用|无需)([^，,；;。！？!?\n]+?)[，,；;。！？!?\n]+(?:而是)?(?:改为看|转而看|只看|仅看|改看|转看)([^，,；;。！？!?\n]+)/g;
  for (const match of text.matchAll(pattern)) {
    const precedingContext = text.slice(Math.max(0, match.index - 32), match.index);
    if (/(?:事实合同|事实说明|字段说明|文档原文|规则示例|错误示例)(?:中|里|写着|写明|提到|包含|说明)?$/.test(precedingContext)) continue;
    const excluded = parseDomainScope(match[1]);
    const included = parseDomainScope(match[2]);
    if (excluded.length && included.length) switches.push({ excluded, included });
  }
  // 手机输入常省略逗号，例如“不要看业绩只看商机”。这里只接受两端都
  // 是完整、已知的单一域别名；较长业务描述仍交给上面的保守解析，避免把
  // “排除业绩异常只看商机质量”误当作切换数据域。
  const aliases = [...DOMAIN_SCOPE_ALIASES.keys()]
    .sort((left, right) => right.length - left.length)
    .map((alias) => alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const compactPattern = new RegExp(
    `(?:^|[，,；;。！？!?\\n])(?:请|麻烦|帮我|本次|这次|此次|本轮|本月|这个月|当月|今年|本年|先|暂时)*(?:不要看|不用看|无需看|不看|别看|排除|不用|无需)(${aliases})(?:而是)?(?:改为看|转而看|只看|仅看|改看|转看)(${aliases})(?=$|[，,；;。！？!?\\n])`,
    "g"
  );
  for (const match of text.matchAll(compactPattern)) {
    const precedingContext = text.slice(Math.max(0, match.index - 32), match.index);
    if (/(?:事实合同|事实说明|字段说明|文档原文|规则示例|错误示例)(?:中|里|写着|写明|提到|包含|说明)?$/.test(precedingContext)) continue;
    switches.push({
      excluded: [DOMAIN_SCOPE_ALIASES.get(match[1])],
      included: [DOMAIN_SCOPE_ALIASES.get(match[2])]
    });
  }
  return switches;
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
  const switches = explicitDomainSwitches(text);
  const included = new Set(switches.flatMap((item) => item.included));
  const excluded = new Set(switches.flatMap((item) => item.excluded).filter((domain) => !included.has(domain)));
  return [...new Set([...domains, ...included])].filter((domain) => !excluded.has(domain));
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
