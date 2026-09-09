"use strict";

const { performance } = require("node:perf_hooks");

const REQUEST_DEADLINE_EXCEEDED = "REQUEST_DEADLINE_EXCEEDED";
const REQUEST_CANCELLED = "REQUEST_CANCELLED";
const MAX_TIMER_MS = 2 ** 31 - 1;

function lifecycleError(kind, routeMode) {
  const error = new Error(kind === "deadline" ? "请求已超过处理截止时间。" : "请求已取消。");
  error.name = kind === "deadline" ? "RequestDeadlineExceededError" : "RequestCancelledError";
  error.code = kind === "deadline" ? REQUEST_DEADLINE_EXCEEDED : REQUEST_CANCELLED;
  error.routeMode = routeMode === "xbb" ? "xbb" : "general";
  return error;
}

function isRequestLifecycleError(error) {
  return error?.code === REQUEST_DEADLINE_EXCEEDED || error?.code === REQUEST_CANCELLED;
}

// One request, one non-sliding monotonic deadline, including time spent waiting
// for startup or another turn. Callers may only narrow this budget.
function createRequestLifecycle({ signal, remainingMs, timeoutMs, routeMode = "general", onCancel,
  makeError = (kind) => lifecycleError(kind, routeMode),
  clock = { now: () => performance.now(), setTimeout, clearTimeout } } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("请求总预算必须是正数。");
  if (remainingMs !== undefined && typeof remainingMs !== "function") throw new Error("remainingMs 必须是返回剩余毫秒数的函数。");
  if (signal !== undefined && (!signal || typeof signal.addEventListener !== "function" || typeof signal.aborted !== "boolean")) throw new Error("请求 signal 必须是 AbortSignal。");
  const controller = new AbortController();
  const startedAt = clock.now();
  let deadline = startedAt + timeoutMs;
  let timer = null;
  let settled = false;
  let terminalError = null;
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; });
  // _enqueue can still be awaiting startup when its internal budget expires.
  // Observe now without changing the rejection seen by the eventual caller.
  void promise.catch(() => {});
  const cleanup = () => {
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
    signal?.removeEventListener("abort", onAbort);
  };
  const cancel = (kind = "cancelled") => {
    if (settled) return;
    terminalError = makeError(kind);
    settled = true;
    cleanup();
    controller.abort(terminalError);
    try { onCancel?.(terminalError); } catch {}
    rejectPromise(terminalError);
  };
  const remaining = () => {
    if (settled) return 0;
    const current = clock.now();
    const previousDeadline = deadline;
    if (remainingMs) {
      let value;
      try { value = remainingMs(); } catch { cancel("cancelled"); return 0; }
      if (!Number.isFinite(value)) { cancel("cancelled"); return 0; }
      deadline = Math.min(deadline, current + Math.max(0, value));
    }
    const left = Math.max(0, deadline - current);
    if (deadline < previousDeadline && timer !== null) {
      clock.clearTimeout(timer);
      timer = null;
      if (left > 0) schedule(left);
      else cancel("deadline");
    }
    return left;
  };
  const throwIfStopped = () => {
    if (!settled && remaining() <= 0) cancel("deadline");
    if (terminalError) throw terminalError;
    if (settled) throw lifecycleError("cancelled", routeMode);
  };
  const onAbort = () => cancel(signal?.reason?.code === REQUEST_DEADLINE_EXCEEDED || remaining() <= 0 ? "deadline" : "cancelled");
  const schedule = (left) => {
    timer = clock.setTimeout(() => { timer = null; arm(); }, Math.min(MAX_TIMER_MS, Math.max(1, Math.ceil(left))));
    timer?.unref?.();
  };
  const arm = () => {
    const left = remaining();
    if (settled) return;
    if (left <= 0) { cancel("deadline"); return; }
    schedule(left);
  };
  const settle = (operation, value) => {
    if (settled) return;
    if (remaining() <= 0) { cancel("deadline"); return; }
    settled = true;
    cleanup();
    if (operation === rejectPromise) {
      terminalError = value;
      controller.abort(value);
    }
    operation(value);
  };
  const wait = (operation) => {
    try { throwIfStopped(); } catch (error) { return Promise.reject(error); }
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = (callback, value) => {
        if (finished) return;
        finished = true;
        controller.signal.removeEventListener("abort", stopped);
        callback(value);
      };
      const stopped = () => finish(reject, terminalError || lifecycleError("cancelled", routeMode));
      controller.signal.addEventListener("abort", stopped, { once: true });
      let result;
      try { result = typeof operation === "function" ? operation() : operation; } catch (error) { finish(reject, error); return; }
      Promise.resolve(result).then((value) => {
        try { throwIfStopped(); finish(resolve, value); } catch (error) { finish(reject, error); }
      }, (error) => finish(reject, error));
    });
  };
  if (signal?.aborted) onAbort();
  else {
    signal?.addEventListener("abort", onAbort, { once: true });
    arm();
  }
  return Object.freeze({
    promise,
    signal: controller.signal,
    get settled() { return settled; },
    get error() { return terminalError; },
    get deadline() { return deadline; },
    remainingMs: remaining,
    throwIfStopped,
    wait,
    cancel,
    limitDeadline: (value) => {
      if (!Number.isFinite(value) || settled) return;
      deadline = Math.min(deadline, value);
      if (timer !== null) clock.clearTimeout(timer);
      timer = null;
      arm();
    },
    resolve: (value) => settle(resolvePromise, value),
    reject: (error) => settle(rejectPromise, error)
  });
}

module.exports = { REQUEST_CANCELLED, REQUEST_DEADLINE_EXCEEDED, createRequestLifecycle, isRequestLifecycleError, lifecycleError };
