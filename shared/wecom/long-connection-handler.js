"use strict";

const crypto = require("node:crypto");
const { AgentBusyError, principalKeyFromUserId } = require("../codex/persistent-agent.js");
const { authorize, AccessDeniedError } = require("../security/access-control.js");
const { createWecomChartImage } = require("./chart-image.js");
const { MessageStore } = require("./message-store.js");

function extractQuestion(message) {
  if (message?.msgtype === "text") return message.text?.content;
  if (message?.msgtype === "voice") return message.voice?.content;
  if (message?.msgtype === "mixed" && Array.isArray(message.mixed?.msg_item)) {
    return message.mixed.msg_item
      .filter((item) => item?.msgtype === "text")
      .map((item) => item.text?.content || "")
      .join("\n");
  }
  return "";
}

function operationalFailure(error) {
  if (error instanceof AccessDeniedError) return error.message;
  if (error instanceof AgentBusyError) return "上一条问题仍在处理中，本条没有合并到当前任务。请等待上一条结果后再提问。";
  return "实时经营分析失败，未返回替代或陈旧数据。请稍后重试。";
}

function defaultStreamId() {
  return `stream_${Date.now()}_${crypto.randomBytes(8).toString("hex")}`;
}

function validateFrame(frame) {
  if (!frame?.headers?.req_id || typeof frame.headers.req_id !== "string") throw new Error("企业微信长连接消息缺少 req_id。");
  const message = frame.body;
  if (!message || typeof message !== "object") throw new Error("企业微信长连接消息缺少正文。");
  if (!message.msgid || typeof message.msgid !== "string") throw new Error("企业微信长连接消息缺少 msgid，无法排重。");
  return message;
}

function createLongConnectionHandler({
  policy,
  agent,
  messageStore = new MessageStore(),
  streamIdFactory = defaultStreamId,
  principalKeyFactory = principalKeyFromUserId,
  statusWriter = () => {},
  heartbeatMs = 45000,
  chartRenderer = createWecomChartImage
}) {
  if (!policy || !agent?.answer) throw new Error("企业微信长连接处理器初始化参数不完整。");

  return Object.freeze({
    async handleMessage(frame, client) {
      if (!client?.replyStream) throw new Error("企业微信长连接客户端不可用。");
      const message = validateFrame(frame);
      const messageId = message.msgid;
      const receivedAtMs = Date.now();
      const userId = String(message.from?.userid || "");
      const question = String(extractQuestion(message) || "").trim();

      let access;
      try {
        access = authorize(policy, userId);
      } catch (error) {
        const content = operationalFailure(error);
        const { state, isNew } = messageStore.begin({ messageId, userId, streamId: streamIdFactory(), content });
        if (isNew) messageStore.complete(messageId, content);
        return client.replyStream(frame, state.streamId, state.content, true);
      }

      const initialContent = question
        ? "正在查询，请稍候……"
        : "目前仅支持文字、语音转文字或图文中的文字经营问题。";
      const { state, isNew } = messageStore.begin({ messageId, userId, streamId: streamIdFactory(), content: initialContent });

      if (!isNew) return client.replyStream(frame, state.streamId, state.content, state.finish, state.finish ? state.msgItem : undefined);
      statusWriter({ status: "message_received" });
      if (!question) {
        messageStore.complete(messageId, initialContent);
        const reply = await client.replyStream(frame, state.streamId, initialContent, true);
        statusWriter({ status: "reply_completed", elapsedMs: Date.now() - receivedAtMs });
        return reply;
      }

      try {
        await client.replyStream(frame, state.streamId, initialContent, false);
      } catch (error) {
        messageStore.delete(messageId);
        throw error;
      }

      let answer;
      let chart = null;
      let heartbeat;
      try {
        let delivery = Promise.resolve();
        const onProgress = (content) => {
          messageStore.update(messageId, content);
          delivery = delivery.then(() => client.replyStream(frame, state.streamId, content, false));
          return delivery;
        };
        heartbeat = setInterval(() => {
          const seconds = Math.max(1, Math.floor((Date.now() - receivedAtMs) / 1000));
          void onProgress(`Codex 仍在分析，已用时约 ${seconds} 秒，请稍候……`).catch(() => {});
        }, heartbeatMs);
        heartbeat.unref?.();
        const result = await agent.answer({
          question,
          access,
          principalKey: principalKeyFactory(userId, access),
          messageId,
          onProgress
        });
        answer = typeof result === "string" ? result : result.answer;
        chart = typeof result === "object" && result ? result.chart : null;
        clearInterval(heartbeat);
        await delivery;
      } catch (error) {
        if (heartbeat) clearInterval(heartbeat);
        answer = operationalFailure(error);
      }
      let msgItem = [];
      let imageBuffer = null;
      if (chart) {
        try {
          const rendered = await chartRenderer(chart);
          if (rendered?.item && Buffer.isBuffer(rendered.buffer)) {
            msgItem = [rendered.item];
            imageBuffer = rendered.buffer;
          } else {
            msgItem = [rendered];
          }
          statusWriter({ status: "chart_generated" });
        } catch {
          statusWriter({ status: "chart_failed" });
        }
      }
      let uploadedMediaId = null;
      const target = message.chattype === "group" ? String(message.chatid || "") : userId;
      if (imageBuffer && target && typeof client.uploadMedia === "function" && typeof client.sendMediaMessage === "function") {
        try {
          const uploaded = await client.uploadMedia(imageBuffer, { type: "image", filename: "经营分析图表.png" });
          uploadedMediaId = uploaded?.media_id || null;
          if (!uploadedMediaId) throw new Error("企业微信未返回图片 media_id。");
          statusWriter({ status: "chart_uploaded" });
        } catch {
          uploadedMediaId = null;
        }
      }
      let standaloneDelivered = false;
      if (uploadedMediaId) {
        try {
          await client.sendMediaMessage(target, "image", uploadedMediaId);
          standaloneDelivered = true;
          statusWriter({ status: "chart_delivered" });
        } catch {
          standaloneDelivered = false;
        }
      }
      const inlineItems = standaloneDelivered ? [] : msgItem;
      messageStore.complete(messageId, answer, inlineItems);
      const reply = await client.replyStream(frame, state.streamId, answer, true, inlineItems);
      if (inlineItems.length) statusWriter({ status: "chart_delivered" });
      statusWriter({ status: "reply_completed", elapsedMs: Date.now() - receivedAtMs });
      return reply;
    }
  });
}

module.exports = { createLongConnectionHandler, extractQuestion, operationalFailure, validateFrame };
