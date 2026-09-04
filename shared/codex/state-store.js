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
    if (thread.lastMode != null && !["general", "xbb"].includes(thread.lastMode)) throw new Error("Codex Agent 最近能力路由无效。");
    if (thread.lastModeSource != null && thread.lastModeSource !== "user") throw new Error("Codex Agent 最近能力路由来源无效。");
    if (thread.turnCount != null && (!Number.isInteger(thread.turnCount) || thread.turnCount < 0 || thread.turnCount > 1000000)) {
      throw new Error("Codex Agent 线程轮次数无效。");
    }
    if (thread.estimatedInputBytes != null && (!Number.isInteger(thread.estimatedInputBytes) || thread.estimatedInputBytes < 0 || thread.estimatedInputBytes > 1024 * 1024 * 1024)) {
      throw new Error("Codex Agent 线程输入预算无效。");
    }
    if (thread.turnInProgress != null && typeof thread.turnInProgress !== "boolean") {
      throw new Error("Codex Agent 线程活动状态无效。");
    }
  }
  return value;
}

function loadAgentState(statePath) {
  if (!fs.existsSync(statePath)) return emptyState();
  try {
    return validateState(JSON.parse(fs.readFileSync(statePath, "utf8")));
  } catch (error) {
    // Thread 状态不含经营事实，也不是服务启动的必要数据。损坏时先原子隔离原件，
    // 再从空状态安全启动；继续卡在同一个坏 JSON 会造成计划任务无限重启。
    const quarantine = `${path.resolve(statePath)}.corrupt-${Date.now()}-${process.pid}`;
    try {
      fs.renameSync(statePath, quarantine);
    } catch (quarantineError) {
      throw new Error("Codex Agent 状态文件损坏且无法隔离。", { cause: quarantineError });
    }
    const recovered = emptyState();
    Object.defineProperty(recovered, "recoveredFromCorruption", { value: true, enumerable: false });
    Object.defineProperty(recovered, "quarantinedPath", { value: quarantine, enumerable: false });
    return recovered;
  }
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
