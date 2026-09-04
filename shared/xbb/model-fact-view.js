"use strict";

const crypto = require("node:crypto");
const { assertNoSensitiveFactValues } = require("../security/fact-privacy.js");

const MAX_MODEL_FACT_VIEW_BYTES = 96 * 1024;
const MIN_MODEL_FACT_VIEW_BYTES = 16 * 1024;

const ARRAY_RULES = Object.freeze([
  { path: "performance.ranking", initial: 25, minimum: 10, core: true },
  { path: "performance.dailyTrend", initial: 31, minimum: 0 },
  { path: "productSales.ranking", initial: 25, minimum: 10, core: true },
  { path: "productSales.ticketRanking", initial: 25, minimum: 10, core: true },
  { path: "productSales.commercialRanking", initial: 25, minimum: 10, core: true },
  { path: "productSales.companyProductMix", initial: 30, minimum: 0 },
  { path: "productSales.products", initial: 30, minimum: 0 },
  { path: "productSales.dailyTrend", initial: 31, minimum: 0 },
  { path: "courses.companies", initial: 25, minimum: 10, core: true },
  { path: "courses.positionBreakdown", initial: 100, minimum: 1, core: true },
  { path: "courses.courses", initial: 20, minimum: 0 },
  { path: "courses.courseHighlights", initial: 20, minimum: 0 },
  { path: "courses.dailyTrend", initial: 31, minimum: 0 },
  { path: "delivery.companies", initial: 25, minimum: 10, core: true },
  { path: "delivery.courses", initial: 20, minimum: 0 },
  { path: "delivery.courseHighlights", initial: 20, minimum: 0 },
  { path: "delivery.dailyTrend", initial: 31, minimum: 0 },
  { path: "opportunities.stages", initial: 100, minimum: 1, core: true },
  { path: "opportunities.people", initial: 25, minimum: 10, core: true },
  { path: "opportunities.reactivationCandidates", initial: 20, minimum: 0 },
  { path: "opportunities.opportunities", initial: 20, minimum: 0 },
  { path: "opportunities.dailyTrend", initial: 31, minimum: 0 }
]);

function utf8Prefix(value, maxBytes) {
  const text = String(value);
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return "";
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const ellipsis = Buffer.byteLength("…", "utf8") <= maxBytes ? "…" : "";
  const contentBudget = Math.max(0, maxBytes - Buffer.byteLength(ellipsis, "utf8"));
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, middle), "utf8") <= contentBudget) low = middle;
    else high = middle - 1;
  }
  return `${text.slice(0, low).replace(/[\uD800-\uDBFF]$/, "")}${ellipsis}`;
}

function compactClone(value, key = "") {
  if (["evidenceRef", "evidenceRefs"].includes(key)) return undefined;
  if (typeof value === "string") return utf8Prefix(value, key === "excerpt" ? 360 : 2048);
  if (Array.isArray(value)) return value.map((item) => compactClone(item)).filter((item) => item !== undefined);
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [childKey, child] of Object.entries(value)) {
    const compacted = compactClone(child, childKey);
    if (compacted !== undefined) result[childKey] = compacted;
  }
  return result;
}

function factArray(view, path) {
  const parts = path.split(".");
  let value = view.facts;
  for (const part of parts) value = value?.[part];
  return Array.isArray(value) ? value : null;
}

function serializedBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function viewCanonical(view) {
  const copy = { ...view };
  delete copy.viewIntegrity;
  return copy;
}

function refreshViewIntegrity(view) {
  view.viewIntegrity = {
    algorithm: "sha256",
    viewSha256: crypto.createHash("sha256").update(JSON.stringify(viewCanonical(view)), "utf8").digest("hex")
  };
}

function stabilizeFinalBytes(view) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    refreshViewIntegrity(view);
    const bytes = serializedBytes(view);
    if (view.viewCoverage.finalBytes === bytes) return bytes;
    view.viewCoverage.finalBytes = bytes;
  }
  refreshViewIntegrity(view);
  return serializedBytes(view);
}

function recordCoverage(view, rule, sourceRows, includedRows) {
  view.viewCoverage.arrays[rule.path] = { sourceRows, includedRows };
  if (includedRows < sourceRows && !view.viewCoverage.omittedPaths.includes(`facts.${rule.path}[]`)) {
    view.viewCoverage.omittedPaths.push(`facts.${rule.path}[]`);
  }
}

function trimLargestTail(view, rules, allowBelowMinimum = false) {
  const candidates = rules.map((rule, index) => {
    const rows = factArray(view, rule.path);
    const floor = allowBelowMinimum ? 0 : Math.min(rule.minimum, view.viewCoverage.arrays[rule.path]?.sourceRows || 0);
    return rows && rows.length > floor ? { rule, rows, index, bytes: serializedBytes(rows.at(-1)) } : null;
  }).filter(Boolean).sort((a, b) => b.bytes - a.bytes || a.index - b.index);
  if (!candidates.length) return false;
  const candidate = candidates[0];
  candidate.rows.pop();
  const coverage = view.viewCoverage.arrays[candidate.rule.path];
  recordCoverage(view, candidate.rule, coverage.sourceRows, candidate.rows.length);
  return true;
}

function minimalFacts(facts, coverage) {
  const result = {};
  for (const [domain, fact] of Object.entries(facts || {})) {
    const compact = {
      definitions: compactClone(fact?.definitions || {}),
      summary: compactClone(fact?.summary || {})
    };
    for (const field of ["monthlyTrend", "ranking", "ticketRanking", "commercialRanking", "companies", "positionBreakdown", "stages", "people"]) {
      if (Array.isArray(fact?.[field])) compact[field] = compactClone(fact[field].slice(0, field === "monthlyTrend" ? 120 : 10));
    }
    if (fact?.detailCoverage) compact.detailCoverage = compactClone(fact.detailCoverage);
    result[domain] = compact;
    coverage.omittedPaths.push(`facts.${domain}.nonCoreDetails`);
  }
  return result;
}

function buildModelFactView(pack, options = {}) {
  if (!pack || typeof pack !== "object" || Array.isArray(pack)) throw new Error("模型事实视图来源无效。");
  const maxBytes = Number.isInteger(options.maxBytes) ? options.maxBytes : MAX_MODEL_FACT_VIEW_BYTES;
  if (maxBytes < MIN_MODEL_FACT_VIEW_BYTES || maxBytes > MAX_MODEL_FACT_VIEW_BYTES) {
    throw new Error(`模型事实视图预算必须在 ${MIN_MODEL_FACT_VIEW_BYTES} 至 ${MAX_MODEL_FACT_VIEW_BYTES} 字节之间。`);
  }
  const sourceBytes = serializedBytes(pack);
  const provenance = pack.provenance || {};
  const factValues = Object.values(pack.facts || {});
  const aggregationComplete = pack.mode === "xbb-live-readonly-multi-period-aggregate"
    ? factValues.length > 0 && factValues.every((fact) => fact?.detailCoverage?.aggregationComplete === true)
    : pack.mode === "xbb-live-readonly-fact-pack" && pack.status === "ready" && factValues.length > 0;
  const periods = Array.isArray(provenance.periods)
    ? provenance.periods.map((period) => ({ month: period.month, sourceRefreshedAt: period.sourceRefreshedAt || null }))
    : undefined;
  const view = {
    schemaVersion: "1.0",
    skill: "xbb-executive-analyst",
    mode: "xbb-live-readonly-model-fact-view",
    status: pack.status,
    scope: compactClone(pack.scope || {}),
    entityResolution: compactClone(pack.entityResolution || {}),
    provenance: {
      live: provenance.live === true,
      readOnly: provenance.readOnly === true,
      dataSource: provenance.dataSource || null,
      sourceRefreshedAt: provenance.sourceRefreshedAt || null,
      formIds: compactClone(provenance.formIds || {}),
      recordCounts: compactClone(provenance.recordCounts || {}),
      ...(periods ? { periods } : {}),
      telephoneFieldsExported: false,
      credentialFieldsExported: false
    },
    facts: compactClone(pack.facts || {}),
    limitations: compactClone(pack.limitations || []),
    sourceFactPackSha256: pack.integrity?.factPackSha256 || null,
    sourceCompaction: compactClone(pack.compaction || null),
    viewCoverage: {
      budgetBytes: maxBytes,
      sourceBytes,
      finalBytes: 0,
      aggregationComplete,
      omittedPaths: [],
      arrays: {}
    }
  };

  for (const rule of ARRAY_RULES) {
    const rows = factArray(view, rule.path);
    if (!rows) continue;
    const sourceRows = rows.length;
    if (rows.length > rule.initial) rows.splice(rule.initial);
    recordCoverage(view, rule, sourceRows, rows.length);
  }

  let bytes = stabilizeFinalBytes(view);
  const optionalRules = ARRAY_RULES.filter((rule) => !rule.core);
  const coreRules = ARRAY_RULES.filter((rule) => rule.core);
  while (bytes > maxBytes && trimLargestTail(view, optionalRules)) bytes = stabilizeFinalBytes(view);
  while (bytes > maxBytes && trimLargestTail(view, coreRules)) bytes = stabilizeFinalBytes(view);
  if (bytes > maxBytes) {
    view.facts = minimalFacts(view.facts, view.viewCoverage);
    bytes = stabilizeFinalBytes(view);
  }
  while (bytes > maxBytes && trimLargestTail(view, coreRules, true)) bytes = stabilizeFinalBytes(view);
  if (bytes > maxBytes) throw new Error(`模型事实视图核心汇总超过 ${maxBytes} 字节安全预算。`);
  view.viewCoverage.omittedPaths = [...new Set(view.viewCoverage.omittedPaths)].sort();
  bytes = stabilizeFinalBytes(view);
  if (bytes > maxBytes || view.viewCoverage.finalBytes !== bytes) throw new Error("模型事实视图大小元数据无效。");
  assertNoSensitiveFactValues(view);
  return view;
}

module.exports = {
  ARRAY_RULES,
  MAX_MODEL_FACT_VIEW_BYTES,
  MIN_MODEL_FACT_VIEW_BYTES,
  buildModelFactView,
  utf8Prefix
};
