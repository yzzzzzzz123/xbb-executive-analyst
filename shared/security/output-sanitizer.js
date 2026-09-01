"use strict";

function sanitizeAgentText(value, options = {}) {
  let text = String(value || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  text = text.replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, "[手机号已脱敏]");
  text = text.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[邮箱已脱敏]");
  text = text.replace(/\b(?:ghp_|github_pat_|sk-)[A-Za-z0-9_-]{16,}\b/g, "[密钥已脱敏]");
  const maxBytes = options.maxBytes || 20480;
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    let end = text.length;
    while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > maxBytes - 100) end -= 1;
    text = `${text.slice(0, end).trimEnd()}\n\n（内容已按企业微信长度限制截断）`;
  }
  return text;
}

module.exports = { sanitizeAgentText };
