"use strict";

const assert = require("node:assert/strict");
const { ChartAgentTracker } = require("../shared/codex/chart-agent-tracker.js");
const { safeStatus } = require("../shared/wecom/status-writer.js");
const { parseAgentResponse } = require("../shared/codex/response-contract.js");

(async () => {
  const scope = { parentThreadId: "parent", factGeneration: 1, revision: 0, hasFacts: true };
  const threads = new Map();
  const interrupts = [];
  const tracker = new ChartAgentTracker({
    async request(_method, { threadId }) { return { thread: threads.get(threadId) }; },
    async interruptTurn(threadId, turnId) { interrupts.push({ threadId, turnId }); }
  });
  function event(id, kind, overrides = {}) {
    if (!threads.has(id)) threads.set(id, { parentThreadId: "parent", model: "gpt-6-astra", reasoningEffort: "ultra", forkedFromId: null });
    return tracker.observe({ type: "subAgentActivity", agentThreadId: id, kind }, { ...scope, ...overrides });
  }
  assert.equal(await tracker.completedFor(scope), false, "主模型宣称委派不能代替真实原生事件");
  event("correct", "started");
  assert.equal(await tracker.accepts("correct", scope), true, "只允许当前已核验子 Agent 校验图");
  assert.equal(await tracker.accepts("correct", { ...scope, revision: 1 }), false);
  assert.equal(tracker.running, true);
  assert.equal(await tracker.completedFor(scope), false, "子 Agent 启动尚未完成不能发布图");
  event("correct", "completed");
  assert.equal(await tracker.accepts("correct", scope), false, "已结束子 Agent 不能继续发校验请求");
  assert.equal(await tracker.completedFor(scope), true);
  assert.equal(await tracker.completedFor({ ...scope, revision: 1 }), false, "新增问题维度使旧分析失效");
  assert.equal(await tracker.completedFor({ ...scope, factGeneration: 2 }), false, "更换日期或公司后的旧图不得发布");
  for (const [id, override] of [["lower-effort", { reasoningEffort: "xhigh" }], ["other-parent", { parentThreadId: "another-user" }],
    ["history-fork", { forkedFromId: "old-facts" }], ["other-model", { model: "another-model" }]]) {
    threads.set(id, { parentThreadId: "parent", model: "gpt-6-astra", reasoningEffort: "ultra", forkedFromId: null, ...override });
    event(id, "started", { revision: 2 }); event(id, "completed", { revision: 2 });
  }
  assert.equal(await tracker.completedFor({ ...scope, revision: 2 }), false, "不可降级、跨主体或继承旧事实");
  event("before-query", "started", { revision: 3, hasFacts: false }); event("before-query", "completed", { revision: 3 });
  assert.equal(await tracker.completedFor({ ...scope, revision: 3 }), false, "未取得当前事实不能以空任务完成抵充图表分析");
  threads.set("running", { parentThreadId: "parent", model: "gpt-6-astra", reasoningEffort: "ultra", turns: [{ id: "child-turn", status: "inProgress" }] });
  event("running", "started");
  await tracker.stop();
  assert.deepEqual(interrupts, [{ threadId: "running", turnId: "child-turn" }]);
  assert.equal(tracker.running, false);
  assert.equal(await tracker.completedFor(scope), false, "取消后迟到结果失效");
  event("running", "completed");
  assert.equal(await tracker.completedFor(scope), false);

  const nativeMetadata = () => ({ parentThreadId: "parent", model: "gpt-6-astra", reasoningEffort: "ultra", forkedFromId: null });
  const observe = (instance, id, kind) => instance.observe({ type: "subAgentActivity", agentThreadId: id, kind }, scope);
  for (const initial of ["missing-fields", "read-failed"]) {
    let ready = false;
    let readCount = 0;
    const delayed = new ChartAgentTracker({ async request() {
      readCount += 1;
      if (ready) return { thread: nativeMetadata() };
      if (initial === "read-failed") throw new Error("synthetic temporary thread/read failure");
      return { thread: { parentThreadId: "parent", forkedFromId: null } };
    } });
    observe(delayed, initial, "started");
    assert.equal(await delayed.accepts(initial, scope), false, "原生元数据尚未就绪时仍不得授权子Agent图校验");
    ready = true;
    observe(delayed, initial, "completed");
    assert.equal(await delayed.completedFor(scope), true, `${initial} 不得永久污染已完成子Agent的元数据核验`);
    assert.ok(readCount >= 2, "完成时须重新读取原生元数据，不能复用启动时的失败Promise");
  }

  let validatorMetadataReady = false;
  let validatorReadCount = 0;
  const validatorRetry = new ChartAgentTracker({ async request() {
    validatorReadCount += 1;
    return { thread: validatorMetadataReady ? nativeMetadata() : { parentThreadId: "parent", model: "gpt-6-astra", reasoningEffort: null, forkedFromId: null } };
  } });
  observe(validatorRetry, "validator-retry", "started");
  assert.equal(await validatorRetry.accepts("validator-retry", scope), false);
  validatorMetadataReady = true;
  assert.equal(await validatorRetry.accepts("validator-retry", scope), true, "运行中图校验可重新核验先前未初始化的原生元数据");
  assert.ok(validatorReadCount >= 2);

  for (const override of [{ parentThreadId: "another-user" }, { reasoningEffort: "xhigh" }, { model: "another-model" }, { forkedFromId: "old-facts" }]) {
    let metadata = nativeMetadata();
    const changedAtCompletion = new ChartAgentTracker({ async request() { return { thread: metadata }; } });
    observe(changedAtCompletion, "changed-at-completion", "started");
    assert.equal(await changedAtCompletion.accepts("changed-at-completion", scope), true);
    metadata = { ...metadata, ...override };
    observe(changedAtCompletion, "changed-at-completion", "completed");
    assert.equal(await changedAtCompletion.completedFor(scope), false, `完成时仍须核对${Object.keys(override)[0]}，不能缓存启动时的true绕过强校验`);
  }

  async function expectMetadataRead(started) {
    let timer;
    try {
      await Promise.race([started, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("等待重新读取原生元数据超时")), 2000);
      })]);
    } finally { clearTimeout(timer); }
  }
  for (const operation of ["completedFor", "accepts"]) {
    let blockRead = false;
    let releaseRead;
    let signalRead;
    const deferredRead = new Promise((resolve) => { releaseRead = resolve; });
    const readStarted = new Promise((resolve) => { signalRead = resolve; });
    const stoppedWhileReading = new ChartAgentTracker({
      async request(_method, { includeTurns }) {
        if (includeTurns) return { thread: { ...nativeMetadata(), turns: [] } };
        if (blockRead) { signalRead(); return deferredRead; }
        return { thread: operation === "completedFor" ? nativeMetadata() : { parentThreadId: "parent", reasoningEffort: null } };
      },
      async interruptTurn() { throw new Error("此离线场景没有运行中的原生Turn"); }
    });
    observe(stoppedWhileReading, "stop-during-read", "started");
    assert.equal(await stoppedWhileReading.accepts("stop-during-read", scope), operation === "completedFor");
    blockRead = true;
    if (operation === "completedFor") observe(stoppedWhileReading, "stop-during-read", "completed");
    const pending = operation === "completedFor" ? stoppedWhileReading.completedFor(scope) : stoppedWhileReading.accepts("stop-during-read", scope);
    await expectMetadataRead(readStarted);
    await stoppedWhileReading.stop();
    releaseRead({ thread: nativeMetadata() });
    assert.equal(await pending, false, `${operation} 等待元数据期间停止范围后，迟到的合法元数据不得重新授权`);
    assert.equal(await stoppedWhileReading.completedFor(scope), false);
  }
  const log = safeStatus({ status: "chart_agent_started", prompt: "private facts", threadId: "private-id", model: "untrusted" });
  assert.deepEqual(Object.keys(log).sort(), ["at", "status", "transport"]);
  const unknownReference = JSON.stringify({ answer: "保留已核验结论", chart: { type: "validated", id: "00000000-0000-0000-0000-000000000000" } });
  assert.equal(parseAgentResponse(unknownReference).chart, null, "跨请求或不存在的图引用不能发布");
  process.stdout.write("chart agent lifecycle verification passed\n");
})().catch((error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
