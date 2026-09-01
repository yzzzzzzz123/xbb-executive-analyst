"use strict";

class MessageStore {
  constructor(options = {}) {
    this.ttlMs = options.ttlMs || 10 * 60 * 1000;
    this.now = options.now || Date.now;
    this.messages = new Map();
  }

  cleanup() {
    const cutoff = this.now() - this.ttlMs;
    for (const [messageId, state] of this.messages) {
      if (state.updatedAt < cutoff) this.messages.delete(messageId);
    }
  }

  begin({ messageId, userId, streamId, content }) {
    this.cleanup();
    const existing = this.messages.get(messageId);
    if (existing) {
      if (existing.userId !== userId) throw new Error("企业微信消息标识发生用户冲突。");
      return { state: existing, isNew: false };
    }
    const state = { messageId, userId, streamId, content, msgItem: [], finish: false, updatedAt: this.now() };
    this.messages.set(messageId, state);
    return { state, isNew: true };
  }

  complete(messageId, content, msgItem = []) {
    const state = this.messages.get(messageId);
    if (!state) return;
    state.content = content;
    state.msgItem = Array.isArray(msgItem) ? msgItem : [];
    state.finish = true;
    state.updatedAt = this.now();
  }

  update(messageId, content) {
    const state = this.messages.get(messageId);
    if (!state || state.finish) return;
    state.content = content;
    state.updatedAt = this.now();
  }

  delete(messageId) {
    this.messages.delete(messageId);
  }
}

module.exports = { MessageStore };
