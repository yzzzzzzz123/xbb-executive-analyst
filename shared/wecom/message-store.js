"use strict";

const DEFAULT_MAX_ENTRIES = 1000;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_INFLIGHT_TTL_MS = 60 * 60 * 1000;

class MessageStoreCapacityError extends Error {
  constructor() {
    super("企业微信消息排重缓存已达到并发保护上限。");
    this.name = "MessageStoreCapacityError";
  }
}

function textBytes(value) {
  // V8 通常以一字节或二字节字符串表示内部文本；按更保守的 UTF-16 上界计费，
  // 避免图片 Base64 在长驻进程内被低估。
  return typeof value === "string" ? value.length * 2 : 0;
}

function itemBytes(items) {
  if (!Array.isArray(items)) return 0;
  let bytes = 0;
  for (const item of items) {
    bytes += 256;
    bytes += textBytes(item?.msgtype);
    bytes += textBytes(item?.image?.base64);
    bytes += textBytes(item?.image?.md5);
  }
  return bytes;
}

function stateBytes(state) {
  return 256
    + textBytes(state?.messageId)
    + textBytes(state?.userId)
    + textBytes(state?.streamId)
    + textBytes(state?.content)
    + itemBytes(state?.msgItem);
}

class MessageStore {
  constructor(options = {}) {
    this.ttlMs = options.ttlMs ?? 10 * 60 * 1000;
    this.inflightTtlMs = options.inflightTtlMs ?? DEFAULT_INFLIGHT_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.now = options.now || Date.now;
    this.messages = new Map();
    this.totalBytes = 0;
    if (!Number.isInteger(this.ttlMs) || this.ttlMs < 1000) throw new Error("企业微信消息缓存 TTL 无效。");
    if (!Number.isInteger(this.inflightTtlMs) || this.inflightTtlMs < this.ttlMs) throw new Error("企业微信在途消息缓存 TTL 无效。");
    if (!Number.isInteger(this.maxEntries) || this.maxEntries < 1) throw new Error("企业微信消息缓存条目上限无效。");
    if (!Number.isInteger(this.maxBytes) || this.maxBytes < 4096) throw new Error("企业微信消息缓存字节上限无效。");
  }

  _remove(messageId) {
    const state = this.messages.get(messageId);
    if (!state) return false;
    this.messages.delete(messageId);
    this.totalBytes = Math.max(0, this.totalBytes - Number(state.bytes || stateBytes(state)));
    return true;
  }

  _replaceSize(state, previousBytes) {
    state.bytes = stateBytes(state);
    this.totalBytes = Math.max(0, this.totalBytes - previousBytes + state.bytes);
  }

  _touch(messageId, state) {
    this.messages.delete(messageId);
    this.messages.set(messageId, state);
  }

  _evictCompleted({ reserveEntries = 0, reserveBytes = 0, excludeMessageId = null } = {}) {
    for (const [messageId, state] of this.messages) {
      if (this.messages.size + reserveEntries <= this.maxEntries && this.totalBytes + reserveBytes <= this.maxBytes) break;
      if (messageId === excludeMessageId || !state.finish) continue;
      this._remove(messageId);
    }
  }

  cleanup() {
    const now = this.now();
    for (const [messageId, state] of this.messages) {
      const ttl = state.finish ? this.ttlMs : this.inflightTtlMs;
      if (state.updatedAt < now - ttl) this._remove(messageId);
    }
    this._evictCompleted();
  }

  begin({ messageId, userId, streamId, content }) {
    this.cleanup();
    const existing = this.messages.get(messageId);
    if (existing) {
      if (existing.userId !== userId) throw new Error("企业微信消息标识发生用户冲突。");
      this._touch(messageId, existing);
      return { state: existing, isNew: false };
    }
    const state = { messageId, userId, streamId, content, msgItem: [], finish: false, updatedAt: this.now(), bytes: 0 };
    state.bytes = stateBytes(state);
    if (state.bytes > this.maxBytes) throw new MessageStoreCapacityError();
    this._evictCompleted({ reserveEntries: 1, reserveBytes: state.bytes });
    if (this.messages.size >= this.maxEntries || this.totalBytes + state.bytes > this.maxBytes) throw new MessageStoreCapacityError();
    this.messages.set(messageId, state);
    this.totalBytes += state.bytes;
    return { state, isNew: true };
  }

  complete(messageId, content, msgItem = []) {
    const state = this.messages.get(messageId);
    if (!state) return;
    const previousBytes = state.bytes;
    state.content = content;
    state.msgItem = Array.isArray(msgItem) ? msgItem : [];
    state.finish = true;
    state.updatedAt = this.now();
    this._replaceSize(state, previousBytes);
    this._touch(messageId, state);
    this._evictCompleted({ excludeMessageId: messageId });
    // 单条回复遵守企微 10 MiB 原图边界后仍可能因 Base64/UTF-16 记账接近预算；
    // 此时保留当前重投状态并清空其他已完成项，绝不逐出仍在处理的请求。
  }

  update(messageId, content) {
    const state = this.messages.get(messageId);
    if (!state || state.finish) return;
    const previousBytes = state.bytes;
    state.content = content;
    state.updatedAt = this.now();
    this._replaceSize(state, previousBytes);
    this._touch(messageId, state);
    this._evictCompleted({ excludeMessageId: messageId });
  }

  delete(messageId) {
    this._remove(messageId);
  }
}

module.exports = {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_INFLIGHT_TTL_MS,
  MessageStore,
  MessageStoreCapacityError,
  itemBytes,
  stateBytes
};
