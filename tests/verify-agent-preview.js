"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const { PersistentCodexAgent, principalKeyFromUserId } = require("../shared/codex/persistent-agent.js");
const { emptyState } = require("../shared/codex/state-store.js");

const access = { scope: "all" };
const prefix = '{"answer":"第一段已经完整。\\n\\n第二段仍在生成';
const suffix = '，现在完成。","chart":null}';
const rawAnswer = prefix + suffix;
const observe = (promise) => { void promise.catch(() => {}); return promise; };
const pause = () => new Promise((resolve) => setImmediate(resolve));
const pending = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const keepAlive = setInterval(() => {}, 1000);
async function until(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) { if (predicate()) return; await pause(); }
  assert.fail(message);
}

class Client extends EventEmitter {
  constructor() { super(); this.turns = []; this.steers = []; this.threadCount = 0; this.interrupts = []; }
  async connect() {}
  async close() {}
  async startThread() { return { thread: { id: `preview-thread-${++this.threadCount}` } }; }
  async startTurn(params) { const turn = { id: `preview-turn-${this.turns.length + 1}`, params }; this.turns.push(turn); return { turn: { id: turn.id } }; }
  async steerTurn(params) { this.steers.push(params); return { turnId: params.expectedTurnId }; }
  async interruptTurn(threadId, turnId) { this.interrupts.push({ threadId, turnId }); }
  reject() {}
  respond() {}
  notify(method, params = {}, turn = this.turns.at(-1)) {
    this.emit("notification", { method, params: { threadId: turn.params.threadId, turnId: turn.id, ...params } });
  }
  startItem(id = "final-item", phase = "final_answer", turn) {
    this.notify("item/started", { item: { id, type: "agentMessage", phase } }, turn);
  }
  delta(delta, itemId = "final-item", turn) { this.notify("item/agentMessage/delta", { itemId, delta }, turn); }
  completeItem(text = rawAnswer, id = "final-item", phase = "final_answer", turn) {
    this.notify("item/completed", { item: { id, type: "agentMessage", phase, text } }, turn);
  }
  finish(text = rawAnswer, { status = "completed", itemId = "final-item", phase = "final_answer", turn = this.turns.at(-1) } = {}) {
    const item = { id: itemId, type: "agentMessage", phase, text };
    this.notify("turn/completed", { turn: { id: turn.id, status, items: [item] } }, turn);
  }
}

async function fixture() {
  const client = new Client();
  const process = new EventEmitter(); process.exitCode = null;
  const persisted = [];
  const activity = [];
  const agent = new PersistentCodexAgent({
    projectRoot: path.resolve(__dirname, ".."), agentStatePath: "unused-preview-state.json", serviceLeasePath: "unused-preview-lease.json",
    codexModel: "gpt-5.6-sol", codexReasoningEffort: "medium", agentTurnTimeoutMs: 2000, generalTurnTimeoutMs: 2000,
    agentTotalTimeoutMs: 2000, generalTotalTimeoutMs: 2000
  }, {
    hostFactory: { start: async () => ({ process, close: async () => {} }) }, clientFactory: () => client,
    verifyLogin: () => ({}), readVersion: () => "test-only", loadState: () => emptyState(),
    saveState: (_file, state) => persisted.push(JSON.stringify(state)), queryXbb: () => { throw new Error("preview fixture forbids business queries"); }
  });
  agent.on("activity", (event) => activity.push(event));
  await agent.start();
  const principalKey = principalKeyFromUserId("synthetic-preview-user", access);
  const ask = (extra = {}) => observe(agent.answer({ question: "解释二分查找", access, principalKey, ...extra }));
  return { agent, client, ask, principalKey, activity, persisted };
}

(async () => {
  const basic = await fixture();
  try {
    const previews = []; const timings = [];
    const answer = basic.ask({ onAnswerPreview: (value) => { previews.push(value); return new Promise(() => {}); }, onTiming: (event) => timings.push(event) });
    await until(() => basic.client.turns.length === 1, "normal preview turn should start");
    basic.client.startItem("comment", "commentary");
    basic.client.delta("", "comment"); basic.client.delta("模型内部备注不能出现在预览", "comment");
    assert.equal(previews.length, 0);
    assert.equal(timings.filter((event) => event.stage === "model_first_delta").length, 1);
    basic.client.startItem();
    basic.client.delta('{"answer":');
    assert.equal(previews.length, 0, "JSON syntax is not user-facing answer text");
    basic.client.delta(prefix.slice('{"answer":'.length));
    assert.equal(previews.length, 1);
    assert.equal(previews[0].text, "第一段已经完整。");
    assert.equal(previews[0].isCurrent(), true);
    assert.deepEqual(Object.keys(previews[0]).sort(), ["isCurrent", "text"]);
    basic.client.delta(suffix);
    assert.equal(previews.length, 2);
    basic.client.completeItem();
    assert.equal(previews.length, 2, "identical completed-item preview must not be repeated");
    basic.client.finish();
    assert.equal((await answer).answer, JSON.parse(rawAnswer).answer);
    assert.equal(previews.every((preview) => !preview.isCurrent()), true);
    for (const stage of ["model_first_delta", "answer_preview_ready"]) {
      const events = timings.filter((event) => event.stage === stage);
      assert.equal(events.length, 1);
      assert.ok(Number.isInteger(events[0].elapsedMs) && events[0].elapsedMs >= 0);
      assert.deepEqual(Object.keys(events[0]).sort(), ["elapsedMs", "stage"]);
    }
    assert.ok(Number.isInteger(timings.find((event) => event.stage === "session_started").queueWaitMs));
    assert.equal(JSON.stringify([...basic.activity, ...basic.persisted]).includes("第一段已经完整"), false, "preview content must not enter activity or persistent state");
  } finally { await basic.agent.close(); }

  for (const phase of [null, "commentary", "reasoning"]) {
    const f = await fixture();
    try {
      const previews = [];
      const answer = f.ask({ onAnswerPreview: (preview) => previews.push(preview) });
      await until(() => f.client.turns.length === 1, "phase-negative turn should start");
      f.client.startItem("not-final", phase); f.client.delta(rawAnswer, "not-final");
      f.client.completeItem(rawAnswer, "not-final", "final_answer");
      assert.equal(previews.length, 0, "missing/changed phase cannot be retroactively promoted to a preview");
      f.client.finish(rawAnswer, { itemId: "not-final" }); await answer;
    } finally { await f.agent.close(); }
  }

  for (const reason of ["multiple-items", "rewrite", "blocked-json", "phase-change", "late-start"]) {
    const f = await fixture();
    try {
      const previews = [];
      const answer = f.ask({ onAnswerPreview: (preview) => previews.push(preview) });
      await until(() => f.client.turns.length === 1, "preview invalidation turn should start");
      f.client.startItem(); f.client.delta(rawAnswer);
      assert.equal(previews.length, 1);
      if (reason === "multiple-items") { f.client.startItem("another-final"); f.client.delta(rawAnswer, "another-final"); }
      else if (reason === "rewrite") f.client.completeItem('{"answer":"这段是重写的不同正文。","chart":null}');
      else if (reason === "blocked-json") f.client.delta(" invalid-json-tail");
      else if (reason === "phase-change") f.client.completeItem(rawAnswer, "final-item", "commentary");
      else f.client.startItem("final-item", "final_answer");
      assert.equal(previews[0].isCurrent(), false, `${reason} must invalidate already queued previews`);
      f.client.startItem("yet-another-final"); f.client.delta(rawAnswer, "yet-another-final");
      assert.equal(previews.length, 1, `${reason} must permanently disable this turn's preview`);
      f.client.finish(rawAnswer, { status: "failed" });
      await assert.rejects(answer, /未生成可用最终答复/u);
    } finally { await f.agent.close(); }
  }

  const cancelled = await fixture();
  try {
    const controller = new AbortController(); const previews = [];
    const answer = cancelled.ask({ signal: controller.signal, onAnswerPreview: (preview) => previews.push(preview) });
    await until(() => cancelled.client.turns.length === 1, "cancel preview turn should start");
    cancelled.client.startItem(); cancelled.client.delta(prefix);
    controller.abort(); await assert.rejects(answer, { code: "REQUEST_CANCELLED" });
    assert.equal(previews[0].isCurrent(), false);
    cancelled.client.delta(suffix);
    assert.equal(previews.length, 1);
  } finally { await cancelled.agent.close(); }

  const malformed = await fixture();
  try {
    const previews = [];
    const answer = malformed.ask({ onAnswerPreview: (preview) => previews.push(preview) });
    await until(() => malformed.client.turns.length === 1, "malformed final turn should start");
    malformed.client.startItem(); malformed.client.delta(prefix);
    assert.equal(previews.length, 1);
    malformed.client.completeItem(prefix);
    assert.equal(previews[0].isCurrent(), false, "incomplete completed JSON must invalidate a prior draft");
    malformed.client.finish(prefix);
    await assert.rejects(answer, /最终答复不是有效结构化结果/u);
  } finally { await malformed.agent.close(); }

  for (const callback of [() => { throw new Error("synthetic observer throw"); }, () => Promise.reject(new Error("synthetic observer rejection"))]) {
    const f = await fixture();
    try {
      const answer = f.ask({ onAnswerPreview: callback });
      await until(() => f.client.turns.length === 1, "throwing preview observer turn should start");
      f.client.startItem(); f.client.delta(rawAnswer); f.client.finish();
      assert.equal((await answer).answer, JSON.parse(rawAnswer).answer);
      await pause();
    } finally { await f.agent.close(); }
  }

  for (const failAck of [false, true]) {
    const f = await fixture(); const gate = pending();
    f.client.steerTurn = (params) => { f.client.steers.push(params); return gate.promise; };
    try {
      const oldPreviews = []; const newPreviews = []; const timings = []; const nextTimings = [];
      const oldAnswer = f.ask({ onAnswerPreview: (preview) => oldPreviews.push(preview), onTiming: (event) => timings.push(event) });
      await until(() => f.client.turns.length === 1, "steer preview original should start");
      const firstTurn = f.client.turns[0];
      f.client.startItem(); f.client.delta(prefix);
      const nextAnswer = f.ask({ question: "补充说明时间复杂度", onAnswerPreview: (preview) => newPreviews.push(preview), onTiming: (event) => nextTimings.push(event) });
      await until(() => f.client.steers.length === 1, "steer must become pending");
      assert.equal(oldPreviews[0].isCurrent(), false);
      f.client.delta(suffix);
      assert.equal(oldPreviews.length, 1); assert.equal(newPreviews.length, 0);
      if (failAck) {
        gate.reject(new Error("synthetic preview steer ACK failure"));
        await assert.rejects(nextAnswer, /synthetic preview steer ACK failure/u);
        await until(() => f.client.turns.length === 2, "failed steer should recover a fresh preview permit");
        f.client.startItem(); f.client.delta(rawAnswer);
        assert.equal(oldPreviews.length, 2);
        assert.equal(oldPreviews[1].isCurrent(), true);
        assert.equal(oldPreviews[0].isCurrent(), false);
        f.client.finish(); await oldAnswer;
        assert.equal(timings.filter((event) => event.stage === "model_first_delta").length, 1);
        assert.equal(timings.filter((event) => event.stage === "answer_preview_ready").length, 1, "recovery cannot double-count per-request first preview");
      } else {
        gate.resolve({ turnId: firstTurn.id }); await oldAnswer;
        f.client.startItem("steered-final"); f.client.delta(rawAnswer, "steered-final");
        assert.equal(newPreviews.length, 0, "new owner must not inherit an old turn's output stream");
        assert.equal(nextTimings.some((event) => event.stage === "model_first_delta" || event.stage === "answer_preview_ready"), false);
        f.client.finish(rawAnswer, { itemId: "steered-final" }); await nextAnswer;
      }
      assert.equal(newPreviews.length, 0);
    } finally { await f.agent.close(); }
  }

  for (const warmup of [false, true]) {
    const f = await fixture();
    try {
      const previews = [];
      const args = { question: "销帮帮业绩字段有哪些？", principalKey: f.principalKey, access, onAnswerPreview: (preview) => previews.push(preview) };
      const answer = observe(warmup ? f.agent._enqueue({ ...args, warmup: true }) : f.agent.answer(args));
      await until(() => f.client.turns.length === 1, "business/warmup preview exclusion turn should start");
      f.client.startItem(); f.client.delta(rawAnswer); f.client.completeItem();
      assert.equal(previews.length, 0);
      f.client.finish(); await answer;
    } finally { await f.agent.close(); }
  }

  console.log("verify-agent-preview: final-phase streaming, first-output timing, observer isolation, guard invalidation, steer/recovery and final-failure separation passed");
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => clearInterval(keepAlive));
