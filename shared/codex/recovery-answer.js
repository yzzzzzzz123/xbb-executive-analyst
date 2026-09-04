"use strict";

const MAX_RECOVERY_ANSWER_BYTES = 18_000;
const MAX_LABEL_BYTES = 192;
const RECOVERABLE_FACT_DOMAINS = Object.freeze([
  "performance",
  "productSales",
  "courses",
  "delivery",
  "opportunities"
]);
const RECOVERABLE_SUMMARY_FIELDS = Object.freeze({
  performance: Object.freeze(["total", "course", "consulting", "other"]),
  productSales: Object.freeze(["ticketCount", "commercialCount", "openOppRevenue"]),
  courses: Object.freeze(["courseCount", "bookedCustomers", "bosses", "dealAmount"]),
  delivery: Object.freeze(["deliveryCourseCount", "invitations", "bosses", "attributedPaidAmount"]),
  opportunities: Object.freeze(["createdCount", "expectedAmount", "wins", "wonAmount", "active", "forgottenCandidates"])
});

const TECHNICAL_REFUSAL_PATTERNS = Object.freeze([
  /(?:超过|超出).{0,24}(?:安全大小|大小|上下文|长度|token|令牌).{0,16}(?:限制|上限)/i,
  /(?:未能|不能|无法).{0,16}(?:完成|生成|给出).{0,16}(?:经营|年度|跨月|本次)?.{0,8}(?:分析|数字|结论|答案)/,
  /(?:建议|请).{0,12}(?:缩小|拆分).{0,12}(?:范围|主题|月份|问题)/,
  /请.{0,12}(?:稍后重试|重新发送|重发)/,
  /(?:系统|上下文|事实包).{0,20}(?:过长|过大).{0,20}(?:无法|不能|失败)/,
  /(?:信息|数据|内容|材料|问题).{0,8}(?:太多|过多|量太大|规模太大)/,
  /(?:信息|数据|内容|材料|问题).{0,12}(?:太多|过多|量太大|规模太大).{0,24}(?:处理不了|没法处理|无法处理|不能处理|无法分析|不能分析)/,
  /(?:处理不了|处理不完|处理不过来|没法处理|无法处理|不能处理)(?:.{0,20}(?:这么多|这些|全部|信息|数据|内容|材料|问题))?/,
  /(?:做不了|做不到|搞不定|应付不了|算不过来|回答不了)(?:.{0,20}(?:分析|问题|任务|信息|数据|内容|结果|全部))?/,
  /(?:无法|不能|没法).{0,12}(?:(?:一次|一次性|全部)\s*)?(?:处理|分析|回答|完成|汇总|计算)/
]);

const SUBSTANTIVE_FACT_PATTERNS = Object.freeze([
  /(?:¥|￥|人民币)\s*\d[\d,.]*(?:\s*(?:元|万元|亿元))?/i,
  /\d[\d,.]*\s*(?:元|万|万元|亿|亿元|%)/i,
  /(?:业绩|收入|金额|门票|商业操盘|开课|课程|参课|商机|赢单|输单|邀约|到场|老板|客户|成交|订单|成家率|成交率|占比|环比|同比).{0,16}\d[\d,.]*(?:\s*(?:%|元|万|亿|个|单|堂|人次|家|张))?/i,
  /\d[\d,.]*\s*(?:个|单|堂|人次|家|张).{0,12}(?:门票|商业操盘|课程|商机|赢单|邀约|老板|客户|公司|成交|订单)/i,
  /(?:业绩|收入|课程|咨询|产品|门票|商业操盘|商机|赢单|邀约|成家率|成交率|占比).{0,16}[零一二三四五六七八九十两]+(?:成|个百分点|%)/,
  /(?:第\s*(?:\d+|[一二三四五六七八九十]+)\s*名|(?:排名|位居|排在)\s*第?\s*(?:\d+|[一二三四五六七八九十]+)|(?:公司|业绩|课程|产品|商机|邀约).{0,12}前\s*\d+)/i
]);

const SUBSTANTIVE_ANALYSIS_PATTERNS = Object.freeze([
  /(?:经营|业绩|收入|课程|咨询|产品|门票|商业操盘|商机|赢单|转化|跟进|邀约|公司).{0,36}(?:增长|下降|领先|落后|最高|最低|较高|较低|偏高|偏低|集中|短板|风险|改善|恶化|优先|拉动|向好|承压|为主|主导|主要来源|核心来源|主力|贡献最大|表现最好|表现最弱|靠前|垫底|过半|断档|薄弱|滞后)/,
  /(?:增长|下降|领先|落后|最高|最低|较高|较低|偏高|偏低|集中|短板|风险|改善|恶化|优先|拉动|向好|承压|为主|主导|主要来源|核心来源|主力|贡献最大|表现最好|表现最弱|靠前|垫底|过半|断档|薄弱|滞后).{0,36}(?:经营|业绩|收入|课程|咨询|产品|门票|商业操盘|商机|赢单|转化|跟进|邀约|公司)/,
  /(?:核心结论|关键发现|主要问题|主要风险|优先建议|建议优先)[：:\s]*(?=.{2,80}(?:业绩|收入|课程|产品|商机|跟进|邀约|公司)).{2,80}/
]);

function wellFormed(value) {
  const text = String(value ?? "");
  if (typeof text.toWellFormed === "function") return text.toWellFormed();
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD");
}

function utf8Prefix(value, maxBytes) {
  const budget = Math.max(0, Math.floor(number(maxBytes)));
  if (!budget) return "";
  let bytes = 0;
  let output = "";
  for (const character of wellFormed(value)) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > budget) break;
    output += character;
    bytes += size;
  }
  return output;
}

function limitUtf8(value, maxBytes = MAX_RECOVERY_ANSWER_BYTES, suffix = "\n（恢复内容已按长度上限压缩。）") {
  const budget = Math.max(0, Math.floor(number(maxBytes)));
  const text = wellFormed(value);
  if (Buffer.byteLength(text, "utf8") <= budget) return text;
  const safeSuffix = utf8Prefix(suffix, budget);
  const suffixBytes = Buffer.byteLength(safeSuffix, "utf8");
  const prefix = utf8Prefix(text, budget - suffixBytes).trimEnd();
  return `${prefix}${safeSuffix}`;
}

function safeLabel(value, fallback) {
  const normalized = wellFormed(value)
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return fallback;
  if (Buffer.byteLength(normalized, "utf8") <= MAX_LABEL_BYTES) return normalized;
  return `${utf8Prefix(normalized, MAX_LABEL_BYTES - Buffer.byteLength("…", "utf8")).trimEnd()}…`;
}

function hasUsableDomainFact(domain, fact) {
  if (!RECOVERABLE_SUMMARY_FIELDS[domain]
    || !fact || typeof fact !== "object" || Array.isArray(fact)
    || !fact.summary || typeof fact.summary !== "object" || Array.isArray(fact.summary)) return false;
  return RECOVERABLE_SUMMARY_FIELDS[domain].some((field) => {
    const value = fact.summary[field];
    return value !== null && value !== "" && typeof value !== "boolean" && Number.isFinite(Number(value));
  });
}

function hasUsableFacts(pack) {
  if (pack?.status !== "ready" || !pack.facts || typeof pack.facts !== "object" || Array.isArray(pack.facts)) return false;
  return RECOVERABLE_FACT_DOMAINS.some((domain) => hasUsableDomainFact(domain, pack.facts[domain]));
}

function refusalProbe(value) {
  return wellFormed(value)
    .replace(
      /(?:不是|并非|并不是|绝非|不会|不至于|无需担心|不用担心).{0,24}(?:处理不了|处理不完|处理不过来|没法处理|无法处理|不能处理|做不了|做不到|信息太多|数据太多)/g,
      ""
    )
    .replace(
      /(?:信息|数据|内容|材料).{0,8}(?:太多|过多|量太大).{0,12}(?:不是问题|并不影响|也能处理|仍可处理|已经处理|已处理)/g,
      ""
    )
    .replace(/(?:处理不了|做不了|做不到).{0,12}(?:并不存在|不是事实|并不准确)/g, "");
}

function containsTechnicalRefusal(value) {
  const probe = refusalProbe(value);
  return TECHNICAL_REFUSAL_PATTERNS.some((candidate) => candidate.test(probe));
}

function hasSubstantiveConclusion(value) {
  const segments = wellFormed(value)
    .split(/[\n。！？!?；;，,]+|(?:但是|但|不过|然而|只是|由于|因为|鉴于)/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  return segments.some((segment) => {
    if (containsTechnicalRefusal(segment)) return false;
    if (/(?:没有|无|缺少|缺乏).{0,8}(?:可用|足够|完整|有效)?.{0,4}(?:数据|事实|信息|结果)/.test(segment)) return false;
    return SUBSTANTIVE_FACT_PATTERNS.some((pattern) => pattern.test(segment))
      || SUBSTANTIVE_ANALYSIS_PATTERNS.some((pattern) => pattern.test(segment));
  });
}

function falseTechnicalRefusalReason(answer, pack) {
  if (!hasUsableFacts(pack)) return null;
  const text = wellFormed(answer).trim();
  if (!text || !containsTechnicalRefusal(text) || hasSubstantiveConclusion(text)) return null;
  return "ready_facts_rejected_by_model";
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function count(value) {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(number(value));
}

function money(value) {
  return `¥${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(number(value))}`;
}

function percentage(value) {
  return `${count(value)}%`;
}

function monthsLabel(scope) {
  const months = Array.isArray(scope?.months) ? scope.months : scope?.month ? [scope.month] : [];
  const canonicalMonths = months.map((month) => String(month || "")).filter((month) => /^\d{4}-(?:0[1-9]|1[0-2])$/.test(month));
  if (!canonicalMonths.length) return "本轮实时查询范围";
  const label = (month) => `${month.slice(0, 4)}年${Number(month.slice(5))}月`;
  return canonicalMonths.length === 1 ? label(canonicalMonths[0]) : `${label(canonicalMonths[0])}—${label(canonicalMonths.at(-1))}`;
}

function rankingLine(label, rows, valueField, formatter = count) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const values = rows.slice(0, 5).map((row, index) => `${index + 1}.${safeLabel(row?.company || row?.person?.name, "未命名")} ${formatter(row?.[valueField])}`);
  return `${label}：${values.join("；")}`;
}

function buildVerifiedFallbackAnswer(pack) {
  if (!hasUsableFacts(pack)) throw new Error("没有可用于本地恢复回答的已校验事实。");
  const facts = pack.facts;
  const lines = [`${monthsLabel(pack.scope)}经营结论（本轮实时只读事实）：`];

  if (hasUsableDomainFact("performance", facts.performance)) {
    const summary = facts.performance.summary || {};
    lines.push(`业绩：合计 ${money(summary.total)}；课程 ${money(summary.course)}（${percentage(summary.courseShare)}），咨询 ${money(summary.consulting)}（${percentage(summary.consultingShare)}），其他 ${money(summary.other)}（${percentage(summary.otherShare)}）。`);
    const ranking = rankingLine("公司业绩前列", facts.performance.ranking, "total", money);
    if (ranking) lines.push(ranking);
  }

  if (hasUsableDomainFact("productSales", facts.productSales)) {
    const summary = facts.productSales.summary || {};
    lines.push(`开源产品：门票 ${count(summary.ticketCount)}；商业操盘 ${count(summary.commercialCount)}，其中首训 ${count(summary.commercialInitialCount)}、复训 ${count(summary.commercialRetrainingCount)}；OPP 开源产品成交额 ${money(summary.openOppRevenue)}。`);
    const tickets = rankingLine("门票前列", facts.productSales.ticketRanking, "ticketCount");
    const commercial = rankingLine("商业操盘前列", facts.productSales.commercialRanking, "commercialCount");
    if (tickets) lines.push(tickets);
    if (commercial) lines.push(commercial);
  }

  if (hasUsableDomainFact("courses", facts.courses)) {
    const summary = facts.courses.summary || {};
    lines.push(`课程：开课 ${count(summary.courseCount)} 堂，约课 ${count(summary.bookedCustomers)} 人次，老板 ${count(summary.bosses)} 人次，关联成交 ${count(summary.dealOrders)} 单、${money(summary.dealAmount)}，成家率 ${percentage(summary.conversionRate)}。`);
    const ranking = rankingLine("开课公司前列", facts.courses.companies, "courseCount");
    if (ranking) lines.push(ranking);
  }

  if (hasUsableDomainFact("delivery", facts.delivery)) {
    const summary = facts.delivery.summary || {};
    lines.push(`交付：课程 ${count(summary.deliveryCourseCount)} 堂，邀约 ${count(summary.invitations)} 人次，老板 ${count(summary.bosses)} 人次，可追溯分配业绩 ${money(summary.attributedPaidAmount)}。`);
    const ranking = rankingLine("邀约公司前列", facts.delivery.companies, "invitations");
    if (ranking) lines.push(ranking);
  }

  if (hasUsableDomainFact("opportunities", facts.opportunities)) {
    const summary = facts.opportunities.summary || {};
    lines.push(`商机：创建 ${count(summary.createdCount)} 个，预计金额 ${money(summary.expectedAmount)}；赢单 ${count(summary.wins)} 个、赢单金额 ${money(summary.wonAmount)}；活跃 ${count(summary.active)} 个，建议重新激活 ${count(summary.forgottenCandidates)} 个。`);
    if (Array.isArray(facts.opportunities.stages) && facts.opportunities.stages.length) {
      const stages = facts.opportunities.stages.slice(0, 12)
        .map((row) => `${safeLabel(row?.stage, "未标阶段")} ${count(row?.count)} 个/${money(row?.expectedAmount)}`);
      const omitted = facts.opportunities.stages.length - stages.length;
      lines.push(`阶段结构：${stages.join("；")}${omitted > 0 ? `；另有 ${count(omitted)} 个阶段未展开` : ""}`);
    }
    if (Array.isArray(facts.opportunities.reactivationCandidates) && facts.opportunities.reactivationCandidates.length) {
      lines.push(`优先激活：${facts.opportunities.reactivationCandidates.slice(0, 5).map((row) => `${safeLabel(row?.creator?.name, "未标人员")}-${safeLabel(row?.name || row?.customerName, "未命名商机")}（${money(row?.expectedAmount)}，${count(row?.signals?.staleDays)}天未跟进）`).join("；")}`);
    }
  }

  lines.push("系统已保留完整汇总口径；上面仅压缩展示明细，不用截断明细反推总额。");
  return limitUtf8(lines.join("\n"), MAX_RECOVERY_ANSWER_BYTES);
}

module.exports = {
  MAX_RECOVERY_ANSWER_BYTES,
  TECHNICAL_REFUSAL_PATTERNS,
  buildVerifiedFallbackAnswer,
  falseTechnicalRefusalReason,
  hasSubstantiveConclusion,
  hasUsableFacts,
  limitUtf8
};
