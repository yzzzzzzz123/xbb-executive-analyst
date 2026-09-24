"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const PROJECT_ROOT = path.resolve(__dirname, "..");
// Each suite has one owner group; npm test always executes every group.
// New verification files must be registered here to prevent silent coverage gaps.
const SUITES = Object.freeze({
  unit: Object.freeze([
    "verify-project-boundaries.js",
    "verify-agent-framework.js",
    "verify-context-policy.js",
    "verify-task-checkpoint.js",
    "verify-answer-preview.js",
    "verify-chart-findings.js",
    "verify-chart-agent.js",
    "verify-data-demand.js",
    "verify-delivery-deadline.js",
    "verify-live-benchmark-contract.js",
    "verify-runtime-observation.js",
    "verify-production-metrics.js",
    "verify-access-control.js",
    "verify-rag-knowledge-base.js",
    "verify-recovery-answer.js",
    "verify-state-recovery.js",
    "verify-message-store.js",
    "verify-watchdog-launcher.js",
  ]),
  integration: Object.freeze([
    "verify-web-experience.js",
    "verify-web-supervisor.js",
    "verify-facts.js",
    "verify-query-scheduling.js",
    "verify-multi-period-consumers.js",
    "verify-charts.js",
    "verify-codex-app-server.js",
    "verify-request-lifecycle.js",
    "verify-agent-preview.js",
    "verify-answer-preview-delivery.js",
    "verify-reliability-benchmark.js",
    "verify-database-rehearsal.py",
    "verify-wecom-long-connection.js",
  ]),
  windows: Object.freeze([
    "verify-runner-utf8.js",
    "verify-secure-config.ps1",
    "verify-hidden-task.ps1",
  ]),
});

function validateSuiteManifest(projectRoot = PROJECT_ROOT) {
  const registered = Object.values(SUITES).flat();
  const discovered = fs.readdirSync(path.join(projectRoot, "tests"))
    .filter((file) => /^verify-.*\.(?:js|ps1|py)$/.test(file)).sort();
  const duplicates = registered.filter((file, index) => registered.indexOf(file) !== index);
  const unregistered = discovered.filter((file) => !registered.includes(file));
  const missing = registered.filter((file) => !discovered.includes(file));
  if (duplicates.length || unregistered.length || missing.length) {
    throw new Error(`Test manifest mismatch: ${JSON.stringify({ duplicates, unregistered, missing })}`);
  }
  return registered.length;
}

function parseArgs(args) {
  if (args.length === 0) return { groups: Object.keys(SUITES), list: false };
  if (args.length === 1 && args[0] === "--list") return { groups: Object.keys(SUITES), list: true };
  if (args.length === 2 && args[0] === "--group" && Object.hasOwn(SUITES, args[1])) {
    return { groups: [args[1]], list: false };
  }
  throw new Error("Usage: node scripts/run-tests.js [--list | --group unit|integration|windows]");
}

function windowsPowerShellEnvironment(environment = process.env) {
  // PowerShell 7 includes its Core modules in PSModulePath. Windows PowerShell
  // 5.1 must rebuild its own module search path or DPAPI cmdlet autoload fails.
  return Object.fromEntries(Object.entries(environment).filter(([key]) => key.toLowerCase() !== "psmodulepath"));
}

function pythonRuntime() {
  for (const [command, prefix] of [["python", []], ["py", ["-3"]]]) {
    const probe = spawnSync(command, [...prefix, "--version"], { encoding: "utf8", windowsHide: true, shell: false, timeout: 10000 });
    if (!probe.error && probe.status === 0 && /^Python 3\./.test(`${probe.stdout}${probe.stderr}`.trim())) return { command, prefix };
  }
  throw new Error("Python 3 is required for the isolated database rehearsal; no suite is skipped.");
}

function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  const totalRegistered = validateSuiteManifest();
  if (options.list) {
    process.stdout.write(`${JSON.stringify({ totalRegistered, groups: SUITES }, null, 2)}\n`);
    return 0;
  }
  if (options.groups.includes("windows") && process.platform !== "win32") {
    throw new Error("Full acceptance requires Windows PowerShell 5.1, DPAPI and ScheduledTasks. Run test:unit/test:integration for partial checks; Windows suites are never silently skipped.");
  }

  const started = performance.now();
  const results = [];
  for (const group of options.groups) {
    for (const file of SUITES[group]) {
      const filePath = path.join(PROJECT_ROOT, "tests", file);
      const powershell = file.endsWith(".ps1");
      const python = file.endsWith(".py") ? pythonRuntime() : null;
      const command = powershell ? "powershell.exe" : python ? python.command : process.execPath;
      const commandArgs = powershell
        ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", filePath]
        : python ? [...python.prefix, filePath] : [filePath];
      process.stdout.write(`[test:start] ${group}/${file}\n`);
      const suiteStarted = performance.now();
      const child = spawnSync(command, commandArgs, {
        cwd: PROJECT_ROOT,
        stdio: "inherit",
        windowsHide: true,
        shell: false,
        ...(powershell ? { env: windowsPowerShellEnvironment() } : {}),
      });
      const elapsedMs = Math.round(performance.now() - suiteStarted);
      const passed = !child.error && child.status === 0;
      results.push({ group, file, passed, elapsedMs });
      process.stdout.write(`[test:${passed ? "pass" : "fail"}] ${group}/${file} ${elapsedMs} ms\n`);
      if (!passed) {
        if (child.error) process.stderr.write(`${child.error.message}\n`);
        if (child.signal) process.stderr.write(`Suite terminated by ${child.signal}\n`);
        process.stdout.write(`${JSON.stringify({ success: false, totalRegistered, completed: results, elapsedMs: Math.round(performance.now() - started) })}\n`);
        return child.status || 1;
      }
    }
  }
  process.stdout.write(`${JSON.stringify({ success: true, groups: options.groups, suites: results.length, totalRegistered, elapsedMs: Math.round(performance.now() - started) })}\n`);
  return 0;
}

if (require.main === module) {
  try { process.exitCode = main(); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}

module.exports = { SUITES, validateSuiteManifest, parseArgs, windowsPowerShellEnvironment, main };
