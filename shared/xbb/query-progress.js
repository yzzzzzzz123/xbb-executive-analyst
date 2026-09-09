"use strict";

const RUNNER_STAGES = new Set([
  "run_started",
  "month_started",
  "source_ready",
  "month_completed",
  "aggregate_started",
  "aggregate_completed",
  "output_ready",
  "validating",
  "query_ready"
]);

const DOMAIN_LABELS = Object.freeze({
  all: "全部经营模块",
  performance: "集团业绩",
  "product-sales": "开源产品",
  courses: "课程经营",
  delivery: "交付邀约",
  opportunities: "商机质量"
});

const DOMAIN_FOCUS = Object.freeze({
  all: "业绩、产品、课程、交付和商机",
  performance: "总业绩、公司排名、课程/咨询结构和月度走势",
  "product-sales": "门票、商业操盘、开源产品和公司排名",
  courses: "开课场次、老板参课、成交率和成交金额",
  delivery: "邀约、到场、关联回款和业绩归属",
  opportunities: "商机数量、阶段、金额、跟进质量和激活候选"
});

function normalizeRunnerProgressEvent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !RUNNER_STAGES.has(value.stage)) return null;
  const event = { stage: value.stage };
  if (typeof value.month === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value.month)) event.month = value.month;
  for (const key of ["index", "completed", "total"]) {
    if (Number.isInteger(value[key]) && value[key] >= 0 && value[key] <= 12) event[key] = value[key];
  }
  if (["live", "encrypted-cache"].includes(value.source)) event.source = value.source;
  return Object.freeze(event);
}

function monthName(value) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(value || ""));
  return match ? `${match[1]}年${Number(match[2])}月` : "所选月份";
}

function monthsLabel(months) {
  const values = Array.isArray(months) ? months.filter((value) => /^\d{4}-\d{2}$/.test(value)) : [];
  if (!values.length) return "所选期间";
  if (values.length === 1) return monthName(values[0]);
  const first = values[0].split("-").map(Number);
  const last = values.at(-1).split("-").map(Number);
  if (first[0] === last[0]) return `${first[0]}年${first[1]}—${last[1]}月`;
  return `${monthName(values[0])}至${monthName(values.at(-1))}`;
}

function domainLabel(domains) {
  const values = Array.isArray(domains) ? domains : [];
  if (values.includes("all")) return DOMAIN_LABELS.all;
  return values.map((value) => DOMAIN_LABELS[value]).filter(Boolean).join("＋") || "经营数据";
}

function analysisFocus(domains) {
  const values = Array.isArray(domains) ? domains : [];
  if (values.includes("all")) return DOMAIN_FOCUS.all;
  return values.map((value) => DOMAIN_FOCUS[value]).filter(Boolean).join("；") || "问题相关的经营指标";
}

function entityLabel(input, access) {
  if (typeof input?.company === "string" && input.company.trim()) return input.company.trim();
  if (typeof input?.person === "string" && input.person.trim()) return `人员：${input.person.trim()}`;
  if (access?.scope === "companies" && Array.isArray(access.companies) && access.companies.length) return access.companies.join("、");
  return "集团";
}

function progressHeader(input, access) {
  return `正在分析：${monthsLabel(input?.months)}｜${entityLabel(input, access)}｜${domainLabel(input?.domains)}`;
}

function formatQueryProgress(input, rawEvent, access) {
  const event = normalizeRunnerProgressEvent(rawEvent);
  if (!event) return null;
  const header = progressHeader(input, access);
  const total = event.total || (Array.isArray(input?.months) ? input.months.length : 1);
  const focus = analysisFocus(input?.domains);
  switch (event.stage) {
    case "run_started":
      return `${header}\n数据进度：准备读取 ${total} 个月的真实只读数据\n分析重点：${focus}`;
    case "month_started":
      return `${header}\n数据进度：已完成 ${event.completed || 0}/${total}；正在读取 ${monthName(event.month)}（第 ${event.index || 1}/${total} 个月）\n分析重点：${focus}`;
    case "source_ready":
      return `${header}\n数据进度：${monthName(event.month)}已${event.source === "encrypted-cache" ? "命中5分钟加密缓存" : "完成实时读取"}，正在编译业务事实（第 ${event.index || 1}/${total} 个月）\n分析重点：${focus}`;
    case "month_completed":
      return `${header}\n数据进度：已完成 ${event.completed || event.index || 1}/${total} 个月；${monthName(event.month)}事实已编译\n下一步：${total > 1 ? "继续读取剩余月份并做跨月汇总" : "执行隐私与完整性校验"}`;
    case "aggregate_started":
      return `${header}\n数据进度：${total}/${total} 个月已完成\n正在汇总：${focus}`;
    case "aggregate_completed":
    case "output_ready":
    case "validating":
      return `${header}\n数据进度：跨月汇总已完成\n正在校验：实时只读来源、隐私字段和完整性哈希`;
    case "query_ready":
      return `${header}\n数据已就绪：${total} 个月完整，并通过隐私与完整性校验\n正在分析：${focus}\n下一步：生成老板结论并选择最合适的图表`;
    default:
      return null;
  }
}

function formatContextAnalysisProgress() {
  return "正在理解当前问题与对话范围……\n如需补充实时经营数据，将继续显示具体取数月份和分析维度。";
}

function formatGeneralAnalysisProgress() {
  return "已识别为通用问题，正在请求模型回答……\n本轮不会读取销帮帮经营数据。";
}

function chartTypeLabel(type) {
  return ({
    bar: "排名条形图",
    "stacked-bar": "结构堆叠图",
    line: "趋势折线图",
    donut: "结构占比图",
    scatter: "商机分布图",
    funnel: "商机阶段漏斗图"
  })[type] || "辅助图表";
}

function formatDuration(seconds) {
  const value = Math.max(1, Math.floor(Number(seconds) || 0));
  if (value < 60) return `${value}秒`;
  const minutes = Math.floor(value / 60);
  const remainder = value % 60;
  return remainder ? `${minutes}分${remainder}秒` : `${minutes}分钟`;
}

module.exports = {
  DOMAIN_FOCUS,
  DOMAIN_LABELS,
  analysisFocus,
  chartTypeLabel,
  domainLabel,
  entityLabel,
  formatContextAnalysisProgress,
  formatGeneralAnalysisProgress,
  formatDuration,
  formatQueryProgress,
  monthName,
  monthsLabel,
  normalizeRunnerProgressEvent,
  progressHeader
};
