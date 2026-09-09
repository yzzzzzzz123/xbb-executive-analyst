"use strict";

const assert = require("node:assert/strict");
const { performance } = require("node:perf_hooks");
const { createDeliveryDeadline, withinBudget } = require("../shared/wecom/delivery-budget.js");
const { createLongConnectionHandler } = require("../shared/wecom/long-connection-handler.js");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const never = () => new Promise(() => {});
const image = { item: { msgtype: "image", image: { base64: "synthetic", md5: "synthetic" } }, buffer: Buffer.from("synthetic") };
const policy = { schemaVersion: "1.0", users: { test: { scope: "all" } } };
const frame = (id, question = "集团业绩") => ({ headers: { req_id: id }, body: { msgid: id, chattype: "single", from: { userid: "test" }, msgtype: "text", text: { content: question } } });

async function run() {
  let now = 10;
  const controlled = createDeliveryDeadline({ budgetMs: 100, startedAt: 10, now: () => now });
  assert.equal(controlled.remaining(20), 80);
  now = 60;
  assert.equal(controlled.remaining(20), 30);
  let starts = 0;
  now = 111;
  await assert.rejects(controlled.run(() => { starts += 1; }), { code: "REQUEST_DEADLINE_EXCEEDED" });
  assert.equal(starts, 0, "过期时不得启动操作");
  await assert.rejects(controlled.run(() => {}, 10, -20), /预留预算/);
  await assert.rejects(controlled.run(() => {}, NaN), /阶段预算/);

  now = 0;
  let lateSignal;
  const syncLate = createDeliveryDeadline({ budgetMs: 100, startedAt: 0, now: () => now });
  await assert.rejects(syncLate.run((_open, signal) => { lateSignal = signal; now = 101; return "late"; }), { code: "REQUEST_DEADLINE_EXCEEDED" });
  assert.equal(lateSignal.aborted, true, "事件循环未及时调度 timer 也不能接收过期成功");
  now = 0;
  const phaseLate = createDeliveryDeadline({ budgetMs: 100, startedAt: 0, now: () => now });
  await assert.rejects(phaseLate.run(() => { now = 15; return "late"; }, 10), { code: "DELIVERY_TIMEOUT" });
  await assert.rejects(withinBudget(() => { const until = performance.now() + 25; while (performance.now() < until) {} return "late"; }, 5), { code: "DELIVERY_TIMEOUT" });

  const replies = [];
  const statuses = [];
  let analysisSignal;
  let resolveLate;
  let renderCalls = 0;
  const handler = createLongConnectionHandler({
    policy,
    agent: { answer: ({ signal, remainingMs }) => {
      analysisSignal = signal;
      assert.ok(remainingMs() > 0 && remainingMs() < 180);
      return new Promise((resolve) => { resolveLate = resolve; });
    } },
    businessRequestBudgetMs: 180, generalRequestBudgetMs: 180,
    replyBudgetMs: 50, analysisDeliveryReserveMs: 60,
    progressDrainBudgetMs: 10, renderBudgetMs: 50, uploadBudgetMs: 50,
    chartRenderer: () => { renderCalls += 1; return image; },
    emergencyImageFactory: () => image,
    statusWriter: (status) => statuses.push(status)
  });
  const started = performance.now();
  await handler.handleMessage(frame("analysis-timeout"), { replyStream: async (_, __, content, finish, items) => replies.push({ content, finish, items }) });
  assert.ok(performance.now() - started < 600, "总预算不能变成每个阶段重新计时");
  assert.equal(analysisSignal.aborted, true);
  assert.equal(analysisSignal.reason.code, "REQUEST_DEADLINE_EXCEEDED");
  assert.equal(replies.at(-1).finish, true);
  assert.match(replies.at(-1).content, /包含排队等待/);
  assert.deepEqual(replies.at(-1).items, [image.item]);
  assert.equal(statuses.filter((status) => status.status === "request_measured").length, 1);
  const replyCount = replies.length;
  resolveLate({ answer: "不得补发的迟到结论", routeMode: "xbb", chart: { type: "bar" } });
  await wait(10);
  assert.equal(replies.length, replyCount);
  assert.equal(renderCalls, 0);

  const combinedReplies = [];
  let uploads = 0;
  let mediaSends = 0;
  const combined = createLongConnectionHandler({
    policy, agent: { answer: async () => { await wait(80); return { answer: "离线结论", routeMode: "xbb", chart: { type: "bar" } }; } },
    businessRequestBudgetMs: 220, replyBudgetMs: 40, analysisDeliveryReserveMs: 40,
    chartRenderer: async () => { await wait(70); return image; },
    emergencyImageFactory: () => image, renderBudgetMs: 100, uploadBudgetMs: 100
  });
  const combinedStart = performance.now();
  await combined.handleMessage(frame("combined-timeout"), {
    replyStream: async (_, __, content, finish, items) => combinedReplies.push({ content, finish, items }),
    uploadMedia: () => { uploads += 1; return never(); }, sendMediaMessage: () => { mediaSends += 1; }
  });
  assert.ok(performance.now() - combinedStart < 500);
  assert.equal(uploads, 1);
  assert.equal(mediaSends, 0);
  assert.deepEqual(combinedReplies.at(-1).items, [image.item], "总预算临近时保留最后一次内嵌交付");

  // Deterministic integration check: neither render nor upload consumes its
  // own 900ms cap, but their combined work crosses the same request deadline.
  now = 0;
  let controlledMedia = 0;
  const controlledReplies = [];
  await createLongConnectionHandler({
    policy, monotonicNow: () => now, businessRequestBudgetMs: 1000,
    replyBudgetMs: 100, analysisDeliveryReserveMs: 200, renderBudgetMs: 900, uploadBudgetMs: 900,
    emergencyImageFactory: () => image,
    agent: { answer: async () => { now = 400; return { answer: "受控时钟离线结论", routeMode: "xbb", chart: { type: "bar" } }; } },
    chartRenderer: async () => { now = 850; return image; }
  }).handleMessage(frame("controlled-cumulative"), {
    replyStream: async (_, __, content, finish, items) => controlledReplies.push({ content, finish, items }),
    uploadMedia: async () => { now = 950; return { media_id: "late-controlled" }; },
    sendMediaMessage: async () => { controlledMedia += 1; }
  });
  assert.equal(controlledMedia, 0, "阶段预算未耗尽也不能重新开始总预算或发送跨总截止的上传结果");
  assert.deepEqual(controlledReplies.at(-1).items, [image.item]);

  const unboundedReply = { replyStream: never };
  const denied = frame("denied"); denied.body.from.userid = "denied";
  await assert.rejects(createLongConnectionHandler({ policy, agent: { answer: never }, replyBudgetMs: 15, emergencyImageFactory: () => image }).handleMessage(denied, unboundedReply), { code: "DELIVERY_TIMEOUT" });
  const oversizedReplies = [];
  await createLongConnectionHandler({ policy, agent: { answer: () => { throw new Error("oversized input reached model"); } }, emergencyImageFactory: () => image })
    .handleMessage(frame("oversized", "长".repeat(12000)), { replyStream: async (_, __, content) => oversizedReplies.push(content) });
  assert.equal(oversizedReplies.length, 1);
  assert.match(oversizedReplies[0], /超过 32 KiB/);
  process.stdout.write(`${JSON.stringify({ success: true, synthetic: true, scenarios: 7 })}\n`);
}

if (require.main === module) run().catch((error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
module.exports = { run };
