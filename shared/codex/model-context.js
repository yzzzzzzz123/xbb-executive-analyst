"use strict";

// Verified with the deployed GPT-6 Codex runtime: 872,000 configured tokens
// produce an effective modelContextWindow of 828,400 (95%). The API's
// 1,050,000-token specification does not override this client's model ceiling.
const DEFAULT_CONTEXT_WINDOW = 872000;
const DEFAULT_AUTO_COMPACT_TOKEN_LIMIT = 750000;

function modelContextConfig(config = {}) {
  const window = Number(config.codexContextWindow ?? DEFAULT_CONTEXT_WINDOW);
  const compact = Number(config.codexAutoCompactTokenLimit ?? Math.min(DEFAULT_AUTO_COMPACT_TOKEN_LIMIT, Math.floor(window * 0.9)));
  if (!Number.isSafeInteger(window) || window < 32768 || window > DEFAULT_CONTEXT_WINDOW) {
    throw new Error("Codex 上下文窗口必须是 32768-872000 的整数；更大容量须先验证当前运行版本支持。");
  }
  if (!Number.isSafeInteger(compact) || compact < 16384 || compact > Math.floor(window * 0.9)) {
    throw new Error("Codex 自动压缩阈值必须至少为 16384 tokens，且不超过配置窗口的 90%。");
  }
  return Object.freeze({ model_context_window: window, model_auto_compact_token_limit: compact });
}

module.exports = { DEFAULT_CONTEXT_WINDOW, DEFAULT_AUTO_COMPACT_TOKEN_LIMIT, modelContextConfig };
