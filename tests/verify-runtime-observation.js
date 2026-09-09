"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseOptions, readSnapshot } = require("../scripts/observe-runtime-health.js");
assert.deepEqual(parseOptions([]), { count: 6, intervalMs: 60000 });
assert.throws(() => parseOptions(["--samples=1000"]));
assert.throws(() => parseOptions(["--interval-ms=1"]));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "xbb-observation-test-"));
try {
  const lease = { state: "running", instanceId: "private-instance", updatedAtMs: 100 };
  fs.writeFileSync(path.join(root, "service-lease.json"), JSON.stringify(lease));
  fs.writeFileSync(path.join(root, "agent-state.json"), JSON.stringify({ threads: { "private-user": { turnInProgress: true } } }));
  fs.writeFileSync(path.join(root, "status.jsonl"), JSON.stringify({ status: "ready", instanceId: lease.instanceId }));
  const healthy = readSnapshot(root, null, 200);
  assert.equal(healthy.sample.passed, true);
  assert.equal(healthy.sample.activeTurns, 1);
  assert.doesNotMatch(JSON.stringify(healthy.sample), /private-instance|private-user/);
  assert.equal(readSnapshot(root, "older-private-instance", 200).sample.instanceChanged, true);
  assert.equal(readSnapshot(root, null, 100000).sample.passed, false);
  fs.appendFileSync(path.join(root, "status.jsonl"), '\n{"status":"disconnected"}');
  assert.equal(readSnapshot(root, null, 200).sample.authenticated, false, "旧ready不能掩盖后续断线");
  fs.writeFileSync(path.join(root, "service-lease.json"), "broken");
  assert.equal(readSnapshot(root, null, 200).sample.failure, "local_health_unavailable");
} finally { fs.rmSync(root, { recursive: true, force: true }); }
process.stdout.write(`${JSON.stringify({ success: true, synthetic: true, scenarios: 5 })}\n`);
