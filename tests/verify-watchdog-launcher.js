"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const {
  buildPowerShellArguments,
  launch,
  parseArguments,
} = require("../scripts/launch-wecom-watchdog");

const input = [
  "--powershell", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  "--script", "D:\\codex\\xbb-executive-analyst\\scripts\\watchdog-wecom-task.ps1",
  "--task-name", "Codex-XBB-Executive-Analyst-WeCom",
  "--lease-path", "C:\\Users\\EDY\\AppData\\Local\\Codex\\xbb-executive-analyst\\service-lease.json",
  "--stale-seconds", "180",
];

const config = parseArguments(input);
assert.equal(config.taskName, "Codex-XBB-Executive-Analyst-WeCom");
assert.equal(config.staleSeconds, 180);
assert.deepEqual(buildPowerShellArguments(config), [
  "-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden",
  "-ExecutionPolicy", "Bypass", "-File", config.scriptPath,
  "-TaskName", config.taskName, "-LeasePath", config.leasePath,
  "-StaleSeconds", "180",
]);

for (const invalid of [
  [...input.slice(0, -2)],
  [...input.slice(0, -1), "60"],
  input.map((value) => value === "--task-name" ? "--unknown" : value),
  input.map((value) => value.endsWith("watchdog-wecom-task.ps1") ? "D:\\codex\\other.ps1" : value),
  input.map((value) => value.endsWith("powershell.exe") ? "C:\\Windows\\System32\\cmd.exe" : value),
  input.map((value) => value.endsWith("service-lease.json") ? "C:relative\\service-lease.json" : value),
]) {
  assert.throws(() => parseArguments(invalid));
}

let observed;
const spawnImpl = (executable, args, options) => {
  observed = { executable, args, options };
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  queueMicrotask(() => {
    child.stdout.end('{"success":true,"action":"healthy"}\n');
    child.stderr.end();
    child.emit("close", 0, null);
  });
  return child;
};

(async () => {
  const result = await launch(config, { spawnImpl, verifyFiles: false, writeLog: false });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /"action":"healthy"/);
  assert.equal(observed.executable, config.powershellPath);
  assert.deepEqual(observed.args, buildPowerShellArguments(config));
  assert.deepEqual(observed.options, {
    windowsHide: true,
    shell: false,
    detached: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  process.stdout.write(JSON.stringify({ success: true, checks: 18, launcher: "nodew+windowsHide" }) + "\n");
})().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
