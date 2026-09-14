"use strict";

const { CHART_AGENT_MODEL, CHART_AGENT_EFFORT } = require("./chart-agent-config.js");

// Trust native parent/child metadata, never a model's claim that it delegated.
class ChartAgentTracker {
  constructor(client) {
    this.client = client;
    this.children = new Map();
  }

  get running() { return [...this.children.values()].some((child) => child.kind === "started" && !child.stopped); }

  _matches(child, scope, kind) {
    return Boolean(child && !child.stopped && child.hasFacts && child.kind === kind
      && child.parentThreadId === scope.parentThreadId && child.factGeneration === scope.factGeneration
      && child.revision === scope.revision);
  }

  _verify(child) {
    child.check = this.client.request("thread/read", { threadId: child.id, includeTurns: false }, { timeoutMs: 10000 })
      .then(({ thread }) => {
        child.verified = thread?.parentThreadId === child.parentThreadId
          && thread?.model === CHART_AGENT_MODEL && thread?.reasoningEffort === CHART_AGENT_EFFORT
          && !thread?.forkedFromId;
        return child.verified;
      }).catch(() => { child.verified = false; return false; });
    return child.check;
  }

  observe(item, scope) {
    if (item?.type !== "subAgentActivity" || typeof item.agentThreadId !== "string") return null;
    let child = this.children.get(item.agentThreadId);
    if (item.kind === "started" && !child) {
      if (this.children.size >= 12) return null;
      child = { ...scope, id: item.agentThreadId, kind: "started", verified: false, stopped: false };
      this.children.set(child.id, child);
      this._verify(child);
      return "started";
    }
    if (!child || child.stopped || !["completed", "interrupted"].includes(item.kind) || child.kind === item.kind) return null;
    child.kind = item.kind;
    return item.kind;
  }

  async completedFor(scope) {
    const matching = [...this.children.values()].filter((child) => this._matches(child, scope, "completed"));
    await Promise.all(matching.map(async (child) => {
      await child.check;
      // A started event may arrive before native model/effort metadata is ready.
      // Completion must verify fresh metadata, including a formerly valid read.
      if (this._matches(child, scope, "completed")) await this._verify(child);
    }));
    return matching.some((child) => this._matches(child, scope, "completed") && child.verified);
  }

  async stop() {
    const running = [...this.children.values()].filter((child) => child.kind === "started" && !child.stopped);
    for (const child of this.children.values()) child.stopped = true;
    await Promise.allSettled(running.map(async (child) => {
      const { thread } = await this.client.request("thread/read", { threadId: child.id, includeTurns: true }, { timeoutMs: 10000 });
      if (thread?.parentThreadId !== child.parentThreadId) return;
      const turn = [...(thread.turns || [])].reverse().find((item) => item.status === "inProgress");
      if (turn) await this.client.interruptTurn(child.id, turn.id);
    }));
  }

  async accepts(threadId, scope) {
    const child = this.children.get(threadId);
    if (!this._matches(child, scope, "started")) return false;
    let verified = await child.check;
    if (!verified && this._matches(child, scope, "started")) verified = await this._verify(child);
    return this._matches(child, scope, "started") && verified;
  }
}

module.exports = { ChartAgentTracker };
