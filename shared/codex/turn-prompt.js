"use strict";

const { PromptTemplate } = require("@langchain/core/prompts");
const { RunnableBranch } = require("@langchain/core/runnables");
const { formatTaskContext, formatUserMessage } = require("./context-policy.js");
const { formatTaskCheckpoint } = require("./task-checkpoint.js");
const { invokeLocal } = require("../langchain/local-execution.js");

const businessPrompt = PromptTemplate.fromTemplate("$xbb-executive-analyst\n$xbb-executive-chart\n【能力路由】销帮帮经营 Skill\n需要出图时必须实际调用原生 xbb_chart 子 Agent：model=gpt-6-astra、reasoning_effort=ultra、fork_turns=none。先拿到本轮 ready 事实，再把完整有效问题、必要事实与日期分母覆盖边界、图 Skill 与合同交给它；等待逐项分析及图规格，主 Agent 复核后统一答复。不得仅自行出图却声称已委派；子 Agent 不查询业务或再委派。\n出图前由子 Agent 或你调用 validate_xbb_chart 校验完整图并检查返回的手机预览，按具体错误修正直到通过。money的unit必须为空字符串。最终chart直接使用工具返回的validated引用，不再复制完整规格；子 Agent 未暴露校验工具时由你校验它返回的规格，不能跳过。\n本轮必须交付可独立阅读的文字答复，需要出图时同时交付合格经营图；answer 逐项写明结论、关键数字、依据及限制，图中有数字也不能删减正文，不能只写见图或图表已生成。先合并原问题和仍有效追问，按语义识别全部维度并逐项回答，不按数据域或句号数计数。两个及以上维度必须综合出图，宽泛问题也出图：例如‘今天业绩怎么样’应检查同日总体与公司贡献；明确某公司某日单一金额可免图。总体、时间趋势、分公司比较是三个维度，即使只查询 performance。多个合格维度必须在 composite 分别呈现；缺数维度单独说明，不拖累其他面板。用户明确只要文字时尊重要求。要求图表呈现或综合一点时保留全部原意图。\n由你根据完整问题与连续追问自主规划经营查询，不以关键词、固定指标或语句模板限制分析。months、domains 必填；metrics 可省略，省略即读取所选数据域的完整授权事实。综合分析可用 domains=[all] 且省略 metrics；可按分析需要跨域、跨期比较、下钻和补充查询，不限固定调用次数。集团或各个公司不填写 company；只有实际筛选单家公司时填写。商机转化分析应取得创建数量、赢单、阶段及所需关联证据，不能因没有 conversion 指标而拒查。上个月呢等追问继承仍有效的主题与集团/实体范围，按新期间重新调用 query_xbb，不能未查就说没有数据。问今天或明确单日业绩须传上海 date=YYYY-MM-DD，月累计不能冒充单日。真实字段缺失、来源范围和授权边界仍应诚实说明；只读、隐私、实体消歧及图文质量规则不变。\n【销帮帮 Skill RAG 适用规则】\n{rules}\n{prefetched}\n{prestart}\n{entities}\n{continuity}\n【可信运行元数据】\n上海日期：{date}\n授权范围：{scope}\n【用户问题】\n{question}");
const generalPrompt = PromptTemplate.fromTemplate("【能力路由】通用 Codex\n本轮不是销帮帮经营查询，不注入经营或辅助图 Skill，不得调用 query_xbb，chart 固定为 null。请直接使用通用能力回答用户。\n{continuity}\n{taskGuidance}\n{checkpoint}\n【用户问题】\n{question}");
const promptChain = RunnableBranch.from([
  [(values) => values.businessMode, businessPrompt],
  generalPrompt
]);

async function buildTurnPrompt({ businessMode, question, retrieved, prefetchedFactView,
  preStartContext, requiresDynamicEntityQuery, continuity, taskGuidance, taskCheckpoint, date, scope }) {
  const value = await invokeLocal(promptChain, {
    businessMode, question: formatUserMessage(question), rules: retrieved?.text || "",
    date, scope, continuity: continuity.join("\n"), taskGuidance: taskGuidance || "",
    checkpoint: taskCheckpoint ? formatTaskCheckpoint(taskCheckpoint) : "",
    prefetched: prefetchedFactView ? [
      "【本轮 query_xbb 实时预取事实包】", JSON.stringify(prefetchedFactView),
      "这是完整事实包经过确定性预算投影后的模型视图，summary、月度趋势、核心排名及覆盖元数据已保留。它已按授权范围实时查询并通过完整性与隐私校验；不要重复查询相同范围。"
    ].join("\n") : "",
    prestart: preStartContext ? [
      "【本轮启动前仍有效的意图链（按出现顺序应用，后续修正优先）】", formatTaskContext(preStartContext),
      prefetchedFactView
        ? "以下最新问题优先；较早问题中已被覆盖的期间或范围仅是语义上下文，不得沿用。经营事实只能使用本轮最新范围的预取事实包。"
        : "以下最新问题优先；较早问题中已被覆盖的期间、公司或人员范围不得沿用，也不得使用旧范围事实。"
    ].join("\n") : "",
    entities: requiresDynamicEntityQuery ? [
      "【最新实体范围必须动态查询】",
      "本轮因公司或销售人员范围修正而未注入宽范围事实。必须合并上述意图链中的仍有效期间和业务域，并在给出经营数字或结论前调用 query_xbb：最新消息明确点名实体时才传入准确 company/person；若只是各公司或销售人员的分组维度，则按当前授权集团范围查询。只有用户明确要求单一实体但名称无法唯一识别时才做最小澄清，不得猜名或沿用旧事实。"
    ].join("\n") : ""
  });
  return value.toString();
}

module.exports = { buildTurnPrompt };
