"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { updateTaskContext } = require("../shared/codex/context-policy.js");
const {
  MAX_CHECKPOINT_BYTES, MAX_CHECKPOINT_MATERIALS, MAX_PLAN_STEPS, STAGES,
  applyPlanUpdate, bindCheckpointTurn, createTaskCheckpoint, formatTaskCheckpoint,
  reportUserStage, reviseTaskCheckpoint
} = require("../shared/codex/task-checkpoint.js");

const principalKey = "a".repeat(64);
const turnId = "synthetic-checkpoint-turn-a";
const source = "目标：优化数据库 notes 的表结构。必须兼容旧接口。\n\n```sql\nCREATE TABLE notes (body TEXT);\n-- password=synthetic-secret\n```";
const context = updateTaskContext(null, source, { mode: "general" });
const binding = (state, turn = turnId) => ({ principalKey, routeMode: "general", turnId: turn, revision: state.revision });
const create = (question = source, taskContext = context, turn = turnId) => createTaskCheckpoint({
  principalKey, routeMode: "general", turnId: turn, context: taskContext, question
});
const plan = (status = "completed") => STAGES.map((stage) => ({ step: stage.id, status }));
const apply = (state, steps, turn = turnId) => applyPlanUpdate(state, { turnId: turn, plan: steps }, binding(state, turn));

function verifyBoundedPrivateState() {
  const state = create();
  assert.equal(state.revision, 1);
  assert.equal(state.readOnly, true);
  assert.equal(state.executionStatus, "not-executed");
  assert.equal(state.materials.contentRetained, false);
  assert.equal(state.materials.count, 1);
  assert.equal(state.materials.entries[0].kind, "code");
  assert.equal(state.materials.entries[0].complete, true);
  assert.equal(state.sourceReadRequired, true);
  const serialized = formatTaskCheckpoint(state);
  assert.doesNotMatch(serialized, /CREATE TABLE|synthetic-secret|synthetic-checkpoint-turn|"principalKey"|"turnId"|"routeMode"/u);
  assert.equal(serialized.includes(principalKey), false);
  assert.ok(Buffer.byteLength(JSON.stringify(state), "utf8") <= MAX_CHECKPOINT_BYTES);
  assert.equal(Object.isFrozen(state), true);
  assert.equal(Object.isFrozen(state.materials.entries[0]), true);
  assert.equal(Object.isFrozen(state.stages[0].blockedBy), true);
  assert.throws(() => { state.stages[0].verified = true; }, TypeError);
  assert.throws(() => apply(JSON.parse(JSON.stringify(state)), plan()), (error) => error.code === "unrecognized_checkpoint");
  const general = updateTaskContext(null, "为什么天空是蓝色？");
  assert.equal(create("为什么天空是蓝色？", general), null);
  assert.equal(createTaskCheckpoint({ principalKey, routeMode: "xbb", context, question: source }), null);
  assert.equal(formatTaskCheckpoint(null), "");
}

function verifyReportsAreNotExecutionEvidence() {
  const state = apply(create(), plan());
  assert.equal(state.stages.every((stage) => stage.status === "model-reported"), true);
  assert.equal(state.stages.every((stage) => stage.verified === false && stage.source === "model"), true);
  assert.equal(state.executionStatus, "not-executed");
  assert.equal(state.pendingVerification.some((item) => item.stage === "validation"), true);
  assert.match(formatTaskCheckpoint(state), /不是执行证据/u);
  let userState = create();
  for (const stage of STAGES) {
    userState = reportUserStage(userState, { stage: stage.id, status: "completed", verified: true, source: "host" }, binding(userState));
  }
  assert.equal(userState.stages.every((stage) => stage.status === "user-reported" && !stage.verified), true);
  assert.throws(() => reportUserStage(userState, { stage: "validation", status: "verified" }, binding(userState)),
    (error) => error.code === "invalid_stage_report");
  const forgedPlan = apply(create(), plan().map((item) => ({ ...item, verified: true, source: "host" })));
  assert.equal(forgedPlan.stages.every((stage) => !stage.verified && stage.source === "model"), true);
}

function verifyDependencyGuards() {
  const jumped = apply(create(), [{ step: "validation", status: "completed" }]);
  const validation = jumped.stages.find((stage) => stage.id === "validation");
  assert.equal(validation.status, "blocked");
  assert.deepEqual(validation.blockedBy, ["draft"]);
  const userJump = reportUserStage(create(), { stage: "handoff", status: "completed" }, binding(create()));
  assert.equal(userJump.stages.at(-1).status, "blocked");
  const reported = apply(create(), plan());
  const regressed = apply(reported, [{ step: "intake", status: "pending" }]);
  assert.equal(regressed.stages[0].status, "pending");
  assert.equal(regressed.stages.slice(1).every((stage) => stage.status === "invalidated"), true);
  const grouped = apply(create(), [
    { step: "现状确认", status: "completed" },
    { step: "收集材料", status: "pending" },
    { step: "影响与依赖", status: "completed" }
  ]);
  assert.equal(grouped.stages[0].status, "pending", "A grouped phase cannot complete while one of its plan steps remains pending");
  assert.equal(grouped.stages[1].status, "blocked");
  const unmapped = apply(create(), [{ step: "password=synthetic-untrusted-label", status: "completed" }]);
  assert.equal(unmapped.unmappedPlanSteps, 1);
  assert.doesNotMatch(formatTaskCheckpoint(unmapped), /synthetic-untrusted-label/u);
}

function verifyRevisionAndTurnFencing() {
  const reported = apply(create(), plan());
  const correction = "补充：必须保留旧字段可读。";
  const nextContext = updateTaskContext(context, correction, { mode: "general", continuation: true });
  const revised = reviseTaskCheckpoint(reported, { context: nextContext, question: correction, binding: binding(reported) });
  assert.equal(revised.revision, 2);
  assert.equal(revised.lastInvalidation.reason, "constraints_changed");
  assert.equal(revised.stages[0].status, "model-reported");
  assert.equal(revised.stages.slice(1).every((stage) => stage.status === "invalidated"), true);
  assert.equal(revised.planAcceptance, "blocked-until-new-turn");
  assert.equal(apply(revised, plan()), revised, "Same-turn plan events lack revision tags and must remain blocked after a correction");
  const reboundSame = bindCheckpointTurn(revised, binding(revised));
  assert.equal(reboundSame.planAcceptance, "blocked-until-new-turn");
  assert.throws(() => applyPlanUpdate(revised, { turnId, plan: plan() }, binding(reported)),
    (error) => error.code === "revision_mismatch");
  const nextTurn = "synthetic-checkpoint-turn-b";
  const rebound = bindCheckpointTurn(revised, binding(revised, nextTurn));
  assert.equal(rebound.planAcceptance, "current-turn");
  assert.equal(applyPlanUpdate(rebound, { turnId, plan: plan() }, binding(rebound, nextTurn)), rebound,
    "A delayed event from the prior turn must not alter the current revision");
  const progressed = apply(rebound, plan(), nextTurn);
  assert.equal(progressed.stages.every((stage) => stage.status === "model-reported" && stage.revision === 2), true);
  const newGoal = "目标改为：只优化数据库索引。";
  const finalContext = updateTaskContext(nextContext, newGoal, { mode: "general", continuation: true });
  const changedGoal = reviseTaskCheckpoint(progressed, { context: finalContext, question: newGoal, binding: binding(progressed, nextTurn) });
  assert.equal(changedGoal.lastInvalidation.reason, "goal_changed");
  assert.equal(changedGoal.stages.every((stage) => stage.status === "invalidated"), true);
  const duplicate = reviseTaskCheckpoint(changedGoal, { context: finalContext, question: newGoal, binding: binding(changedGoal, nextTurn) });
  assert.equal(duplicate.revision, changedGoal.revision);
}

function verifyMaterialVersionsAndOmissions() {
  const original = apply(create(), plan());
  const updatedSource = "补充：改用以下材料。\n```sql\nCREATE TABLE notes (body TEXT, extra TEXT);\n```";
  const nextContext = updateTaskContext(context, updatedSource, { mode: "general", continuation: true });
  const revised = reviseTaskCheckpoint(original, { context: nextContext, question: updatedSource, binding: binding(original) });
  assert.equal(revised.materials.version, 2);
  assert.notEqual(revised.materials.entries[0].sha256, original.materials.entries[0].sha256);
  assert.equal(revised.materials.omitted, 1);
  assert.equal(revised.stages.every((stage) => stage.status === "invalidated"), true);
  const noSource = "材料版本更新，稍后提供新 SQL。";
  const awaiting = reviseTaskCheckpoint(revised, {
    context: updateTaskContext(nextContext, noSource, { mode: "general", continuation: true }), question: noSource, binding: binding(revised)
  });
  assert.equal(awaiting.materials.awaitingReplacement, true);
  assert.equal(awaiting.materials.entries.length, 0, "Superseded source fingerprints cannot appear as current materials");
  assert.equal(awaiting.sourceReadRequired, true);
  const incompleteSource = "优化数据库。\n```sql\nSELECT";
  const incomplete = create(incompleteSource, updateTaskContext(null, incompleteSource));
  assert.equal(incomplete.materials.entries[0].complete, false);
  const blocks = Array.from({ length: MAX_CHECKPOINT_MATERIALS + 1 }, (_, index) => `\`\`\`sql\nSELECT ${index};\n\`\`\``);
  const many = `优化数据库表结构。\n${blocks.join("\n")}`;
  const manyContext = updateTaskContext(null, many);
  const manyState = create(many, manyContext);
  assert.equal(manyState.materials.entries.length, MAX_CHECKPOINT_MATERIALS);
  assert.equal(manyState.materials.omitted, 1);
  const changedOmitted = many.replace(`SELECT ${MAX_CHECKPOINT_MATERIALS};`, "SELECT 999;");
  const omittedRevision = reviseTaskCheckpoint(manyState, {
    context: updateTaskContext(manyContext, changedOmitted, { continuation: true }), question: changedOmitted, binding: binding(manyState)
  });
  assert.equal(omittedRevision.revision, 2, "Changing an omitted ninth block must still invalidate stage claims");
  assert.deepEqual(omittedRevision.materials.entries, manyState.materials.entries);
  assert.equal(omittedRevision.materials.omitted, 10, "Previously omitted blocks must not be counted twice when material versions change");
  assert.ok(Buffer.byteLength(JSON.stringify(omittedRevision), "utf8") <= MAX_CHECKPOINT_BYTES);
  assert.equal(omittedRevision.materials.entries[0].sha256,
    crypto.createHash("sha256").update(`${blocks[0]}\n`).digest("hex"));
}

function verifyInputAndIdentityIsolation() {
  const state = create();
  assert.throws(() => applyPlanUpdate(state, { turnId, plan: plan() }, { ...binding(state), principalKey: "b".repeat(64) }),
    (error) => error.code === "scope_mismatch");
  assert.throws(() => reviseTaskCheckpoint(state, { context, question: source, binding: { ...binding(state), routeMode: "xbb" } }),
    (error) => error.code === "invalid_binding");
  assert.throws(() => apply(state, Array.from({ length: MAX_PLAN_STEPS + 1 }, () => ({ step: "intake", status: "pending" }))),
    (error) => error.code === "invalid_plan");
  assert.throws(() => apply(state, [{ step: "intake", status: "verified" }]), (error) => error.code === "invalid_plan_step");
  assert.throws(() => apply(state, [{ step: "x".repeat(1025), status: "completed" }]), (error) => error.code === "invalid_plan_step");
  assert.throws(() => create("x".repeat(32769)), (error) => error.code === "invalid_material_input");
  const unbound = create(source, context, null);
  assert.equal(unbound.planAcceptance, "awaiting-turn");
  const bound = bindCheckpointTurn(unbound, binding(unbound));
  assert.equal(bound.planAcceptance, "current-turn");
  const otherContext = updateTaskContext(context, "新问题：解释原理。", { continuation: true });
  assert.equal(reviseTaskCheckpoint(state, { context: otherContext, question: "新问题：解释原理。", binding: binding(state) }), null);
}

const checks = [verifyBoundedPrivateState, verifyReportsAreNotExecutionEvidence, verifyDependencyGuards,
  verifyRevisionAndTurnFencing, verifyMaterialVersionsAndOmissions, verifyInputAndIdentityIsolation];
for (const check of checks) check();
process.stdout.write(`${JSON.stringify({ success: true, checks: checks.length, mode: "synthetic-task-checkpoint" })}\n`);
