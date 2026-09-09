"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { PersistentCodexAgent, principalKeyFromUserId } = require("../shared/codex/persistent-agent.js");
const { emptyState } = require("../shared/codex/state-store.js");
const { createRequestLifecycle, REQUEST_CANCELLED, REQUEST_DEADLINE_EXCEEDED } = require("../shared/codex/request-lifecycle.js");

const pause = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const pending = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const observe = (promise) => { void promise.catch(() => {}); return promise; };
// Production deadline timers are unref'ed; keep this standalone test process
// alive until every asynchronous assertion has actually run.
const keepAlive = setInterval(() => {}, 1000);
async function until(predicate, message) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await pause(1);
  }
  assert.fail(message);
}
class FakeClient extends EventEmitter {
  constructor() { super(); this.threads = []; this.turns = []; this.steers = []; this.interrupts = []; this.responses = []; }
  async connect() {}
  async close() {}
  async startThread(params) { const id = `thread-${this.threads.length + 1}`; this.threads.push({ id, params }); return { thread: { id } }; }
  async startTurn(params) { const id = `turn-${this.turns.length + 1}`; this.turns.push({ id, params }); return { turn: { id } }; }
  async steerTurn(params) { this.steers.push(params); return { turnId: params.expectedTurnId }; }
  async interruptTurn(threadId, turnId) { this.interrupts.push({ threadId, turnId }); return {}; }
  respond(id, result) { this.responses.push({ id, result }); }
  reject() {}
  complete(turn = this.turns.at(-1), answer = "已按原始问题完成只读分析。") {
    const item = { type: "agentMessage", id: `item-${turn.id}`, phase: "final_answer", text: JSON.stringify({ answer, chart: null }) };
    this.emit("notification", { method: "turn/completed", params: { threadId: turn.params.threadId, turn: { id: turn.id, status: "completed", items: [item] } } });
  }
  plan(plan, turn = this.turns.at(-1)) {
    this.emit("notification", { method: "turn/plan/updated", params: { threadId: turn.params.threadId, turnId: turn.id, plan } });
  }
}
function fixture(options = {}) {
  const client = options.client || new FakeClient();
  const process = new EventEmitter();
  process.exitCode = null;
  const host = { process, close: async () => {} };
  const persisted = [];
  const agent = new PersistentCodexAgent({
    projectRoot: path.resolve(__dirname, ".."), agentStatePath: "unused-lifecycle-state.json", serviceLeasePath: "unused-lifecycle-lease.json",
    codexModel: "gpt-5.6-sol", codexReasoningEffort: "medium", agentTurnTimeoutMs: 2000,
    generalTurnTimeoutMs: 2000, agentTotalTimeoutMs: 2000, generalTotalTimeoutMs: 2000,
    ...(options.config || {})
  }, {
    hostFactory: { start: options.startHost || (async () => host) }, clientFactory: () => client,
    verifyLogin: () => ({}), readVersion: () => "test-only", loadState: () => emptyState(),
    saveState: (_file, state) => persisted.push(JSON.stringify(state)),
    queryXbb: options.queryXbb || (() => { throw new Error("Lifecycle fixture must not query business data"); })
  });
  const key = principalKeyFromUserId("synthetic-lifecycle-user", { scope: "all" });
  const ask = (question = "解释二分查找", extra = {}) => observe(agent.answer({ question, access: { scope: "all" }, principalKey: key, ...extra }));
  return { agent, client, key, ask, host, persisted };
}

function syntheticPerformancePack(month, total) {
  return {
    status: "ready", scope: { month, domains: ["performance"] },
    provenance: { live: true, readOnly: true, dataSource: "xbb-openapi", telephoneFieldsExported: false, credentialFieldsExported: false },
    facts: { performance: { summary: { total, course: total, consulting: 0, other: 0 }, ranking: [{ company: "合成测试公司", total, course: total, consulting: 0, other: 0 }] } },
    limitations: [], integrity: { algorithm: "sha256", factPackSha256: "b".repeat(64) }
  };
}

function callSyntheticQuery(f, month, id = `synthetic-query-${month}`, turn = f.client.turns.at(-1)) {
  return f.agent._handleServerRequest({ id, method: "item/tool/call", params: {
    threadId: turn.params.threadId, turnId: turn.id, tool: "query_xbb", arguments: { months: [month], domains: ["performance"] }
  } });
}

(async () => {
  // Deterministic monotonic deadline: external changes can narrow, never renew.
  let now = 10;
  let offered = 50;
  let nextTimer = 1;
  const timers = new Map();
  const clock = { now: () => now, setTimeout: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, at: now + ms }); return id; }, clearTimeout: (id) => timers.delete(id) };
  const life = createRequestLifecycle({ timeoutMs: 100, remainingMs: () => offered, clock });
  assert.equal(life.deadline, 60);
  now = 30; offered = 1000;
  assert.equal(life.remainingMs(), 30);
  life.limitDeadline(45);
  assert.equal(life.deadline, 45);
  now = 45;
  assert.throws(() => life.throwIfStopped(), { code: REQUEST_DEADLINE_EXCEEDED });
  await assert.rejects(life.promise, { code: REQUEST_DEADLINE_EXCEEDED });
  assert.equal(timers.size, 0);

  const f = fixture({ config: { agentTotalTimeoutMs: 25 } }); await f.agent.start();
  try {
    const already = new AbortController(); already.abort();
    await assert.rejects(f.ask(undefined, { signal: already.signal }), { code: REQUEST_CANCELLED });
    await assert.rejects(f.ask(undefined, { remainingMs: () => 0 }), { code: REQUEST_DEADLINE_EXCEEDED });
    assert.equal(f.client.threads.length, 0);
    assert.equal(f.client.turns.length, 0);

    const timings = [];
    const active = f.ask(undefined, { onProgress: () => new Promise(() => {}), onTiming: (event) => { timings.push(event); return new Promise(() => {}); } });
    await until(() => f.client.turns.length === 1, "observer must not prevent first model turn");
    const queueTimings = [];
    const queued = f.ask("集团8月业绩排名", { onTiming: (event) => queueTimings.push(event) });
    await assert.rejects(queued, { code: REQUEST_DEADLINE_EXCEEDED });
    assert.equal(f.client.turns.length, 1, "expired different-route request must never start");
    assert.equal(f.client.interrupts.length, 0, "queued cancellation must preserve original owner");
    assert.deepEqual(queueTimings.map((event) => event.stage), ["session_expired"]);
    assert.ok(queueTimings[0].queueWaitMs >= 15);
    f.client.complete(); await active;
    assert.deepEqual(timings.map((event) => event.stage), ["session_started"]);
  } finally { await f.agent.close(); }

  const startupGate = pending();
  const startup = fixture({ startHost: () => startupGate.promise });
  const started = observe(startup.agent.start());
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  try {
    const answer = startup.ask(undefined, { remainingMs: () => 15 });
    await assert.rejects(answer, { code: REQUEST_DEADLINE_EXCEEDED });
    await pause(5);
    assert.equal(startup.client.turns.length, 0);
    assert.deepEqual(unhandled, [], "expiry while awaiting startup must remain observed");
    startupGate.resolve(startup.host); await started;
    assert.equal(startup.agent.started, true, "one request cannot cancel service-owned startup");
  } finally { process.removeListener("unhandledRejection", onUnhandled); await startup.agent.close(); }

  const threadGate = pending();
  const threadClient = new FakeClient();
  threadClient.startThread = () => threadGate.promise;
  const threads = fixture({ client: threadClient }); await threads.agent.start();
  try {
    const request = threads.ask(undefined, { remainingMs: () => 15 });
    await assert.rejects(request, { code: REQUEST_DEADLINE_EXCEEDED });
    threadGate.resolve({ thread: { id: "late-thread" } }); await pause(5);
    assert.equal(threadClient.turns.length, 0, "late thread creation must not start expired model request");
    assert.equal(threads.agent.sessions.get(threads.key).threadId, null);
  } finally { await threads.agent.close(); }

  const turnGate = pending();
  const turnClient = new FakeClient();
  turnClient.startTurn = (params) => { turnClient.turns.push({ params }); return turnGate.promise; };
  const turns = fixture({ client: turnClient }); await turns.agent.start();
  try {
    const controller = new AbortController();
    const request = turns.ask(undefined, { signal: controller.signal });
    await until(() => turnClient.turns.length === 1, "startTurn should be in flight");
    controller.abort(); await assert.rejects(request, { code: REQUEST_CANCELLED });
    const originalThread = turnClient.turns[0].params.threadId;
    turnGate.resolve({ turn: { id: "late-turn" } }); await pause(5);
    assert.deepEqual(turnClient.interrupts, [{ threadId: originalThread, turnId: "late-turn" }]);
    assert.equal(turns.agent.sessions.get(turns.key).active, null);
  } finally { await turns.agent.close(); }

  const subscriptions = [];
  const query = fixture({ queryXbb: (_args, _access, invocation) => new Promise((_resolve, reject) => {
    subscriptions.push(invocation.signal);
    invocation.signal.addEventListener("abort", () => reject(invocation.signal.reason), { once: true });
  }) }); await query.agent.start();
  try {
    const controller = new AbortController();
    const one = query.ask("集团8月业绩排名", { signal: controller.signal });
    const otherController = new AbortController();
    const two = query.ask("集团8月业绩排名", { principalKey: principalKeyFromUserId("synthetic-other-user", { scope: "all" }), signal: otherController.signal });
    await until(() => subscriptions.length === 2, "two independent query subscriptions should start");
    controller.abort(); await assert.rejects(one, { code: REQUEST_CANCELLED });
    assert.equal(subscriptions[0].aborted, true);
    assert.equal(subscriptions[1].aborted, false, "one principal cancellation must not cancel another subscriber");
    otherController.abort(); await assert.rejects(two, { code: REQUEST_CANCELLED });
    assert.equal(query.client.turns.length, 0);
  } finally { await query.agent.close(); }

  const steerGate = pending();
  const steers = fixture();
  steers.client.steerTurn = (params) => { steers.client.steers.push(params); return steerGate.promise; };
  await steers.agent.start();
  try {
    const original = steers.ask("解释二分查找");
    await until(() => steers.client.turns.length === 1, "original turn should start");
    const originalTurn = steers.client.turns[0];
    const originalDeadline = steers.agent.sessions.get(steers.key).active.deadlineAtMs;
    const controller = new AbortController();
    const correction = steers.ask("补充：改为解释快速排序", { signal: controller.signal });
    await until(() => steers.client.steers.length === 1, "steer must be in flight");
    controller.abort(); await assert.rejects(correction, { code: REQUEST_CANCELLED });
    await until(() => steers.client.turns.length === 2, "cancelled sent steer must replay surviving original owner on fresh thread");
    const replay = steers.client.turns[1];
    assert.notEqual(replay.params.threadId, originalTurn.params.threadId);
    assert.equal(replay.params.input.map((item) => item.text || "").join("\n").includes("快速排序"), false);
    assert.equal(steers.agent.sessions.get(steers.key).active.deadlineAtMs, originalDeadline);
    steerGate.resolve({ turnId: originalTurn.id });
    steers.client.complete(originalTurn, "已取消的修正不应生效");
    await pause(2);
    assert.equal(steers.agent.sessions.get(steers.key).active.turnId, replay.id);
    steers.client.complete(replay, "二分查找原始答复");
    assert.equal((await original).answer, "二分查找原始答复");
  } finally { await steers.agent.close(); }

  // A tool result can arrive after steer delivery but before its ACK. It is
  // not evidence owned by the previous accepted request, even if verified.
  for (const confirmedFacts of ["none", "prefetch", "dynamic"]) {
    for (const ackFailure of ["rejected", "cancelled"]) {
      const gate = pending();
      const facts = fixture({ queryXbb: async (args) => syntheticPerformancePack(args.months[0], args.months[0] === "2026-08" ? 111 : 999) });
      facts.client.steerTurn = (params) => { facts.client.steers.push(params); return gate.promise; };
      await facts.agent.start();
      try {
        const original = facts.ask(confirmedFacts === "prefetch" ? "集团2026年8月业绩排名" : "销帮帮2026年8月整体经营情况怎么样？");
        await until(() => facts.client.turns.length === 1, "business original owner should start");
        if (confirmedFacts === "dynamic") await callSyntheticQuery(facts, "2026-08");
        const active = facts.agent.sessions.get(facts.key).active;
        const originalPlan = structuredClone(active.queryPlan);
        const originalDeadline = active.deadlineAtMs;
        const originalReplay = structuredClone(active.replayTurnParams.input);
        const controller = new AbortController();
        const correction = facts.ask("改为集团2026年9月业绩排名", { signal: controller.signal });
        await until(() => facts.client.steers.length === 1, "new-scope steer should be awaiting ACK");
        await callSyntheticQuery(facts, "2026-09");
        assert.deepEqual(active.queryPlan.months, ["2026-09"]);
        if (confirmedFacts === "none") assert.equal(active.latestFactView.facts.performance.summary.total, 999, "fixture must reproduce unconfirmed facts entering the active slot");
        const charged = { toolCalls: active.toolCalls, factBytesSent: active.factBytesSent, inputBytes: active.inputBytes };
        const previousGeneration = active.factGeneration;
        if (ackFailure === "cancelled") controller.abort();
        else gate.reject(new Error("synthetic business steer ACK failure"));
        await assert.rejects(correction, /请求已取消|synthetic business steer ACK failure/u);
        await until(() => facts.client.turns.length === 2, "previous business owner should recover on fresh thread");
        assert.equal(active.latestFactView?.facts.performance.summary.total ?? null, confirmedFacts === "none" ? null : 111,
          "recovered previous owner must never retain unacknowledged new-scope facts");
        assert.deepEqual(active.queryPlan, originalPlan, "query scope must return to the accepted owner");
        assert.equal(active.prefetchedFactAvailable, confirmedFacts === "prefetch");
        assert.equal(active.prefetchedFactView?.facts.performance.summary.total ?? null, confirmedFacts === "prefetch" ? 111 : null);
        assert.equal(active.deadlineAtMs, originalDeadline);
        assert.ok(active.factGeneration > previousGeneration, "late uncertain query results must remain ineligible");
        for (const [name, value] of Object.entries(charged)) assert.equal(active[name], value, `${name} must not reset during recovery`);
        assert.deepEqual(facts.client.turns[1].params.input, originalReplay, "replay may contain only accepted inputs");
        await facts.agent._timeoutTurn(facts.agent.sessions.get(facts.key), active);
        if (confirmedFacts === "none") await assert.rejects(original, /处理超时/u);
        else {
          const result = await original;
          assert.doesNotMatch(result.answer, /999|2026-09/u, "fallback may use only confirmed original-scope facts");
          assert.match(result.answer, /111/u);
        }
      } finally { await facts.agent.close(); }
    }
  }

  for (const confirmedFacts of [false, true]) {
    const gate = pending();
    const facts = fixture({ queryXbb: async (args) => syntheticPerformancePack(args.months[0], args.months[0] === "2026-08" ? 111 : 999) });
    facts.client.steerTurn = (params) => { facts.client.steers.push(params); return gate.promise; };
    await facts.agent.start();
    try {
      const original = facts.ask(confirmedFacts ? "集团2026年8月业绩排名" : "销帮帮2026年8月整体经营情况怎么样？");
      await until(() => facts.client.turns.length === 1, "timeout-boundary original should start");
      const correction = facts.ask("改为集团2026年9月业绩排名");
      await until(() => facts.client.steers.length === 1, "timeout-boundary steer should remain unacknowledged");
      await callSyntheticQuery(facts, "2026-09");
      const session = facts.agent.sessions.get(facts.key);
      await facts.agent._timeoutTurn(session, session.active);
      await assert.rejects(correction, /处理超时/u);
      if (confirmedFacts) {
        const result = await original;
        assert.match(result.answer, /111/u);
        assert.doesNotMatch(result.answer, /999|2026-09/u);
      } else await assert.rejects(original, /处理超时/u);
      assert.equal(session.active, null);
    } finally { await facts.agent.close(); }
  }

  for (const queryPhase of ["before-subscribe", "before-prefetch-response", "awaiting-cleanup"]) {
    const ack = pending();
    const suspended = pending();
    const queryCalls = [];
    const facts = fixture({ queryXbb: async (args, _access, invocation) => {
      queryCalls.push({ args, signal: invocation.signal });
      if (args.months[0] === "2026-09") return suspended.promise;
      return syntheticPerformancePack(args.months[0], 111);
    } });
    facts.client.steerTurn = (params) => { facts.client.steers.push(params); return ack.promise; };
    await facts.agent.start();
    try {
      const original = facts.ask(queryPhase === "before-prefetch-response" ? "集团2026年8月业绩排名" : "销帮帮2026年8月整体经营情况怎么样？");
      await until(() => facts.client.turns.length === 1, "suspended query original should start");
      const correction = facts.ask("改为集团2026年9月业绩排名");
      await until(() => facts.client.steers.length === 1, "suspended query steer should await ACK");
      let pausedProgress = false;
      const notify = facts.agent._notifyQueryProgress.bind(facts.agent);
      if (queryPhase !== "awaiting-cleanup") {
        facts.agent._notifyQueryProgress = async (...args) => {
          if (!pausedProgress && args[3].stage === (queryPhase === "before-prefetch-response" ? "query_ready" : "run_started")) {
            pausedProgress = true;
            await suspended.promise;
          } else await notify(...args);
        };
      }
      const oldMonth = queryPhase === "before-prefetch-response" ? "2026-08" : "2026-09";
      const oldQuery = callSyntheticQuery(facts, oldMonth, "old-suspended-query", facts.client.turns[0]);
      await until(() => queryPhase === "awaiting-cleanup" ? queryCalls.length === 1 : pausedProgress, "old tool should pause at the intended boundary");
      const session = facts.agent.sessions.get(facts.key);
      const active = session.active;
      active.generationRemainingMs = 321;
      const deadline = active.deadlineAtMs;
      const chargedCalls = queryCalls.length;
      ack.reject(new Error("synthetic suspended-query ACK failure"));
      await assert.rejects(correction, /synthetic suspended-query ACK failure/u);
      await until(() => facts.client.turns.length === 2, "suspended tool owner should recover");
      assert.equal(active.inFlightToolCount, 1, "recovery must not release a still-unsettled tool slot");
      assert.equal(active.generationRemainingMs, 321);
      if (queryPhase === "awaiting-cleanup") assert.equal(queryCalls[0].signal.aborted, true);
      await callSyntheticQuery(facts, "2026-08", "blocked-new-query");
      assert.equal(queryCalls.length, chargedCalls, "new turn cannot launch a replacement while old cleanup is outstanding");
      suspended.resolve(syntheticPerformancePack("2026-09", 999));
      await oldQuery;
      assert.equal(queryCalls.length, chargedCalls, "old progress continuation must not start an old-scope query after recovery");
      assert.equal(active.inFlightToolCount, 0);
      assert.ok(active.generationRemainingMs <= 321, "old finally must not renew the new turn generation budget");
      assert.equal(active.deadlineAtMs, deadline);
      assert.equal(facts.client.responses.some((entry) => entry.id === "old-suspended-query"), false, "old-thread tool continuation must not emit a stale response");
      assert.equal(active.latestFactView?.facts.performance.summary.total ?? null, queryPhase === "before-prefetch-response" ? 111 : null);
      await callSyntheticQuery(facts, "2026-08", "fresh-original-query");
      assert.equal(active.latestFactView.facts.performance.summary.total, 111);
      facts.client.complete(); await original;
    } finally { await facts.agent.close(); }
  }

  {
    const ack = pending();
    const progress = pending();
    let queryCalls = 0;
    const facts = fixture({ queryXbb: async (args) => { queryCalls += 1; return syntheticPerformancePack(args.months[0], 999); } });
    facts.client.steerTurn = (params) => { facts.client.steers.push(params); return ack.promise; };
    await facts.agent.start();
    try {
      const original = facts.ask("销帮帮2026年8月整体经营情况怎么样？");
      await until(() => facts.client.turns.length === 1, "accepted steer original should start");
      const correction = facts.ask("改为集团2026年9月业绩排名");
      await until(() => facts.client.steers.length === 1, "accepted steer should first await ACK");
      const notify = facts.agent._notifyQueryProgress.bind(facts.agent);
      let held = false;
      facts.agent._notifyQueryProgress = async (...args) => {
        if (!held) { held = true; await progress.promise; }
        else await notify(...args);
      };
      const oldQuery = callSyntheticQuery(facts, "2026-08", "same-turn-old-query");
      await until(() => held, "same-turn old query should pause before subscription");
      ack.resolve({ turnId: facts.client.turns[0].id });
      await original;
      progress.resolve(); await oldQuery;
      assert.equal(queryCalls, 0, "confirmed same-turn scope change must prevent old query execution");
      const response = facts.client.responses.find((entry) => entry.id === "same-turn-old-query");
      assert.equal(JSON.parse(response.result.contentItems[0].text).status, "superseded");
      const session = facts.agent.sessions.get(facts.key);
      assert.equal(session.active.steerFactBoundary, null, "confirmed new owner must no longer use the old-owner snapshot");
      await callSyntheticQuery(facts, "2026-09", "confirmed-new-query");
      await facts.agent._timeoutTurn(session, session.active);
      assert.match((await correction).answer, /999/u, "confirmed new owner may use its own fresh scope facts");
    } finally { await facts.agent.close(); }
  }

  for (const ackFailure of ["rpc-rejected", "wrong-turn"]) {
    const gate = pending();
    const uncertain = fixture();
    uncertain.client.steerTurn = (params) => { uncertain.client.steers.push(params); return gate.promise; };
    await uncertain.agent.start();
    try {
      const previous = uncertain.ask("解释二分查找");
      await until(() => uncertain.client.turns.length === 1, "uncertain ACK original turn should start");
      const oldTurn = uncertain.client.turns[0];
      const latest = uncertain.ask("补充：改为解释快速排序");
      await until(() => uncertain.client.steers.length === 1, "uncertain steer should be sent");
      uncertain.client.complete(oldTurn, "受未确认的新请求污染的结果");
      assert.ok(uncertain.agent.sessions.get(uncertain.key).active.pendingCompletion);
      if (ackFailure === "rpc-rejected") gate.reject(new Error("synthetic lost ACK"));
      else gate.resolve({ turnId: "wrong-turn-id" });
      await assert.rejects(latest, /synthetic lost ACK|未确认目标/u);
      assert.equal(uncertain.client.turns.length, 2, "uncertain ACK must restart only the previous accepted owner");
      const replay = uncertain.client.turns[1];
      assert.doesNotMatch(replay.params.input.map((item) => item.text || "").join("\n"), /快速排序/u);
      assert.equal(uncertain.agent.sessions.get(uncertain.key).active.pendingCompletion, null);
      uncertain.client.complete(replay, "仍属于旧请求的二分查找答复");
      assert.equal((await previous).answer, "仍属于旧请求的二分查找答复");
    } finally { await uncertain.agent.close(); }
  }

  const survivingGate = pending();
  const surviving = fixture();
  surviving.client.steerTurn = (params) => { surviving.client.steers.push(params); return survivingGate.promise; };
  await surviving.agent.start();
  try {
    const controller = new AbortController();
    const previous = surviving.ask(undefined, { signal: controller.signal });
    await until(() => surviving.client.turns.length === 1, "surviving owner test should start");
    const latest = surviving.ask("补充说明时间复杂度");
    await until(() => surviving.client.steers.length === 1, "new subscriber should own pending steer");
    controller.abort(); await assert.rejects(previous, { code: REQUEST_CANCELLED });
    assert.equal(surviving.client.interrupts.length, 0, "pending new owner survives old subscriber cancellation");
    const activeTurn = surviving.client.turns[0];
    survivingGate.resolve({ turnId: activeTurn.id });
    await until(() => !surviving.agent.sessions.get(surviving.key).active.steerInFlight, "steer should transfer to surviving owner");
    surviving.client.complete(activeTurn, "新订阅者的时间复杂度答复");
    assert.equal((await latest).answer, "新订阅者的时间复杂度答复");
  } finally { await surviving.agent.close(); }

  const orphanGate = pending();
  const orphan = fixture();
  orphan.client.steerTurn = (params) => { orphan.client.steers.push(params); return orphanGate.promise; };
  await orphan.agent.start();
  try {
    const controller = new AbortController();
    const previous = orphan.ask(undefined, { signal: controller.signal });
    await until(() => orphan.client.turns.length === 1, "orphan scenario original turn should start");
    const latest = orphan.ask("补充说明时间复杂度");
    await until(() => orphan.client.steers.length === 1, "orphan scenario steer should start");
    controller.abort(); await assert.rejects(previous, { code: REQUEST_CANCELLED });
    orphanGate.reject(new Error("synthetic ACK failure after prior cancellation"));
    await assert.rejects(latest, /synthetic ACK failure/u);
    assert.equal(orphan.agent.sessions.get(orphan.key).active, null, "failed last pending owner must immediately release the active slot");
    assert.equal(orphan.client.interrupts.length, 1);
    const after = orphan.ask("解释快速排序");
    await until(() => orphan.client.turns.length === 2, "new work should proceed after ownerless failure");
    orphan.client.complete(); await after;
  } finally { await orphan.agent.close(); }

  const transfers = fixture(); await transfers.agent.start();
  try {
    const ownerAbort = new AbortController();
    const original = transfers.ask(undefined, { signal: ownerAbort.signal, remainingMs: () => 90 });
    await until(() => transfers.client.turns.length === 1, "budget test first turn should start");
    const session = transfers.agent.sessions.get(transfers.key);
    const deadline = session.active.deadlineAtMs;
    await pause(20);
    const next = transfers.ask("补充说明时间复杂度", { remainingMs: () => 2000 });
    await original;
    ownerAbort.abort();
    assert.equal(session.active.deadlineAtMs, deadline, "accepted steer must never extend absolute deadline");
    assert.ok(session.active.generationRemainingMs < session.active.timeoutMs, "steer cannot renew generation budget");
    assert.equal(transfers.client.interrupts.length, 0, "settled predecessor signal cannot affect new owner");
    await assert.rejects(next, (error) => error.code === REQUEST_DEADLINE_EXCEEDED || error.name === "AgentTurnTimeoutError");
    assert.ok(performance.now() >= deadline - 5);
  } finally { await transfers.agent.close(); }

  // Integration: App Server plan notification -> bound in-memory state -> next input.
  const checkpoints = fixture(); await checkpoints.agent.start();
  try {
    const first = checkpoints.ask("请只读审查数据库迁移，目标：为订单表新增状态列，提供影响分析、回退方案和验证清单。\n```sql\nCREATE TABLE orders(id bigint PRIMARY KEY);\n```");
    await until(() => checkpoints.client.turns.length === 1, "database planning turn should start");
    const session = checkpoints.agent.sessions.get(checkpoints.key);
    assert.ok(session.taskCheckpoint);
    checkpoints.client.plan([{ step: "现状与目标", status: "completed" }, { step: "影响与依赖", status: "inProgress" }]);
    assert.equal(session.taskCheckpoint.stages[0].status, "model-reported");
    assert.equal(session.taskCheckpoint.stages[0].verified, false);
    const revision = session.taskCheckpoint.revision;
    checkpoints.client.complete(); await first;
    const second = checkpoints.ask("继续。");
    await until(() => checkpoints.client.turns.length === 2, "continuation should start");
    const input = checkpoints.client.turns[1].params.input.map((item) => item.text || "").join("\n");
    assert.match(input, /【任务检查点】/u);
    assert.match(input, /model-reported/u);
    assert.match(input, /verified":false/u);
    assert.equal(session.taskCheckpoint.revision, revision);
    checkpoints.client.complete(); await second;
    const third = checkpoints.ask("继续数据库任务，改用最新表结构。\n```sql\nCREATE TABLE orders(id uuid PRIMARY KEY);\n```");
    await until(() => checkpoints.client.turns.length === 3, "material correction should start");
    assert.ok(session.taskCheckpoint.revision > revision);
    assert.equal(session.taskCheckpoint.stages[0].status, "invalidated");
    checkpoints.client.plan([{ step: "现状与目标", status: "completed" }], checkpoints.client.turns[0]);
    assert.equal(session.taskCheckpoint.stages[0].status, "invalidated", "old turn notification must not update new material revision");
    checkpoints.client.complete(); await third;
    const independent = checkpoints.ask("为什么天空是蓝色的？");
    await until(() => checkpoints.client.turns.length === 4, "independent general question should start");
    assert.equal(session.taskCheckpoint, null);
    assert.doesNotMatch(checkpoints.client.turns[3].params.input.map((item) => item.text || "").join("\n"), /【任务检查点】/u);
    checkpoints.client.complete(); await independent;
    assert.ok(checkpoints.persisted.every((text) => !text.includes("taskCheckpoint") && !text.includes("CREATE TABLE")), "checkpoint and source SQL must not enter persistent agent state");
  } finally { await checkpoints.agent.close(); }

  const revised = fixture(); await revised.agent.start();
  try {
    const first = revised.ask("请只读审查数据库迁移，目标：调整订单表状态列。\n```sql\nCREATE TABLE orders(id bigint);\n```");
    await until(() => revised.client.turns.length === 1, "same-turn checkpoint first turn should start");
    revised.client.plan([{ step: "现状与目标", status: "completed" }]);
    const next = revised.ask("改用最新表结构。\n```sql\nCREATE TABLE orders(id uuid);\n```");
    await first;
    const session = revised.agent.sessions.get(revised.key);
    const checkpoint = session.taskCheckpoint;
    assert.equal(checkpoint.planAcceptance, "blocked-until-new-turn");
    assert.equal(checkpoint.stages[0].status, "invalidated");
    revised.client.plan([{ step: "现状与目标", status: "completed" }]);
    assert.equal(session.taskCheckpoint.stages[0].status, "invalidated", "same-turn plan has no revision and cannot revive invalidated material");
    revised.client.complete(); await next;
    const follow = revised.ask("继续。");
    await until(() => revised.client.turns.length === 2, "new actual turn should bind the material revision");
    assert.equal(session.taskCheckpoint.planAcceptance, "current-turn");
    revised.client.plan([{ step: "现状与目标", status: "completed" }]);
    assert.equal(session.taskCheckpoint.stages[0].status, "model-reported");
    revised.client.complete(); await follow;
    const oldFingerprint = session.taskCheckpoint.materials.entries[0].sha256;
    const independent = revised.ask("新问题：只读优化客户数据库的索引，目标：降低查询延迟。");
    await until(() => revised.client.turns.length === 3, "independent database task should start");
    assert.equal(session.taskCheckpoint.revision, 1);
    assert.equal(session.taskCheckpoint.materials.count, 0);
    assert.equal(JSON.stringify(session.taskCheckpoint).includes(oldFingerprint), false, "independent database task must not inherit previous SQL material fingerprints");
    revised.client.complete(); await independent;
  } finally { await revised.agent.close(); }
  console.log("verify-request-lifecycle: monotonic deadlines, startup/queue/active cancellation, observer isolation, steer ownership and checkpoint integration passed");
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => clearInterval(keepAlive));
