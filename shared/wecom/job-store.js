"use strict";

const crypto = require("node:crypto");

class JobStore {
  constructor(options = {}) {
    this.ttlMs = options.ttlMs || 7 * 60 * 1000;
    this.now = options.now || Date.now;
    this.jobs = new Map();
    this.byMessage = new Map();
  }

  cleanup() {
    const cutoff = this.now() - this.ttlMs;
    for (const [streamId, job] of this.jobs) {
      if (job.updatedAt < cutoff) {
        this.jobs.delete(streamId);
        this.byMessage.delete(job.messageId);
      }
    }
  }

  begin({ messageId, userId, initialContent }) {
    this.cleanup();
    const existingId = this.byMessage.get(messageId);
    if (existingId && this.jobs.has(existingId)) return { job: this.jobs.get(existingId), isNew: false };
    const streamId = crypto.randomBytes(16).toString("hex");
    const job = {
      streamId,
      messageId,
      userId,
      content: initialContent,
      finish: false,
      updatedAt: this.now()
    };
    this.jobs.set(streamId, job);
    this.byMessage.set(messageId, streamId);
    return { job, isNew: true };
  }

  get(streamId) {
    this.cleanup();
    return this.jobs.get(streamId);
  }

  complete(streamId, content) {
    const job = this.jobs.get(streamId);
    if (!job) return;
    job.content = content;
    job.finish = true;
    job.updatedAt = this.now();
  }
}

module.exports = { JobStore };
