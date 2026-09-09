"use strict";

const assert = require("node:assert/strict");

// Install tripwires before importing the benchmark and its runtime dependencies.
// Any accidental real model/runner/network call fails this isolated test process.
const originals = [];
const forbiddenCalls = [];
for (const [moduleName, functions] of [
  ["node:child_process", ["spawn", "exec", "execFile", "spawnSync", "execSync", "execFileSync"]],
  ["node:http", ["request", "get"]], ["node:https", ["request", "get"]],
  ["node:net", ["connect", "createConnection"]], ["node:tls", ["connect"]]
]) {
  const target = require(moduleName);
  for (const name of functions) {
    const original = target[name];
    originals.push(() => { target[name] = original; });
    target[name] = () => {
      forbiddenCalls.push(`${moduleName}.${name}`);
      throw new Error(`Offline benchmark attempted forbidden ${moduleName}.${name}`);
    };
  }
}
const originalFetch = globalThis.fetch;
globalThis.fetch = () => { forbiddenCalls.push("fetch"); throw new Error("Offline benchmark attempted forbidden fetch"); };
const { SCENARIOS, makePlan, normalizeOptions, parseOptions, distribution, summarize, runReliabilityBenchmark, validateReport } = require("../scripts/benchmark-reliability.js");

async function run() {
  assert.deepEqual(parseOptions([]), { seed: 20260909, rounds: 4, users: 8, concurrency: 4 });
  assert.deepEqual(parseOptions(["--rounds=2", "--seed=0", "--users=3", "--concurrency=2"]), { seed: 0, rounds: 2, users: 3, concurrency: 2 });
  for (const args of [["--live"], ["--rounds=0"], ["--seed=4294967296"], ["--users=1"], ["--concurrency=17"], ["--seed=1", "--seed=2"], ["--rounds=1.5"], ["--output=production.json"]]) {
    assert.throws(() => parseOptions(args), /expected|supported/);
  }
  assert.throws(() => normalizeOptions({ rounds: Infinity }), /integer/);
  const options = { seed: 42, rounds: 2, users: 4, concurrency: 4 };
  const plan = makePlan(options);
  assert.deepEqual(plan, makePlan(options), "The same seed must reproduce every planned scenario/user/tick");
  assert.notDeepEqual(plan, makePlan({ ...options, seed: 43 }));
  assert.equal(plan.length, SCENARIOS.length * options.rounds);
  assert.equal(new Set(plan.map((item) => item.user)).size, options.users, "The fixed regression seed must exercise every configured user");
  for (const scenario of SCENARIOS) assert.equal(plan.filter((item) => item.scenario === scenario).length, options.rounds);
  assert.deepEqual(distribution([]), { count: 0, p50Ms: null, p95Ms: null, p99Ms: null, maxMs: null });
  assert.deepEqual(distribution(Array.from({ length: 100 }, (_, index) => index + 1)), { count: 100, p50Ms: 50, p95Ms: 95, p99Ms: 99, maxMs: 100 });
  const censored = summarize([
    { outcome: "success", expectedOutcome: "success", passed: true, censored: false, elapsedMs: 2, execution: "new" },
    { outcome: "timeout", expectedOutcome: "success", passed: false, censored: true, elapsedMs: 50, execution: "new" }
  ]);
  assert.deepEqual(censored.terminal, { succeeded: 1, failed: 0, timedOut: 1 });
  assert.equal(censored.observedElapsed.count, 2, "Timed-out observations cannot disappear from the denominator");
  assert.equal(censored.uncensoredElapsed.count, 1, "Safety deadline observations are not completed-request latency");
  assert.equal(censored.censoredSamples, 1);
  assert.equal(censored.unexpectedSamples, 1);

  const report = await runReliabilityBenchmark(options);
  assert.deepEqual(forbiddenCalls, [], "Even a swallowed external-call error must fail the offline boundary check");
  assert.equal(validateReport(report), true);
  assert.equal(report.samples.length, 44);
  assert.deepEqual(report.summary.outcomes, { success: 12, degraded: 10, denied: 2, cancelled: 4, rejected: 2, failed: 4, timeout: 10 });
  assert.deepEqual(report.summary.terminal, { succeeded: 22, failed: 12, timedOut: 10 });
  assert.equal(report.cache.syntheticMessageReplayHits, 2);
  assert.equal(report.summary.unexpectedSamples, 0);
  assert.equal(report.summary.censoredSamples, 0);
  assert.ok(report.samples.filter((sample) => sample.execution === "message-cache-replay").every((sample) => sample.agentCalls === 0 && sample.metrics === null));
  assert.ok(report.samples.filter((sample) => sample.scenario === "shared-survivor-stalled-observer").every((sample) => sample.shared));
  assert.ok(report.samples.filter((sample) => sample.scenario === "cumulative-delivery-deadline").every((sample) => sample.checks.cumulativeBudget && sample.checks.noLateMedia));
  assert.ok(report.samples.filter((sample) => sample.scenario === "agent-never-settles").every((sample) => sample.faults.includes("agent-deadline") && sample.checks.noLateReplyAttempts));
  assert.doesNotMatch(JSON.stringify(report), /synthetic-user-|synthetic-denied|synthetic-media|synthetic-late|离线验收替身答复|集团业绩|factPackSha256|fact-pack\.json/,
    "The report must not accidentally serialize transport targets, text, media IDs, or protocol facts");
  const missing = structuredClone(report);
  missing.samples.pop();
  assert.throws(() => validateReport(missing), /AssertionError/);
  const dishonest = structuredClone(report);
  dishonest.sources.live = 1;
  assert.throws(() => validateReport(dishonest), /AssertionError/);
  const hiddenFailure = structuredClone(report);
  hiddenFailure.samples[0].checks.noLateMedia = false;
  assert.throws(() => validateReport(hiddenFailure), /AssertionError/);
  const skippedFailure = structuredClone(report);
  skippedFailure.summary.terminal.failed = 0;
  assert.throws(() => validateReport(skippedFailure), /AssertionError/);
  process.stdout.write(`${JSON.stringify({ success: true, mode: report.mode, samples: report.samples.length,
    outcomes: report.summary.outcomes, checks: "seed/bounds/full-denominator/quantiles/fault-containment/late-results/no-network/no-process/report-negative-controls" })}\n`);
}

run().catch((error) => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; }).finally(() => {
  for (const restore of originals) restore();
  globalThis.fetch = originalFetch;
});
