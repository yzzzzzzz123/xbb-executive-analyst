"use strict";

const DIRECT_XBB_TERMS = Object.freeze([
  "销帮帮",
  "经营分析",
  "经营数据",
  "业绩",
  "回款",
  "商机",
  "赢单",
  "输单",
  "预计成交",
  "商业操盘",
  "开源产品",
  "交付课程",
  "业绩分配",
  "参课",
  "开课",
  "成交率",
  "到场率",
  "跟进记录",
  "业绩订单",
  "系统销售订单",
  "opp订单",
  "学员约课明细",
  "交付邀约关联",
  "销售机会表",
  "表单id",
  "模板id",
  "字段id",
  "5614255",
  "6707824",
  "7452529",
  "7642173",
  "7452855",
  "5614247",
  "5614253",
  "5614251",
  "有效商机",
  "公司排名",
  "集团排名",
  "门票成交",
  "课程占比",
  "咨询占比"
]);

const BUSINESS_SCOPE_TERMS = Object.freeze([
  "集团",
  "公司",
  "销售",
  "经营",
  "课程",
  "咨询",
  "门票",
  "产品",
  "交付",
  "邀约",
  "成交",
  "跟进"
]);

const ANALYSIS_TERMS = Object.freeze([
  "本月",
  "这个月",
  "当月",
  "全年",
  "年度",
  "季度",
  "今年",
  "最近",
  "多少",
  "排名",
  "占比",
  "金额",
  "数量",
  "趋势",
  "同比",
  "环比",
  "质量",
  "阶段",
  "情况",
  "分析",
  "汇总",
  "收入",
  "销量"
]);

const GENERAL_CREATION_PATTERNS = Object.freeze([
  /(?:帮我|请)?(?:写|起草|润色|翻译|改写|生成)(?:一份|一个|这段|以下)?(?:销售话术|销售方案|课程介绍|课程大纲|商业计划书|公司简介|邮件|通知|文章)/,
  /公司法/,
  /注册公司/,
  /公司名称(?:怎么|如何)/,
  /(?:解释|介绍).*(?:概念|原理|方法)/
]);

const BUSINESS_FOLLOW_UP_PATTERNS = Object.freeze([
  /^(?:\d+|[一二三四五六七八九十]+)[.。？?]?$/,
  /^(?:继续|接着|展开|详细点|再细一点|再看|看一下|上一个|不截断|完整的|再查|重试)[.。！!？?]?$/,
  /^(?:为什么|为啥|啥意思|什么意思|怎么回事)[.。！!？?]?$/,
  /^(?:真实(?:地|的)?说|说实话|实话实说|客观(?:点|一点)?|直接(?:点|说)|别(?:保守|客气|绕弯子)|说真实(?:点|一点)?)[.。！!？?]?$/,
  /^(?:结论呢|怎么办|有什么建议|风险在哪|靠谱吗|严重吗|有多严重|然后呢)[.。！!？?]?$/,
  /^(?:按|换成|改成|只看|再看).{1,24}$/
]);

function normalizedQuestion(question) {
  return String(question || "").trim().toLocaleLowerCase("zh-CN").replace(/\s+/g, "");
}

function isExplicitXbbQuestion(question) {
  const text = normalizedQuestion(question);
  if (!text) return false;
  if (DIRECT_XBB_TERMS.some((term) => text.includes(term))) return true;
  if (GENERAL_CREATION_PATTERNS.some((pattern) => pattern.test(text))) return false;
  return BUSINESS_SCOPE_TERMS.some((term) => text.includes(term))
    && ANALYSIS_TERMS.some((term) => text.includes(term));
}

function isBusinessFollowUp(question) {
  const text = normalizedQuestion(question);
  return Boolean(text) && text.length <= 28 && BUSINESS_FOLLOW_UP_PATTERNS.some((pattern) => pattern.test(text));
}

function routeSkill(question, previousMode = null) {
  if (isExplicitXbbQuestion(question)) {
    return Object.freeze({ mode: "xbb", reason: "explicit-business-intent" });
  }
  if (previousMode === "xbb" && isBusinessFollowUp(question)) {
    return Object.freeze({ mode: "xbb", reason: "business-follow-up" });
  }
  return Object.freeze({ mode: "general", reason: "general-intent" });
}

module.exports = {
  ANALYSIS_TERMS,
  BUSINESS_FOLLOW_UP_PATTERNS,
  BUSINESS_SCOPE_TERMS,
  DIRECT_XBB_TERMS,
  isBusinessFollowUp,
  isExplicitXbbQuestion,
  routeSkill
};
