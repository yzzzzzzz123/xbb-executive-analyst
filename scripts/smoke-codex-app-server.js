"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PersistentCodexAgent, principalKeyFromUserId } = require("../shared/codex/persistent-agent.js");
const { readCodexVersion, verifyCodexChatGptLogin } = require("../shared/codex/runtime.js");
const { chooseTurnEffort } = require("../shared/xbb/fast-query-plan.js");

function elapsed(startedAtMs) {
  return Date.now() - startedAtMs;
}

async function runSmoke() {
  const business = process.argv.includes("--business");
  const repeatOption = process.argv.find((value) => value.startsWith("--repeat="));
  const repeat = repeatOption ? Number(repeatOption.split("=")[1]) : 1;
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 3) throw new Error("--repeat 必须是 1-3 的整数。");
  const projectRoot = path.resolve(__dirname, "..");
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "xbb-agent-smoke-"));
  const config = {
    projectRoot,
    agentStatePath: path.join(tempRoot, "agent-state.json"),
    agentTurnTimeoutMs: 300000,
    generalTurnTimeoutMs: 900000,
    codexModel: "gpt-5.6-sol",
    codexReasoningEffort: "medium"
  };
  verifyCodexChatGptLogin(config);
  const codexVersion = readCodexVersion(config);
  const access = Object.freeze({ userId: "local-smoke", scope: "all", companies: Object.freeze([]) });
  const principalKey = principalKeyFromUserId(access.userId, access);
  const activities = [];
  const agent = new PersistentCodexAgent(config);
  agent.on("activity", (value) => activities.push({ at: Date.now(), ...value }));
  try {
    await agent.start();
    const warmStartedAtMs = Date.now();
    await agent.warm({ access, principalKey });
    const warmMs = elapsed(warmStartedAtMs);

    const question = business
      ? "对集团2026年9月业绩按照公司名称排名，并区分课程和咨询占比。结论给老板看，尽量简短，并配一张图。"
      : "你好。请只用一句中文说明你是通用 Codex Agent，也可以按需调用销帮帮经营 Skill；不要查询销帮帮。";
    const runs = [];
    for (let index = 0; index < repeat; index += 1) {
      const answerStartedAtMs = Date.now();
      const result = await agent.answer({
        question,
        access,
        principalKey,
        messageId: `${business ? "local-business" : "local-greeting"}-smoke-${index + 1}`
      });
      const answerMs = elapsed(answerStartedAtMs);
      const answerActivities = activities.filter((value) => value.at >= answerStartedAtMs);
      const toolStarted = answerActivities.find((value) => value.status === "tool_started");
      const toolCompleted = answerActivities.find((value) => value.status === "tool_completed");
      if (!business && (result.chart !== null || toolStarted)) throw new Error("问候冒烟不应查询业务或生成图表。");
      if (business && (!toolStarted || !toolCompleted)) throw new Error("业务冒烟未调用真实 query_xbb。");
      if (business && !result.chart) throw new Error("业务冒烟未生成辅助图表。");
      runs.push({
        answerMs,
        timeToToolMs: toolStarted ? toolStarted.at - answerStartedAtMs : null,
        toolMs: toolCompleted?.elapsedMs ?? null,
        hasChart: result.chart !== null,
        answerBytes: Buffer.byteLength(result.answer, "utf8")
      });
    }
    process.stdout.write(`${JSON.stringify({
      success: true,
      mode: business ? "live-business" : "greeting",
      codexVersion,
      model: config.codexModel,
      configuredEffort: config.codexReasoningEffort,
      turnEffort: business ? chooseTurnEffort(question, config.codexReasoningEffort) : config.codexReasoningEffort,
      skills: business ? ["xbb-executive-analyst", "xbb-executive-chart"] : [],
      warmMs,
      runs
    })}\n`);
  } finally {
    await agent.close().catch(() => {});
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

runSmoke().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
