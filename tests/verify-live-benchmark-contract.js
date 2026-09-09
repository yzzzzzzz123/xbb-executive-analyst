"use strict";
const assert = require("node:assert/strict");
const { FIXED_WORKLOADS, parseOptions, summarizeLiveSamples } = require("../scripts/benchmark-production.js");
assert.equal(parseOptions(["--live", "--workload", "--repeat=4"]).repeat, 4);
assert.throws(() => parseOptions(["--workload"]));
assert.throws(() => parseOptions(["--preview"]));
assert.equal(parseOptions(["--live", "--preview"]).preview, true);
assert.throws(() => parseOptions(["--live", "--repeat=500"]));
assert.equal(FIXED_WORKLOADS.length, 3);
assert.equal(FIXED_WORKLOADS[0].matches("READY"), true);
assert.equal(FIXED_WORKLOADS[0].matches("READY\n额外解释"), false);
const samples = [
  { scenario: "a", passed: true, answerMs: 10 },
  { scenario: "a", passed: false, answerMs: 100, failure: "REQUEST_DEADLINE_EXCEEDED" },
  { scenario: "b", passed: false, answerMs: 20, failure: "probe_failed" }
];
const report = summarizeLiveSamples(samples);
assert.equal(report.count, 3);
assert.equal(report.passed + report.failed, report.count);
assert.equal(report.failed, 2);
assert.equal(report.timeouts, 1);
assert.equal(report.p95Ms, 100, "延迟分位数不得删除失败和超时样本");
assert.equal(report.byScenario.a.count, 2);
assert.equal(report.byScenario.a.p99Ms, 100);
assert.equal(summarizeLiveSamples([]).p50Ms, null);
process.stdout.write(`${JSON.stringify({ success: true, synthetic: true, fixedWorkloads: 3 })}\n`);
