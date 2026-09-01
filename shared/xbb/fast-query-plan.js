"use strict";

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

function parseMonths(question, now = new Date()) {
  const text = String(question || "");
  const current = shanghaiMonth(now);
  const months = [];
  for (const match of text.matchAll(/(20\d{2})\s*(?:年|[-/.])\s*(0?[1-9]|1[0-2])\s*月?/g)) {
    months.push(`${match[1]}-${String(Number(match[2])).padStart(2, "0")}`);
  }
  const range = /(?<!\d)(0?[1-9]|1[0-2])\s*(?:-|—|至|到)\s*(0?[1-9]|1[0-2])\s*月/.exec(text);
  if (!months.length && range) {
    const start = Number(range[1]);
    const end = Number(range[2]);
    if (end >= start && end - start < 12) {
      for (let month = start; month <= end; month += 1) months.push(`${current.getUTCFullYear()}-${String(month).padStart(2, "0")}`);
    }
  }
  const recent = /(?:近|最近|过去)\s*([2-9]|1[0-2])\s*个?月/.exec(text);
  if (!months.length && recent) {
    const count = Number(recent[1]);
    for (let offset = 1 - count; offset <= 0; offset += 1) months.push(monthLabel(shiftMonth(current, offset)));
  }
  if (!months.length && /今年/.test(text)) {
    for (let month = 1; month <= current.getUTCMonth() + 1; month += 1) months.push(`${current.getUTCFullYear()}-${String(month).padStart(2, "0")}`);
  }
  if (!months.length && /上(?:个)?月/.test(text)) months.push(monthLabel(shiftMonth(current, -1)));
  if (!months.length) months.push(monthLabel(current));
  return [...new Set(months)].slice(0, 12);
}

function routeDomains(question) {
  const text = String(question || "").replace(/\s+/g, "");
  const domains = [];
  if (/商机|赢单|输单|预计成交|跟进质量|遗忘|重新激活|商机阶段/.test(text)) domains.push("opportunities");
  if (/门票|商业操盘|开源产品|产品成交/.test(text)) domains.push("product-sales");
  if (/交付课程|交付邀约|邀约情况|受邀|到场|业绩分配/.test(text)) domains.push("delivery");
  if (/开了?多少(?:堂|门)?课|开课|堂课|每堂课|成交率|参课|参训/.test(text)) domains.push("courses");
  if (/业绩|收入|课程.{0,8}咨询|咨询.{0,8}课程|课程占比|咨询占比/.test(text)) domains.push("performance");
  return [...new Set(domains)];
}

function planFastQuery(question, now = new Date()) {
  const domains = routeDomains(question);
  if (!domains.length) return null;
  return Object.freeze({ months: Object.freeze(parseMonths(question, now)), domains: Object.freeze(domains) });
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

module.exports = { chooseTurnEffort, monthLabel, parseMonths, planFastQuery, routeDomains, shanghaiMonth, shiftMonth };
