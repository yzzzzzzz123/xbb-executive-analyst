"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const util = require("node:util");
const { enforceCompany } = require("../security/access-control.js");

const execFile = util.promisify(childProcess.execFile);
const ALLOWED_DOMAINS = new Set(["all", "performance", "product-sales", "courses", "delivery", "opportunities"]);
const PRIVACY_PATTERN = /(?<!\d)1[3-9]\d{9}(?!\d)|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\b(?:ghp_|github_pat_|sk-)[A-Za-z0-9_-]{16,}\b/i;

function normalizeList(value, label, max) {
  const list = (Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [])
    .map((item) => String(item).trim()).filter(Boolean);
  const unique = [...new Set(list)];
  if (!unique.length) throw new Error(`${label}不能为空。`);
  if (unique.length > max) throw new Error(`${label}最多允许 ${max} 项。`);
  return unique;
}

function validateRequest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("查询参数必须是对象。");
  const extra = Object.keys(input).filter((key) => !["months", "domains", "company", "person", "forceRefresh"].includes(key));
  if (extra.length) throw new Error(`查询包含不支持的参数：${extra.join(", ")}`);
  const months = normalizeList(input.months, "月份", 12);
  if (months.some((month) => !/^\d{4}-(0[1-9]|1[0-2])$/.test(month))) throw new Error("月份必须使用 YYYY-MM 格式。");
  const domains = normalizeList(input.domains, "数据域", 5);
  if (domains.some((domain) => !ALLOWED_DOMAINS.has(domain))) throw new Error("查询包含不支持的数据域。");
  if (domains.includes("all") && domains.length !== 1) throw new Error("all 不能与其他数据域同时使用。");
  const company = typeof input.company === "string" ? input.company.trim() : "";
  const person = typeof input.person === "string" ? input.person.trim() : "";
  if (Buffer.byteLength(company, "utf8") > 360 || Buffer.byteLength(person, "utf8") > 360) throw new Error("公司或人员名称过长。");
  return { months, domains, company: company || undefined, person: person || undefined, forceRefresh: input.forceRefresh === true };
}

function hashCanonical(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function assertSinglePack(pack) {
  if (!pack || typeof pack !== "object" || !["ready", "needs_disambiguation"].includes(pack.status)) throw new Error("事实包状态无效。");
  if (pack.provenance?.live !== true || pack.provenance?.readOnly !== true || pack.provenance?.telephoneFieldsExported !== false || pack.provenance?.credentialFieldsExported !== false) {
    throw new Error("事实包来源或隐私边界无效。");
  }
  const canonical = {
    scope: pack.scope,
    entityResolution: pack.entityResolution,
    provenance: pack.provenance,
    facts: pack.facts,
    limitations: pack.limitations
  };
  if (pack.integrity?.algorithm !== "sha256" || pack.integrity.factPackSha256 !== hashCanonical(canonical)) {
    throw new Error("事实包完整性校验失败。");
  }
}

function assertSafeFactPack(pack) {
  if (Array.isArray(pack?.periods)) {
    if (!pack.periods.length || pack.periods.length > 12) throw new Error("多期事实包数量无效。");
    for (const period of pack.periods) assertSinglePack(period);
    if (pack.integrity?.algorithm !== "sha256" || typeof pack.integrity.factPackSha256 !== "string") throw new Error("多期事实包缺少完整性信息。");
  } else {
    assertSinglePack(pack);
  }
  if (PRIVACY_PATTERN.test(JSON.stringify(pack))) throw new Error("事实包隐私扫描失败。");
  return pack;
}

function createToolGateway(options = {}) {
  const projectRoot = options.projectRoot || path.resolve(__dirname, "..", "..");
  const runner = options.runner || path.join(projectRoot, "skills", "xbb-executive-analyst", "scripts", "query-xbb.ps1");
  const powershell = options.powershell || "powershell.exe";
  const run = options.execFile || execFile;

  if (!fs.existsSync(runner)) throw new Error(`销帮帮唯一 runner 不存在：${runner}`);

  return async function queryXbb(rawInput, access) {
    const input = validateRequest(rawInput);
    const company = enforceCompany(access, input.company);
    const tempParent = path.join(os.tmpdir(), "Codex", "xbb-executive-analyst", "bot-runs");
    fs.mkdirSync(tempParent, { recursive: true });
    const runDir = fs.mkdtempSync(path.join(tempParent, "request-"));
    const outputPath = path.join(runDir, "fact-pack.json");
    const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", runner,
      "-Month", input.months.join(","), "-Domains", input.domains.join(","), "-OutputPath", outputPath];
    if (company) args.push("-Company", company);
    if (input.person) args.push("-Person", input.person);
    if (input.forceRefresh) args.push("-ForceRefresh");

    try {
      await run(powershell, args, { windowsHide: true, encoding: "utf8", timeout: 300000, maxBuffer: 2 * 1024 * 1024 });
      if (!fs.existsSync(outputPath)) throw new Error("销帮帮 runner 未生成事实包。");
      const pack = JSON.parse(fs.readFileSync(outputPath, "utf8"));
      return assertSafeFactPack(pack);
    } catch (error) {
      if (error && /事实包|查询参数|月份|数据域|公司|runner/.test(error.message || "")) throw error;
      throw new Error("实时销帮帮查询失败，未返回任何替代或陈旧结果。", { cause: error });
    } finally {
      try { fs.rmSync(runDir, { recursive: true, force: true }); } catch { /* 单次临时目录由系统清理兜底 */ }
    }
  };
}

module.exports = { ALLOWED_DOMAINS, assertSafeFactPack, createToolGateway, validateRequest };
