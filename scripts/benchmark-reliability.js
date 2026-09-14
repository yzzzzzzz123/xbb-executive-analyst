"use strict";

// Offline component exercise, NOT a load generator or a model/network benchmark.
// Real handler/store/gateway code runs; all external boundaries are injected.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { AsyncLocalStorage } = require("node:async_hooks");
const { performance } = require("node:perf_hooks");
const { createLongConnectionHandler } = require("../shared/wecom/long-connection-handler.js");
const { AgentTurnTimeoutError } = require("../shared/codex/persistent-agent.js");
const { createToolGatewayForTest } = require("../shared/xbb/tool-gateway.js");
const { TIMING_FIELDS, percentile } = require("../shared/observability/request-metrics.js");

const DEFAULT_SEED = 20260909;
const HANDLER_BUDGETS = Object.freeze({
  progressDrainBudgetMs: 25, replyBudgetMs: 100, renderBudgetMs: 800, uploadBudgetMs: 800,
  mediaDeliveryBudgetMs: 100, businessRequestBudgetMs: 750, generalRequestBudgetMs: 750, analysisDeliveryReserveMs: 100
});
const SCENARIOS = Object.freeze([
  "general", "chart", "cache-replay", "denied", "agent-failure", "agent-timeout",
  "upload-failure", "render-failure", "progress-upload-timeout",
  "media-failure", "first-reply-timeout", "final-reply-timeout", "agent-never-settles", "cumulative-delivery-deadline"
]);
const OUTCOMES = Object.freeze(["success", "degraded", "denied", "cancelled", "rejected", "failed", "timeout"]);
const EXPECTED = Object.freeze({
  general: "success", chart: "success", "cache-replay": "success", denied: "denied",
  "agent-failure": "failed", "agent-timeout": "timeout", "upload-failure": "degraded",
  "render-failure": "degraded", "progress-upload-timeout": "degraded", "media-failure": "degraded",
  "first-reply-timeout": "timeout", "final-reply-timeout": "timeout", "agent-never-settles": "timeout", "cumulative-delivery-deadline": "degraded"
});
const tick = () => new Promise((resolve) => setImmediate(resolve));
const roundMs = (value) => Math.round(value * 1000) / 1000;

function normalizeOptions(options = {}) {
  const result = { seed: options.seed ?? DEFAULT_SEED, rounds: options.rounds ?? 4,
    users: options.users ?? 8, concurrency: options.concurrency ?? 4 };
  for (const [key, min, max] of [["seed", 0, 0xffffffff], ["rounds", 1, 20], ["users", 2, 32], ["concurrency", 1, 16]]) {
    if (!Number.isInteger(result[key]) || result[key] < min || result[key] > max) throw new Error(`Invalid ${key}: expected integer ${min}..${max}`);
  }
  return result;
}

function makePlan(options = {}) {
  const config = normalizeOptions(options);
  let state = config.seed >>> 0;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const plan = [];
  for (let round = 0; round < config.rounds; round += 1) {
    const scenarios = [...SCENARIOS];
    for (let index = scenarios.length - 1; index > 0; index -= 1) {
      const other = Math.floor(random() * (index + 1));
      [scenarios[index], scenarios[other]] = [scenarios[other], scenarios[index]];
    }
    for (const scenario of scenarios) plan.push({
      id: `h${plan.length + 1}`, round, scenario,
      user: Math.floor(random() * config.users), ticks: Math.floor(random() * 3)
    });
  }
  return plan;
}

function distribution(values) {
  return { count: values.length, p50Ms: percentile(values, 0.5), p95Ms: percentile(values, 0.95),
    p99Ms: percentile(values, 0.99), maxMs: values.length ? Math.max(...values) : null };
}

function summarize(samples) {
  const outcomes = Object.fromEntries(OUTCOMES.map((outcome) => [outcome, 0]));
  for (const sample of samples) outcomes[sample.outcome] += 1;
  const timedOut = outcomes.timeout;
  const succeeded = outcomes.success + outcomes.degraded;
  return {
    sampleCount: samples.length, outcomes,
    terminal: { succeeded, failed: samples.length - succeeded - timedOut, timedOut },
    expectedFaultSamples: samples.filter((sample) => sample.expectedOutcome !== "success").length,
    unexpectedSamples: samples.filter((sample) => !sample.passed).length,
    censoredSamples: samples.filter((sample) => sample.censored).length,
    observedElapsed: distribution(samples.map((sample) => sample.elapsedMs)),
    uncensoredElapsed: distribution(samples.filter((sample) => !sample.censored).map((sample) => sample.elapsedMs)),
    byOutcome: Object.fromEntries(OUTCOMES.map((outcome) => [outcome, distribution(samples.filter((sample) => sample.outcome === outcome).map((sample) => sample.elapsedMs))])),
    byExecution: Object.fromEntries([...new Set(samples.map((sample) => sample.execution))].sort().map((execution) =>
      [execution, distribution(samples.filter((sample) => sample.execution === execution).map((sample) => sample.elapsedMs))]))
  };
}

async function bounded(operation, budgetMs = 5000) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error("Synthetic benchmark safety deadline exceeded");
        error.code = "BENCHMARK_DEADLINE";
        reject(error);
      }, budgetMs);
    })]);
  } finally { clearTimeout(timer); }
}

async function runHandlerBatch(plan, config) {
  const local = new AsyncLocalStorage();
  const samples = [];
  const policy = { schemaVersion: "1.0", users: Object.fromEntries(Array.from({ length: config.users }, (_, index) =>
    [`synthetic-user-${index}`, { scope: "all" }])) };
  const image = { item: { msgtype: "image", image: { base64: "c3ludGhldGlj", md5: "d41d8cd98f00b204e9800998ecf8427e" } }, buffer: Buffer.from("synthetic-not-a-production-image") };
  const context = () => { const value = local.getStore(); assert.ok(value, "Synthetic request context missing"); return value; };
  const stall = (value) => new Promise((resolve) => { context().releases.push(() => resolve(value)); });
  const fault = (name) => { context().faults.add(name); };
  const handler = createLongConnectionHandler({
    policy, principalKeyFactory: (userId) => userId, streamIdFactory: () => `synthetic-stream-${context().item.id}`,
    ...HANDLER_BUDGETS, heartbeatMs: 60000, renderAttempts: 1, transportAttempts: 1,
    retryWait: async () => {}, emergencyImageFactory: () => image,
    statusWriter: (value) => {
      if (value.status === "request_measured") context().metrics.push({ outcome: value.outcome,
        imageDelivery: value.imageDelivery, timings: Object.fromEntries(TIMING_FIELDS.filter((key) => Number.isFinite(value.timings?.[key])).map((key) => [key, value.timings[key]])) });
    },
    agent: { answer: async ({ messageId, onProgress, signal }) => {
      const state = context();
      state.agentCalls += 1;
      assert.equal(messageId, `synthetic-${state.item.id}`);
      for (let index = 0; index < state.item.ticks; index += 1) await tick();
      switch (state.item.scenario) {
        case "agent-failure": fault("agent-failure"); throw new Error("synthetic agent failure");
        case "agent-timeout": fault("agent-timeout"); throw new AgentTurnTimeoutError("xbb", 1);
        case "agent-never-settles":
          fault("agent-stall");
          signal?.addEventListener("abort", () => state.faults.add("agent-deadline"), { once: true });
          return stall({ answer: "synthetic-late-agent-result", routeMode: "xbb", chart: null });
        case "progress-upload-timeout":
          onProgress("synthetic-progress-inflight");
          onProgress("synthetic-progress-obsolete");
          break;
      }
      return { answer: "离线验收替身答复，不含经营事实。", routeMode: state.item.scenario === "general" ? "general" : "xbb",
        chart: state.item.scenario === "general" ? null : { type: "bar" } };
    } },
    chartRenderer: async () => {
      context().renders += 1;
      if (context().item.scenario === "cumulative-delivery-deadline") {
        fault("render-consumes-shared-budget");
        await new Promise((resolve) => setTimeout(resolve, 300));
        context().renderCompleted = true;
      }
      if (context().item.scenario === "render-failure") {
        fault("chart-failure"); throw new Error("synthetic schema failure");
      }
      return image;
    },
    answerRenderer: async () => {
      context().fallbackRenders += 1;
      throw new Error("text-only images must never be rendered");
    }
  });
  const client = {
    async replyStream(frame, _stream, content, finish, items) {
      const state = context();
      assert.equal(frame.body.from.userid, state.item.scenario === "denied" ? "synthetic-denied" : `synthetic-user-${state.item.user}`);
      state.replyAttempts += 1;
      if (state.item.scenario === "first-reply-timeout" || (state.item.scenario === "final-reply-timeout" && finish)) {
        fault(state.item.scenario); return stall();
      }
      if (content === "synthetic-progress-inflight") { fault("progress-timeout"); return stall(); }
      if (content === "synthetic-progress-obsolete") state.obsoleteProgress += 1;
      if (finish) state.finalReplies.push({ imageCount: items?.length || 0 });
      return { synthetic: true };
    },
    async uploadMedia() {
      context().uploads += 1;
      if (context().item.scenario === "upload-failure") { fault("upload-failure"); throw new Error("synthetic upload failure"); }
      if (["progress-upload-timeout", "cumulative-delivery-deadline"].includes(context().item.scenario)) { fault("upload-timeout"); return stall({ media_id: "synthetic-late" }); }
      return { media_id: "synthetic-media" };
    },
    async sendMediaMessage(target) {
      assert.equal(target, `synthetic-user-${context().item.user}`);
      context().mediaAttempts += 1;
      if (context().item.scenario === "media-failure") { fault("media-failure"); throw new Error("synthetic media failure"); }
      context().mediaDelivered += 1;
    }
  };

  async function request(item, replay = false) {
    const state = { item, releases: [], faults: new Set(), metrics: [], agentCalls: 0, renders: 0,
      fallbackRenders: 0, uploads: 0, mediaAttempts: 0, mediaDelivered: 0, replyAttempts: 0, finalReplies: [], obsoleteProgress: 0 };
    const started = performance.now();
    let caught;
    await local.run(state, async () => {
      try {
        await bounded(() => handler.handleMessage({ headers: { req_id: `synthetic-${item.id}-${replay ? "replay" : "new"}` }, body: {
          msgid: `synthetic-${item.id}`, chattype: "single", from: { userid: item.scenario === "denied" ? "synthetic-denied" : `synthetic-user-${item.user}` },
          msgtype: "text", text: { content: item.scenario === "general" ? "不要查询销帮帮。你好，请介绍编程能力。" : "集团业绩（离线协议测试，禁止真实查询）" }
        } }, client));
      } catch (error) { caught = error; }
    });
    const elapsedMs = roundMs(performance.now() - started);
    const mediaAtCompletion = state.mediaAttempts;
    const repliesAtCompletion = state.replyAttempts;
    for (const release of state.releases) release();
    await tick();
    const measured = state.metrics[0];
    const timeout = ["BENCHMARK_DEADLINE", "DELIVERY_TIMEOUT", "REQUEST_DEADLINE_EXCEEDED"].includes(caught?.code)
      || state.faults.has("agent-timeout") || state.faults.has("agent-deadline");
    const outcome = timeout ? "timeout" : caught ? "failed" : item.scenario === "denied" ? "denied" : measured?.outcome || (replay ? "success" : "failed");
    const expectedOutcome = replay ? "success" : EXPECTED[item.scenario];
    const checks = {
      expectedOutcome: outcome === expectedOutcome,
      completedWithinSafetyGuard: caught?.code !== "BENCHMARK_DEADLINE",
      metricsExactlyOnce: state.metrics.length === (replay || item.scenario === "denied" ? 0 : 1),
      agentAdmission: state.agentCalls === (replay || ["denied", "first-reply-timeout"].includes(item.scenario) ? 0 : 1),
      finalDelivery: state.finalReplies.length === (["first-reply-timeout", "final-reply-timeout"].includes(item.scenario) ? 0 : 1),
      noLateMedia: state.mediaAttempts === mediaAtCompletion,
      noLateReplyAttempts: state.replyAttempts === repliesAtCompletion,
      noObsoleteProgress: state.obsoleteProgress === 0,
      failureMetric: !["agent-failure", "agent-timeout", "agent-never-settles"].includes(item.scenario) || measured?.outcome === "failed",
      cumulativeBudget: item.scenario !== "cumulative-delivery-deadline" || (state.renderCompleted === true
        && state.fallbackRenders === 0 && measured?.timings.uploadMs < HANDLER_BUDGETS.uploadBudgetMs
        && elapsedMs < HANDLER_BUDGETS.businessRequestBudgetMs * 2),
      replayDidNotRegenerate: !replay || (state.renders === 0 && state.fallbackRenders === 0 && state.uploads === 0 && state.mediaAttempts === 0),
      noTextImageFallback: state.fallbackRenders === 0,
      imageContract: ["first-reply-timeout", "final-reply-timeout"].includes(item.scenario)
        || (["general", "denied", "agent-failure", "agent-timeout", "agent-never-settles", "render-failure"].includes(item.scenario)
          ? state.mediaDelivered === 0 && state.finalReplies.at(-1)?.imageCount === 0
          : state.mediaDelivered === 1 || state.finalReplies.at(-1)?.imageCount === 1)
    };
    const requiredFaults = {
      "upload-failure": ["upload-failure"],
      "render-failure": ["chart-failure"],
      "progress-upload-timeout": ["progress-timeout", "upload-timeout"],
      "media-failure": ["media-failure"], "agent-failure": ["agent-failure"], "agent-timeout": ["agent-timeout"],
      "first-reply-timeout": ["first-reply-timeout"], "final-reply-timeout": ["final-reply-timeout"],
      "agent-never-settles": ["agent-stall", "agent-deadline"], "cumulative-delivery-deadline": ["render-consumes-shared-budget", "upload-timeout"]
    };
    checks.faultsExercised = (requiredFaults[item.scenario] || []).every((name) => state.faults.has(name));
    samples.push({ id: `${item.id}${replay ? "-replay" : ""}`, scenario: replay ? "cache-replay-hit" : item.scenario === "cache-replay" ? "cache-prime" : item.scenario,
      user: item.user, source: "synthetic", execution: replay ? "message-cache-replay" : "handler-new-request",
      expectedOutcome, outcome, elapsedMs, censored: caught?.code === "BENCHMARK_DEADLINE", faults: [...state.faults].sort(),
      agentCalls: state.agentCalls, metrics: measured || null, checks, passed: Object.values(checks).every(Boolean) });
  }
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(config.concurrency, plan.length) }, async () => {
    while (cursor < plan.length) {
      const item = plan[cursor++];
      await request(item);
      if (item.scenario === "cache-replay") await request(item, true);
    }
  }));
  return samples.sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
}

async function runQueryRound(round) {
  // provenance.live is a required protocol field, not evidence of a live query:
  // this empty pack exists only inside the injected fake process and is never reported.
  const canonical = { scope: { month: "2026-01", domains: ["performance"] }, entityResolution: {},
    provenance: { live: true, readOnly: true, telephoneFieldsExported: false, credentialFieldsExported: false },
    facts: {}, limitations: ["Synthetic empty protocol fixture; no live data"] };
  const pack = { status: "ready", ...canonical, integrity: { algorithm: "sha256", factPackSha256: crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex") } };
  const runs = [];
  const fixturePaths = [];
  const samples = [];
  const pending = [];
  const controllers = [];
  let active = 0;
  let maxActive = 0;
  let observerCalls = 0;
  let releaseObserver;
  const observer = new Promise((resolve) => { releaseObserver = resolve; });
  const query = createToolGatewayForTest({ testOnlyPlatform: "linux", powershell: "synthetic-never-spawned",
    maxConcurrentQueries: 1, maxQueuedQueries: 1, queueTtlMs: 80, progressPollMs: 10,
    execFile: (_command, args, options) => new Promise((resolve, reject) => {
      fixturePaths.push(path.dirname(args[args.indexOf("-OutputPath") + 1]));
      active += 1;
      maxActive = Math.max(maxActive, active);
      let settled = false;
      const complete = (error) => {
        if (settled) return;
        settled = true;
        active -= 1;
        options.signal.removeEventListener("abort", abort);
        if (error) reject(error);
        else {
          fs.writeFileSync(args[args.indexOf("-OutputPath") + 1], JSON.stringify(pack), "utf8");
          resolve({ stdout: "", stderr: "" });
        }
      };
      const abort = () => complete(options.signal.reason || new Error("synthetic cleanup"));
      options.signal.addEventListener("abort", abort, { once: true });
      runs.push({ scope: JSON.parse(options.stdinText).company, complete, signal: options.signal });
    })
  });
  const submit = (label, company, expectedOutcome, extra = {}) => {
    const controller = new AbortController();
    controllers.push(controller);
    const events = [];
    const started = performance.now();
    const promise = query({ months: ["2026-01"], domains: ["performance"], company }, { scope: "all" }, {
      ...extra, signal: controller.signal, onTiming: (event) => { events.push(event); extra.onTiming?.(event); }
    }).then(() => ({ outcome: "success" }), (error) => ({ outcome: error.code === "XBB_QUERY_QUEUE_TIMEOUT" ? "timeout"
      : error.code === "XBB_QUERY_QUEUE_FULL" ? "rejected" : controller.signal.aborted ? "cancelled" : "failed" }))
      .then(({ outcome }) => {
        const expectedStages = { success: "completed", failed: "failed", rejected: "rejected", cancelled: "cancelled", timeout: "expired" };
        const checks = { expectedOutcome: outcome === expectedOutcome, terminalTiming: events.at(-1)?.stage === expectedStages[outcome],
          timingNumbers: events.every((event) => [event.elapsedMs, event.queueWaitMs, event.runMs].every((value) => Number.isInteger(value) && value >= 0)) };
        const sample = { id: `q${round}-${label}`, scenario: label, user: samples.length, source: "synthetic", execution: "query-gateway-stub",
          expectedOutcome, outcome, elapsedMs: roundMs(performance.now() - started), censored: false, checks, passed: Object.values(checks).every(Boolean),
          stages: events.map((event) => event.stage), shared: events.some((event) => event.shared) };
        samples.push(sample);
        return sample;
      });
    pending.push(promise);
    return { promise, controller };
  };
  let batchError = false;
  try {
    await bounded(async () => {
      const primary = submit("shared-cancel", "synthetic-shared", "cancelled");
      const shared = submit("shared-survivor-stalled-observer", "synthetic-shared", "success", {
        schedulingProgress: true, onProgress: () => { observerCalls += 1; return observer; },
        onTiming: () => { throw new Error("synthetic observer failure"); }
      });
      const cancelled = submit("queued-cancel", "synthetic-cancelled", "cancelled");
      cancelled.controller.abort(new Error("synthetic queued cancellation"));
      await cancelled.promise;
      const expired = submit("queue-expired", "synthetic-expired", "timeout");
      const full = submit("queue-full", "synthetic-full", "rejected");
      primary.controller.abort(new Error("synthetic subscriber cancellation"));
      await Promise.all([primary.promise, expired.promise, full.promise]);
      assert.equal(runs.length, 1);
      assert.equal(runs[0].signal.aborted, false);
      const failure = submit("runner-failure", "synthetic-failure", "failed");
      runs[0].complete();
      await shared.promise;
      await tick();
      assert.equal(runs.length, 2);
      runs[1].complete(new Error("事实包 synthetic permanent failure"));
      await failure.promise;
      const recovery = submit("after-failure-recovery", "synthetic-recovery", "success");
      await tick();
      assert.equal(runs.length, 3);
      runs[2].complete();
      await recovery.promise;
    });
  } catch { batchError = true; }
  finally {
    for (const controller of controllers) controller.abort(new Error("synthetic fixture cleanup"));
    for (const run of runs) run.complete(new Error("synthetic fixture cleanup"));
    releaseObserver();
    await bounded(() => Promise.all(pending));
    await tick();
  }
  const checks = { completedScenario: !batchError, fullDenominator: samples.length === 7, oneRunnerSlot: maxActive === 1,
    runnersDrained: active === 0, temporaryPacksRemoved: fixturePaths.every((directory) => !fs.existsSync(directory)),
    exactlyThreeRunnerInvocations: runs.length === 3, stalledObserverContained: observerCalls === 1 };
  return { samples: samples.sort((a, b) => a.id.localeCompare(b.id)), checks, passed: Object.values(checks).every(Boolean) && samples.every((sample) => sample.passed) };
}

function validateReport(report) {
  assert.equal(report.mode, "synthetic-offline");
  assert.equal(report.sources.live, 0);
  assert.equal(report.sources.cache, 0, "Business cache and synthetic message replay must not be conflated");
  assert.equal(report.sources.synthetic, report.samples.length);
  assert.equal(new Set(report.samples.map((sample) => sample.id)).size, report.samples.length);
  assert.equal(report.samples.length, report.config.rounds * (SCENARIOS.length + 1 + 7), "Every prime, replay and gateway request belongs in the denominator");
  for (const sample of report.samples) {
    assert.ok(OUTCOMES.includes(sample.outcome));
    assert.equal(sample.source, "synthetic");
    assert.ok(Number.isFinite(sample.elapsedMs) && sample.elapsedMs >= 0);
    assert.equal(sample.passed, Object.values(sample.checks).every(Boolean));
    assert.equal(sample.passed, true, `Unexpected behavior in ${sample.id}: ${JSON.stringify(sample.checks)}`);
  }
  assert.deepEqual(report.summary, summarize(report.samples));
  assert.ok(report.queryRounds.every((round) => round.passed));
  assert.equal(report.passed, true);
  return true;
}

async function runReliabilityBenchmark(options = {}) {
  const config = normalizeOptions(options);
  const plan = makePlan(config);
  const handler = await runHandlerBatch(plan, config);
  const queryRounds = [];
  for (let round = 0; round < config.rounds; round += 1) queryRounds.push(await runQueryRound(round));
  const samples = [...handler, ...queryRounds.flatMap((round) => round.samples)];
  return {
    schemaVersion: 1, mode: "synthetic-offline", config,
    environment: { node: process.version, platform: process.platform, arch: process.arch },
    syntheticBudgets: { handler: HANDLER_BUDGETS, queryQueueTtlMs: 80, outerSafetyMs: 5000 },
    planSha256: crypto.createHash("sha256").update(JSON.stringify(plan)).digest("hex"),
    sources: { synthetic: samples.length, live: 0, cache: 0 },
    cache: { syntheticMessageReplayHits: samples.filter((sample) => sample.execution === "message-cache-replay").length, businessFactCacheHits: 0 },
    coverage: ["real-handler", "real-message-store", "real-query-scheduler", "synthetic-agent", "synthetic-renderer", "synthetic-transport", "synthetic-runner"],
    limitations: [
      "All samples are synthetic; live and business-cache samples are zero. No contacts, credentials, production state or business records are read.",
      "No real model, network, image engine, Windows runner isolation or sustained load is exercised. Synthetic elapsed time is not online latency or speedup.",
      "Seed fixes the scenario plan, not OS scheduling or measured duration. Each worker closes a request before taking another: this is a bounded closed workload, not open-loop capacity testing.",
      "Nearest-rank P50/P95/P99 include every observed sample, including failures; outer safety timeouts are censored and separately counted. Small-sample P99 often equals the maximum.",
      "Terminal succeeded includes graceful degradation; failed includes denied/cancelled/rejected; timeout includes an injected model-timeout signal and actual component timer expiry. Expected fault containment is reported separately."
    ],
    queryRounds: queryRounds.map(({ checks, passed }) => ({ checks, passed })), samples, summary: summarize(samples),
    passed: samples.every((sample) => sample.passed) && queryRounds.every((round) => round.passed)
  };
}

function parseOptions(args) {
  const options = {};
  for (const arg of args) {
    const match = /^--(seed|rounds|users|concurrency)=(\d+)$/.exec(arg);
    if (!match || Object.hasOwn(options, match[1])) throw new Error("Only unique --seed=N --rounds=1..20 --users=2..32 --concurrency=1..16 are supported; live mode does not exist.");
    options[match[1]] = Number(match[2]);
  }
  return normalizeOptions(options);
}

async function main() {
  const report = await runReliabilityBenchmark(parseOptions(process.argv.slice(2)));
  const root = path.resolve(__dirname, "..", "test-results", "reliability");
  fs.mkdirSync(root, { recursive: true });
  const reportPath = path.join(root, `synthetic-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  process.stdout.write(`${JSON.stringify({ mode: report.mode, passed: report.passed, config: report.config, sources: report.sources, summary: report.summary, reportPath })}\n`);
  validateReport(report);
}

if (require.main === module) main().catch((error) => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; });
module.exports = { DEFAULT_SEED, SCENARIOS, makePlan, normalizeOptions, parseOptions, distribution, summarize, runReliabilityBenchmark, validateReport };
