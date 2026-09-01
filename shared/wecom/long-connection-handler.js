"use strict";

const crypto = require("node:crypto");
const { authorize, AccessDeniedError } = require("../security/access-control.js");
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

function createLongConnectionHandler({ policy, agent, messageStore = new MessageStore(), streamIdFactory = defaultStreamId }) {
  if (!policy || !agent?.answer) throw new Error("企业微信长连接处理器初始化参数不完整。");

  return Object.freeze({
    async handleMessage(frame, client) {
      if (!client?.replyStream) throw new Error("企业微信长连接客户端不可用。");
      const message = validateFrame(frame);
      const messageId = message.msgid;
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
        ? "正在查询销帮帮实时数据，请稍候……"
        : "目前仅支持文字、语音转文字或图文中的文字经营问题。";
      const { state, isNew } = messageStore.begin({ messageId, userId, streamId: streamIdFactory(), content: initialContent });

      if (!isNew) return client.replyStream(frame, state.streamId, state.content, state.finish);
      if (!question) {
        messageStore.complete(messageId, initialContent);
        return client.replyStream(frame, state.streamId, initialContent, true);
      }

      try {
        await client.replyStream(frame, state.streamId, initialContent, false);
      } catch (error) {
        messageStore.delete(messageId);
        throw error;
      }

      let answer;
      try {
        answer = await agent.answer({ question, access });
      } catch (error) {
        answer = operationalFailure(error);
      }
      messageStore.complete(messageId, answer);
      return client.replyStream(frame, state.streamId, answer, true);
    }
  });
}

module.exports = { createLongConnectionHandler, extractQuestion, operationalFailure, validateFrame };
