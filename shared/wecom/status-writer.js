"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { safeModelErrorCode } = require("../codex/model-error.js");
const { safeRequestMetrics } = require("../observability/request-metrics.js");

const ALLOWED_STATUSES = new Set([
  "connecting", "ready", "disconnected", "reconnecting", "connection_error", "connection_stalled", "lease_write_failed", "message_failed", "agent_failed",
  "message_received", "turn_started", "turn_steered", "turn_queued", "model_retrying", "model_responding", "tool_started", "tool_completed", "tool_failed",
  "turn_completed", "turn_failed", "turn_cancelled", "context_resumed", "context_rotated", "context_invalidated", "answer_recovered", "agent_warming", "agent_warmed", "agent_warm_failed",
  "chart_generated", "chart_uploaded", "chart_upload_failed", "chart_media_delivery_failed", "chart_inline_delivered", "chart_delivered", "chart_failed", "reply_completed", "request_measured"
]);
const SAFE_INSTANCE_ID_PATTERN = /^[A-Za-z0-9-]{16,128}$/;

function safeInstanceId(value) {
  return typeof value === "string" && SAFE_INSTANCE_ID_PATTERN.test(value) ? value : null;
}

function safeStatus(value) {
  const status = String(value?.status || "");
  if (!ALLOWED_STATUSES.has(status)) throw new Error("不允许写入未知机器人状态。");
  const result = { at: new Date().toISOString(), status, transport: "wecom-websocket" };
  if (status === "request_measured") return { ...result, ...safeRequestMetrics(value) };
  const instanceId = safeInstanceId(value?.instanceId);
  if (status === "ready" && instanceId !== null) result.instanceId = instanceId;
  if (status === "reconnecting" && Number.isInteger(value?.attempt)) result.attempt = value.attempt;
  const modelErrorCode = safeModelErrorCode(value?.modelErrorCode);
  if (["model_retrying", "turn_failed"].includes(status) && modelErrorCode !== null) result.modelErrorCode = modelErrorCode;
  if (["connection_stalled", "tool_completed", "tool_failed", "turn_completed", "turn_failed", "answer_recovered", "agent_warmed", "reply_completed"].includes(status)
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

module.exports = { ALLOWED_STATUSES, SAFE_INSTANCE_ID_PATTERN, createStatusWriter, rotateStatusLog, safeInstanceId, safeStatus };
