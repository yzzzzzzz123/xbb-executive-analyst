"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ALLOWED_STATUSES = new Set([
  "connecting", "ready", "disconnected", "reconnecting", "connection_error", "message_failed", "agent_failed",
  "message_received", "agent_busy", "turn_started", "tool_started", "tool_completed", "tool_failed",
  "turn_completed", "turn_failed", "chart_generated", "chart_failed", "reply_completed"
]);

function safeStatus(value) {
  const status = String(value?.status || "");
  if (!ALLOWED_STATUSES.has(status)) throw new Error("不允许写入未知机器人状态。");
  const result = { at: new Date().toISOString(), status, transport: "wecom-websocket" };
  if (status === "reconnecting" && Number.isInteger(value?.attempt)) result.attempt = value.attempt;
  if (["tool_completed", "tool_failed", "turn_completed", "turn_failed", "reply_completed"].includes(status)
      && Number.isInteger(value?.elapsedMs) && value.elapsedMs >= 0) result.elapsedMs = value.elapsedMs;
  return result;
}

function rotateStatusLog(logPath, maxBytes) {
  if (!fs.existsSync(logPath) || fs.statSync(logPath).size < maxBytes) return;
  const previous = `${logPath}.1`;
  if (fs.existsSync(previous)) fs.rmSync(previous, { force: true });
  fs.renameSync(logPath, previous);
}

function createStatusWriter({ logPath, output = process.stdout, maxBytes = 64 * 1024 }) {
  const resolved = path.resolve(logPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  return function writeStatus(value) {
    const line = `${JSON.stringify(safeStatus(value))}\n`;
    output.write(line);
    rotateStatusLog(resolved, maxBytes);
    fs.appendFileSync(resolved, line, "utf8");
  };
}

module.exports = { ALLOWED_STATUSES, createStatusWriter, rotateStatusLog, safeStatus };
