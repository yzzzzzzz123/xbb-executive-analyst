"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const { createToolGatewayForTest } = require("../shared/xbb/tool-gateway.js");

// Protocol-only fixture: no business rows, network requests or real runner.
const canonical = {
  scope: { month: "2026-01", domains: ["performance"] },
  entityResolution: {},
  provenance: { live: true, readOnly: true, telephoneFieldsExported: false, credentialFieldsExported: false },
  facts: {},
  limitations: ["Synthetic scheduling test fixture"]
};
const pack = {
  status: "ready", ...canonical,
  integrity: { algorithm: "sha256", factPackSha256: crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex") }
};
const access = { scope: "all" };
const input = (company) => ({ months: ["2026-01"], domains: ["performance"], company });
const nextTick = () => new Promise((resolve) => setImmediate(resolve));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function within(operation, label, timeoutMs = 1500) {
  let timer;
  return Promise.race([
    operation,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded test deadline`)), timeoutMs); })
  ]).finally(() => clearTimeout(timer));
}

function fakeScheduler({ deferAbort = false, ...options } = {}) {
  const runs = [];
  const query = createToolGatewayForTest({
    testOnlyPlatform: "linux",
    powershell: "synthetic-runner-never-spawned",
    maxConcurrentQueries: 1,
    progressPollMs: 10,
    ...options,
    execFile: (_command, args, runOptions) => new Promise((resolve, reject) => {
      const outputPath = args[args.indexOf("-OutputPath") + 1];
      const progressPath = args[args.indexOf("-ProgressPath") + 1];
      const run = {
        scope: JSON.parse(runOptions.stdinText).company,
        signal: runOptions.signal,
        abortObserved: false,
        complete() {
          runOptions.signal.removeEventListener("abort", onAbort);
          fs.writeFileSync(outputPath, JSON.stringify(pack), "utf8");
          resolve({ stdout: "", stderr: "" });
        },
        progress(event) { fs.appendFileSync(progressPath, `${JSON.stringify(event)}\n`, "utf8"); },
        fail(error = new Error("事实包 synthetic permanent failure")) {
          runOptions.signal.removeEventListener("abort", onAbort);
          reject(error);
        }
      };
      const onAbort = () => {
        run.abortObserved = true;
        if (!deferAbort) run.fail(runOptions.signal.reason);
      };
      runOptions.signal.addEventListener("abort", onAbort, { once: true });
      runs.push(run);
    })
  });
  return { query, runs };
}

function assertTiming(events) {
  for (const event of events) {
    assert.deepEqual(Object.keys(event).sort(), ["elapsedMs", "queueWaitMs", "runMs", "shared", "stage"]);
    assert.ok(Object.isFrozen(event));
    for (const field of ["elapsedMs", "queueWaitMs", "runMs"]) {
      assert.ok(Number.isInteger(event[field]) && event[field] >= 0);
    }
    assert.equal(typeof event.shared, "boolean");
  }
}

async function verifySharedCancellationAndQueueTiming() {
  const { query, runs } = fakeScheduler();
  const firstController = new AbortController();
  const firstTiming = [];
  const sharedTiming = [];
  const queuedTiming = [];
  const queuedProgress = [];
  const first = query(input("synthetic-a"), access, { signal: firstController.signal, onTiming: (event) => firstTiming.push(event) });
  const shared = query(input("synthetic-a"), access, { onTiming: (event) => sharedTiming.push(event) });
  const queued = query(input("synthetic-b"), access, {
    schedulingProgress: true,
    onTiming: (event) => queuedTiming.push(event),
    onProgress: (event) => queuedProgress.push(event.stage)
  });
  const firstRejected = assert.rejects(first, /synthetic subscriber left/);
  await nextTick();
  assert.equal(runs.length, 1, "Identical scopes must share one runner");
  firstController.abort(new Error("synthetic subscriber left"));
  await firstRejected;
  assert.equal(runs[0].signal.aborted, false, "Remaining subscriber owns the shared runner");
  assert.deepEqual(queuedProgress, ["queued"]);
  await delay(20);
  runs[0].complete();
  await shared;
  await nextTick();
  assert.equal(runs.length, 2);
  assert.ok(queuedProgress.includes("query_started"));
  runs[1].complete();
  await queued;
  assert.deepEqual(firstTiming.map((event) => event.stage), ["started", "cancelled"]);
  assert.deepEqual(sharedTiming.map((event) => event.stage), ["started", "completed"]);
  assert.equal(firstTiming.at(-1).shared, true);
  assert.equal(sharedTiming.at(-1).shared, true);
  assert.equal(sharedTiming[0].queueWaitMs, 0, "Joining a running query must not inherit earlier queue time");
  assert.deepEqual(queuedTiming.map((event) => event.stage), ["queued", "started", "completed"]);
  assert.ok(queuedTiming.at(-1).queueWaitMs >= 15);
  assertTiming([...firstTiming, ...sharedTiming, ...queuedTiming]);
}

async function verifyQueuedCancellationAndExpiry() {
  const { query, runs } = fakeScheduler({ maxQueuedQueries: 1, queueTtlMs: 30 });
  const blocker = query(input("synthetic-blocker"), access);
  const controller = new AbortController();
  const cancelledTiming = [];
  const cancelled = query(input("synthetic-cancelled"), access, {
    signal: controller.signal, onTiming: (event) => cancelledTiming.push(event)
  });
  const cancelledResult = assert.rejects(cancelled, /synthetic queued cancellation/);
  controller.abort(new Error("synthetic queued cancellation"));
  await cancelledResult;
  const expiredTiming = [];
  const expired = query(input("synthetic-expired"), access, { onTiming: (event) => expiredTiming.push(event) });
  const expiredResult = assert.rejects(expired, (error) => error.code === "XBB_QUERY_QUEUE_TIMEOUT");
  const rejectedTiming = [];
  await assert.rejects(query(input("synthetic-full"), access, { onTiming: (event) => rejectedTiming.push(event) }),
    (error) => error.code === "XBB_QUERY_QUEUE_FULL");
  await expiredResult;
  assert.equal(runs.length, 1, "Cancelled and expired queue entries must never spawn");
  const replacement = query(input("synthetic-expired"), access);
  runs[0].complete();
  await blocker;
  await nextTick();
  assert.equal(runs.length, 2, "Expiry must remove the single-flight entry and release queue capacity");
  runs[1].complete();
  await replacement;
  assert.deepEqual(cancelledTiming.map((event) => event.stage), ["queued", "cancelled"]);
  assert.deepEqual(expiredTiming.map((event) => event.stage), ["queued", "expired"]);
  assert.equal(expiredTiming.at(-1).runMs, 0);
  assert.deepEqual(rejectedTiming.map((event) => event.stage), ["rejected"]);
  assertTiming([...cancelledTiming, ...expiredTiming, ...rejectedTiming]);
}

async function verifyLastSubscriberWaitsForCleanup() {
  const { query, runs } = fakeScheduler({ deferAbort: true });
  const controller = new AbortController();
  const first = query(input("synthetic-abandoned"), access, { signal: controller.signal });
  const firstRejected = assert.rejects(first, /synthetic last subscriber/);
  const second = query(input("synthetic-next"), access);
  await nextTick();
  controller.abort(new Error("synthetic last subscriber"));
  await firstRejected;
  assert.equal(runs[0].abortObserved, true);
  await nextTick();
  assert.equal(runs.length, 1, "Cancellation must retain the slot until runner termination settles");
  runs[0].fail(runs[0].signal.reason);
  await nextTick();
  assert.equal(runs.length, 2);
  runs[1].complete();
  await second;
}

async function verifyObserversCannotHoldRunnerSlot() {
  const { query, runs } = fakeScheduler();
  let releaseProgress;
  let calls = 0;
  const stalledProgress = new Promise((resolve) => { releaseProgress = resolve; });
  const first = query(input("synthetic-observer"), access, {
    schedulingProgress: true,
    onProgress: () => { calls += 1; return stalledProgress; },
    onTiming: () => new Promise(() => {})
  });
  const healthyProgress = [];
  const shared = query(input("synthetic-observer"), access, {
    onProgress: (event) => healthyProgress.push(event.stage)
  });
  const secondTiming = [];
  const second = query(input("synthetic-next"), access, {
    onTiming: (event) => { secondTiming.push(event); throw new Error("synthetic observer failure"); }
  });
  await nextTick();
  runs[0].progress({ stage: "month_completed", completed: 1, total: 1 });
  runs[0].complete();
  await within(first, "stalled progress must not block a completed query", 300);
  await shared;
  assert.ok(healthyProgress.includes("query_ready"), "A stalled subscriber must not delay healthy shared subscribers");
  await nextTick();
  assert.equal(runs.length, 2, "Completed runner must release the only slot despite stalled observers");
  runs[1].complete();
  await second;
  releaseProgress();
  await nextTick();
  assert.equal(calls, 1, "Settled subscriptions must discard pending progress instead of publishing stale stages");
  assert.deepEqual(secondTiming.map((event) => event.stage), ["queued", "started", "completed"]);
}

async function verifyFailureAndLegacyInterface() {
  const { query, runs } = fakeScheduler();
  const timing = [];
  const failed = query(input("synthetic-failure"), access, { onTiming: (event) => timing.push(event) });
  const failedResult = assert.rejects(failed, (error) => error.code === "XBB_RUNNER_EXECUTION_FAILED");
  const legacyProgress = [];
  const next = query(input("synthetic-legacy"), access, { onProgress: async (event) => legacyProgress.push(event.stage) });
  await nextTick();
  runs[0].fail();
  await failedResult;
  await nextTick();
  assert.equal(runs.length, 2);
  runs[1].complete();
  await next;
  assert.deepEqual(timing.map((event) => event.stage), ["started", "failed"]);
  assert.deepEqual(legacyProgress, ["validating", "query_ready"], "Scheduling progress must remain opt-in for existing consumers");
  const aborted = new AbortController();
  aborted.abort();
  const rejectedTiming = [];
  await assert.rejects(query(input("synthetic-preaborted"), access, { signal: aborted.signal, onTiming: (event) => rejectedTiming.push(event) }));
  await assert.rejects(query({ months: [], domains: ["performance"] }, access, { onTiming: (event) => rejectedTiming.push(event) }));
  assert.deepEqual(rejectedTiming.map((event) => event.stage), ["cancelled", "rejected"]);
  assert.equal(runs.length, 2);
}

(async () => {
  const checks = [
    verifySharedCancellationAndQueueTiming,
    verifyQueuedCancellationAndExpiry,
    verifyLastSubscriberWaitsForCleanup,
    verifyObserversCannotHoldRunnerSlot,
    verifyFailureAndLegacyInterface
  ];
  for (const check of checks) await within(check(), check.name);
  process.stdout.write(`${JSON.stringify({ success: true, checks: checks.length, mode: "synthetic-query-scheduling" })}\n`);
})().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
