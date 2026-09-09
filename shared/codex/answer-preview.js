"use strict";

const MAX_PREVIEW_INPUT_BYTES = 36 * 1024;
const MAX_PREVIEW_OUTPUT_BYTES = 12 * 1024;
const JSON_ESCAPES = Object.freeze({ '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" });

function result(status, text, reason) {
  return Object.freeze({ status, text, reason });
}

function skipWhitespace(source, index) {
  while (index < source.length && /[\x20\t\r\n]/u.test(source[index])) index += 1;
  return index;
}

// Decode JSON string tokens, including escaped surrogate pairs, without ever
// exposing an incomplete escape or half of a Unicode scalar to the caller.
function readString(source, start) {
  if (source[start] !== '"') return { kind: "invalid" };
  const parts = [];
  let high = null;
  let index = start + 1;
  const append = (unit) => {
    const code = unit.charCodeAt(0);
    if (high !== null) {
      if (code < 0xdc00 || code > 0xdfff) return false;
      parts.push(high, unit);
      high = null;
      return true;
    }
    if (code >= 0xd800 && code <= 0xdbff) high = unit;
    else if (code >= 0xdc00 && code <= 0xdfff) return false;
    else parts.push(unit);
    return true;
  };
  const partial = () => ({ kind: "partial", value: parts.join("") });
  while (index < source.length) {
    const unit = source[index++];
    if (unit === '"') {
      if (high !== null) return { kind: "invalid" };
      return { kind: "complete", value: parts.join(""), end: index };
    }
    if (unit.charCodeAt(0) < 0x20) return { kind: "invalid" };
    if (unit !== "\\") {
      if (!append(unit)) return { kind: "invalid" };
      continue;
    }
    if (index === source.length) return partial();
    const escape = source[index++];
    if (escape !== "u") {
      if (!Object.hasOwn(JSON_ESCAPES, escape) || !append(JSON_ESCAPES[escape])) return { kind: "invalid" };
      continue;
    }
    const digits = source.slice(index, index + 4);
    if (!/^[0-9a-f]*$/iu.test(digits)) return { kind: "invalid" };
    if (digits.length < 4) return partial();
    index += 4;
    if (!append(String.fromCharCode(Number.parseInt(digits, 16)))) return { kind: "invalid" };
  }
  return partial();
}

// This deliberately supports only the final-answer schema with answer first.
// Unsupported ordering/fields disable previews, not the authoritative final reply.
function readEnvelope(source) {
  let index = skipWhitespace(source, 0);
  const waiting = (answer = "", answerClosed = false) => ({ kind: "partial", answer, answerClosed });
  if (index === source.length) return waiting();
  if (source[index++] !== "{") return { kind: "unsupported" };
  index = skipWhitespace(source, index);
  if (index === source.length) return waiting();
  const first = readString(source, index);
  if (first.kind === "invalid") return first;
  if (first.kind === "partial") return "answer".startsWith(first.value) ? waiting() : { kind: "unsupported" };
  if (first.value !== "answer") return { kind: "unsupported" };
  index = skipWhitespace(source, first.end);
  if (index === source.length) return waiting();
  if (source[index++] !== ":") return { kind: "invalid" };
  index = skipWhitespace(source, index);
  if (index === source.length) return waiting();
  const answer = readString(source, index);
  if (answer.kind === "invalid") return answer;
  if (answer.kind === "partial") return waiting(answer.value);
  index = skipWhitespace(source, answer.end);
  if (index === source.length) return waiting(answer.value, true);
  if (source[index++] !== ",") return { kind: "unsupported" };
  index = skipWhitespace(source, index);
  if (index === source.length) return waiting(answer.value, true);
  const second = readString(source, index);
  if (second.kind === "invalid") return second;
  if (second.kind === "partial") return "chart".startsWith(second.value) ? waiting(answer.value, true) : { kind: "unsupported" };
  if (second.value !== "chart") return { kind: "unsupported" };
  index = skipWhitespace(source, second.end);
  if (index === source.length) return waiting(answer.value, true);
  if (source[index++] !== ":") return { kind: "invalid" };
  index = skipWhitespace(source, index);
  for (const unit of "null") {
    if (index === source.length) return waiting(answer.value, true);
    if (source[index++] !== unit) return { kind: "unsupported" };
  }
  index = skipWhitespace(source, index);
  if (index === source.length) return waiting(answer.value, true);
  if (source[index++] !== "}") return { kind: "unsupported" };
  index = skipWhitespace(source, index);
  if (index !== source.length) return { kind: "invalid" };
  return { kind: "complete", answer: answer.value, answerClosed: true };
}

function textRisk(text) {
  const normalized = text.normalize("NFKC");
  // Reject markup rather than removing a completed tag: a not-yet-closed think
  // tag, its variants, or HTML entities must never expose the content it encloses.
  if (/[<>]/u.test(normalized) || /&(?:amp;)*(?:lt|gt|#)/iu.test(normalized)) return "unsafe_markup";
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(text)) return "unsafe_text";
  // Do not normalize the displayed text: that could change code literals.
  // Fail closed when compatibility characters could bypass raw redaction.
  if (normalized !== text && (normalized.includes("@")
    || /\b(?:sk-|ghp_|github_pat_)/iu.test(normalized)
    || /(?<!\d)(?:\+?86[ .()-]*)?1[3-9](?:[ .()-]*\d){9}(?!\d)/u.test(normalized))) return "normalized_sensitive_text";
  // Unknown credential formats cannot safely be reconstructed across lines.
  if (/(?:\b(?:password|passwd|secret|api[_ -]?key|access[_ -]?token|authorization)\b|密钥|密码)\s*[=:：]/iu.test(normalized)
    || /\bbearer\s+/iu.test(normalized)) return "credential_context";
  return null;
}

function completeUnits(text, closed) {
  const units = [];
  let start = 0;
  let lineStart = 0;
  let fence = null;
  const line = (end, hasNewline) => {
    const content = text.slice(lineStart, end).replace(/\r$/u, "");
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(content);
    if (fence) {
      if (marker && marker[1][0] === fence.character && marker[1].length >= fence.length && !marker[2].trim()) {
        fence = null;
        if (hasNewline || closed) {
          units.push(text.slice(start, hasNewline ? end + 1 : end));
          start = hasNewline ? end + 1 : end;
        }
      }
    } else if (marker) {
      fence = { character: marker[1][0], length: marker[1].length };
    } else if (!content.trim() && hasNewline) {
      units.push(text.slice(start, end + 1));
      start = end + 1;
    }
    lineStart = end + 1;
  };
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") line(index, true);
  }
  if (closed && lineStart < text.length) line(text.length, false);
  if (closed && fence) return { invalidFence: true, units: [] };
  if (closed && start < text.length) units.push(text.slice(start));
  return { invalidFence: false, units };
}

function sanitizeUnit(unit) {
  // Completed units, not arbitrary delta fragments, are redacted. Mask even a
  // short key prefix; later deltas cannot append to a published complete token.
  let text = unit.replace(/\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]*/giu, "[密钥已脱敏]");
  text = text.replace(/(?<!\d)(?:\+?86[ .()-]*)?1[3-9](?:[ .()-]*\d){9}(?!\d)/gu, "[手机号已脱敏]");
  // Consume each maximal token once. Searching for an @ with a greedy email
  // regex retries every suffix of a long non-email token and can be quadratic.
  // Preview redaction is deliberately stronger than final-output redaction.
  text = text.replace(/[\p{L}\p{N}._%+@-]+/gu, (token) => token.includes("@") ? "[邮箱已脱敏]" : token);
  return text.trim();
}

/**
 * Stateless extraction from the complete accumulated final_answer JSON snapshot.
 * The caller must permanently disable a blocked/revised item, gate active turn /
 * route / identity, and discard stale callbacks. No model claim is execution proof.
 * Never forward held/blocked output. Even complete previews are not final delivery.
 */
function extractAnswerPreview(snapshot, options = {}) {
  if (options.phase !== "final_answer" || options.itemType !== "agentMessage") return result("blocked", "", "gate_mismatch");
  if (typeof snapshot !== "string") return result("blocked", "", "invalid_input");
  if (snapshot.length > MAX_PREVIEW_INPUT_BYTES || Buffer.byteLength(snapshot, "utf8") > MAX_PREVIEW_INPUT_BYTES) {
    return result("blocked", "", "input_limit");
  }
  const envelope = readEnvelope(snapshot);
  if (envelope.kind === "invalid") return result("blocked", "", "invalid_json");
  if (envelope.kind === "unsupported") return result("blocked", "", "unsupported_envelope");
  if (options.finished === true && envelope.kind !== "complete") return result("blocked", "", "incomplete_json");
  const risk = textRisk(envelope.answer);
  if (risk) return result("blocked", "", risk);
  const { invalidFence, units } = completeUnits(envelope.answer, envelope.answerClosed);
  if (invalidFence) return result("blocked", "", "incomplete_code_fence");
  const output = [];
  let bytes = 0;
  let limited = false;
  for (const unit of units) {
    const safe = sanitizeUnit(unit);
    if (!safe) continue;
    const nextBytes = Buffer.byteLength(safe, "utf8") + (output.length ? 2 : 0);
    if (bytes + nextBytes > MAX_PREVIEW_OUTPUT_BYTES) { limited = true; break; }
    output.push(safe);
    bytes += nextBytes;
  }
  const text = output.join("\n\n");
  if (envelope.kind === "complete") return result("complete", text, limited ? "output_limit" : "complete");
  if (text) return result("preview", text, limited ? "output_limit" : "safe_prefix");
  return result("held", "", limited ? "output_limit" : "awaiting_boundary");
}

module.exports = { extractAnswerPreview, MAX_PREVIEW_INPUT_BYTES, MAX_PREVIEW_OUTPUT_BYTES };
