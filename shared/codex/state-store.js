"use strict";

const fs = require("node:fs");
const path = require("node:path");

function emptyState() {
  return { schemaVersion: "1.0", agent: "xbb-executive-analyst", threads: {} };
}

function validateState(value) {
  if (!value || value.schemaVersion !== "1.0" || value.agent !== "xbb-executive-analyst" || !value.threads || typeof value.threads !== "object" || Array.isArray(value.threads)) {
    throw new Error("Codex Agent 状态文件无效。");
  }
  for (const [principalKey, thread] of Object.entries(value.threads)) {
    if (!/^[a-f0-9]{64}$/.test(principalKey) || !thread || typeof thread.threadId !== "string" || !thread.threadId || typeof thread.contractHash !== "string") {
      throw new Error("Codex Agent 线程状态无效。");
    }
  }
  return value;
}

function loadAgentState(statePath) {
  if (!fs.existsSync(statePath)) return emptyState();
  return validateState(JSON.parse(fs.readFileSync(statePath, "utf8")));
}

function saveAgentState(statePath, state) {
  validateState(state);
  const parent = path.dirname(path.resolve(statePath));
  fs.mkdirSync(parent, { recursive: true });
  const temporary = `${statePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    fs.renameSync(temporary, statePath);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
}

module.exports = { emptyState, loadAgentState, saveAgentState, validateState };
