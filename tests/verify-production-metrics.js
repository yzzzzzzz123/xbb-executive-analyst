"use strict";

const assert = require("node:assert/strict");
const { createRequestMetrics, safeRequestMetrics, summarizeTimings } = require("../shared/observability/request-metrics.js");
const { safeStatus } = require("../shared/wecom/status-writer.js");
const { createLongConnectionHandler, createProgressPublisher, retryTransient } = require("../shared/wecom/long-connection-handler.js");
const { withinBudget, DeliveryTimeoutError } = require("../shared/wecom/delivery-budget.js");
const { formatQueryProgress } = require("../shared/xbb/query-progress.js");

const tick = () => new Promise((resolve) => setImmediate(resolve));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

function fixture(id) {
  return { headers: { req_id: `offline-${id}` }, body: {
    msgid: `offline-${id}`, chattype: "single", from: { userid: "offline-test" },
    msgtype: "text", text: { content: "集团业绩" }
  } };
}

// Synthetic transport fixtures only: no model, query, network or real message.
async function runDeliveryChecks() {
  const image = { item: { msgtype: "image", image: { base64: "offline-fixture", md5: "offline-fixture" } }, buffer: Buffer.from("fixture") };
  const policy = { schemaVersion: "1.0", users: { "offline-test": { scope: "all" } } };
  const answer = "离线测试结论：不是经营数据。";
  const statuses = [];
  const replies = [];
  const uploadStarted = deferred();
  const upload = deferred();
  let uploads = 0;
  let mediaSends = 0;
  const options = {
    policy, statusWriter: (value) => statuses.push(safeStatus(value)),
    agent: { answer: async ({ onTiming }) => {
      onTiming?.({ stage: "completed", queueWaitMs: 4, runMs: 8 });
      return { answer, chart: { type: "bar" }, routeMode: "xbb" };
    } },
    chartRenderer: async () => image, answerRenderer: async () => image, emergencyImageFactory: () => image,
    progressDrainBudgetMs: 20, replyBudgetMs: 80, renderBudgetMs: 20, uploadBudgetMs: 25, mediaDeliveryBudgetMs: 20
  };
  const client = {
    replyStream: async (_, __, content, finish, items) => { const value = { content, finish, items }; replies.push(value); return value; },
    uploadMedia: () => { uploads += 1; uploadStarted.resolve(); return upload.promise; },
    sendMediaMessage: async () => { mediaSends += 1; }
  };
  const handler = createLongConnectionHandler(options);
  const pending = handler.handleMessage(fixture("slow-upload"), client);
  await uploadStarted.promise;
  assert.ok(replies.some((value) => !value.finish && value.content.startsWith(answer)), "upload 未完成时结论已可读");
  assert.equal(replies.some((value) => value.finish), false);
  await pending;
  assert.deepEqual(replies.at(-1).items, [image.item], "upload 预算耗尽必须内嵌图");
  assert.equal(uploads, 1, "默认不重复全量上传");
  upload.resolve({ media_id: "late-offline-id" });
  await tick();
  assert.equal(mediaSends, 0, "超时上传的迟到结果不得再发独立媒体");
  const measured = statuses.filter((value) => value.status === "request_measured");
  assert.equal(measured.length, 1);
  assert.equal(measured[0].outcome, "degraded");
  assert.equal(measured[0].imageDelivery, "inline");
  assert.equal(measured[0].timings.queryQueueMs, 4);
  assert.equal(measured[0].timings.queryRunMs, 8);
  assert.ok(measured[0].timings.answerVisibleMs < measured[0].timings.totalMs);
  assert.doesNotMatch(JSON.stringify(measured), /offline-test|集团|离线测试结论|slow-upload|late-offline/);
  const metricsBeforeReplay = measured.length;
  await handler.handleMessage(fixture("slow-upload"), client);
  assert.equal(statuses.filter((value) => value.status === "request_measured").length, metricsBeforeReplay, "重放不重复计入新请求");

  const blocked = deferred();
  const sentProgress = [];
  const publisher = createProgressPublisher({ deliver: (content) => { sentProgress.push(content); return blocked.promise; }, updateState: () => {}, drainBudgetMs: 10 });
  publisher.publish("in flight");
  publisher.publish("obsolete pending");
  assert.equal(await publisher.close(), false, "未决进度必须有界关闭");
  publisher.publish("late update");
  blocked.resolve();
  await tick();
  assert.deepEqual(sentProgress, ["in flight"], "关闭后不能发送旧 pending 或迟到进度");

  const stalledStatuses = [];
  const stalledReplies = [];
  const stalled = deferred();
  const stalledHandler = createLongConnectionHandler({ ...options, statusWriter: (value) => stalledStatuses.push(safeStatus(value)), agent: {
    answer: async ({ onProgress }) => { onProgress("测试进度"); onProgress("旧的待发送进度"); return { answer, chart: null, routeMode: "general" }; }
  } });
  await stalledHandler.handleMessage(fixture("stalled-progress"), {
    replyStream: async (_, __, content, finish) => {
      stalledReplies.push({ content, finish });
      if (content === "测试进度") await stalled.promise;
    }
  });
  assert.equal(stalledReplies.at(-1).content, answer);
  assert.equal(stalledReplies.at(-1).finish, true);
  stalled.resolve();
  await tick();
  assert.equal(stalledReplies.some((value) => value.content === "旧的待发送进度"), false);
  assert.equal(stalledStatuses.at(-1).status, "request_measured");

  const renderReplies = [];
  const renderStatuses = [];
  await createLongConnectionHandler({ ...options, chartRenderer: () => new Promise(() => {}),
    statusWriter: (value) => renderStatuses.push(safeStatus(value))
  }).handleMessage(fixture("stalled-render"), { replyStream: async (_, __, content, finish, items) => { renderReplies.push({ content, finish, items }); } });
  assert.match(renderReplies.at(-1).content, /改用结论速览图/);
  assert.deepEqual(renderReplies.at(-1).items, [image.item]);
  assert.equal(renderStatuses.at(-1).outcome, "degraded");

  const failedStatuses = [];
  await assert.rejects(createLongConnectionHandler({ ...options, statusWriter: (value) => failedStatuses.push(safeStatus(value)) })
    .handleMessage(fixture("first-reply-failed"), { replyStream: async () => { throw new Error("offline failure"); } }), /offline failure/);
  assert.equal(failedStatuses.at(-1).outcome, "failed");
  assert.equal(Object.hasOwn(failedStatuses.at(-1).timings, "answerVisibleMs"), false);
  return { synthetic: true, checks: 23, samples: [...measured, ...stalledStatuses, ...renderStatuses].filter((value) => value.status === "request_measured") };
}

async function run() {
  let now = 10;
  const metrics = createRequestMetrics({ now: () => now });
  now = 20;
  metrics.mark("firstReplyMs");
  await metrics.measure("analysisMs", async () => { now = 40; });
  now = 45;
  metrics.mark("answerReadyMs");
  const result = metrics.finish({ routeMode: "general", outcome: "success", imageDelivery: "none" });
  assert.deepEqual(result.timings, { firstReplyMs: 10, analysisMs: 20, answerReadyMs: 35, totalMs: 35 });
  assert.equal(metrics.finish({}), null, "同请求指标只发一次");
  const queryMetrics = createRequestMetrics();
  queryMetrics.addQueryTiming({ stage: "session_started", queueWaitMs: 15 });
  queryMetrics.addQueryTiming({ stage: "session_started", queueWaitMs: 999 });
  queryMetrics.addQueryTiming({ stage: "started", queueWaitMs: 99, runMs: 0 });
  queryMetrics.addQueryTiming({ stage: "completed", queueWaitMs: 10, runMs: 20, question: "PRIVATE" });
  queryMetrics.addQueryTiming({ stage: "completed", queueWaitMs: 2, runMs: 8 });
  const measuredQuery = queryMetrics.finish({});
  assert.equal(measuredQuery.timings.sessionQueueMs, 15, "会话排队单独且只计一次");
  assert.equal(measuredQuery.timings.queryQueueMs, 12);
  assert.equal(measuredQuery.timings.queryRunMs, 28);
  assert.doesNotMatch(JSON.stringify(measuredQuery), /PRIVATE|question/);
  const clean = safeRequestMetrics({ ...result, question: "SECRET", userId: "SECRET", timings: { ...result.timings, token: "SECRET", uploadMs: Infinity, renderMs: -1, mediaDeliveryMs: "SECRET" } });
  assert.doesNotMatch(JSON.stringify(clean), /SECRET|token|uploadMs|renderMs|mediaDeliveryMs/);
  assert.equal(Object.hasOwn(safeStatus({ status: "request_measured", requestTrace: "user-id", routeMode: "SECRET" }), "requestTrace"), false);
  assert.equal(Object.hasOwn(safeRequestMetrics({ requestTrace: { secret: "PRIVATE", toString: () => "a".repeat(32) } }), "requestTrace"), false);
  assert.equal(safeRequestMetrics({ failureClass: "deadline_exceeded" }).failureClass, "deadline_exceeded");
  assert.equal(Object.hasOwn(safeRequestMetrics({ failureClass: "PRIVATE" }), "failureClass"), false);
  assert.notEqual(createRequestMetrics().finish({}).requestTrace, result.requestTrace);
  assert.deepEqual(summarizeTimings([{ timings: { totalMs: 10 } }, { timings: { totalMs: 30 } }]).totalMs, { count: 2, p50: 10, p95: 30, max: 30 });
  await assert.rejects(withinBudget(() => new Promise(() => {}), 5), DeliveryTimeoutError);
  await assert.rejects(withinBudget(() => wait(1), Infinity), /预算/);
  let lateAttempts = 0;
  await assert.rejects(withinBudget((isOpen) => retryTransient(async () => { lateAttempts += 1; throw new Error("offline transient"); }, {
    attempts: 3, canAttempt: isOpen, wait: () => wait(20)
  }), 5), DeliveryTimeoutError);
  await wait(25);
  assert.equal(lateAttempts, 1, "budget 到期时等待中的重试不得再开始");
  assert.match(formatQueryProgress({ months: ["2026-09"] }, { stage: "queued" }, {}), /尚未开始/);
  assert.match(formatQueryProgress({}, { stage: "query_started" }, {}), /已进入/);
  const delivery = await runDeliveryChecks();
  process.stdout.write(`${JSON.stringify({ success: true, checks: delivery.checks + 11, synthetic: true })}\n`);
}

if (require.main === module) run().catch((error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
module.exports = { runDeliveryChecks };
