"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const SOURCE_FILES = Object.freeze([
  "SKILL.md",
  "references/data-contract.md",
  "references/runtime-contract.md",
  "references/response-policy.md",
  "references/wecom-service-contract.md"
]);

const DOMAIN_TERMS = Object.freeze({
  performance: ["业绩", "收入", "课程", "咨询", "占比", "排名", "公司"],
  "product-sales": ["门票", "商业操盘", "开源产品", "成交数量", "产品"],
  courses: ["开课", "课程", "成交率", "参课", "老板", "课堂"],
  delivery: ["交付", "邀约", "受邀", "到场", "业绩分配"],
  opportunities: ["商机", "赢单", "输单", "预计成交", "跟进", "遗忘", "激活", "阶段", "销售"]
});

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function stripFrontmatter(text) {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
}

function splitMarkdown(relativePath, rawText) {
  const text = relativePath === "SKILL.md" ? stripFrontmatter(rawText) : rawText;
  const lines = text.split(/\r?\n/);
  let documentTitle = relativePath;
  let sectionTitle = "概述";
  let current = [];
  const chunks = [];

  const flush = () => {
    const body = current.join("\n").trim();
    if (!body) return;
    chunks.push({
      id: sha256(`${relativePath}\n${sectionTitle}\n${body}`).slice(0, 20),
      source: relativePath.replace(/\\/g, "/"),
      documentTitle,
      sectionTitle,
      text: body
    });
  };

  for (const line of lines) {
    const heading = /^(#{1,3})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      if (heading[1].length === 1) {
        documentTitle = heading[2];
        if (!current.length) {
          sectionTitle = "概述";
          current.push(line);
          continue;
        }
      }
      flush();
      sectionTitle = heading[2];
      current = [line];
    } else {
      current.push(line);
    }
  }
  flush();
  return chunks;
}

function chineseNgrams(value) {
  const normalized = String(value || "").toLocaleLowerCase("zh-CN");
  const tokens = new Set(normalized.match(/[a-z0-9][a-z0-9_-]{1,}|[\u3400-\u9fff]{2,}/g) || []);
  for (const run of normalized.match(/[\u3400-\u9fff]{2,}/g) || []) {
    for (let index = 0; index < run.length - 1; index += 1) tokens.add(run.slice(index, index + 2));
  }
  return tokens;
}

function detectedDomains(question) {
  const text = String(question || "").toLocaleLowerCase("zh-CN");
  return Object.entries(DOMAIN_TERMS)
    .filter(([, terms]) => terms.some((term) => text.includes(term.toLocaleLowerCase("zh-CN"))))
    .map(([domain]) => domain);
}

function scoreChunk(chunk, queryTokens, domains) {
  const haystack = `${chunk.documentTitle}\n${chunk.sectionTitle}\n${chunk.text}`.toLocaleLowerCase("zh-CN");
  const chunkTokens = chunk.tokens;
  let score = 0;
  for (const token of queryTokens) {
    if (chunkTokens.has(token)) score += token.length >= 4 ? 4 : 1;
  }
  for (const domain of domains) {
    const matches = DOMAIN_TERMS[domain].filter((term) => haystack.includes(term.toLocaleLowerCase("zh-CN"))).length;
    score += Math.min(matches, 5) * 5;
  }
  if (chunk.source === "SKILL.md") score += 1;
  return score;
}

class SkillKnowledgeBase {
  constructor(projectRoot) {
    this.skillRoot = path.join(projectRoot, "skills", "xbb-executive-analyst");
    const sources = SOURCE_FILES.map((relativePath) => {
      const absolutePath = path.join(this.skillRoot, ...relativePath.split("/"));
      if (!fs.existsSync(absolutePath)) throw new Error(`RAG 知识源不存在：${relativePath}`);
      return { relativePath, text: fs.readFileSync(absolutePath, "utf8") };
    });
    this.sourceBytes = sources.reduce((total, source) => total + Buffer.byteLength(source.text, "utf8"), 0);
    this.digest = sha256(sources.map((source) => `${source.relativePath}\n${source.text}`).join("\n\n"));
    this.chunks = Object.freeze(sources.flatMap((source) => splitMarkdown(source.relativePath, source.text)).map((chunk) => Object.freeze({
      ...chunk,
      tokens: chineseNgrams(`${chunk.documentTitle}\n${chunk.sectionTitle}\n${chunk.text}`)
    })));
    if (this.chunks.length < 15) throw new Error("RAG 知识库切分结果不完整。");
  }

  stats() {
    return Object.freeze({ sources: SOURCE_FILES.length, chunks: this.chunks.length, sourceBytes: this.sourceBytes, digest: this.digest });
  }

  retrieve(question, options = {}) {
    const limit = Number.isInteger(options.limit) ? options.limit : 8;
    const maxBytes = Number.isInteger(options.maxBytes) ? options.maxBytes : 14000;
    const queryTokens = chineseNgrams(question);
    const domains = detectedDomains(question);
    const mandatory = this.chunks.filter((chunk) =>
      (chunk.source === "SKILL.md" && ["数据域路由", "不可突破的边界"].includes(chunk.sectionTitle))
      || (chunk.source.endsWith("response-policy.md") && ["回答方式", "何时画图"].includes(chunk.sectionTitle))
    );
    const ranked = this.chunks
      .map((chunk) => ({ chunk, score: scoreChunk(chunk, queryTokens, domains) }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score || left.chunk.id.localeCompare(right.chunk.id));
    const selected = [];
    const seen = new Set();
    for (const chunk of [...mandatory, ...ranked.map((entry) => entry.chunk)]) {
      if (seen.has(chunk.id) || selected.length >= limit) continue;
      seen.add(chunk.id);
      selected.push(chunk);
    }
    if (!selected.length) selected.push(this.chunks[0]);

    const blocks = [];
    const sources = [];
    let bytes = 0;
    for (const chunk of selected) {
      const block = `[RAG 来源：${chunk.source}；章节：${chunk.sectionTitle}]\n${chunk.text}`;
      const blockBytes = Buffer.byteLength(block, "utf8");
      if (blocks.length && bytes + blockBytes > maxBytes) continue;
      blocks.push(block);
      sources.push(Object.freeze({ id: chunk.id, source: chunk.source, section: chunk.sectionTitle }));
      bytes += blockBytes;
    }
    return Object.freeze({ text: blocks.join("\n\n"), sources: Object.freeze(sources), domains: Object.freeze(domains), bytes, digest: this.digest });
  }
}

module.exports = { DOMAIN_TERMS, SOURCE_FILES, SkillKnowledgeBase, chineseNgrams, detectedDomains, splitMarkdown };
