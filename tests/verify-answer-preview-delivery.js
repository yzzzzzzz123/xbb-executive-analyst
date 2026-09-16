"use strict";

const assert = require("node:assert/strict");
const { createLongConnectionHandler, createProgressPublisher } = require("../shared/wecom/long-connection-handler.js");
const { MessageStore } = require("../shared/wecom/message-store.js");
const { safeStatus } = require("../shared/wecom/status-writer.js");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tick = () => new Promise((resolve) => setImmediate(resolve));
const pending = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const keepAlive = setInterval(() => {}, 1000);
function fixture(id, answer, options = {}) {
  const replies = [];
  const statuses = [];
  const store = new MessageStore();
  const handler = createLongConnectionHandler({
    policy: { schemaVersion: "1.0", users: { "synthetic-preview-user": { scope: "all" } } },
    agent: { answer }, messageStore: store, statusWriter: (event) => statuses.push(safeStatus(event)),
    heartbeatMs: 8, answerPreviewIntervalMs: 5, replyBudgetMs: 200, progressDrainBudgetMs: 20,
    ...options
  });
  const frame = { headers: { req_id: `preview-${id}` }, body: {
    msgid: `preview-${id}`, from: { userid: "synthetic-preview-user" }, chattype: "single", msgtype: "text", text: { content: "解释二分查找" }
  } };
  const client = { replyStream: async (_frame, _stream, content, finish, items) => { replies.push({ content, finish, items }); } };
  return { frame, client, handler, replies, statuses, store };
}
function previews(replies) { return replies.filter((reply) => reply.content.startsWith("正文预览")); }

(async () => {
  let callback;
  const finish = pending();
  const started = pending();
  const visible = fixture("visible", async ({ onAnswerPreview, onProgress, onTiming }) => {
    callback = onAnswerPreview;
    onTiming({ stage: "model_first_delta", elapsedMs: 1, private: "NEVER_LOG" });
    onTiming({ stage: "answer_preview_ready", elapsedMs: 2 });
    onAnswerPreview({ text: "第一段：每次把候选范围减半。", isCurrent: () => true });
    onProgress("旧阶段状态");
    started.resolve();
    await finish.promise;
    return { answer: "完整结果：每次减半，直到找到目标或范围为空。", chart: null, routeMode: "general" };
  });
  const handling = visible.handler.handleMessage(visible.frame, visible.client);
  await started.promise; await tick();
  assert.equal(previews(visible.replies).length, 1);
  assert.equal(visible.replies.at(-1).finish, false);
  assert.equal(visible.store.messages.get(visible.frame.body.msgid).content.includes("第一段"), false, "draft is never cached for replay");
  await wait(20);
  assert.equal(visible.replies.some((reply) => reply.content.includes("旧阶段状态")), false, "status/heartbeat must not overwrite a current useful preview");
  finish.resolve(); await handling;
  assert.equal(visible.replies.at(-1).finish, true);
  assert.match(visible.replies.at(-1).content, /^完整结果/);
  callback({ text: "迟到段落", isCurrent: () => true }); await wait(10);
  assert.equal(visible.replies.some((reply) => reply.content.includes("迟到段落")), false);
  const metric = visible.statuses.find((event) => event.status === "request_measured");
  assert.equal(metric.outcome, "success");
  for (const name of ["modelFirstDeltaMs", "answerPreviewReadyMs", "answerPreviewVisibleMs"]) assert.ok(Number.isInteger(metric.timings[name]));
  assert.ok(metric.timings.answerPreviewVisibleMs < metric.timings.answerVisibleMs);
  assert.doesNotMatch(JSON.stringify(visible.statuses), /NEVER_LOG|第一段|synthetic-preview-user/);

  const blocker = pending();
  let ownerCurrent = true;
  const sent = [];
  const cached = [];
  const publisher = createProgressPublisher({
    deliver: async (content, isCurrent, onDispatch) => {
      if (!isCurrent()) return false;
      onDispatch(); sent.push(content);
      if (content === "already dispatched") await blocker.promise;
    }, updateState: (content) => cached.push(content), drainBudgetMs: 20
  });
  publisher.publish("already dispatched");
  publisher.publish("old-owner draft", { store: false, isCurrent: () => ownerCurrent });
  ownerCurrent = false; blocker.resolve(); await publisher.flush();
  assert.deepEqual(sent, ["already dispatched"]);
  assert.deepEqual(cached, ["already dispatched"]);
  await publisher.close();

  const failAfterPreview = fixture("failed", async ({ onAnswerPreview }) => {
    onAnswerPreview({ text: "未完成的第一段", isCurrent: () => true });
    await wait(5); throw new Error("synthetic failure");
  });
  await failAfterPreview.handler.handleMessage(failAfterPreview.frame, failAfterPreview.client);
  assert.match(failAfterPreview.replies.at(-1).content, /正文预览不是完整结果/);
  assert.equal(failAfterPreview.statuses.at(-1).outcome, "failed");

  const stalled = pending();
  const unacked = fixture("unacked", async ({ onAnswerPreview }) => {
    onAnswerPreview({ text: "未得到通道回执的段落", isCurrent: () => true });
    await wait(20); throw new Error("synthetic failure after send");
  }, { replyBudgetMs: 10 });
  unacked.client.replyStream = async (_frame, _stream, content, finish) => {
    unacked.replies.push({ content, finish });
    if (content.startsWith("正文预览")) await stalled.promise;
  };
  await unacked.handler.handleMessage(unacked.frame, unacked.client);
  assert.match(unacked.replies.at(-1).content, /正文预览不是完整结果/);
  assert.equal(Object.hasOwn(unacked.statuses.at(-1).timings, "answerPreviewVisibleMs"), false, "no ACK means no visible-time success");
  stalled.resolve(); await tick();
  assert.equal(Object.hasOwn(unacked.statuses.at(-1).timings, "answerPreviewVisibleMs"), false);

  const rejectedPreview = fixture("preview-rejected", async ({ onAnswerPreview, onProgress }) => {
    onAnswerPreview({ text: "发送失败的正文段落", isCurrent: () => true });
    onProgress("继续整理验证结果");
    await wait(25);
    return { answer: "预览失败不影响完整答复", chart: null, routeMode: "general" };
  }, { heartbeatMs: 5 });
  rejectedPreview.client.replyStream = async (_frame, _stream, content, finish) => {
    if (content.startsWith("正文预览")) throw new Error("synthetic immediate preview rejection");
    rejectedPreview.replies.push({ content, finish });
  };
  await rejectedPreview.handler.handleMessage(rejectedPreview.frame, rejectedPreview.client);
  assert.ok(rejectedPreview.replies.some((reply) => reply.content === "继续整理验证结果"), "failed current preview must restore the latest stage");
  assert.ok(rejectedPreview.replies.some((reply) => reply.content.includes("已用时")), "failed current preview must no longer suppress heartbeat");
  assert.equal(rejectedPreview.replies.at(-1).finish, true);
  assert.equal(rejectedPreview.statuses.at(-1).outcome, "success");
  assert.equal(Object.hasOwn(rejectedPreview.statuses.at(-1).timings, "answerPreviewVisibleMs"), false, "rejected preview must not claim an ACK");

  const oldSending = pending();
  const failOld = pending();
  const newerQueued = fixture("newer-preview", async ({ onAnswerPreview, onProgress }) => {
    onAnswerPreview({ text: "旧预览发送中", isCurrent: () => true });
    await oldSending.promise;
    onAnswerPreview({ text: "更新后的正文预览", isCurrent: () => true });
    onProgress("不应覆盖新预览的状态");
    failOld.resolve();
    await wait(25);
    return { answer: "完整最终答复", chart: null, routeMode: "general" };
  });
  newerQueued.client.replyStream = async (_frame, _stream, content, finish) => {
    if (content.includes("旧预览发送中")) {
      oldSending.resolve(); await failOld.promise;
      throw new Error("synthetic old preview failure after newer draft queued");
    }
    newerQueued.replies.push({ content, finish });
  };
  await newerQueued.handler.handleMessage(newerQueued.frame, newerQueued.client);
  assert.equal(previews(newerQueued.replies).length, 1);
  assert.match(previews(newerQueued.replies)[0].content, /更新后的正文预览/);
  assert.equal(newerQueued.replies.some((reply) => reply.content.includes("不应覆盖新预览的状态")), false, "older failure cannot replace a newer queued preview with status");
  assert.ok(Number.isInteger(newerQueued.statuses.at(-1).timings.answerPreviewVisibleMs));
  assert.equal(newerQueued.replies.at(-1).finish, true);

  const failureEvents = [];
  const failureObserver = createProgressPublisher({
    deliver: async (content) => { failureEvents.push(content); if (content === "failed") throw new Error("synthetic publisher delivery failure"); },
    updateState: () => {}
  });
  failureObserver.publish("failed", { onDeliveryFailed: () => new Promise(() => {}) });
  failureObserver.publish("continues");
  await failureObserver.flush(); await failureObserver.close();
  assert.deepEqual(failureEvents, ["failed", "continues"], "unsettled failure observer must not block the publisher");

  const business = fixture("business", async ({ onAnswerPreview }) => {
    onAnswerPreview({ text: "禁止提前发送的合成经营数字", isCurrent: () => true });
    return { answer: "经营测试最终状态", chart: null, routeMode: "xbb" };
  });
  business.frame.body.text.content = "集团2026年8月业绩";
  await business.handler.handleMessage(business.frame, business.client);
  assert.equal(previews(business.replies).length, 0);
  assert.equal(business.replies.at(-1).items.length, 0, "无合格图表时仅回复文字，不能补发摘要图片");

  const capped = fixture("cap", async ({ onAnswerPreview }) => {
    for (let index = 0; index < 20; index += 1) {
      onAnswerPreview({ text: `完整测试段落 ${index}`, isCurrent: () => true });
      await wait(3);
    }
    return { answer: "最终答复不受预览限额限制", chart: null, routeMode: "general" };
  }, { answerPreviewIntervalMs: 1 });
  await capped.handler.handleMessage(capped.frame, capped.client);
  assert.equal(previews(capped.replies).length, 12);
  assert.equal(capped.replies.at(-1).finish, true);

  const coalesced = fixture("coalesced", async ({ onAnswerPreview }) => {
    onAnswerPreview({ text: "首段", isCurrent: () => true }); await tick();
    for (let index = 0; index < 20; index += 1) onAnswerPreview({ text: `最新段落 ${index}`, isCurrent: () => true });
    await wait(35);
    return { answer: "完整答复", chart: null, routeMode: "general" };
  }, { answerPreviewIntervalMs: 20 });
  await coalesced.handler.handleMessage(coalesced.frame, coalesced.client);
  assert.equal(previews(coalesced.replies).length, 2);
  assert.match(previews(coalesced.replies)[1].content, /最新段落 19/);

  const invalid = fixture("invalid", async ({ onAnswerPreview }) => {
    onAnswerPreview({ text: "错误guard", isCurrent: () => { throw new Error("synthetic guard failure"); } });
    onAnswerPreview({ text: "没有guard" });
    onAnswerPreview({ text: "长".repeat(6001), isCurrent: () => true });
    return { answer: "安全完成", chart: null, routeMode: "general" };
  });
  await invalid.handler.handleMessage(invalid.frame, invalid.client);
  assert.equal(previews(invalid.replies).length, 0);
  assert.equal(Object.hasOwn(invalid.statuses.at(-1).timings, "answerPreviewVisibleMs"), false);
  // Long synthetic analysis exercises transport preservation, not model quality.
  const fullAnswer = [
    "离线虚构验收。总体：公司甲100元、公司乙80元，合计180元。",
    "趋势：缺少连续时间点，无法确认增减。",
    "排名：公司甲领先20元；缺少目标，不能判断目标达成。",
    "口径：上述均为离线测试数字。".repeat(180)
  ].join("\n\n");
  const chartItem = { msgtype: "image", image: { base64: "c3ludGhldGlj", md5: "test-only" } };
  for (const mode of ["text", "standalone", "inline", "render-failed"]) {
    const events = [];
    const result = fixture(`required-text-${mode}`, async () => ({
      answer: fullAnswer, chart: mode === "text" ? null : { type: "bar" }, routeMode: mode === "text" ? "general" : "xbb"
    }), { chartRenderer: async () => {
      events.push("render");
      assert.ok(result.replies.some((reply) => reply.content.startsWith(fullAnswer) && !reply.finish),
        "完整文字必须在制作图片前发送");
      if (mode === "render-failed") throw new Error("synthetic rendering failure");
      return { item: chartItem, buffer: Buffer.from("synthetic image") };
    }, retryWait: async () => {} });
    if (mode !== "text") result.frame.body.text.content = "总体业绩、趋势与公司排名";
    if (mode === "standalone") {
      result.client.uploadMedia = async () => ({ media_id: "synthetic-image" });
      result.client.sendMediaMessage = async () => { events.push("media"); };
    }
    await result.handler.handleMessage(result.frame, result.client);
    const finalReply = result.replies.at(-1);
    assert.equal(finalReply.finish, true);
    if (mode === "render-failed") {
      assert.ok(finalReply.content.startsWith(fullAnswer));
      assert.match(finalReply.content, /图表暂未生成/);
    } else assert.equal(finalReply.content, fullAnswer, `${mode} 必须保留完整多段正文`);
    assert.deepEqual(finalReply.items, mode === "inline" ? [chartItem] : []);
    if (mode === "standalone") assert.deepEqual(events, ["render", "media"]);
    if (mode === "text") assert.deepEqual(events, []);
    await result.handler.handleMessage(result.frame, result.client);
    assert.equal(result.replies.at(-1).content, finalReply.content, "重复投递仍保留完整正文");
    assert.deepEqual(result.replies.at(-1).items, ["inline", "standalone"].includes(mode) ? [chartItem] : []);
  }
  for (const answer of [undefined, " \n", { invalid: true }]) {
    const missing = fixture("missing-text", async () => ({ answer, chart: { type: "bar" } }), {
      chartRenderer: async () => { throw new Error("空正文不得进入制图发送流程"); }
    });
    await missing.handler.handleMessage(missing.frame, missing.client);
    assert.equal(missing.replies.at(-1).finish, true);
    assert.ok(missing.replies.at(-1).content.trim(), "异常也必须给出文字状态");
    assert.deepEqual(missing.replies.at(-1).items, []);
    assert.equal(missing.statuses.at(-1).outcome, "failed", "不能把只有图片的结果标为成功");
  }
  // Reproduce the production failure at the transport boundary: analysis
  // succeeds after ten minutes, passive replies fail, active images still work.
  const { MARKDOWN_PART_BYTES, splitMarkdownText } = require("../shared/wecom/text-delivery.js");
  const completeText = "离线虚构验收：公司甲100元，课程60%、咨询40%；公司乙80元，课程25%、咨询75%。\n".repeat(70) + "口径与缺口：仅为测试，不是真实业绩。😀";
  assert.equal(splitMarkdownText(completeText).join(""), completeText);
  assert.equal(splitMarkdownText("😀".repeat(1400)).join(""), "😀".repeat(1400));
  for (const mode of ["expired-single", "expired-group", "text-only", "final-only", "text-rejected", "text-timeout", "deadline", "image-rejected", "render-rejected"]) {
    let now = 0;
    const events = [];
    const markdown = [];
    let analysisComplete = false;
    let renders = 0;
    const useChart = mode !== "text-only";
    const result = fixture(`fallback-${mode}`, async () => {
      analysisComplete = true;
      now = 610000;
      return { answer: completeText, chart: useChart ? { type: "bar" } : null, routeMode: useChart ? "xbb" : "general" };
    }, {
      monotonicNow: () => now, replyBudgetMs: 30,
      chartRenderer: async () => {
        renders += 1;
        if (mode !== "final-only") assert.equal(markdown.join(""), completeText, "完整文字须先获得回执，才能出图");
        if (mode === "render-rejected") throw new Error("synthetic render rejection");
        events.push("render"); return { item: chartItem, buffer: Buffer.from("synthetic image") };
      }
    });
    if (useChart) result.frame.body.text.content = "对集团业绩按照公司名称排名，区分课程和咨询占比";
    if (mode === "expired-group") {
      result.frame.body.chattype = "group";
      result.frame.body.chatid = "synthetic-group";
    }
    const destination = mode === "expired-group" ? "synthetic-group" : "synthetic-preview-user";
    const originalReply = result.client.replyStream;
    result.client.replyStream = async (...args) => {
      if (analysisComplete && (mode !== "final-only" || args[3])) {
        if (mode === "deadline") now = 20 * 60 * 1000;
        throw new Error("synthetic passive reply expired");
      }
      return originalReply(...args);
    };
    result.client.sendMessage = async (target, body) => {
      assert.equal(target, destination, "补发必须留在原授权会话，群聊不能变成私聊");
      assert.equal(body.msgtype, "markdown");
      assert.ok(Buffer.byteLength(body.markdown.content, "utf8") <= MARKDOWN_PART_BYTES);
      assert.doesNotMatch(body.markdown.content, /\uFFFD/);
      if (mode === "text-rejected") throw new Error("synthetic text rejection");
      if (mode === "text-timeout") return new Promise(() => {});
      markdown.push(body.markdown.content); events.push("text");
      return { errcode: 0 };
    };
    result.client.uploadMedia = async () => ({ media_id: "synthetic-image" });
    result.client.sendMediaMessage = async (target) => {
      assert.equal(target, destination);
      if (mode === "image-rejected") throw new Error("synthetic media rejection");
      events.push("image"); return { errcode: 0 };
    };
    if (["text-rejected", "text-timeout", "deadline"].includes(mode)) {
      await assert.rejects(() => result.handler.handleMessage(result.frame, result.client));
      assert.equal(renders, 0, "文字未确认交付，不得出图或只发图片");
      assert.equal(events.includes("image"), false);
      assert.equal(result.statuses.at(-1).outcome, "failed");
      assert.equal(Object.hasOwn(result.statuses.at(-1).timings, "answerVisibleMs"), false);
    } else {
      await result.handler.handleMessage(result.frame, result.client);
      assert.ok(markdown.join("").startsWith(completeText), "排名、占比、口径和缺口均须保留");
      if (mode !== "render-rejected") assert.equal(markdown.join(""), completeText, "不能重复补发已经确认送达的正文");
      else assert.match(markdown.join(""), /图表暂未生成/);
      const metric = result.statuses.at(-1);
      assert.ok(Number.isInteger(metric.timings.answerVisibleMs));
      assert.equal(metric.outcome, ["image-rejected", "render-rejected"].includes(mode) ? "degraded" : "success");
      if (["expired-single", "expired-group"].includes(mode)) {
        assert.ok(events.lastIndexOf("text") < events.indexOf("image"));
        assert.equal(events.filter((event) => event === "image").length, 1);
        assert.equal(metric.imageDelivery, "standalone");
      }
      if (mode === "image-rejected") assert.equal(metric.imageDelivery, "failed");
      assert.equal(result.store.messages.get(result.frame.body.msgid).content.startsWith(completeText), true, "重放缓存必须保留完整文字");
    }
    assert.doesNotMatch(JSON.stringify(result.statuses), /公司甲|synthetic-preview-user|synthetic-group|synthetic passive/);
  }
  // Exercise the installed official SDK's payload and fresh req_id construction
  // without connecting to WeCom or sending a real user any test message.
  const { WSClient } = require("@wecom/aibot-node-sdk");
  const sdk = new WSClient({ botId: "synthetic", secret: "synthetic", logger: { debug() {}, info() {}, warn() {}, error() {} } });
  const sdkPackets = [];
  let sdkAnalysisComplete = false;
  sdk.wsManager.sendReply = async (reqId, body, command = "aibot_respond_msg") => {
    sdkPackets.push({ reqId, body, command });
    if (sdkAnalysisComplete && command === "aibot_respond_msg") throw { errcode: 400, errmsg: "synthetic expired request" };
    return { errcode: 0 };
  };
  const sdkFixture = fixture("official-sdk", async () => {
    sdkAnalysisComplete = true;
    return { answer: completeText, chart: null, routeMode: "general" };
  });
  await sdkFixture.handler.handleMessage(sdkFixture.frame, sdk);
  const activePackets = sdkPackets.filter((packet) => packet.command === "aibot_send_msg");
  assert.ok(activePackets.length > 1);
  assert.equal(activePackets.map((packet) => packet.body.markdown.content).join(""), completeText);
  assert.equal(new Set(activePackets.map((packet) => packet.reqId)).size, activePackets.length);
  for (const packet of activePackets) {
    assert.notEqual(packet.reqId, sdkFixture.frame.headers.req_id);
    assert.equal(packet.body.chatid, sdkFixture.frame.body.from.userid);
    assert.equal(packet.body.msgtype, "markdown");
  }
  console.log(JSON.stringify({ success: true, synthetic: true, scenarios: 28, realMessagesSent: 0 }));
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => clearInterval(keepAlive));
