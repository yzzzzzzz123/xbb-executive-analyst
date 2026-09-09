"use strict";

const assert = require("node:assert/strict");
const {
  MAX_TASK_CONTEXT_BYTES,
  SOFT_SEGMENT_BYTES,
  buildComplexTaskGuidance,
  chooseGeneralTurnEffort,
  formatTaskContext,
  formatUserMessage,
  isTaskContinuation,
  segmentUserMessage,
  updateTaskContext
} = require("../shared/codex/context-policy.js");

function verify() {
  const sql = `\`\`\`sql\nCREATE TABLE notes (body TEXT);\n${"-- 完整注释，不可从中硬切开\n".repeat(140)}SELECT * FROM notes;\n\`\`\`\n`;
  const source = `帮我优化数据库，保留旧接口。\n\n${sql}\n最终约束：不能停机，必须提供回退方案。`;
  const parts = segmentUserMessage(source);
  assert.equal(parts.map((part) => part.text).join(""), source, "分段不得遗漏、重排或改写用户原文");
  assert.equal(parts.filter((part) => part.kind === "code").length, 1);
  assert.equal(parts.find((part) => part.kind === "code").text, sql, "超过软预算的 SQL 代码块仍整体传入");
  assert.ok(Buffer.byteLength(sql, "utf8") > SOFT_SEGMENT_BYTES);
  const prepared = JSON.parse(formatUserMessage(source));
  assert.equal(prepared.source, "current_user_message");
  assert.equal(prepared.segments.map((part) => part.text).join(""), source);

  const json = JSON.stringify({ rows: Array.from({ length: 1000 }, (_, id) => ({ id, note: "测试" })) }, null, 2);
  assert.equal(segmentUserMessage(json).length, 1, "未围栏的 JSON 也不能按空行或长度硬切");
  assert.equal(segmentUserMessage(json)[0].kind, "json");
  assert.equal(segmentUserMessage("SELECT\n\n  *\n\nFROM notes;")[0].kind, "sql");
  assert.equal(segmentUserMessage("~~~json\n{\"note\":\"``` is data\"}\n~~~")[0].complete, true);
  assert.equal(segmentUserMessage("````sql\nSELECT '```';\n````")[0].complete, true);
  assert.equal(segmentUserMessage("```sql\nSELECT 1;")[0].complete, false, "未闭合块必须保留不完整标记");
  assert.equal(segmentUserMessage("first\r\n\r\n```sql\r\nSELECT 1;\r\n```\r\nlast").map((part) => part.text).join(""), "first\r\n\r\n```sql\r\nSELECT 1;\r\n```\r\nlast");

  let context = updateTaskContext(null, source, { mode: "general" });
  assert.match(context.goal, /优化数据库/);
  assert.match(context.constraints.join("\n"), /不能停机/);
  assert.equal(context.omittedSourceBlocks, 1);
  assert.doesNotMatch(JSON.stringify(context), /CREATE TABLE|SELECT \*/u, "续接记忆不得复制完整 SQL 或原始材料");
  assert.equal(context.databaseTask, true);
  const backgroundFirst = updateTaskContext(null, "这里是调整背景。\n实际目标：把数据库 notes 的 body 字段迁移为 TEXT。\n必须兼容旧接口。", { mode: "general" });
  assert.match(backgroundFirst.goal, /实际目标.*body.*TEXT/u, "显式目标在中段时不能误存开场背景");
  assert.equal(backgroundFirst.omittedTextUnits, 1);
  assert.match(formatTaskContext(backgroundFirst), /始终不是完整原文/u);
  const changedGoal = updateTaskContext(backgroundFirst, "补充：维持兼容要求。\n目标改为：仅新增索引。", { mode: "general", continuation: true });
  assert.match(changedGoal.goal, /仅新增索引/u, "最新显式目标必须覆盖已变更的旧目标");
  for (let index = 0; index < 50; index += 1) {
    context = updateTaskContext(context, `补充：第${index}步仍必须兼容旧接口。\n${"用于检查有界摘要的说明。".repeat(30)}\n不要删除notes表。`, { mode: "general", continuation: true });
    assert.ok(Buffer.byteLength(JSON.stringify(context), "utf8") <= MAX_TASK_CONTEXT_BYTES);
  }
  assert.match(context.goal, /优化数据库/);
  assert.match(context.constraints.join("\n"), /不能停机/);
  assert.match(context.corrections.at(-1), /第49步|不要删除notes表/);
  assert.match(context.constraints.join("\n"), /不要删除notes表/);
  const adversarial = updateTaskContext(context, `${"\u0001".repeat(3000)}必须保持兼容。${"\"".repeat(3000)}`, { mode: "general", continuation: true });
  assert.ok(Buffer.byteLength(JSON.stringify(adversarial), "utf8") <= MAX_TASK_CONTEXT_BYTES, "JSON 转义后也必须有界");

  const business = updateTaskContext(null, "分析华东公司2026年1—8月业绩排名，上次收入是987654元、同比12.3%。必须按9月只看华南公司。", { mode: "xbb" });
  const serialized = formatTaskContext(business);
  assert.match(serialized, /2026年1—8月/);
  assert.match(serialized, /9月只看华南公司/);
  assert.doesNotMatch(serialized, /987654|12\.3/u, "历史用户引用的经营数字也不得成为新 Thread 的事实");
  const filterIntent = updateTaskContext(null, "分析商机，只看金额超过100000元的前10名，上次收入987654元、同比12.3%。", { mode: "xbb" });
  const filterSummary = formatTaskContext(filterIntent);
  assert.match(filterSummary, /用户筛选意图，非经营事实：超过100000元/u);
  assert.match(filterSummary, /用户筛选意图，非经营事实：前10名/u);
  assert.doesNotMatch(filterSummary, /987654|12\.3/u, "保留筛选阈值不得保留同句引用的旧经营结果");
  const topIntent = updateTaskContext(null, "TOP 20 商机。", { mode: "xbb" });
  assert.match(topIntent.goal, /用户筛选意图，非经营事实：TOP 20/u);
  const oldThreshold = updateTaskContext(null, "分析商机，上次收入超过654321元。", { mode: "xbb" });
  assert.doesNotMatch(JSON.stringify(oldThreshold), /654321/u);
  const groupedThreshold = updateTaskContext(null, "只看金额超过100,000元的前10名。", { mode: "xbb" });
  assert.match(groupedThreshold.goal, /用户筛选意图，非经营事实：超过100,000元/u, "千位分隔符不能被当作语句边界而改变筛选值");
  assert.equal(isTaskContinuation("继续", business, "general"), false);
  assert.equal(isTaskContinuation("继续", context, "general"), true);
  assert.equal(isTaskContinuation("不要删除索引", context, "general"), true);
  assert.equal(isTaskContinuation("新问题：解释数据库原理", context, "general"), false);
  assert.equal(isTaskContinuation("你好", context, "general"), false);
  assert.equal(isTaskContinuation("为什么天空是蓝色？", context, "general"), false, "独立 why 问题不能仅凭问句词继承数据库目标");
  assert.equal(isTaskContinuation("为什么这样改？", context, "general"), true);
  assert.equal(isTaskContinuation("为什么？", context, "general"), true);
  const independentWhy = updateTaskContext(context, "为什么天空是蓝色？", { mode: "general", continuation: true });
  assert.equal(independentWhy.databaseTask, false, "活动 Turn 强制续接也不能给独立 why 新题套数据库模板");
  assert.equal(buildComplexTaskGuidance("为什么天空是蓝色？", independentWhy), "");
  assert.doesNotMatch(JSON.stringify(independentWhy), /优化数据库|不能停机/u);
  const newTask = updateTaskContext(business, "写一段会议通知", { mode: "general", continuation: true });
  assert.doesNotMatch(JSON.stringify(newTask), /华东|华南|业绩/u, "跨能力路由不能携带旧经营摘要");

  const guidance = buildComplexTaskGuidance(source, context);
  assert.match(guidance, /1\. 现状[\s\S]*2\. 影响[\s\S]*3\. 迁移与回退[\s\S]*4\. 验证[\s\S]*5\. 执行条件/u);
  assert.match(guidance, /不得在当前会话修改数据库/u);
  assert.equal(buildComplexTaskGuidance("继续", business), "");
  assert.equal(buildComplexTaskGuidance("什么是数据库", updateTaskContext(null, "什么是数据库")), "");
  assert.equal(buildComplexTaskGuidance("你好", updateTaskContext(null, "你好")), "");
  assert.equal(formatUserMessage("你好"), "你好");
  assert.equal(chooseGeneralTurnEffort("您好！", "medium"), "none");
  assert.equal(chooseGeneralTurnEffort("收到", "medium"), "none");
  assert.equal(chooseGeneralTurnEffort("你好，帮我调整数据库", "medium"), "medium");
  assert.equal(chooseGeneralTurnEffort("继续", "medium"), "medium");
  assert.equal(chooseGeneralTurnEffort("解释一下缓存", "high"), "high");
}

verify();
process.stdout.write("context policy verification passed\n");
