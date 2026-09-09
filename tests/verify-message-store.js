"use strict";

const assert = require("node:assert/strict");
const {
  XBB_FOLLOW_UP_HANDOFF_ANSWER,
  createLongConnectionHandler,
  isTransientTransportError,
  retryTransient,
  validateFrame
} = require("../shared/wecom/long-connection-handler.js");
const { MessageStore, MessageStoreCapacityError } = require("../shared/wecom/message-store.js");

function frame(index, userId = "unknown") {
  return {
    headers: { req_id: `req-${index}` },
    body: {
      msgid: `msg-${index}`,
      chattype: "single",
      from: { userid: userId },
      msgtype: "text",
      text: { content: "集团业绩排名" }
    }
  };
}

(async () => {
  let now = 1_000_000;
  const store = new MessageStore({ ttlMs: 1000, inflightTtlMs: 5000, maxEntries: 3, maxBytes: 8192, now: () => now });
  const first = store.begin({ messageId: "a", userId: "u", streamId: "s-a", content: "a" });
  store.complete("a", "done-a");
  store.begin({ messageId: "b", userId: "u", streamId: "s-b", content: "b" });
  store.complete("b", "done-b");
  store.begin({ messageId: "c", userId: "u", streamId: "s-c", content: "c" });
  assert.equal(store.messages.size, 3);
  assert.equal(store.begin({ messageId: "a", userId: "u", streamId: "ignored", content: "ignored" }).isNew, false);
  store.begin({ messageId: "d", userId: "u", streamId: "s-d", content: "d" });
  assert.equal(store.messages.has("a"), true, "recently touched completed entry should remain");
  assert.equal(store.messages.has("b"), false, "least-recent completed entry should be evicted first");
  assert.equal(store.messages.size, 3);

  const activeOnly = new MessageStore({ ttlMs: 1000, inflightTtlMs: 5000, maxEntries: 2, maxBytes: 4096, now: () => now });
  activeOnly.begin({ messageId: "x", userId: "u", streamId: "s-x", content: "x" });
  activeOnly.begin({ messageId: "y", userId: "u", streamId: "s-y", content: "y" });
  assert.throws(
    () => activeOnly.begin({ messageId: "z", userId: "u", streamId: "s-z", content: "z" }),
    MessageStoreCapacityError
  );
  now += 2000;
  activeOnly.cleanup();
  assert.equal(activeOnly.messages.size, 2, "normal reply TTL must not evict an in-flight analysis");
  now += 4000;
  activeOnly.cleanup();
  assert.equal(activeOnly.messages.size, 0, "abandoned in-flight entries still have a hard lifetime");

  const byteBounded = new MessageStore({ ttlMs: 1000, inflightTtlMs: 5000, maxEntries: 10, maxBytes: 4096, now: () => now });
  byteBounded.begin({ messageId: "small", userId: "u", streamId: "s", content: "small" });
  byteBounded.complete("small", "small");
  byteBounded.begin({ messageId: "large", userId: "u", streamId: "l", content: "L".repeat(1800) });
  assert.equal(byteBounded.messages.has("small"), false, "byte pressure should evict completed entries");
  assert.ok(byteBounded.totalBytes <= byteBounded.maxBytes);

  const emergencyItem = Object.freeze({ msgtype: "image", image: Object.freeze({ base64: "iVBORw0KGgo=", md5: "safe-md5" }) });
  const deniedStore = new MessageStore({ maxEntries: 32, maxBytes: 64 * 1024 });
  let emergencyBuilds = 0;
  let answerRenders = 0;
  let agentCalls = 0;
  const handler = createLongConnectionHandler({
    policy: { schemaVersion: "1.0", users: { boss: { scope: "all" } } },
    agent: { answer: async () => { agentCalls += 1; return { answer: "unexpected", chart: null }; } },
    messageStore: deniedStore,
    answerRenderer: async () => { answerRenders += 1; throw new Error("unauthorized traffic must not invoke Sharp"); },
    emergencyImageFactory: () => {
      emergencyBuilds += 1;
      return { buffer: Buffer.from("safe"), item: emergencyItem };
    }
  });
  const replies = [];
  const client = { replyStream: async (_frame, _stream, content, finish, items) => { replies.push({ content, finish, items }); } };
  await Promise.all(Array.from({ length: 500 }, (_, index) => handler.handleMessage(frame(index), client)));
  assert.equal(emergencyBuilds, 1, "safe emergency image must be prebuilt once");
  assert.equal(answerRenders, 0, "denied flood must not invoke the answer renderer");
  assert.equal(agentCalls, 0);
  assert.ok(deniedStore.messages.size <= deniedStore.maxEntries);
  assert.ok(deniedStore.totalBytes <= deniedStore.maxBytes);
  assert.equal(replies.length, 500);
  assert.equal(replies.every((reply) => reply.finish === true && reply.items?.[0] === emergencyItem), true);

  const handoffStore = new MessageStore({ maxEntries: 256, maxBytes: 2 * 1024 * 1024 });
  let handoffEmergencyBuilds = 0;
  let handoffAnswerRenders = 0;
  let handoffChartRenders = 0;
  const handoffHandler = createLongConnectionHandler({
    policy: { schemaVersion: "1.0", users: { boss: { scope: "all" } } },
    agent: {
      answer: async () => ({
        answer: XBB_FOLLOW_UP_HANDOFF_ANSWER,
        chart: null,
        routeMode: "xbb"
      })
    },
    messageStore: handoffStore,
    answerRenderer: async () => {
      handoffAnswerRenders += 1;
      throw new Error("handoff must reuse the prebuilt image");
    },
    chartRenderer: async () => {
      handoffChartRenders += 1;
      throw new Error("handoff must not render a chart");
    },
    emergencyImageFactory: () => {
      handoffEmergencyBuilds += 1;
      return { buffer: Buffer.from("safe"), item: emergencyItem };
    }
  });
  const handoffReplies = [];
  const handoffClient = {
    replyStream: async (_frame, _stream, content, finish, items) => {
      handoffReplies.push({ content, finish, items });
    },
    uploadMedia: async () => { throw new Error("handoff emergency image must be inline without repeated upload"); },
    sendMediaMessage: async () => { throw new Error("handoff emergency image must be inline without repeated send"); }
  };
  const handoffCount = 200;
  await Promise.all(Array.from({ length: handoffCount }, (_, index) => handoffHandler.handleMessage(frame(`handoff-${index}`, "boss"), handoffClient)));
  const handoffFinals = handoffReplies.filter((reply) => reply.finish);
  assert.equal(handoffEmergencyBuilds, 1);
  assert.equal(handoffAnswerRenders, 0, "authorized handoff flood must not invoke Sharp summary rendering");
  assert.equal(handoffChartRenders, 0);
  assert.equal(handoffFinals.length, handoffCount);
  assert.equal(handoffFinals.every((reply) => reply.items?.[0] === emergencyItem), true);

  const routeReplies = [];
  const routeMemoryHandler = createLongConnectionHandler({
    policy: { schemaVersion: "1.0", users: {} },
    agent: { answer: async () => { throw new Error("denied route memory must not call the agent"); } },
    routeMemoryMaxEntries: 2,
    emergencyImageFactory: () => ({ buffer: Buffer.from("safe"), item: emergencyItem })
  });
  const routeClient = {
    replyStream: async (_frame, _stream, _content, finish, items) => { routeReplies.push({ finish, items }); }
  };
  await routeMemoryHandler.handleMessage(frame("route-a", "route-a"), routeClient);
  await routeMemoryHandler.handleMessage(frame("route-b", "route-b"), routeClient);
  const routeAContinue = frame("route-a-continue", "route-a");
  routeAContinue.body.text.content = "继续";
  await routeMemoryHandler.handleMessage(routeAContinue, routeClient);
  await routeMemoryHandler.handleMessage(frame("route-c", "route-c"), routeClient);
  const evictedBContinue = frame("route-b-continue", "route-b");
  evictedBContinue.body.text.content = "继续";
  await routeMemoryHandler.handleMessage(evictedBContinue, routeClient);
  const retainedCContinue = frame("route-c-continue", "route-c");
  retainedCContinue.body.text.content = "继续";
  await routeMemoryHandler.handleMessage(retainedCContinue, routeClient);
  assert.equal(routeReplies[2].items?.[0], emergencyItem, "拒绝后的追问应继承最近的 XBB 路由");
  assert.deepEqual(routeReplies[4].items, [], "路由记忆达到上限后应按 LRU 淘汰");
  assert.equal(routeReplies[5].items?.[0], emergencyItem, "未被淘汰的拒绝路由仍应附应急图");

  assert.throws(() => createLongConnectionHandler({
    policy: { schemaVersion: "1.0", users: {} },
    agent: { answer: async () => "unused" },
    emergencyImageFactory: () => ({ item: { msgtype: "image", image: {} } })
  }), /有效的企业微信图片项/);
  assert.throws(() => createLongConnectionHandler({
    policy: { schemaVersion: "1.0", users: {} },
    agent: { answer: async () => "unused" },
    routeMemoryMaxEntries: 0
  }), /路由记忆上限无效/);
  assert.throws(() => validateFrame({ headers: { req_id: "x".repeat(513) }, body: {} }), /安全上限/);
  assert.equal(isTransientTransportError(new Error("HTTP 401 authentication failed")), false);
  let permanentAttempts = 0;
  await assert.rejects(() => retryTransient(async () => {
    permanentAttempts += 1;
    throw new Error("permanent");
  }, { attempts: 4, wait: async () => {}, shouldRetry: () => false }), /permanent/);
  assert.equal(permanentAttempts, 1);

  const groupFrame = frame("group", "boss");
  groupFrame.body.chattype = "group";
  groupFrame.body.chatid = "group-chat-42";
  groupFrame.body.text.content = "@经营机器人 这个月各公司业绩怎么样";
  const groupMedia = [];
  const groupHandler = createLongConnectionHandler({
    policy: { schemaVersion: "1.0", users: { boss: { scope: "all" } } },
    agent: { answer: async () => ({ answer: "集团本月经营结论。", chart: null, routeMode: "xbb" }) },
    answerRenderer: async () => ({ buffer: Buffer.from("summary"), item: emergencyItem }),
    emergencyImageFactory: () => ({ buffer: Buffer.from("safe"), item: emergencyItem })
  });
  const groupClient = {
    replyStream: async () => {},
    uploadMedia: async () => ({ media_id: "group-image" }),
    sendMediaMessage: async (target, type, mediaId) => { groupMedia.push({ target, type, mediaId }); }
  };
  await groupHandler.handleMessage(groupFrame, groupClient);
  assert.deepEqual(groupMedia, [{ target: "group-chat-42", type: "image", mediaId: "group-image" }], "群内@机器人应把经营图片发到群 chatid");

  process.stdout.write(`${JSON.stringify({ success: true, checks: 42, deniedFlood: 500, handoffFlood: handoffCount, groupMentionImage: true, maxEntries: deniedStore.maxEntries })}\n`);
})().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
