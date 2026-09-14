"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PersistentCodexAgent, principalKeyFromUserId } = require("../shared/codex/persistent-agent.js");
const { readCodexVersion, verifyCodexChatGptLogin } = require("../shared/codex/runtime.js");

function elapsed(startedAtMs) {
  return Date.now() - startedAtMs;
}

async function runSmoke() {
  const business = process.argv.includes("--business");
  const minimal = process.argv.includes("--minimal");
  const multidimensional = process.argv.includes("--multidimensional");
  const daily = process.argv.includes("--daily");
  if (multidimensional && (!business || minimal)) throw new Error("--multidimensional 需要 --business 且不能与 --minimal 合用。");
  if (daily && (!business || minimal || multidimensional)) throw new Error("--daily 需要 --business 且不能与其他业务场景合用。");
  const repeatOption = process.argv.find((value) => value.startsWith("--repeat="));
  const repeat = repeatOption ? Number(repeatOption.split("=")[1]) : 1;
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 3) throw new Error("--repeat 必须是 1-3 的整数。");
  const projectRoot = path.resolve(__dirname, "..");
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "xbb-agent-smoke-"));
  const runtimePath = path.join(process.env.LOCALAPPDATA, "Codex", "xbb-executive-analyst", "bot-config.json");
  const runtime = fs.existsSync(runtimePath) ? JSON.parse(fs.readFileSync(runtimePath, "utf8").replace(/^\uFEFF/, "")) : {};
  const config = {
    projectRoot,
    agentStatePath: path.join(tempRoot, "agent-state.json"),
    // Live probes use the product's runner registry: all callers share the same
    // bundled runner/run root even though model threads and state are isolated.
    serviceLeasePath: business && runtime.serviceLeasePath ? runtime.serviceLeasePath : path.join(tempRoot, "service-lease.json"),
    agentTurnTimeoutMs: 300000,
    generalTurnTimeoutMs: 900000,
    codexModel: "gpt-6-astra",
    codexReasoningEffort: "xhigh",
    codexContextWindow: runtime.codexContextWindow || 872000,
    codexAutoCompactTokenLimit: runtime.codexAutoCompactTokenLimit || 750000,
    codexProxyUrl: runtime.codexProxyUrl,
    codexCommand: runtime.codexCommand,
    strictDataDemand: true
  };
  verifyCodexChatGptLogin(config);
  const codexVersion = readCodexVersion(config);
  const access = Object.freeze({ userId: "local-smoke", scope: "all", companies: Object.freeze([]) });
  const principalKey = principalKeyFromUserId(access.userId, access);
  const activities = [];
  const agent = new PersistentCodexAgent(config);
  const queryTrace = [];
  let expectedMinimalCount = null;
  let expectedPerformance = null;
  let expectedScope = null;
  let effectiveContextWindow = null;
  let artifactPath = null;
  const liveQuery = agent.queryXbb;
  agent.queryXbb = async (...args) => {
    let pack;
    try { pack = await liveQuery(...args); }
    catch (error) {
      // Only fixed classifications are printed; RPC/PowerShell errors can
      // contain tokens, command lines, paths or business scopes.
      const causes = [];
      for (let cause = error; cause && causes.length < 8; cause = cause.cause) {
        const raw = `${cause.message || ""}\n${cause.stderr || ""}`;
        const categories = [
          ["root_binding_timeout", /未在安全时限内绑定根进程身份/],
          ["root_pid_mismatch", /根进程 PID 与已启动进程不一致/],
          ["marker_read_failed", /隔离标记.*(?:无法读取|无效|无法读取或校验)|根进程绑定校验失败/],
          ["snapshot_incomplete", /process (?:identity|observation) is indeterminate/],
          ["snapshot_disagreement", /Wide (?:and directed|CIM snapshot omitted)/],
          ["sentinel_invalid", /(?:sentinel|CIM runner snapshot).*(?:invalid|failed|changed|omitted|empty)/i],
          ["native_handle_mismatch", /(?:Native runner process handle|process-object).*(?:match|identity)/i],
          ["recovery_timeout", /进程树回收超过硬截止/],
          ["recovery_failure", /隔离恢复未能确认/]
        ].filter(([, pattern]) => pattern.test(raw)).map(([name]) => name);
        causes.push({ categories, timedOut: cause.code === "ETIMEDOUT" || cause.killed === true });
      }
      process.stdout.write(`${JSON.stringify({ diagnostic: "query_failure", causes })}\n`);
      throw error;
    }
    queryTrace.push({ metrics: args[0].metrics, domains: args[0].domains, date: args[0].date, formNames: Object.keys(pack.provenance?.formIds || {}) });
    expectedMinimalCount = pack.facts?.opportunities?.summary?.wins ?? null;
    expectedPerformance = pack.facts?.performance || null;
    expectedScope = pack.scope || null;
    return pack;
  };
  agent.on("activity", (value) => {
    activities.push({ at: Date.now(), ...value });
    if (process.argv.includes("--progress")) process.stdout.write(`${JSON.stringify({ stage: value.status, reason: value.reason, modelErrorCode: value.modelErrorCode, elapsedMs: value.elapsedMs })}\n`);
  });
  try {
    await agent.start();
    agent.client.on("notification", (event) => {
      if (event.method === "thread/tokenUsage/updated") effectiveContextWindow = event.params?.tokenUsage?.modelContextWindow;
    });
    if (process.argv.includes("--progress")) agent.client.on("notification", (event) => {
      const failure = event.method === "turn/completed" ? event.params?.turn?.error : null;
      if (failure) process.stdout.write(`${JSON.stringify({ diagnostic: "model_failure", code: failure.codexErrorInfo,
        ...(/schema|tools|parameter|properties|function|pattern|anyOf|const/i.test(failure.message || "") ? { schemaDiagnostic: failure.message.slice(0,1400) } : {}),
        reason: /requires a newer version of Codex/i.test(failure.message || "") ? "model_requires_newer_codex" : "upstream_generation_error" })}\n`);
    });
    const warmStartedAtMs = Date.now();
    if (!process.argv.includes("--skip-warm")) await agent.warm({ access, principalKey });
    const warmMs = elapsed(warmStartedAtMs);

    const question = daily ? "今天业绩怎么样？" : multidimensional ? "今年公司的业绩怎么样，趋势是什么，其次哪个分公司业绩好。" : business
      ? minimal ? "集团2026年9月赢单商机数量是多少？只要赢单数量，不要跟进，不用图。"
        : "对集团2026年9月业绩按照公司名称排名，并区分课程和咨询占比。结论给老板看，尽量简短，并配一张图。"
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
      if (business && !minimal && !result.chart) throw new Error("业务冒烟未生成辅助图表。");
      if (business && !minimal && !multidimensional && !daily) {
        const combined = `${result.answer}\n${JSON.stringify(result.chart)}`;
        const firstCompany = expectedPerformance?.ranking?.[0]?.company;
        if (!firstCompany || !combined.includes(firstCompany) || !combined.includes("课程") || !combined.includes("咨询")) throw new Error("排名与业务结构问题未覆盖真实第一名和课程咨询两个维度。");
        if (queryTrace.some((trace) => trace.domains.some((domain) => domain !== "performance") || trace.metrics.some((metric) => !metric.startsWith("performance.")))) throw new Error("业绩排名分析不得额外查询无关业务。");
      }
      if (multidimensional) {
        const metrics = [...new Set(queryTrace.flatMap((trace) => trace.metrics || []))].sort();
        if (JSON.stringify(metrics) !== JSON.stringify(["performance.ranking", "performance.total", "performance.trend"])) throw new Error("三维问题未精确覆盖总额、趋势和公司比较。");
        if (result.chart?.type !== "composite" || result.chart.panels.length < 3) throw new Error("三维问题未生成至少三个互补面板。");
        if (!answerActivities.some((value) => value.status === "chart_agent_completed") || answerActivities.some((value) => value.status === "chart_agent_failed")) throw new Error("未通过原生 ultra 子 Agent 完成校验。");
        if (!answerActivities.some((value) => value.status === "chart_validated")) throw new Error("未经过出图前校验与手机预览。");
        const ranking = expectedPerformance?.ranking || [];
        const trend = expectedPerformance?.monthlyTrend || [];
        const panels = result.chart.panels;
        if (!panels.some((panel) => panel.type === "bar" && panel.categories.includes(ranking[0]?.company))) throw new Error("公司比较未覆盖真实第一名。");
        const trendValues = trend.map((row) => row.total);
        const chartSeries = panels.flatMap((panel) => panel.series || []);
        const sameAmounts = (actual, expected) => actual.length === expected.length && actual.every((value, i) => Math.abs(value - expected[i]) <= 0.01);
        if (!chartSeries.some((series) => sameAmounts(series.values, trendValues))) throw new Error("月度发生额与完整事实趋势不一致。");
        if (panels.some((panel) => !panel.findings?.length)) throw new Error("综合图存在没有可验证发现的面板。");
      }
      if (daily) {
        const { shanghaiDate } = require("../shared/xbb/fast-query-plan.js");
        const today = shanghaiDate(new Date(answerStartedAtMs));
        const metrics = [...new Set(queryTrace.flatMap((trace) => trace.metrics || []))].sort();
        if (JSON.stringify(metrics) !== JSON.stringify(["performance.ranking", "performance.total"])) throw new Error("宽泛今日问题未精确覆盖总额和分公司贡献。");
        if (queryTrace.some((trace) => trace.date !== today) || expectedScope?.date !== today || expectedScope?.currentMonthPartial) throw new Error("今日问题错误地使用了月累计范围。");
        const panels = result.chart.type === "composite" ? result.chart.panels : [result.chart];
        const ranking = expectedPerformance?.ranking || [];
        if (!panels.some((panel) => panel.type === "bar" && panel.categories.includes(ranking[0]?.company))) throw new Error("今日图未覆盖真实第一名。");
        if (panels.some((panel) => !panel.findings?.length)) throw new Error("今日分析图缺少可验证发现。");
        if (!answerActivities.some((value) => value.status === "chart_agent_completed") || answerActivities.some((value) => value.status === "chart_agent_failed")) throw new Error("今日出图未完成原生 ultra 委派。");
        if (!answerActivities.some((value) => value.status === "chart_validated")) throw new Error("今日图未经过校验与手机预览。");
      }
      if (multidimensional || daily) {
        if (process.argv.includes("--save-chart")) {
          const sharp = require("sharp");
          const { render } = require("../shared/xbb/render-chart.js");
          const chartRoot = path.join(process.env.LOCALAPPDATA, "Codex", "xbb-executive-analyst", "chart-preview");
          fs.mkdirSync(chartRoot, { recursive: true });
          const basename = `${daily ? "daily" : "multidimensional"}-${Date.now()}`;
          artifactPath = path.join(chartRoot, `${basename}.png`);
          const png = await sharp(Buffer.from(render(result.chart)), { density: 96 }).png().toBuffer();
          fs.writeFileSync(artifactPath, png);
          await sharp(png).resize({ width: 390 }).png().toFile(path.join(chartRoot, `${basename}-mobile.png`));
        }
      }
      if (answerActivities.some((value) => value.status === "answer_recovered")) throw new Error("模型冒烟必须由真实模型完成，不接受恢复路径代答。");
      if (minimal && result.chart) throw new Error("最小数量冒烟不得额外生成图片。");
      if (business && minimal) {
        if (result.answer.length > 240) throw new Error("简单单指标问题回答过长。");
        if (queryTrace.some((trace) => JSON.stringify(trace.metrics) !== JSON.stringify(["opportunities.wins"]) || JSON.stringify(trace.formNames) !== JSON.stringify(["opportunity"]))) throw new Error("最小冒烟发生了额外取数。");
        if (expectedMinimalCount === null || !(result.answer.match(/\d+/g) || []).includes(String(expectedMinimalCount))) throw new Error("模型答案未包含真实事实包中的赢单数量。");
      }
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
      configuredContextWindow: config.codexContextWindow,
      effectiveContextWindow,
      turnEffort: config.codexReasoningEffort,
      skills: business ? ["xbb-executive-analyst", "xbb-executive-chart"] : [],
      warmMs,
      ...(business && minimal ? { exactMetricVerified: true, answerMatchesLiveCount: true, sourceForms: [5614253] } : {}),
      ...(business && !minimal && !multidimensional && !daily ? { rankingAndMixCovered: true, unrelatedDomainsQueried: false } : {}),
      ...(multidimensional ? { allThreeDimensionsCovered: true, currentFactsVerified: true, nativeUltraChildCompleted: true, artifactPath } : {}),
      ...(daily ? { broadQuestionChartVerified: true, exactDayScopeVerified: true, nativeUltraChildCompleted: true, artifactPath } : {}),
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
