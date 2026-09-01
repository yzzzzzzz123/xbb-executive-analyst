"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { AccessDeniedError, authorize, enforceCompany, validatePolicy } = require("../shared/security/access-control.js");

const schema = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "contracts", "access-policy.schema.json"), "utf8"));
const policy = validatePolicy({
  schemaVersion: "1.0",
  users: {
    boss: { scope: "all" },
    manager: { scope: "companies", companies: ["公司A"] },
    regional: { scope: "companies", companies: ["公司A", "公司B"] }
  }
}, schema);

assert.equal(authorize(policy, "boss").scope, "all");
assert.equal(enforceCompany(authorize(policy, "boss"), "公司B"), "公司B");
assert.equal(enforceCompany(authorize(policy, "manager")), "公司A");
assert.equal(enforceCompany(authorize(policy, "manager"), "公司A"), "公司A");
assert.throws(() => authorize(policy, "unknown"), (error) => error instanceof AccessDeniedError && error.code === "user_not_registered");
assert.throws(() => enforceCompany(authorize(policy, "manager"), "公司B"), /无权查询/);
assert.throws(() => enforceCompany(authorize(policy, "regional")), /请先明确/);
assert.throws(() => validatePolicy({ schemaVersion: "1.0", users: { bad: { scope: "all", companies: ["公司A"] } } }, schema), /不得配置/);

process.stdout.write(`${JSON.stringify({ success: true, checks: 8 })}\n`);
