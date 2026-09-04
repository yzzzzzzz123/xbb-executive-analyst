"use strict";

const PHONE_PATTERN = /(?<!\d)1[3-9]\d{9}(?!\d)/;
const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const CREDENTIAL_PATTERN = /\b(?:ghp_|github_pat_|sk-)[A-Za-z0-9_-]{16,}\b/;
const OPAQUE_KEY_PATTERN = /(?:^|_)(?:id|ids|hash|sha256)$/i;
const OPAQUE_CAMEL_KEY_PATTERN = /(?:Id|Ids|Hash|Sha256|Ref|Refs)$/;

function isOpaqueKey(key) {
  return OPAQUE_KEY_PATTERN.test(key) || OPAQUE_CAMEL_KEY_PATTERN.test(key)
    || ["serialNo", "formIds", "ownerIds", "evidenceRef", "evidenceRefs"].includes(key);
}

function findSensitiveFactValue(value, path = [], inheritedOpaque = false) {
  if (typeof value === "string") {
    if (CREDENTIAL_PATTERN.test(value)) return { kind: "credential", path };
    if (!inheritedOpaque && EMAIL_PATTERN.test(value)) return { kind: "email", path };
    if (!inheritedOpaque && PHONE_PATTERN.test(value)) return { kind: "phone", path };
    return null;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const hit = findSensitiveFactValue(value[index], [...path, index], inheritedOpaque);
      if (hit) return hit;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  for (const [key, child] of Object.entries(value)) {
    const hit = findSensitiveFactValue(child, [...path, key], isOpaqueKey(key));
    if (hit) return hit;
  }
  return null;
}

function assertNoSensitiveFactValues(value) {
  if (findSensitiveFactValue(value)) throw new Error("事实包隐私扫描失败。");
  return value;
}

module.exports = { assertNoSensitiveFactValues, findSensitiveFactValue, isOpaqueKey };
