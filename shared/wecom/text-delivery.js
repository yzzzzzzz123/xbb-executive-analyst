"use strict";

// A conservative per-message byte budget for the independent Markdown route.
// Preserve every character, prefer line boundaries, and never split a Unicode
// code point. Text is not shortened to fit an image caption.
const MARKDOWN_PART_BYTES = 4096;

function splitMarkdownText(content) {
  if (typeof content !== "string") throw new Error("企业微信文字答复格式无效。");
  const parts = [];
  let part = "";
  let bytes = 0;
  for (const line of content.match(/[^\n]*\n|[^\n]+$/g) || []) {
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (bytes && bytes + lineBytes > MARKDOWN_PART_BYTES) {
      parts.push(part); part = ""; bytes = 0;
    }
    for (const character of line) {
      const size = Buffer.byteLength(character, "utf8");
      if (bytes + size > MARKDOWN_PART_BYTES) {
        parts.push(part); part = ""; bytes = 0;
      }
      part += character;
      bytes += size;
    }
  }
  if (part) parts.push(part);
  return parts;
}

module.exports = { MARKDOWN_PART_BYTES, splitMarkdownText };
