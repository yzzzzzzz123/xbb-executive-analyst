"use strict";

const { performance } = require("node:perf_hooks");

class DeliveryTimeoutError extends Error {
  constructor() {
    super("消息交付阶段超过等待预算。");
    this.name = "DeliveryTimeoutError";
    this.code = "DELIVERY_TIMEOUT";
  }
}

class RequestDeadlineError extends Error {
  constructor() {
    super("本次请求已到达从接收开始计算的处理截止时间。");
    this.name = "RequestDeadlineError";
    this.code = "REQUEST_DEADLINE_EXCEEDED";
  }
}

// One monotonic window covers admission, queueing, analysis and delivery. A
// phase may use less time, never renew this window. reserveMs keeps a final ACK
// attempt available; it is part of the same deadline, not an extra grace period.
function createDeliveryDeadline({ budgetMs, startedAt = performance.now(), now = () => performance.now() }) {
  if (!Number.isInteger(budgetMs) || budgetMs < 1 || budgetMs > 24 * 60 * 60 * 1000) throw new Error("请求总预算必须是 1–86400000 毫秒的整数。");
  if (typeof now !== "function" || !Number.isFinite(startedAt)) throw new Error("请求截止时钟无效。");
  const deadline = startedAt + budgetMs;
  const remaining = (reserveMs = 0) => {
    if (!Number.isInteger(reserveMs) || reserveMs < 0 || reserveMs > budgetMs) throw new Error("预留预算必须是总预算以内的非负整数。");
    return Math.max(0, Math.floor(deadline - now() - reserveMs));
  };
  return Object.freeze({
    remaining,
    async run(operation, phaseBudgetMs = budgetMs, reserveMs = 0) {
      if (!Number.isInteger(phaseBudgetMs) || phaseBudgetMs < 1 || phaseBudgetMs > 24 * 60 * 60 * 1000) throw new Error("阶段预算必须是有效正整数。");
      const availableMs = remaining(reserveMs);
      const phaseMs = Math.min(phaseBudgetMs, availableMs);
      if (phaseMs < 1) throw new RequestDeadlineError();
      const timeoutError = () => availableMs <= phaseBudgetMs ? new RequestDeadlineError() : new DeliveryTimeoutError();
      const phaseDeadline = now() + phaseMs;
      const controller = new AbortController();
      let timer;
      let open = true;
      const phaseRemaining = () => open ? Math.max(0, Math.floor(Math.min(phaseDeadline, deadline - reserveMs) - now())) : 0;
      const isOpen = () => phaseRemaining() > 0;
      try {
        const value = await Promise.race([
          Promise.resolve().then(() => {
            if (!isOpen()) throw new RequestDeadlineError();
            return operation(isOpen, controller.signal, phaseRemaining);
          }),
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              const error = timeoutError();
              controller.abort(error);
              reject(error);
            }, phaseMs);
          })
        ]);
        if (now() >= Math.min(phaseDeadline, deadline - reserveMs)) {
          const error = timeoutError();
          controller.abort(error);
          throw error;
        }
        return value;
      } finally {
        open = false;
        clearTimeout(timer);
      }
    }
  });
}

function validateBudget(value) {
  if (!Number.isInteger(value) || value < 1 || value > 120000) throw new Error("交付等待预算必须是 1–120000 毫秒的整数。");
  return value;
}

// This bounds waiting, not transport execution. In-flight SDK requests cannot be
// cancelled. Callers must close their publisher / stop retries before returning,
// and must never send a late upload result as a new media message.
async function withinBudget(operation, budgetMs) {
  validateBudget(budgetMs);
  let timer;
  let open = true;
  const deadline = performance.now() + budgetMs;
  try {
    const value = await Promise.race([
      Promise.resolve().then(() => {
        if (performance.now() >= deadline) throw new DeliveryTimeoutError();
        return operation(() => open && performance.now() < deadline);
      }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new DeliveryTimeoutError()), budgetMs); })
    ]);
    if (performance.now() >= deadline) throw new DeliveryTimeoutError();
    return value;
  } finally {
    open = false;
    clearTimeout(timer);
  }
}

module.exports = { DeliveryTimeoutError, RequestDeadlineError, createDeliveryDeadline, validateBudget, withinBudget };
