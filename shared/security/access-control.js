"use strict";

const fs = require("node:fs");
const path = require("node:path");

class AccessDeniedError extends Error {
  constructor(message, code = "access_denied") {
    super(message);
    this.name = "AccessDeniedError";
    this.code = code;
  }
}

function readJson(filePath, label) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${label}无法读取或不是有效 JSON：${error.message}`);
  }
  return value;
}

function validatePolicy(policy, schema) {
  const expectedVersion = schema?.properties?.schemaVersion?.const;
  const allowedScopes = schema?.properties?.users?.additionalProperties?.properties?.scope?.enum;
  const maxUsers = schema?.properties?.users?.maxProperties;
  const maxCompanies = schema?.properties?.users?.additionalProperties?.properties?.companies?.maxItems;

  if (!expectedVersion || !Array.isArray(allowedScopes) || !Number.isInteger(maxUsers) || !Number.isInteger(maxCompanies)) {
    throw new Error("访问策略机器契约不完整。");
  }
  if (!policy || typeof policy !== "object" || Array.isArray(policy) || policy.schemaVersion !== expectedVersion) {
    throw new Error(`访问策略 schemaVersion 必须为 ${expectedVersion}。`);
  }
  if (!policy.users || typeof policy.users !== "object" || Array.isArray(policy.users)) {
    throw new Error("访问策略 users 必须是对象。");
  }

  const entries = Object.entries(policy.users);
  if (entries.length > maxUsers) throw new Error(`访问策略用户数不能超过 ${maxUsers}。`);
  for (const [userId, rule] of entries) {
    if (!userId.trim() || Buffer.byteLength(userId, "utf8") > 256) throw new Error("访问策略包含无效 USERID。");
    if (!rule || typeof rule !== "object" || Array.isArray(rule) || !allowedScopes.includes(rule.scope)) {
      throw new Error(`USERID ${userId} 的 scope 无效。`);
    }
    const extra = Object.keys(rule).filter((key) => !["scope", "companies"].includes(key));
    if (extra.length) throw new Error(`USERID ${userId} 包含不支持的策略字段：${extra.join(", ")}`);
    if (rule.scope === "all" && rule.companies !== undefined) {
      throw new Error(`USERID ${userId} 使用 all 时不得配置 companies。`);
    }
    if (rule.scope === "companies") {
      if (!Array.isArray(rule.companies) || rule.companies.length < 1 || rule.companies.length > maxCompanies) {
        throw new Error(`USERID ${userId} 的 companies 数量无效。`);
      }
      const normalized = rule.companies.map((company) => typeof company === "string" ? company.trim() : "");
      if (normalized.some((company) => !company || Buffer.byteLength(company, "utf8") > 360)) {
        throw new Error(`USERID ${userId} 包含无效公司名称。`);
      }
      if (new Set(normalized).size !== normalized.length) throw new Error(`USERID ${userId} 的 companies 不能重复。`);
      rule.companies = normalized;
    }
  }
  return policy;
}

function loadAccessPolicy(policyPath, options = {}) {
  const contractPath = options.contractPath || path.resolve(__dirname, "..", "..", "contracts", "access-policy.schema.json");
  const resolvedPolicy = path.resolve(policyPath);
  return validatePolicy(readJson(resolvedPolicy, "访问策略"), readJson(contractPath, "访问策略契约"));
}

function authorize(policy, userId) {
  if (typeof userId !== "string" || !userId.trim()) throw new AccessDeniedError("无法识别企业微信用户。", "missing_userid");
  const rule = policy.users[userId];
  if (!rule) throw new AccessDeniedError("当前企业微信账号尚未获准使用经营分析服务。", "user_not_registered");
  return Object.freeze({
    userId,
    scope: rule.scope,
    companies: rule.scope === "companies" ? Object.freeze([...rule.companies]) : Object.freeze([])
  });
}

function enforceCompany(access, requestedCompany) {
  const company = typeof requestedCompany === "string" ? requestedCompany.trim() : "";
  if (access.scope === "all") return company || undefined;
  if (company) {
    if (!access.companies.includes(company)) throw new AccessDeniedError("无权查询该公司。", "company_not_allowed");
    return company;
  }
  if (access.companies.length === 1) return access.companies[0];
  throw new AccessDeniedError(`请先明确要查询的授权公司：${access.companies.join("、")}`, "company_required");
}

module.exports = {
  AccessDeniedError,
  authorize,
  enforceCompany,
  loadAccessPolicy,
  validatePolicy
};
