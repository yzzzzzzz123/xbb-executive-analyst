"use strict";

const crypto = require("node:crypto");
const { MAX_USER_QUESTION_BYTES, segmentUserMessage, taskIntentDescriptor } = require("./context-policy.js");

const MAX_CHECKPOINT_BYTES = 12 * 1024;
const MAX_CHECKPOINT_MATERIALS = 8;
const MAX_PLAN_STEPS = 20;
const STAGES = Object.freeze([
  Object.freeze({ id: "intake", label: "现状与目标", dependsOn: null }),
  Object.freeze({ id: "impact", label: "影响与依赖", dependsOn: "intake" }),
  Object.freeze({ id: "draft", label: "迁移与回退草案", dependsOn: "impact" }),
  Object.freeze({ id: "validation", label: "验证", dependsOn: "draft" }),
  Object.freeze({ id: "handoff", label: "执行条件与交付", dependsOn: "validation" })
]);
const STAGE_IDS = new Set(STAGES.map((stage) => stage.id));
const PLAN_STATUSES = new Set(["pending", "inProgress", "completed"]);
const REVISION_CORRECTION = /改成|改为|改用|替换|切换|修正|不再|版本(?:更新|变更|升级)|(?:新版|更新后)(?:代码|材料|SQL|schema|表结构)/iu;
const MATERIAL_CORRECTION = /(?:(?:代码|材料|SQL|schema|表结构|版本).{0,12}(?:更新|替换|改为|升级|变更))|(?:(?:新版|最新|更新后|替换|改用).{0,12}(?:代码|材料|SQL|schema|表结构|版本))/iu;

// Binding capabilities never appear in the checkpoint's enumerable data or
// formatted prompt. Only objects issued by this runtime can be transitioned;
// user/model JSON cannot forge a checkpoint or its identity/revision binding.
const bindings = new WeakMap();
const digest = (value) => crypto.createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value), "utf8").digest("hex");
const byteLength = (value) => Buffer.byteLength(value, "utf8");
const boundedCount = (value) => Math.min(999, Math.max(0, value));

class TaskCheckpointError extends Error {
  constructor(code) {
    super(`任务检查点未更新：${code}`);
    this.name = "TaskCheckpointError";
    this.code = code;
  }
}

function freezeDeep(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function questionText(question) {
  if (typeof question !== "string" || byteLength(question) > MAX_USER_QUESTION_BYTES) throw new TaskCheckpointError("invalid_material_input");
  return question;
}

function identity({ principalKey, routeMode, turnId = null } = {}) {
  if (typeof principalKey !== "string" || !/^[a-f0-9]{64}$/u.test(principalKey)
      || routeMode !== "general"
      || (turnId !== null && (typeof turnId !== "string" || !turnId || byteLength(turnId) > 256))) {
    throw new TaskCheckpointError("invalid_binding");
  }
  return { principalKey, routeMode, turnId };
}

function metadata(checkpoint) {
  const binding = bindings.get(checkpoint);
  if (!binding) throw new TaskCheckpointError("unrecognized_checkpoint");
  return binding;
}

function assertBinding(checkpoint, supplied, { revision = true, turn = false } = {}) {
  const expected = metadata(checkpoint);
  const actual = identity(supplied);
  if (actual.principalKey !== expected.principalKey || actual.routeMode !== expected.routeMode) throw new TaskCheckpointError("scope_mismatch");
  if (revision && supplied?.revision !== checkpoint.revision) throw new TaskCheckpointError("revision_mismatch");
  if (turn && actual.turnId !== expected.turnId) throw new TaskCheckpointError("turn_mismatch");
  return expected;
}

function materialDescriptors(question) {
  const parts = segmentUserMessage(questionText(question)).filter((part) => part.kind !== "text");
  return {
    entries: parts.slice(0, MAX_CHECKPOINT_MATERIALS).map((part, index) => ({
      id: `material_${index + 1}`, kind: part.kind, bytes: byteLength(part.text),
      sha256: digest(part.text), complete: part.complete !== false
    })),
    omitted: Math.max(0, parts.length - MAX_CHECKPOINT_MATERIALS),
    count: parts.length,
    // Includes omitted blocks so changing block nine still invalidates claims.
    fingerprint: digest(parts.map((part) => ({ kind: part.kind, sha256: digest(part.text), complete: part.complete !== false })))
  };
}

function emptyStages(revision) {
  return STAGES.map((stage) => ({
    id: stage.id, status: "pending", reportedStatus: null, source: null,
    verified: false, revision, blockedBy: []
  }));
}

function finalize(value, binding) {
  value.pendingVerification = value.stages.filter((stage) => stage.status === "model-reported" || stage.status === "user-reported")
    .map((stage) => ({ stage: stage.id, reason: "completion_claim_not_verified" }));
  if (!value.pendingVerification.some((entry) => entry.stage === "validation")) {
    value.pendingVerification.push({ stage: "validation", reason: "no_observed_execution_evidence" });
  }
  value.sourceReadRequired = value.materials.count > 0 || value.materials.omitted > 0 || value.materials.awaitingReplacement;
  if (byteLength(JSON.stringify(value)) > MAX_CHECKPOINT_BYTES) throw new TaskCheckpointError("checkpoint_budget_exceeded");
  const result = freezeDeep(value);
  bindings.set(result, binding);
  return result;
}

function createTaskCheckpoint({ principalKey, routeMode, turnId = null, context, question } = {}) {
  const intent = taskIntentDescriptor(context);
  if (routeMode !== "general" || !intent) return null;
  const owner = identity({ principalKey, routeMode, turnId });
  const material = materialDescriptors(question);
  return finalize({
    version: 1, revision: 1, readOnly: true, executionStatus: "not-executed",
    intent,
    materials: { version: 1, entries: material.entries, count: material.count, omitted: material.omitted, awaitingReplacement: false, contentRetained: false },
    stages: emptyStages(1),
    unmappedPlanSteps: 0, invalidations: 0, lastInvalidation: null,
    planAcceptance: turnId ? "current-turn" : "awaiting-turn"
  }, {
    ...owner, intentFingerprint: digest({ goal: intent.goal, constraints: intent.constraints }),
    materialFingerprint: material.fingerprint, questionFingerprint: digest(question), blockedTurn: null
  });
}

function reviseTaskCheckpoint(checkpoint, { context, question, binding } = {}) {
  const owner = assertBinding(checkpoint, binding);
  const intent = taskIntentDescriptor(context);
  if (!intent) return null;
  questionText(question);
  const material = materialDescriptors(question);
  const questionFingerprint = digest(question);
  const materialCorrection = MATERIAL_CORRECTION.test(question) && questionFingerprint !== owner.questionFingerprint;
  const materialsChanged = material.count > 0 ? material.fingerprint !== owner.materialFingerprint : materialCorrection;
  const goalChanged = intent.goal !== checkpoint.intent.goal;
  const constraintsChanged = digest(intent.constraints) !== digest(checkpoint.intent.constraints);
  const scopeCorrected = REVISION_CORRECTION.test(question) && questionFingerprint !== owner.questionFingerprint;
  const revised = goalChanged || constraintsChanged || materialsChanged || scopeCorrected;
  const revision = checkpoint.revision + (revised ? 1 : 0);
  const reason = goalChanged ? "goal_changed" : materialsChanged ? "materials_changed" : constraintsChanged ? "constraints_changed" : "scope_corrected";
  const fromIndex = goalChanged || materialsChanged || scopeCorrected ? 0 : 1;
  let materials = checkpoint.materials;
  if (materialsChanged) {
    materials = {
      version: checkpoint.materials.version + 1,
      entries: material.count > 0 ? material.entries : [],
      count: material.count,
      omitted: boundedCount(checkpoint.materials.omitted + checkpoint.materials.entries.length + material.omitted),
      awaitingReplacement: material.count === 0, contentRetained: false
    };
  }
  const stages = checkpoint.stages.map((stage, index) => revised && index >= fromIndex
    ? { ...stage, status: "invalidated", reportedStatus: null, source: null, verified: false, revision, blockedBy: [] }
    : { ...stage, revision, blockedBy: [...stage.blockedBy] });
  return finalize({
    ...checkpoint, revision, intent, materials, stages,
    invalidations: boundedCount(checkpoint.invalidations + (revised ? 1 : 0)),
    lastInvalidation: revised ? { revision, reason, fromStage: STAGES[fromIndex].id } : checkpoint.lastInvalidation,
    planAcceptance: revised && owner.turnId ? "blocked-until-new-turn" : checkpoint.planAcceptance
  }, {
    ...owner, intentFingerprint: digest({ goal: intent.goal, constraints: intent.constraints }),
    materialFingerprint: materialsChanged ? material.fingerprint : owner.materialFingerprint,
    questionFingerprint, blockedTurn: revised && owner.turnId ? owner.turnId : owner.blockedTurn
  });
}

function bindCheckpointTurn(checkpoint, binding) {
  const owner = assertBinding(checkpoint, binding);
  const { turnId } = identity(binding);
  if (!turnId) throw new TaskCheckpointError("missing_turn");
  const blocked = turnId === owner.blockedTurn;
  return finalize({ ...checkpoint, stages: checkpoint.stages.map((stage) => ({ ...stage, blockedBy: [...stage.blockedBy] })),
    planAcceptance: blocked ? "blocked-until-new-turn" : "current-turn"
  }, { ...owner, turnId, blockedTurn: blocked ? owner.blockedTurn : null });
}

function classifyStage(step) {
  if (STAGE_IDS.has(step)) return step;
  if (/执行条件|交付|移交|交接|handoff|readiness/iu.test(step)) return "handoff";
  if (/验证|测试|验收|validation|verify|test/iu.test(step)) return "validation";
  if (/迁移草案|迁移方案|迁移脚本|回退|回滚|草案|migration|rollback|draft/iu.test(step)) return "draft";
  if (/影响|依赖|风险|impact|dependenc|risk/iu.test(step)) return "impact";
  if (/现状|需求|目标|收集|材料|结构|intake|inspect|schema/iu.test(step)) return "intake";
  return null;
}

function reportedComplete(stage) {
  return ["model-reported", "user-reported"].includes(stage.status) && stage.reportedStatus === "completed";
}

function transition(stages, stageId, reportedStatus, source, revision) {
  const index = STAGES.findIndex((stage) => stage.id === stageId);
  if (index < 0 || !PLAN_STATUSES.has(reportedStatus)) throw new TaskCheckpointError("invalid_stage_report");
  const dependency = STAGES[index].dependsOn;
  const blockedBy = reportedStatus !== "pending" && dependency && !reportedComplete(stages[index - 1]) ? [dependency] : [];
  const status = blockedBy.length ? "blocked"
    : reportedStatus === "completed" ? `${source}-reported`
      : reportedStatus === "inProgress" ? "in-progress" : "pending";
  const wasComplete = reportedComplete(stages[index]);
  stages[index] = { id: stageId, status, reportedStatus, source, verified: false, revision, blockedBy };
  if (wasComplete && !reportedComplete(stages[index])) {
    for (let cursor = index + 1; cursor < stages.length; cursor += 1) {
      stages[cursor] = { ...stages[cursor], status: "invalidated", reportedStatus: null, source: null, verified: false, revision, blockedBy: [] };
    }
  }
}

function applyPlanUpdate(checkpoint, event, binding) {
  const owner = assertBinding(checkpoint, binding, { turn: true });
  if (owner.turnId === null || event?.turnId !== owner.turnId || checkpoint.planAcceptance !== "current-turn") return checkpoint;
  if (!Array.isArray(event.plan) || event.plan.length > MAX_PLAN_STEPS) throw new TaskCheckpointError("invalid_plan");
  const mapped = new Map();
  let unmapped = 0;
  const rank = { pending: 0, inProgress: 1, completed: 2 };
  for (const item of event.plan) {
    if (!item || typeof item.step !== "string" || byteLength(item.step) > 1024 || !PLAN_STATUSES.has(item.status)) throw new TaskCheckpointError("invalid_plan_step");
    const stage = classifyStage(item.step);
    if (!stage) { unmapped += 1; continue; }
    const prior = mapped.get(stage);
    if (!prior || rank[item.status] < rank[prior]) mapped.set(stage, item.status);
  }
  const stages = checkpoint.stages.map((stage) => ({ ...stage, blockedBy: [...stage.blockedBy] }));
  for (const stage of STAGES) if (mapped.has(stage.id)) transition(stages, stage.id, mapped.get(stage.id), "model", checkpoint.revision);
  return finalize({ ...checkpoint, stages, unmappedPlanSteps: unmapped }, { ...owner });
}

function reportUserStage(checkpoint, { stage, status } = {}, binding) {
  const owner = assertBinding(checkpoint, binding, { turn: true });
  const stages = checkpoint.stages.map((item) => ({ ...item, blockedBy: [...item.blockedBy] }));
  transition(stages, stage, status, "user", checkpoint.revision);
  return finalize({ ...checkpoint, stages }, { ...owner });
}

function formatTaskCheckpoint(checkpoint) {
  if (!checkpoint) return "";
  metadata(checkpoint);
  return [
    "【任务检查点】",
    "这是只读任务的有界状态，不是执行证据。model-reported/user-reported 只表示对应来源声称完成；verified=false 的事项均未验证。材料仅保留指纹和省略记录，精确处理前必须重新核实原文；当前修订的约束优先。",
    JSON.stringify(checkpoint)
  ].join("\n");
}

module.exports = {
  MAX_CHECKPOINT_BYTES, MAX_CHECKPOINT_MATERIALS, MAX_PLAN_STEPS, STAGES, TaskCheckpointError,
  applyPlanUpdate, bindCheckpointTurn, createTaskCheckpoint, formatTaskCheckpoint, reportUserStage, reviseTaskCheckpoint
};
