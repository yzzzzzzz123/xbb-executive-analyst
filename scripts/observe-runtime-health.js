"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const RUNTIME_ROOT = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Codex", "xbb-executive-analyst");
const CONNECTION_STATES = new Set(["ready", "disconnected", "reconnecting", "connection_error", "connection_stalled"]);

function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")); }
function readSnapshot(root, previousInstance = null, now = Date.now()) {
  try {
    const lease = readJson(path.join(root, "service-lease.json"));
    const state = readJson(path.join(root, "agent-state.json"));
    const events = ["status.jsonl.1", "status.jsonl"].flatMap((name) => {
      const file = path.join(root, name);
      if (!fs.existsSync(file)) return [];
      if (fs.statSync(file).size > 1024 * 1024) throw new Error("log_bound");
      return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
    });
    const latestConnection = events.filter((event) => CONNECTION_STATES.has(event.status)).at(-1);
    const leaseAgeMs = Number.isFinite(lease.updatedAtMs) ? now - lease.updatedAtMs : null;
    const fresh = leaseAgeMs !== null && leaseAgeMs >= -1000 && leaseAgeMs <= 90000;
    const authenticated = Boolean(latestConnection?.status === "ready" && latestConnection.instanceId === lease.instanceId);
    const markerRoot = path.join(root, "runner-isolation");
    const sample = {
      leaseRunning: lease.state === "running", leaseFresh: fresh, leaseAgeMs,
      authenticated, instanceChanged: previousInstance !== null && previousInstance !== lease.instanceId,
      activeTurns: Object.values(state.threads || {}).filter((thread) => thread.turnInProgress).length,
      runnerMarkers: fs.existsSync(markerRoot) ? fs.readdirSync(markerRoot).length : 0
    };
    return { sample: { ...sample, passed: sample.leaseRunning && fresh && authenticated }, instance: lease.instanceId };
  } catch { return { sample: { passed: false, failure: "local_health_unavailable" }, instance: previousInstance }; }
}

function parseOptions(args) {
  if (args.some((arg) => !/^--(?:samples=\d+|interval-ms=\d+)$/.test(arg))) throw new Error("Use --samples=1..60 --interval-ms=1000..60000");
  const count = Number(args.find((arg) => arg.startsWith("--samples="))?.split("=")[1] || 6);
  const intervalMs = Number(args.find((arg) => arg.startsWith("--interval-ms="))?.split("=")[1] || 60000);
  if (!Number.isInteger(count) || count < 1 || count > 60 || !Number.isInteger(intervalMs) || intervalMs < 1000 || intervalMs > 60000) throw new Error("Observation bounds exceeded");
  return { count, intervalMs };
}

async function main(args = process.argv.slice(2)) {
  const { count, intervalMs } = parseOptions(args);
  const started = performance.now();
  const report = { schemaVersion: "1.0", at: new Date().toISOString(), source: "live-passive-local", intervalMs, samples: [],
    caveat: "仅观察本机租约和认证状态，不发送消息，不证明手机显示、外部可用率或生产SLA。" };
  let previousInstance = null;
  for (let index = 0; index < count; index += 1) {
    if (index) await new Promise((resolve) => setTimeout(resolve, intervalMs));
    const snapshot = readSnapshot(RUNTIME_ROOT, previousInstance);
    previousInstance = snapshot.instance;
    const sample = { sequence: index + 1, elapsedMs: Math.round(performance.now() - started), ...snapshot.sample };
    report.samples.push(sample);
    process.stdout.write(`${JSON.stringify({ observation: sample })}\n`);
  }
  report.passed = report.samples.every((sample) => sample.passed);
  report.instanceChanges = report.samples.filter((sample) => sample.instanceChanged).length;
  const directory = path.resolve(__dirname, "..", "test-results", "production");
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `health-${report.at.replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ passed: report.passed, report: file })}\n`);
  if (!report.passed) process.exitCode = 1;
  return report;
}

if (require.main === module) main().catch(() => { process.stderr.write("本地健康观察失败，未输出运行时正文或身份数据。\n"); process.exitCode = 1; });
module.exports = { parseOptions, readSnapshot, main };
