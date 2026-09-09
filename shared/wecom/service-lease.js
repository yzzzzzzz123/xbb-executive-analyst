"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_LEASE_HEARTBEAT_MS = 30000;
const VALID_LEASE_STATES = new Set(["starting", "running", "stopped"]);

class ServiceLease {
  constructor({ leasePath, heartbeatMs = DEFAULT_LEASE_HEARTBEAT_MS, clock = { setInterval, clearInterval }, now = Date.now, onError = () => {} }) {
    if (typeof leasePath !== "string" || !leasePath) throw new Error("机器人服务租约路径不能为空。");
    if (!Number.isInteger(heartbeatMs) || heartbeatMs < 5000 || heartbeatMs > 120000) throw new Error("机器人服务租约心跳间隔无效。");
    this.leasePath = path.resolve(leasePath);
    this.heartbeatMs = heartbeatMs;
    this.clock = clock;
    this.now = now;
    this.onError = onError;
    this.timer = null;
    this.state = "stopped";
    this.terminal = false;
    this.stateSinceAtMs = null;
    this.instanceId = crypto.randomUUID();
  }

  _write(state) {
    const updatedAtMs = this.now();
    if (!VALID_LEASE_STATES.has(state)) throw new Error("机器人服务租约状态无效。");
    if (!Number.isFinite(this.stateSinceAtMs)) this.stateSinceAtMs = updatedAtMs;
    const payload = {
      schemaVersion: "1.0",
      service: "xbb-executive-analyst-wecom",
      state,
      pid: process.pid,
      instanceId: this.instanceId,
      stateSinceAtMs: this.stateSinceAtMs,
      stateSinceAt: new Date(this.stateSinceAtMs).toISOString(),
      updatedAtMs,
      updatedAt: new Date(updatedAtMs).toISOString()
    };
    const parent = path.dirname(this.leasePath);
    fs.mkdirSync(parent, { recursive: true });
    const temporary = `${this.leasePath}.tmp-${process.pid}-${updatedAtMs}`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(payload)}\n`, { encoding: "utf8", flag: "wx" });
      fs.renameSync(temporary, this.leasePath);
    } finally {
      if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
    }
  }

  beat() {
    try {
      this._write(this.state);
      return true;
    } catch (error) {
      try { this.onError(error); } catch {}
      return false;
    }
  }

  start(state = "running") {
    if (!VALID_LEASE_STATES.has(state) || state === "stopped") throw new Error("机器人服务租约启动状态无效。");
    if (this.terminal) return false;
    if (this.state !== state || !Number.isFinite(this.stateSinceAtMs)) this.stateSinceAtMs = this.now();
    this.state = state;
    const written = this.beat();
    if (this.timer !== null) return written;
    this.timer = this.clock.setInterval(() => this.beat(), this.heartbeatMs);
    this.timer?.unref?.();
    return written;
  }

  stop() {
    this.terminal = true;
    if (this.timer !== null) this.clock.clearInterval(this.timer);
    this.timer = null;
    if (this.state !== "stopped" || !Number.isFinite(this.stateSinceAtMs)) this.stateSinceAtMs = this.now();
    this.state = "stopped";
    return this.beat();
  }
}

module.exports = { DEFAULT_LEASE_HEARTBEAT_MS, ServiceLease, VALID_LEASE_STATES };
