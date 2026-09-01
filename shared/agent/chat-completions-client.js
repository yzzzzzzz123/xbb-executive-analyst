"use strict";

function createChatCompletionsClient(config, options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("当前 Node.js 不支持 fetch。");

  return Object.freeze({
    async complete({ messages, tools }) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.modelTimeoutMs);
      try {
        const headers = { "content-type": "application/json; charset=utf-8" };
        if (config.modelApiKey) headers.authorization = `Bearer ${config.modelApiKey}`;
        const response = await fetchImpl(config.modelEndpoint, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: config.modelName,
            messages,
            tools,
            tool_choice: "auto",
            temperature: 0
          }),
          signal: controller.signal
        });
        if (!response.ok) throw new Error(`模型接口返回 HTTP ${response.status}。`);
        const payload = await response.json();
        const message = payload?.choices?.[0]?.message;
        if (!message || typeof message !== "object") throw new Error("模型接口未返回兼容的 assistant message。");
        return {
          role: "assistant",
          content: typeof message.content === "string" ? message.content : "",
          tool_calls: Array.isArray(message.tool_calls) ? message.tool_calls : undefined
        };
      } catch (error) {
        if (error?.name === "AbortError") throw new Error("模型接口响应超时。", { cause: error });
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    }
  });
}

module.exports = { createChatCompletionsClient };
