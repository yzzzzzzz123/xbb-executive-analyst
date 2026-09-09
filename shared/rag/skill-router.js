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

// 这里只登记已经进入销帮帮数据合同的真实字段 ID。字段名本身很像普通代码
// 变量，所以不能用 text_\d+ / date_\d+ 这类宽泛正则直接把任意代码问题路由
// 到经营 Skill；只有白名单字段且提问外形确实是字段查询时才算销帮帮问题。
const XBB_FIELD_IDS = Object.freeze([
  "text_63",
  "array_4.num_5",
  "array_4.text_10",
  "array_4",
  "array_1",
  "date_1",
  "date_2",
  "date_3",
  "text_31",
  "array_4.num_3",
  "array_4.text_1",
  "text_5",
  "text_1",
  "text_22",
  "text_28",
  "num_1",
  "num_2",
  "text_2",
  "num_3",
  "num_6",
  "num_9",
  "num_10",
  "text_11",
  "addtime",
  "ownerid",
  "text_17",
  "num_14",
  "creatorid",
  "text_6",
  "text_3",
  "num_5",
  "text_7",
  "text_8",
  "text_9",
  "text_10",
  "text_12",
  "text_15",
  "text_20",
  "text_23",
  "text_24",
  "text_25",
  "text_26",
  "text_36",
  "text_39",
  "text_40"
]);

const XBB_FIELD_ID_SET = new Set(XBB_FIELD_IDS);
const FIELD_ID_PATTERN = /(?<![a-z0-9_.])(?:array_\d+\.)?(?:text|num|date)_\d+(?![a-z0-9_.])|(?<![a-z0-9_])(?:array_\d+|addtime|creatorid|ownerid)(?![a-z0-9_])/giu;
const CODE_CONTEXT_PATTERN = /(?:\b(?:const|let|var|function|class|import|export|select|insert|update|delete|where|undefined|null)\b|javascript|typescript|python|java|sql|代码|变量|函数|编译|报错|异常栈|stack\s*trace|=>|===|!==|[{};])/iu;
const FIELD_QUERY_FILLERS = Object.freeze([
  "请帮我", "麻烦帮我", "告诉我", "查一下", "看一下", "解释一下", "说明一下", "确认一下", "请问",
  "如何使用", "怎么使用", "用来干什么", "用来干嘛", "在哪张表", "哪张表", "是什么字段",
  "分别是什么", "各自是什么", "对应什么", "代表什么", "什么意思", "字段含义", "字段名称",
  "字段", "表单", "这个", "这些", "它们", "它", "请", "帮我", "麻烦", "查", "看", "解释",
  "说明", "确认", "一下", "分别", "各自", "对应", "代表", "含义", "意思", "是什么", "什么",
  "是啥", "啥", "哪个", "哪里", "怎么用", "如何用", "用途", "用来", "的", "和", "与", "以及"
].sort((left, right) => right.length - left.length));

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

function isKnownXbbFieldQuestion(question) {
  const text = normalizedQuestion(question);
  if (!text || CODE_CONTEXT_PATTERN.test(text)) return false;
  const matches = [...text.matchAll(FIELD_ID_PATTERN)].map((match) => match[0].toLocaleLowerCase("en-US"));
  if (!matches.length || matches.some((fieldId) => !XBB_FIELD_ID_SET.has(fieldId))) return false;

  let remainder = text.replace(FIELD_ID_PATTERN, "").replace(/[?？!！。.,，、:：()（）\[\]【】'"`]/g, "");
  if (!remainder) return true;
  // 字段问法通常很短。只消去明确的问句连接词；剩下业务之外的代码语义时
  // 不命中，从而避免把诸如“date_1 为什么 undefined”误判成销帮帮查询。
  let previous;
  do {
    previous = remainder;
    for (const filler of FIELD_QUERY_FILLERS) remainder = remainder.split(filler).join("");
  } while (remainder !== previous);
  return remainder.length === 0;
}

function isExplicitXbbQuestion(question) {
  const text = normalizedQuestion(question);
  if (!text) return false;
  if (DIRECT_XBB_TERMS.some((term) => text.includes(term))) return true;
  if (isKnownXbbFieldQuestion(text)) return true;
  if (GENERAL_CREATION_PATTERNS.some((pattern) => pattern.test(text))) return false;
  return BUSINESS_SCOPE_TERMS.some((term) => text.includes(term))
    && ANALYSIS_TERMS.some((term) => text.includes(term));
}

function isBusinessFollowUp(question) {
  const text = normalizedQuestion(question);
  return Boolean(text) && text.length <= 28 && BUSINESS_FOLLOW_UP_PATTERNS.some((pattern) => pattern.test(text));
}

function unquotedInstructionText(question) {
  let fence = null;
  const prose = String(question || "").split(/\r?\n/).map((line) => {
    const marker = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence.character && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      return "";
    }
    if (marker) { fence = { character: marker[1][0], length: marker[1].length }; return ""; }
    if (/^[ \t]*>/.test(line)) return "";
    return line;
  }).join("\n");
  return prose
    .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|`+[^`]*`+/g, " ")
    .replace(/\/\*[\s\S]*?(?:\*\/|$)/g, " ")
    .replace(/(?:^|[\s;])(?:\/\/|--)[^\n]*/g, " ");
}

function isExplicitXbbQueryDenied(question) {
  // Only a complete, short imperative clause changes capabilities. Mentions of
  // a prohibition inside code, quotes or rule examples remain source material.
  const text = unquotedInstructionText(question).replace(/[^\S\n]+/g, "");
  const pattern = /(?:^|[，,、；;。！!：:\n])(?:请|麻烦你|麻烦|帮我|本次|这次|此次|本轮|现在|先|暂时|也|并且|并|你|务必){0,4}(?:不要|不用|无需|不得|禁止|不许|别|不)(?:再|去|直接|实际|真的)?(?:查询|读取|访问|调用|获取|读|查)销帮帮(?:的?(?:实时)?(?:数据|接口|openapi|api))?(?=$|[，,、；;。！!\n])/giu;
  for (const match of text.matchAll(pattern)) {
    const preceding = text.slice(Math.max(0, match.index - 96), match.index).split(/[。！？!\n]/).at(-1);
    if (/(?:文档|规则|合同|原文|错误示例|反例|引用|代码|字符串|注释)[^，,；;：:]{0,24}(?:写明|写着|写道|提到|说明|说|包含|如下|内容|是|为|例如|示例|要求)[，,；;：:]*$/.test(preceding)) continue;
    if (/^(?:以下(?:是|为)?)?(?:例如|比如|示例|反例|原文|引用|代码|注释)(?:如下)?[：:]*$/.test(preceding)) continue;
    if (/(?:不是|并非|不意味着|不代表)(?:说|要求)?[，,；;：:]*$/.test(preceding)) continue;
    const following = text.slice(match.index + match[0].length);
    if (/^[，,；;](?:这句话|这句|上述表述)(?:只是|是)(?:一个)?(?:错误)?(?:示例|反例|引用)/.test(following)) continue;
    return true;
  }
  return false;
}

function routeSkill(question, previousMode = null) {
  if (isExplicitXbbQueryDenied(question)) {
    return Object.freeze({ mode: "general", reason: "explicit-xbb-query-denial" });
  }
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
  XBB_FIELD_IDS,
  isBusinessFollowUp,
  isExplicitXbbQuestion,
  isExplicitXbbQueryDenied,
  isKnownXbbFieldQuestion,
  routeSkill
};
