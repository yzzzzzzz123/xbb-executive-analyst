"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadAgentState, saveAgentState } = require("../shared/codex/state-store.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "xbb-state-recovery-"));
try {
  const statePath = path.join(root, "agent-state.json");
  fs.writeFileSync(statePath, "{not-json", "utf8");
  const recovered = loadAgentState(statePath);
  assert.equal(recovered.recoveredFromCorruption, true);
  assert.deepEqual(recovered.threads, {});
  assert.equal(fs.existsSync(statePath), false);
  assert.match(path.basename(recovered.quarantinedPath), /^agent-state\.json\.corrupt-\d+-\d+$/);
  assert.equal(fs.readFileSync(recovered.quarantinedPath, "utf8"), "{not-json");
  saveAgentState(statePath, recovered);
  assert.equal(loadAgentState(statePath).recoveredFromCorruption, undefined);
  assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).recoveredFromCorruption, undefined);

  fs.writeFileSync(statePath, JSON.stringify({ schemaVersion: "0", agent: "wrong", threads: {} }), "utf8");
  const schemaRecovered = loadAgentState(statePath);
  assert.equal(schemaRecovered.recoveredFromCorruption, true);
  assert.deepEqual(schemaRecovered.threads, {});

  process.stdout.write(`${JSON.stringify({ success: true, checks: 10, recovery: "quarantine-and-fresh-state" })}\n`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
