"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

if (process.platform !== "win32") throw new Error("Runner encoding verification requires Windows PowerShell.");
const runner = path.resolve(__dirname, "..", "skills", "xbb-executive-analyst", "scripts", "query-xbb.ps1");
const lines = fs.readFileSync(runner, "utf8").split(/\r?\n/);
const stdinStart = lines.findIndex((line) => line === "if ($RequestFromStdin) {");
const boundary = lines.findIndex((line, index) => index > stdinStart && line === "if (-not [string]::IsNullOrWhiteSpace($Date)) {") + 1;
assert.ok(stdinStart > 0 && boundary > stdinStart);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "xbb-runner-utf8-"));
const capture = path.join(directory, "scope.json");
try {
  // Use the real runner under the affected console code page; stop at a debugger
  // boundary before business reads. No credential, HTTP or exporter is invoked.
  const command = `[Console]::InputEncoding=[Text.Encoding]::GetEncoding(936); ` +
    `Set-PSBreakpoint -Script $env:XBB_TEST_RUNNER -Line ${boundary} -Action { ` +
    `[IO.File]::WriteAllText($env:XBB_TEST_CAPTURE,([ordered]@{person=$Person;company=$Company;months=$Month}|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false)); ` +
    `[Environment]::Exit(0) } | Out-Null; & $env:XBB_TEST_RUNNER -OutputPath $env:XBB_TEST_OUTPUT -RequestFromStdin`;
  const scope = { months: ["2026-09"], domains: ["opportunities"], person: "万凯", company: "中文公司（成都）", forceRefresh: false };
  const execute = (input) => spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
    input, encoding: "utf8", windowsHide: true, timeout: 10000,
    env: { ...process.env, XBB_TEST_RUNNER: runner, XBB_TEST_CAPTURE: capture, XBB_TEST_OUTPUT: path.join(directory, "unused.json") }
  });
  const result = execute(Buffer.from(JSON.stringify(scope), "utf8"));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(capture, "utf8")), { person: scope.person, company: scope.company, months: scope.months });
  fs.unlinkSync(capture);
  const invalid = execute(Buffer.from([0xff, 0xfe, 0x80]));
  assert.notEqual(invalid.status, 0, "Malformed UTF-8 must fail before entity lookup");
  assert.equal(fs.existsSync(capture), false);
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
process.stdout.write(`${JSON.stringify({ success: true, encoding: "UTF-8 pipe under GBK Windows console", invalidUtf8Rejected: true })}\n`);
