"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const INDEX_VERSION = "hierarchical-hybrid-sparse-v1";
const MAX_CHUNK_BYTES = 4096;
const MAX_QUERY_BYTES = 32768;
const DEFAULT_RESULT_LIMIT = 8;
const DEFAULT_MAX_BYTES = 14000;

const SOURCE_FILES = Object.freeze([
  Object.freeze({ source: "SKILL.md", projectPath: "skills/xbb-executive-analyst/SKILL.md" }),
  Object.freeze({ source: "references/data-contract.md", projectPath: "skills/xbb-executive-analyst/references/data-contract.md" }),
  Object.freeze({ source: "references/runtime-contract.md", projectPath: "skills/xbb-executive-analyst/references/runtime-contract.md" }),
  Object.freeze({ source: "references/response-policy.md", projectPath: "skills/xbb-executive-analyst/references/response-policy.md" }),
  Object.freeze({ source: "references/wecom-service-contract.md", projectPath: "skills/xbb-executive-analyst/references/wecom-service-contract.md" }),
  Object.freeze({ source: "support/xbb-executive-chart/SKILL.md", projectPath: "skills/xbb-executive-chart/SKILL.md" }),
  Object.freeze({ source: "support/xbb-executive-chart/references/chart-contract.md", projectPath: "skills/xbb-executive-chart/references/chart-contract.md" })
]);

const DOMAIN_TERMS = Object.freeze({
  performance: ["业绩", "收入", "课程", "咨询", "占比", "排名", "公司"],
  "product-sales": ["门票", "商业操盘", "开源产品", "成交数量", "产品"],
  courses: ["开课", "课程", "成交率", "参课", "老板", "课堂"],
  delivery: ["交付", "邀约", "受邀", "到场", "业绩分配"],
  opportunities: ["商机", "赢单", "输单", "预计成交", "跟进", "遗忘", "激活", "阶段", "销售"]
});

const DOMAIN_SECTIONS = Object.freeze({
  performance: Object.freeze(["业绩与收入结构"]),
  "product-sales": Object.freeze(["门票、商业操盘和开源产品"]),
  courses: Object.freeze(["课程"]),
  delivery: Object.freeze(["交付课程邀约与业绩"]),
  opportunities: Object.freeze(["商机与跟进质量"])
});

const ALL_DOMAIN_SECTIONS = new Set(Object.values(DOMAIN_SECTIONS).flat());
const QUERY_ALIASES = Object.freeze([
  Object.freeze(["成家率", "成交率"]),
  Object.freeze(["盘活", "重新激活"]),
  Object.freeze(["唤醒", "重新激活"]),
  Object.freeze(["沉睡商机", "遗忘商机"]),
  Object.freeze(["销售漏斗", "商机阶段"]),
  Object.freeze(["票务", "门票"])
]);

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function stripFrontmatter(text) {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
}

function utf8Prefix(value, maxBytes) {
  if (maxBytes <= 0) return "";
  let result = "";
  let bytes = 0;
  for (const character of String(value || "")) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function splitUtf8(value, maxBytes) {
  const parts = [];
  let current = "";
  let bytes = 0;
  for (const character of String(value || "")) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (current && bytes + characterBytes > maxBytes) {
      parts.push(current);
      current = "";
      bytes = 0;
    }
    current += character;
    bytes += characterBytes;
  }
  if (current) parts.push(current);
  return parts;
}

function splitSectionText(value, maxBytes = MAX_CHUNK_BYTES) {
  const paragraphs = String(value || "").split(/\r?\n\s*\r?\n/).map((item) => item.trim()).filter(Boolean);
  const units = paragraphs.flatMap((paragraph) => Buffer.byteLength(paragraph, "utf8") <= maxBytes
    ? [paragraph]
    : splitUtf8(paragraph, maxBytes));
  const parts = [];
  let current = "";
  for (const unit of units) {
    const candidate = current ? `${current}\n\n${unit}` : unit;
    if (current && Buffer.byteLength(candidate, "utf8") > maxBytes) {
      parts.push(current);
      current = unit;
    } else {
      current = candidate;
    }
  }
  if (current) parts.push(current);
  return parts;
}

function splitMarkdown(relativePath, rawText) {
  const normalizedPath = relativePath.replace(/\\/g, "/");
  const text = path.posix.basename(normalizedPath) === "SKILL.md" ? stripFrontmatter(rawText) : rawText;
  const lines = text.split(/\r?\n/);
  let documentTitle = relativePath;
  let sectionTitle = "概述";
  let current = [];
  const sections = [];

  const flush = () => {
    const body = current.join("\n").trim();
    if (body) sections.push({ documentTitle, sectionTitle, body });
    current = [];
  };

  for (const line of lines) {
    const heading = /^(#{1,3})\s+(.+?)\s*$/.exec(line);
    if (!heading) {
      current.push(line);
      continue;
    }
    flush();
    if (heading[1].length === 1) documentTitle = heading[2];
    sectionTitle = heading[2];
    current = [line];
  }
  flush();

  return sections.flatMap((section) => {
    const parts = splitSectionText(section.body);
    return parts.map((body, index) => ({
      id: sha256(`${normalizedPath}\n${section.sectionTitle}\n${index + 1}/${parts.length}\n${body}`).slice(0, 20),
      source: normalizedPath,
      documentTitle: section.documentTitle,
      sectionTitle: section.sectionTitle,
      part: index + 1,
      parts: parts.length,
      text: body
    }));
  });
}

function normalizeSearchText(value) {
  const base = utf8Prefix(String(value || "").toLocaleLowerCase("zh-CN"), MAX_QUERY_BYTES);
  const expansions = QUERY_ALIASES.filter(([term]) => base.includes(term)).map(([, alias]) => alias);
  return expansions.length ? `${base}\n${expansions.join("\n")}` : base;
}

function termFrequencies(value) {
  const normalized = normalizeSearchText(value);
  const frequencies = new Map();
  const add = (term) => {
    if (!term) return;
    frequencies.set(term, (frequencies.get(term) || 0) + 1);
  };
  for (const token of normalized.match(/[a-z0-9][a-z0-9_-]*/g) || []) add(token);
  for (const run of normalized.match(/[\u3400-\u9fff]+/g) || []) {
    if (run.length === 1) add(run);
    if (run.length <= 24) add(run);
    for (const width of [2, 3]) {
      for (let index = 0; index <= run.length - width; index += 1) add(run.slice(index, index + width));
    }
  }
  return frequencies;
}

function chineseNgrams(value) {
  return new Set(termFrequencies(value).keys());
}

function detectedDomains(question) {
  const text = String(question || "").toLocaleLowerCase("zh-CN");
  return Object.entries(DOMAIN_TERMS)
    .filter(([, terms]) => terms.some((term) => text.includes(term.toLocaleLowerCase("zh-CN"))))
    .map(([domain]) => domain);
}

function normalizeDomains(domains, question) {
  if (!Array.isArray(domains)) return detectedDomains(question);
  const allowed = new Set(Object.keys(DOMAIN_TERMS));
  if (domains.includes("all")) return [...allowed];
  return [...new Set(domains.map(String).filter((domain) => allowed.has(domain)))];
}

function buildIdf(chunks) {
  const documentFrequency = new Map();
  for (const chunk of chunks) {
    for (const term of chunk.frequencies.keys()) documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1);
  }
  return new Map([...documentFrequency].map(([term, count]) => [term, Math.log((chunks.length + 1) / (count + 1)) + 1]));
}

function sparseVector(frequencies, idf) {
  const weighted = new Map();
  let squaredNorm = 0;
  for (const [term, frequency] of frequencies) {
    const weight = (1 + Math.log(frequency)) * (idf.get(term) || 0);
    if (weight <= 0) continue;
    weighted.set(term, weight);
    squaredNorm += weight * weight;
  }
  const norm = Math.sqrt(squaredNorm);
  if (!norm) return weighted;
  return new Map([...weighted].map(([term, weight]) => [term, weight / norm]));
}

function cosineSimilarity(left, right) {
  if (!left.size || !right.size) return 0;
  const [smaller, larger] = left.size <= right.size ? [left, right] : [right, left];
  let score = 0;
  for (const [term, weight] of smaller) score += weight * (larger.get(term) || 0);
  return score;
}

function lexicalScore(chunk, queryFrequencies, domains) {
  const haystack = chunk.searchText;
  let score = 0;
  for (const [token, frequency] of queryFrequencies) {
    const chunkFrequency = chunk.frequencies.get(token) || 0;
    if (chunkFrequency) score += Math.min(frequency, chunkFrequency) * (token.length >= 4 ? 4 : token.length >= 2 ? 2 : 1);
  }
  for (const domain of domains) {
    const matches = DOMAIN_TERMS[domain].filter((term) => haystack.includes(term.toLocaleLowerCase("zh-CN"))).length;
    score += Math.min(matches, 5) * 5;
  }
  if (chunk.source.endsWith("SKILL.md")) score += 1;
  return score;
}

function needsMultiPeriodRules(question, options) {
  if (Number.isInteger(options.periodCount)) return options.periodCount > 1;
  return /全年|整年|年度|跨月|最近\s*\d+\s*个?月|趋势|\d{4}\s*年\s*\d{1,2}\s*月?\s*(?:-|至|到|—|~|～)\s*(?:\d{4}\s*年\s*)?\d{1,2}\s*月/.test(String(question || ""));
}

function chunkKey(chunk) {
  return `${chunk.source}\u0000${chunk.sectionTitle}`;
}

function compareStable(left, right) {
  if (left > right) return 1;
  if (left < right) return -1;
  return 0;
}

function renderBlock(chunk) {
  const part = chunk.parts > 1 ? `；${chunk.part}/${chunk.parts}` : "";
  return `[RAG:${chunk.source}#${chunk.sectionTitle}${part}]\n${chunk.text}`;
}

class SkillKnowledgeBase {
  constructor(projectRoot) {
    this.skillRoot = path.join(projectRoot, "skills", "xbb-executive-analyst");
    const sources = SOURCE_FILES.map(({ source, projectPath }) => {
      const absolutePath = path.join(projectRoot, ...projectPath.split("/"));
      if (!fs.existsSync(absolutePath)) throw new Error(`RAG 知识源不存在：${projectPath}`);
      return { relativePath: source, text: fs.readFileSync(absolutePath, "utf8") };
    });
    this.sourceBytes = sources.reduce((total, source) => total + Buffer.byteLength(source.text, "utf8"), 0);
    this.digest = sha256(`${INDEX_VERSION}\n${sources.map((source) => `${source.relativePath}\n${source.text}`).join("\n\n")}`);
    const chunks = sources.flatMap((source) => splitMarkdown(source.relativePath, source.text)).map((chunk) => {
      const searchText = `${chunk.documentTitle}\n${chunk.sectionTitle}\n${chunk.text}`.toLocaleLowerCase("zh-CN");
      return { ...chunk, searchText, frequencies: termFrequencies(searchText) };
    });
    const idf = buildIdf(chunks);
    this.idf = idf;
    this.chunks = Object.freeze(chunks.map((chunk) => Object.freeze({
      ...chunk,
      tokens: new Set(chunk.frequencies.keys()),
      vector: sparseVector(chunk.frequencies, idf)
    })));
    if (this.chunks.length < 15) throw new Error("RAG 知识库切分结果不完整。");
    if (this.chunks.some((chunk) => Buffer.byteLength(chunk.text, "utf8") > MAX_CHUNK_BYTES)) throw new Error("RAG 知识库存在超大分块。");
  }

  stats() {
    return Object.freeze({
      sources: SOURCE_FILES.length,
      chunks: this.chunks.length,
      sourceBytes: this.sourceBytes,
      digest: this.digest,
      indexVersion: INDEX_VERSION,
      maxChunkBytes: MAX_CHUNK_BYTES
    });
  }

  retrieve(question, options = {}) {
    const limit = Number.isInteger(options.limit) && options.limit >= 0 ? Math.min(options.limit, 64) : DEFAULT_RESULT_LIMIT;
    const maxBytes = Number.isInteger(options.maxBytes) && options.maxBytes >= 0 ? options.maxBytes : DEFAULT_MAX_BYTES;
    const domains = normalizeDomains(options.domains, question);
    const requiredDomainSections = new Set(domains.flatMap((domain) => DOMAIN_SECTIONS[domain] || []));
    const multiPeriod = needsMultiPeriodRules(question, options);
    const mandatorySectionKeys = new Set([
      `SKILL.md\u0000数据域路由`,
      `SKILL.md\u0000不可突破的边界`,
      `references/response-policy.md\u0000回答方式`,
      ...[...requiredDomainSections].map((section) => `references/data-contract.md\u0000${section}`),
      ...(multiPeriod ? [`references/data-contract.md\u0000跨月与年度聚合`] : [])
    ]);
    const preferredSectionKeys = new Set([
      `references/response-policy.md\u0000图片与经营图`,
      `support/xbb-executive-chart/SKILL.md\u0000生成协议`,
      ...(domains.includes("opportunities") ? [`references/response-policy.md\u0000商机建议`] : [])
    ]);
    const mandatory = this.chunks.filter((chunk) => mandatorySectionKeys.has(chunkKey(chunk)));
    const preferred = this.chunks.filter((chunk) => preferredSectionKeys.has(chunkKey(chunk)));

    const queryFrequencies = termFrequencies(question);
    const queryVector = sparseVector(queryFrequencies, this.idf);
    const scored = this.chunks.map((chunk) => ({
      chunk,
      lexical: lexicalScore(chunk, queryFrequencies, domains),
      vector: cosineSimilarity(queryVector, chunk.vector)
    })).filter((entry) => entry.lexical > 0 || entry.vector > 0);
    const maxLexical = scored.reduce((maximum, entry) => Math.max(maximum, entry.lexical), 0);
    const ranked = scored.map((entry) => ({
      ...entry,
      score: (maxLexical ? entry.lexical / maxLexical * 0.6 : 0) + entry.vector * 0.4
    })).filter((entry) => {
      if (!ALL_DOMAIN_SECTIONS.has(entry.chunk.sectionTitle)) return true;
      return requiredDomainSections.has(entry.chunk.sectionTitle);
    }).filter((entry) => {
      if (entry.chunk.source !== "references/data-contract.md" || entry.chunk.sectionTitle !== "跨月与年度聚合") return true;
      return multiPeriod;
    }).sort((left, right) => right.score - left.score || compareStable(left.chunk.id, right.chunk.id));

    const sources = [];
    const seen = new Set();
    const omittedMandatory = new Set();
    const candidates = [
      ...mandatory.map((chunk) => ({ chunk, mandatory: true })),
      ...preferred.map((chunk) => ({ chunk, mandatory: false })),
      ...ranked.map((entry) => ({ chunk: entry.chunk, mandatory: false }))
    ];
    let text = "";
    for (const candidate of candidates) {
      const { chunk } = candidate;
      if (seen.has(chunk.id)) continue;
      seen.add(chunk.id);
      if (!candidate.mandatory && sources.length >= limit) continue;
      const block = renderBlock(chunk);
      const nextText = text ? `${text}\n\n${block}` : block;
      if (Buffer.byteLength(nextText, "utf8") > maxBytes) {
        if (candidate.mandatory) omittedMandatory.add(`${chunk.source}#${chunk.sectionTitle}`);
        continue;
      }
      text = nextText;
      sources.push(Object.freeze({
        id: chunk.id,
        source: chunk.source,
        section: chunk.sectionTitle,
        ...(chunk.parts > 1 ? { part: chunk.part, parts: chunk.parts } : {})
      }));
    }
    const bytes = Buffer.byteLength(text, "utf8");
    return Object.freeze({
      text,
      sources: Object.freeze(sources),
      domains: Object.freeze(domains),
      bytes,
      digest: this.digest,
      retrieval: Object.freeze({
        indexVersion: INDEX_VERSION,
        multiPeriod,
        maxBytes,
        omittedMandatory: Object.freeze([...omittedMandatory].sort(compareStable))
      })
    });
  }
}

module.exports = {
  DEFAULT_MAX_BYTES,
  DOMAIN_SECTIONS,
  DOMAIN_TERMS,
  INDEX_VERSION,
  MAX_CHUNK_BYTES,
  SOURCE_FILES,
  SkillKnowledgeBase,
  chineseNgrams,
  cosineSimilarity,
  detectedDomains,
  sparseVector,
  splitMarkdown,
  termFrequencies,
  utf8Prefix
};
