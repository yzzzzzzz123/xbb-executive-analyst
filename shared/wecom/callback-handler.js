"use strict";

const { authorize, AccessDeniedError } = require("../security/access-control.js");
const { JobStore } = require("./job-store.js");

function queryValue(query, name) {
  const value = query?.[name];
  return Array.isArray(value) ? value[0] : value;
}

function assertFreshTimestamp(timestamp, now = Date.now) {
  const seconds = Number(timestamp);
  if (!Number.isInteger(seconds) || Math.abs(Math.floor(now() / 1000) - seconds) > 2 * 60 * 60) throw new Error("企业微信回调时间戳无效或已过期。");
}

function extractQuestion(message) {
  if (message.msgtype === "text") return message.text?.content;
  if (message.msgtype === "voice") return message.voice?.content;
  if (message.msgtype === "mixed" && Array.isArray(message.mixed?.msg_item)) {
    return message.mixed.msg_item.filter((item) => item?.msgtype === "text").map((item) => item.text?.content || "").join("\n");
  }
  return "";
}

function streamReply(job) {
  return {
    msgtype: "stream",
    stream: {
      id: job.streamId,
      finish: job.finish,
      content: job.content
    }
  };
}

function operationalFailure(error) {
  if (error instanceof AccessDeniedError) return error.message;
  return "实时经营分析失败，未返回替代或陈旧数据。请稍后重试。";
}

function createCallbackHandler({ wecomCrypto, policy, agent, jobStore = new JobStore(), now = Date.now }) {
  if (!wecomCrypto || !policy || !agent?.answer) throw new Error("企业微信回调处理器初始化参数不完整。");

  function encryptReply(reply, timestamp, nonce) {
    if (reply === null) return null;
    return wecomCrypto.encryptResponse(JSON.stringify(reply), timestamp, nonce);
  }

  return Object.freeze({
    verifyUrl(query) {
      const signature = queryValue(query, "msg_signature");
      const timestamp = queryValue(query, "timestamp");
      const nonce = queryValue(query, "nonce");
      const echo = queryValue(query, "echostr");
      assertFreshTimestamp(timestamp, now);
      return wecomCrypto.decryptVerified(echo, signature, timestamp, nonce);
    },

    handlePost(query, encryptedBody) {
      const signature = queryValue(query, "msg_signature");
      const timestamp = queryValue(query, "timestamp");
      const nonce = queryValue(query, "nonce");
      assertFreshTimestamp(timestamp, now);
      if (!encryptedBody || typeof encryptedBody.encrypt !== "string") throw new Error("企业微信回调缺少 encrypt 字段。");
      const message = JSON.parse(wecomCrypto.decryptVerified(encryptedBody.encrypt, signature, timestamp, nonce));

      if (message.msgtype === "event") return null;

      const userId = message.from?.userid;
      let access;
      try { access = authorize(policy, userId); }
      catch (error) {
        const messageId = String(message.msgid || `denied-${timestamp}-${nonce}`);
        const { job } = jobStore.begin({ messageId, userId: String(userId || ""), initialContent: operationalFailure(error) });
        jobStore.complete(job.streamId, operationalFailure(error));
        return encryptReply(streamReply(job), timestamp, nonce);
      }

      if (message.msgtype === "stream") {
        const job = jobStore.get(message.stream?.id);
        if (!job || job.userId !== userId) {
          const expired = { streamId: String(message.stream?.id || "expired"), finish: true, content: "本次查询已结束或已过期，请重新提问。" };
          return encryptReply(streamReply(expired), timestamp, nonce);
        }
        return encryptReply(streamReply(job), timestamp, nonce);
      }

      const question = String(extractQuestion(message) || "").trim();
      const messageId = String(message.msgid || "");
      if (!messageId) throw new Error("企业微信回调缺少 msgid，无法排重。");
      const initialContent = question ? "正在查询销帮帮实时数据，请稍候……" : "目前仅支持文字、语音转文字或图文中的文字经营问题。";
      const { job, isNew } = jobStore.begin({ messageId, userId, initialContent });

      if (!question) {
        jobStore.complete(job.streamId, initialContent);
      } else if (isNew) {
        Promise.resolve()
          .then(() => agent.answer({ question, access }))
          .then((answer) => jobStore.complete(job.streamId, answer))
          .catch((error) => jobStore.complete(job.streamId, operationalFailure(error)));
      }
      return encryptReply(streamReply(job), timestamp, nonce);
    }
  });
}

module.exports = { assertFreshTimestamp, createCallbackHandler, extractQuestion, streamReply };
