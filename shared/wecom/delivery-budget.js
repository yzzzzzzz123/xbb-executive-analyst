"use strict";

const { performance } = require("node:perf_hooks");

class DeliveryTimeoutError extends Error {
  constructor() {
    super("消息交付阶段超过等待预算。");
    this.name = "DeliveryTimeoutError";
    this.code = "DELIVERY_TIMEOUT";
  }
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
    return await Promise.race([
      Promise.resolve().then(() => operation(() => open && performance.now() < deadline)),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new DeliveryTimeoutError()), budgetMs); })
    ]);
  } finally {
    open = false;
    clearTimeout(timer);
  }
}

module.exports = { DeliveryTimeoutError, validateBudget, withinBudget };
