"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const MAX_CAPTURE_BYTES = 16 * 1024;
const MAX_LOG_BYTES = 256 * 1024;
const TASK_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const WATCHDOG_SUFFIX = "\\scripts\\watchdog-wecom-task.ps1";

function fail(message) {
  const error = new Error(message);
  error.code = "INVALID_WATCHDOG_LAUNCH";
  throw error;
}

function normalizeAbsoluteWindowsPath(value, label) {
  if (typeof value !== "string" || value.trim() !== value || !path.win32.isAbsolute(value)) {
    fail(`${label} must be a fully-qualified Windows path`);
  }
  const normalized = path.win32.normalize(value);
  if (!/^(?:[A-Za-z]:\\|\\\\[^\\]+\\[^\\]+)/.test(normalized)) {
    fail(`${label} must be a drive-absolute or UNC path`);
  }
  return normalized;
}

function parseArguments(argv) {
  const values = new Map();
  const allowed = new Set(["--powershell", "--script", "--task-name", "--lease-path", "--stale-seconds"]);
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(option) || value === undefined || values.has(option)) {
      fail("watchdog launcher arguments are incomplete, duplicated, or unsupported");
    }
    values.set(option, value);
  }
  if (values.size !== allowed.size || argv.length !== allowed.size * 2) {
    fail("watchdog launcher requires exactly five option/value pairs");
  }

  const powershellPath = normalizeAbsoluteWindowsPath(values.get("--powershell"), "PowerShell path");
  if (!/^(?:powershell|pwsh)\.exe$/i.test(path.win32.basename(powershellPath))) {
    fail("PowerShell executable name is not allowed");
  }
  const scriptPath = normalizeAbsoluteWindowsPath(values.get("--script"), "watchdog script path");
  if (!scriptPath.toLowerCase().endsWith(WATCHDOG_SUFFIX)) {
    fail("watchdog script path does not match the product entry");
  }
  const leasePath = normalizeAbsoluteWindowsPath(values.get("--lease-path"), "lease path");
  const taskName = values.get("--task-name");
  if (!TASK_NAME_PATTERN.test(taskName || "")) fail("task name is invalid");
  if (values.get("--stale-seconds") !== "180") fail("stale threshold must remain 180 seconds");

  return { powershellPath, scriptPath, taskName, leasePath, staleSeconds: 180 };
}

function assertRuntimeFiles(config) {
  for (const [label, filePath] of [["PowerShell executable", config.powershellPath], ["watchdog script", config.scriptPath]]) {
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      fail(`${label} does not exist`);
    }
    if (!stat.isFile()) fail(`${label} is not a file`);
  }
}

function buildPowerShellArguments(config) {
  return [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-WindowStyle",
    "Hidden",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    config.scriptPath,
    "-TaskName",
    config.taskName,
    "-LeasePath",
    config.leasePath,
    "-StaleSeconds",
    String(config.staleSeconds),
  ];
}

function appendBounded(buffer, chunk) {
  const combined = Buffer.concat([buffer, Buffer.from(chunk)]);
  return combined.length <= MAX_CAPTURE_BYTES ? combined : combined.subarray(combined.length - MAX_CAPTURE_BYTES);
}

function writeResultLog(config, result) {
  const logPath = path.win32.join(path.win32.dirname(config.leasePath), "watchdog-status.jsonl");
  try {
    if (fs.existsSync(logPath) && fs.statSync(logPath).size >= MAX_LOG_BYTES) {
      const previous = `${logPath}.1`;
      fs.rmSync(previous, { force: true });
      fs.renameSync(logPath, previous);
    }
    fs.appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), ...result })}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {
    // Task Scheduler still receives the child exit code if diagnostic logging is unavailable.
  }
}

function launch(config, options = {}) {
  const spawnImpl = options.spawnImpl || spawn;
  const verifyFiles = options.verifyFiles !== false;
  if (verifyFiles) assertRuntimeFiles(config);
  const child = spawnImpl(config.powershellPath, buildPowerShellArguments(config), {
    windowsHide: true,
    shell: false,
    detached: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  if (child.stdout) child.stdout.on("data", (chunk) => { stdout = appendBounded(stdout, chunk); });
  if (child.stderr) child.stderr.on("data", (chunk) => { stderr = appendBounded(stderr, chunk); });

  return new Promise((resolve) => {
    let settled = false;
    const finish = (exitCode, signal, launchError = "") => {
      if (settled) return;
      settled = true;
      const result = {
        exitCode,
        signal: signal || "",
        launchError,
        stdout: stdout.toString("utf8").trim(),
        stderr: stderr.toString("utf8").trim(),
      };
      if (options.writeLog !== false) writeResultLog(config, result);
      resolve(result);
    };
    child.once("error", (error) => finish(1, "", error && error.message ? error.message : "spawn failed"));
    child.once("close", (code, signal) => finish(Number.isInteger(code) ? code : 1, signal));
  });
}

async function main(argv = process.argv.slice(2)) {
  if (process.platform !== "win32") fail("watchdog launcher only supports Windows");
  const config = parseArguments(argv);
  const result = await launch(config);
  process.exitCode = result.exitCode;
}

if (require.main === module) {
  main().catch((error) => {
    try {
      const fallbackLeaseIndex = process.argv.indexOf("--lease-path");
      if (fallbackLeaseIndex >= 0 && process.argv[fallbackLeaseIndex + 1]) {
        const leasePath = normalizeAbsoluteWindowsPath(process.argv[fallbackLeaseIndex + 1], "lease path");
        writeResultLog({ leasePath }, { exitCode: 1, signal: "", launchError: error.message, stdout: "", stderr: "" });
      }
    } catch {}
    process.exitCode = 1;
  });
}

module.exports = {
  buildPowerShellArguments,
  launch,
  normalizeAbsoluteWindowsPath,
  parseArguments,
};
