"use strict";

// 只保留固定错误类别，禁止把上游消息、请求 ID、地址或凭据写入企微与日志。
const MODEL_ERROR_CODES = new Set([
  "unauthorized", "connection_failed", "usage_limit", "context_limit",
  "invalid_request", "service_error", "unknown"
]);

function safeModelErrorCode(value) {
  return typeof value === "string" && MODEL_ERROR_CODES.has(value) ? value : null;
}

function classifyModelError(error) {
  if (!error || typeof error !== "object") return null;
  const info = error.codexErrorInfo;
  const variant = typeof info === "string" ? info : info && typeof info === "object" ? Object.keys(info)[0] : "";
  const name = String(variant || "").toLowerCase();
  const details = info && typeof info === "object" ? info[variant] : null;
  const httpStatusCode = details?.httpStatusCode ?? info?.httpStatusCode;
  if (name === "unauthorized" || httpStatusCode === 401) return "unauthorized";
  if (name === "usagelimitexceeded" || httpStatusCode === 429) return "usage_limit";
  if (name === "contextwindowexceeded") return "context_limit";
  if (name === "badrequest" || httpStatusCode === 400) return "invalid_request";
  if (["httpconnectionfailed", "responsestreamconnectionfailed", "responsestreamdisconnected", "responsetoomanyfailedattempts"].includes(name)) return "connection_failed";
  if (name === "internalservererror") return "service_error";
  return "unknown";
}

module.exports = { classifyModelError, safeModelErrorCode };
