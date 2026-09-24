"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { runDeliveryChecks } = require("../tests/verify-production-metrics.js");
const { summarizeTimings, percentile } = require("../shared/observability/request-metrics.js");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const GREETING = "你好。请只用一句中文说明你是通用编程助手，不调用任何工具。";
const FIXED_WORKLOADS = Object.freeze([
  { id: "exact-format", question: "不要调用任何工具。严格只回复四个大写字母 READY，不加标点。", matches: (answer) => answer.trim() === "READY" },
  { id: "small-reasoning", question: "不调用工具。一个函数把数组 [3,1,3,2] 去重后升序排列。严格只回复结果数组的 JSON，不解释。", matches: (answer) => /^\[\s*1\s*,\s*2\s*,\s*3\s*\]$/.test(answer.trim()) },
  { id: "constraint-following", question: "不调用工具。把英文 apple 翻译成中文。只输出译文，不加解释、标点、拼音或英文。", matches: (answer) => answer.trim() === "苹果" }
]);

function summarizeLiveSamples(samples) {
  const summary = (values) => ({ count: values.length, passed: values.filter((sample) => sample.passed).length,
    failed: values.filter((sample) => !sample.passed).length,
    timeouts: values.filter((sample) => sample.failure === "AgentTurnTimeoutError" || sample.failure === "REQUEST_DEADLINE_EXCEEDED").length,
    p50Ms: percentile(values.map((sample) => sample.answerMs), 0.5),
    p95Ms: percentile(values.map((sample) => sample.answerMs), 0.95),
    p99Ms: percentile(values.map((sample) => sample.answerMs), 0.99) });
  return { ...summary(samples), byScenario: Object.fromEntries([...new Set(samples.map((sample) => sample.scenario))].map((scenario) => [scenario, summary(samples.filter((sample) => sample.scenario === scenario))])) };
}

function parseOptions(args) {
  const allowed = /^(?:--live|--business|--context|--workload|--preview|--repeat=[1-5])$/;
  if (args.some((arg) => !allowed.test(arg))) throw new Error("参数仅支持 --live [--repeat=1..5] [--context] [--business] [--workload] [--preview]。");
  if (!args.includes("--live") && args.some((arg) => arg !== "--repeat=1")) {
    if (args.length) throw new Error("在线场景必须显式指定 --live；默认只运行离线交付故障基准。");
  }
  return { live: args.includes("--live"), business: args.includes("--business"), context: args.includes("--context"), workload: args.includes("--workload"), preview: args.includes("--preview"), repeat: Number(args.find((arg) => arg.startsWith("--repeat="))?.split("=")[1] || 3) };
}

function runtimeRoot() {
  return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Codex", "xbb-executive-analyst");
}

function readProbeConfig() {
  const configPath = process.env.XBB_BOT_CONFIG_PATH || path.join(runtimeRoot(), "bot-config.json");
  const configured = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, "")) : {};
  // Do not decrypt or copy the bot secret, credentials, policy, or production state.
  const codexModel = configured.codexModel || "gpt-6-astra";
  const codexReasoningEffort = configured.codexReasoningEffort || "xhigh";
  if (!/^[a-zA-Z0-9._-]{1,128}$/.test(codexModel) || !["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(codexReasoningEffort)) throw new Error("本机模型配置不合法。");
  const productionStatePath = process.env.XBB_AGENT_STATE_PATH || configured.agentStatePath || path.join(runtimeRoot(), "agent-state.json");
  if (!path.isAbsolute(productionStatePath)) throw new Error("生产状态文件必须是绝对路径。");
  return { codexModel, codexReasoningEffort, codexProxyUrl: configured.codexProxyUrl, codexCommand: configured.codexCommand, modelDrivenQueries: true, productionStatePath };
}

async function liveProbe(options) {
  const { PersistentCodexAgent, principalKeyFromUserId } = require("../shared/codex/persistent-agent.js");
  const { readCodexVersion } = require("../shared/codex/runtime.js");
  const { productionStatePath, ...modelConfig } = readProbeConfig();
  const assertProductionIdle = () => {
    const statePath = productionStatePath;
    if (fs.existsSync(statePath)) {
      const state = JSON.parse(fs.readFileSync(statePath, "utf8").replace(/^\uFEFF/, ""));
      if (Object.values(state.threads || {}).some((thread) => thread.turnInProgress)) throw new Error("生产存在活跃回合，跳过业务探针以免争用。");
    }
  };
  if (options.business) assertProductionIdle();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "xbb-production-probe-"));
  const config = { ...modelConfig, projectRoot: PROJECT_ROOT,
    agentStatePath: path.join(tempRoot, "agent-state.json"), serviceLeasePath: path.join(tempRoot, "service-lease.json"),
    agentTurnTimeoutMs: 300000, generalTurnTimeoutMs: 180000, generalTotalTimeoutMs: 240000
  };
  const agent = new PersistentCodexAgent(config);
  const events = [];
  let scheduling = [];
  let dataSources = new Set();
  let allowBusinessQuery = false;
  agent.on("activity", (value) => events.push({ status: value.status, elapsedMs: value.elapsedMs, at: performance.now() }));
  const originalQuery = agent.queryXbb;
  agent.queryXbb = (input, access, invocation) => {
    if (!allowBusinessQuery) throw new Error("PROBE_QUERY_FORBIDDEN");
    assertProductionIdle();
    return originalQuery(input, access, { ...invocation, onProgress: (value) => {
      if (["live", "encrypted-cache"].includes(value?.source)) dataSources.add(value.source);
      return invocation?.onProgress?.(value);
    }, onTiming: (value) => {
    // Gateway owns and whitelists these numeric / enum fields.
    scheduling.push({ stage: value.stage, elapsedMs: value.elapsedMs, queueWaitMs: value.queueWaitMs, runMs: value.runMs, shared: value.shared });
    invocation?.onTiming?.(value);
    } });
  };
  const access = Object.freeze({ userId: "local-production-probe", scope: "all", companies: Object.freeze([]) });
  const principalKey = principalKeyFromUserId(access.userId, access);
  const samples = [];
  const probe = async (scenario, question, validate) => {
    const eventIndex = events.length;
    scheduling = [];
    dataSources = new Set();
    allowBusinessQuery = scenario === "live-readonly-performance" && options.business;
    const before = performance.now();
    const preview = { count: 0, firstReadyMs: null, modelFirstDeltaMs: null, maxBytes: 0 };
    let response;
    try { response = await agent.answer({ question, access, principalKey, messageId: `local-probe-${samples.length + 1}`,
      onTiming: (event) => {
        if (event.stage === "model_first_delta" && preview.modelFirstDeltaMs === null) preview.modelFirstDeltaMs = Math.round(performance.now() - before);
      },
      onAnswerPreview: (value) => {
        if (value?.isCurrent?.() !== true || typeof value.text !== "string" || !value.text.trim()) return;
        preview.count += 1;
        if (preview.firstReadyMs === null) preview.firstReadyMs = Math.round(performance.now() - before);
        preview.maxBytes = Math.max(preview.maxBytes, Buffer.byteLength(value.text, "utf8"));
      }
    }); }
    catch (error) {
      const failure = { scenario, passed: false, answerMs: Math.round(performance.now() - before),
        failure: error?.code === "REQUEST_DEADLINE_EXCEEDED" ? error.code : ["AgentTurnTimeoutError", "AgentTurnFailureError", "AccessDeniedError"].includes(error?.name) ? error.name : "probe_failed",
        modelErrorCode: ["unauthorized", "connection_failed", "usage_limit", "context_limit", "invalid_request", "service_error"].includes(error?.modelErrorCode) ? error.modelErrorCode : null,
        stages: events.slice(eventIndex).map((event) => event.status), scheduling: [...scheduling], preview
      };
      samples.push(failure);
      options.onSample?.(failure);
      process.stdout.write(`${JSON.stringify({ probe: scenario, answerMs: failure.answerMs, passed: false, failure: failure.failure, modelErrorCode: failure.modelErrorCode })}\n`);
      return;
    }
    const answerMs = Math.round(performance.now() - before);
    const currentEvents = events.slice(eventIndex);
    preview.leadMs = preview.firstReadyMs === null ? null : Math.max(0, answerMs - preview.firstReadyMs);
    const checks = await validate(response, currentEvents, preview);
    const sample = { scenario, answerMs, passed: Object.values(checks).every(Boolean), checks,
      answerBytes: Buffer.byteLength(response.answer, "utf8"), hasChart: Boolean(response.chart), hasFinding: Boolean(response.chart?.finding),
      toolMs: currentEvents.find((event) => event.status === "tool_completed")?.elapsedMs ?? null,
      contextRotations: currentEvents.filter((event) => event.status === "context_rotated").length,
      dataSources: [...dataSources],
      scheduling: [...scheduling], preview
    };
    samples.push(sample);
    options.onSample?.(sample);
    // No answer, question, tool output, user ID, thread ID or business figure is printed.
    process.stdout.write(`${JSON.stringify({ probe: scenario, answerMs, passed: sample.passed, hasChart: sample.hasChart, preview })}\n`);
  };
  try {
    const start = performance.now();
    await agent.start();
    const startupMs = Math.round(performance.now() - start);
    const warmStart = performance.now();
    // Fixed workloads start with a genuinely cold general Thread; no business
    // skill warmup is charged to or hidden ahead of the first measured sample.
    if (!options.workload) await agent.warm({ access, principalKey });
    const warmMs = Math.round(performance.now() - warmStart);
    const generalChecks = (response, currentEvents) => ({ nonempty: Boolean(response.answer?.trim()), generalRoute: response.routeMode === "general", noBusinessQuery: !currentEvents.some((event) => event.status === "tool_started"), noChart: response.chart === null });
    if (options.workload) {
      for (let index = 0; index < options.repeat; index += 1) {
        for (const workload of FIXED_WORKLOADS) await probe(workload.id, workload.question,
          (response, currentEvents) => ({ ...generalChecks(response, currentEvents), expectedAnswer: workload.matches(response.answer) }));
      }
    } else {
      for (let index = 0; index < options.repeat; index += 1) await probe("baseline-greeting", GREETING, generalChecks);
      await probe("strict-greeting", "你好", generalChecks);
    }
    if (options.preview) {
      await probe("general-answer-preview", "不调用任何工具。请为新入职的后端工程师解释幂等、事务、重试、超时、取消五个概念及它们之间的区别，每个概念用两个自然段给出解释与一个贴近日常开发的例子，总计约700字。用空行分段，不使用HTML、代码块或表格。只输出给读者的正文。", (response, currentEvents, preview) => ({
        ...generalChecks(response, currentEvents), meaningfulLength: response.answer.length >= 400,
        previewAvailable: preview.count > 0, earlierThanFinal: preview.leadMs > 0,
        boundedPreview: preview.maxBytes <= 18000
      }));
    }
    if (options.context) {
      const question = [
        "以下为虚构工程验收场景，不连接任何数据库、不执行 SQL。请给迁移计划，明确当前只是方案。",
        "原始目标：把订单表金额从浮点数迁移为整数分，保留旧接口兼容；维护窗口最多60秒，旧字段不可删除。",
        "结构样例（虚构，不是生产库）：\n```sql\nCREATE TABLE orders (id bigint PRIMARY KEY, amount double precision, created_at timestamp);\n```",
        ...Array.from({ length: 30 }, (_, index) => `上下文说明${index + 1}：读接口、写接口和定时统计均引用金额字段，依赖需逐一确认。不能凭样例推断真实数据分布。`),
        "关键约束：资金不能丢失精度；分批回填必须幂等，失败可回滚；必须说明校验与停止条件。",
        "按现状与目标、影响、迁移及回滚、验证、执行条件五段简洁回答。"
      ].join("\n\n");
      await probe("database-plan", question, (response, currentEvents) => {
        const checkpoint = agent.sessions.get(principalKey)?.taskCheckpoint;
        return { ...generalChecks(response, currentEvents), rollback: /回滚|回退/.test(response.answer), validation: /校验|验证/.test(response.answer), planOnly: /方案|未执行|不执行|只读/.test(response.answer),
          checkpointBound: Boolean(checkpoint?.revision && checkpoint.materials?.count > 0),
          executionUnverified: checkpoint?.executionStatus === "not-executed" && checkpoint.stages.every((stage) => stage.verified === false) };
      });
      // Isolated fault injection: exercise a real replacement Thread without
      // touching the production agent or waiting 24 real turns.
      agent.sessions.get(principalKey).turnCount = 24;
      await probe("context-rotation-correction", "继续刚才的数据库迁移目标。修正：维护窗口改为30秒，旧接口兼容保留90天，其他限制不变。请先复述保留的目标与约束，再给下一步，仍不执行任何变更。", (response, currentEvents) => ({
        ...generalChecks(response, currentEvents), rotated: currentEvents.some((event) => event.status === "context_rotated"),
        checkpointRevised: agent.sessions.get(principalKey)?.taskCheckpoint?.revision > 1,
        preservesGoal: /整数分|金额.*分|浮点/.test(response.answer), revisedWindow: /30\s*秒|三十秒/.test(response.answer), revisedCompatibility: /90\s*天|九十天/.test(response.answer), retainsRestriction: /不.*删除|保留.*旧字段|旧字段.*保留/.test(response.answer)
      }));
    }
    if (options.business) {
      assertProductionIdle();
      const month = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit" }).replace(/\//g, "-");
      const [year, currentMonth] = month.match(/^\d{4}-\d{2}$/) ? month.split("-") : [String(new Date().getFullYear()), String(new Date().getMonth() + 1).padStart(2, "0")];
      await probe("live-readonly-performance", `请只查询${year}年${Number(currentMonth)}月集团业绩（performance），按公司名称排名，给简短结论并配一张辅助图，不扩展其他数据域。`, async (response, currentEvents, preview) => {
        const { createWecomChartImage, createWecomAnswerImage } = require("../shared/wecom/chart-image.js");
        let supportingImage = false;
        try {
          const rendered = await (response.chart ? createWecomChartImage(response.chart) : createWecomAnswerImage(response.answer));
          supportingImage = Boolean(rendered?.item?.image?.base64 && rendered?.buffer?.length);
        } catch {}
        return { queried: currentEvents.some((event) => event.status === "tool_started"), verified: currentEvents.some((event) => event.status === "tool_completed"), supportingImage, businessRoute: response.routeMode === "xbb", noBusinessPreview: preview.count === 0,
          governedInsight: !response.chart || (response.chart.finding ? response.chart.insight.startsWith("图内计算") : response.chart.insight.startsWith("兼容概述")) };
      });
    }
    const greetingMs = samples.filter((sample) => sample.scenario === "baseline-greeting").map((sample) => sample.answerMs);
    return { model: config.codexModel, configuredEffort: config.codexReasoningEffort, codexVersion: readCodexVersion(config), startupMs, warmMs,
      greeting: { count: greetingMs.length, p50: percentile(greetingMs, 0.5), p95: percentile(greetingMs, 0.95) },
      workloadVersion: options.workload ? "general-fixed-v1" : null, workloadStartsCold: options.workload, summary: summarizeLiveSamples(samples), samples,
      caveat: "低频小样本；未向企微发送消息；不代表生产SLA、手机首字或持续在线率。" };
  } finally {
    let closeFailed = false;
    await agent.close().catch(() => { closeFailed = true; });
    const { runnerIsolationDirectory, recoverRunnerIsolation } = require("../shared/xbb/runner-isolation.js");
    const markerDirectory = runnerIsolationDirectory(config.serviceLeasePath);
    const hasMarkers = () => fs.existsSync(markerDirectory) && fs.readdirSync(markerDirectory).length > 0;
    if (hasMarkers()) {
      try {
        await recoverRunnerIsolation({ projectRoot: PROJECT_ROOT, serviceLeasePath: config.serviceLeasePath });
        if (hasMarkers()) throw new Error("markers remain");
      } catch {
        // Preserve recovery evidence. Never delete a possibly live process marker.
        process.stderr.write(`${JSON.stringify({ probeCleanup: "isolation_unconfirmed", retainedDirectory: tempRoot })}\n`);
        throw new Error("PROBE_ISOLATION_UNCONFIRMED");
      }
    }
    // Only the explicitly created temporary probe directory is removed.
    if (closeFailed) {
      process.stderr.write(`${JSON.stringify({ probeCleanup: "agent_close_unconfirmed", retainedDirectory: tempRoot })}\n`);
      throw new Error("PROBE_CLOSE_UNCONFIRMED");
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function main(args = process.argv.slice(2)) {
  const options = parseOptions(args);
  const offline = await runDeliveryChecks();
  const report = { schemaVersion: "1.0", at: new Date().toISOString(), platform: process.platform, node: process.version,
    offline: { synthetic: true, checks: offline.checks, timings: summarizeTimings(offline.samples) },
    live: null
  };
  let failedLifecycle = false;
  const retainedSamples = [];
  if (options.live) {
    try { report.live = await liveProbe({ ...options, onSample: (sample) => retainedSamples.push(sample) }); }
    catch { failedLifecycle = true; report.live = { samples: retainedSamples, lifecycleFailure: "startup_or_cleanup_failed", caveat: "未输出凭据、正文或上游错误；本次在线生命周期失败，不能作为通过样本。" }; }
  }
  report.success = !failedLifecycle && (!report.live || report.live.samples.every((sample) => sample.passed));
  const directory = path.join(PROJECT_ROOT, "test-results", "production");
  fs.mkdirSync(directory, { recursive: true });
  const filename = path.join(directory, `benchmark-${report.at.replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(filename, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ success: report.success, report: filename, live: options.live })}\n`);
  if (!report.success) process.exitCode = 1;
  return report;
}

if (require.main === module) main().catch(() => { process.stderr.write("生产探针未通过；未输出正文或上游异常详情，请核查本机登录与安全状态日志。\n"); process.exitCode = 1; });
module.exports = { FIXED_WORKLOADS, parseOptions, summarizeLiveSamples, liveProbe, main };
