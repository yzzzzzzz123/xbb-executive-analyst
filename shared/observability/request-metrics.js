"use strict";

const { randomBytes } = require("node:crypto");
const { performance } = require("node:perf_hooks");

const TIMING_FIELDS = Object.freeze([
  "firstReplyMs", "modelFirstDeltaMs", "answerPreviewReadyMs", "answerPreviewVisibleMs",
  "analysisMs", "answerReadyMs", "answerVisibleMs", "progressDrainMs",
  "sessionQueueMs", "queryQueueMs", "queryRunMs", "renderMs", "uploadMs", "mediaDeliveryMs", "totalMs"
]);
const MAX_TIMING_MS = 24 * 60 * 60 * 1000;

// Only ephemeral, random correlation IDs and measurements cross the logging boundary.
// Never derive this identifier from a user, message, thread, or query.
function safeRequestMetrics(value) {
  const result = {};
  if (typeof value?.requestTrace === "string" && /^[a-f0-9]{32}$/.test(value.requestTrace)) result.requestTrace = value.requestTrace;
  if (["general", "xbb"].includes(value?.routeMode)) result.routeMode = value.routeMode;
  if (["success", "degraded", "failed", "unsupported"].includes(value?.outcome)) result.outcome = value.outcome;
  if (["none", "standalone", "inline", "failed"].includes(value?.imageDelivery)) result.imageDelivery = value.imageDelivery;
  if (["deadline_exceeded", "cancelled", "analysis_timeout", "analysis_failed", "delivery_timeout", "transport_failed"].includes(value?.failureClass)) result.failureClass = value.failureClass;
  result.timings = {};
  for (const key of TIMING_FIELDS) {
    const number = value?.timings?.[key];
    if (Number.isInteger(number) && number >= 0 && number <= MAX_TIMING_MS) result.timings[key] = number;
  }
  return result;
}

function createRequestMetrics({ now = () => performance.now(), startedAt = now() } = {}) {
  const timings = {};
  const requestTrace = randomBytes(16).toString("hex");
  let completed = false;
  const record = (field, ms) => {
    if (!completed && TIMING_FIELDS.includes(field)) timings[field] = Math.max(0, Math.round(ms));
  };
  return Object.freeze({
    mark(field) { record(field, now() - startedAt); },
    markFirst(field) { if (!Object.hasOwn(timings, field)) record(field, now() - startedAt); },
    addQueryTiming(event) {
      const modelField = { model_first_delta: "modelFirstDeltaMs", answer_preview_ready: "answerPreviewReadyMs" }[event?.stage];
      if (modelField) {
        // Agent elapsedMs starts at enqueue, after the initial channel ACK.
        // Measure here on the request's own monotonic clock so all first-event
        // fields have the same received-message origin and cannot expose text.
        if (!Object.hasOwn(timings, modelField) && Number.isInteger(event.elapsedMs) && event.elapsedMs >= 0 && event.elapsedMs <= MAX_TIMING_MS) record(modelField, now() - startedAt);
        return;
      }
      if (["session_started", "session_expired"].includes(event?.stage)) {
        if (!Object.hasOwn(timings, "sessionQueueMs") && Number.isInteger(event.queueWaitMs) && event.queueWaitMs >= 0 && event.queueWaitMs <= MAX_TIMING_MS) record("sessionQueueMs", event.queueWaitMs);
        return;
      }
      if (!["completed", "failed", "cancelled", "expired", "rejected"].includes(event?.stage)) return;
      for (const [source, field] of [["queueWaitMs", "queryQueueMs"], ["runMs", "queryRunMs"]]) {
        if (Number.isInteger(event[source]) && event[source] >= 0 && event[source] <= MAX_TIMING_MS) record(field, (timings[field] || 0) + event[source]);
      }
    },
    async measure(field, operation) {
      const before = now();
      try { return await operation(); } finally { record(field, (timings[field] || 0) + now() - before); }
    },
    finish({ routeMode, outcome, imageDelivery, failureClass }) {
      if (completed) return null;
      record("totalMs", now() - startedAt);
      completed = true;
      return { status: "request_measured", ...safeRequestMetrics({ requestTrace, routeMode, outcome, imageDelivery, failureClass, timings }) };
    }
  });
}

function percentile(values, quantile) {
  const sorted = values.filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)] : null;
}

function summarizeTimings(samples) {
  const result = {};
  for (const key of TIMING_FIELDS) {
    const values = samples.map((sample) => sample.timings?.[key]).filter((value) => Number.isFinite(value) && value >= 0);
    if (values.length) result[key] = { count: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95), max: Math.max(...values) };
  }
  return result;
}

module.exports = { TIMING_FIELDS, createRequestMetrics, safeRequestMetrics, percentile, summarizeTimings };
