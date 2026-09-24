"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "xbb-web-supervisor-"));
  const fixture = path.join(temporary, "worker.js");
  const preload = path.join(temporary, "preload.js");
  fs.writeFileSync(fixture, `
    const fs = require('node:fs');
    const path = require('node:path');
    if (process.argv[2] === 'tunnel') {
      process.stderr.write('https://supervisor-fixture.trycloudflare.com\\n');
      setTimeout(() => process.exit(23), 300);
    } else {
      fs.writeFileSync(path.join(process.env.LOCALAPPDATA, 'worker-started'), String(process.pid));
      process.on('message', (message) => {
        if (message === 'shutdown') {
          fs.writeFileSync(path.join(process.env.LOCALAPPDATA, 'worker-stopped'), 'yes');
          process.exit(0);
        }
      });
      if (process.env.XBB_TEST_FAILURE === 'web') setTimeout(() => process.exit(17), 100);
    }
  `);
  fs.writeFileSync(preload, `
    const cp = require('node:child_process');
    const originalFork = cp.fork;
    const originalSpawn = cp.spawn;
    const fixture = ${JSON.stringify(fixture)};
    cp.fork = (_file, _args, options) => originalFork(fixture, ['web'], { ...options, execArgv: [] });
    cp.spawn = (_file, _args, options) => originalSpawn(process.execPath, [fixture, 'tunnel'], options);
  `);
  try {
    for (const failure of ["web", "tunnel", "manual-stop"]) {
      const localRoot = path.join(temporary, failure);
      const runtimeRoot = path.join(localRoot, "Codex", "xbb-executive-analyst", "web");
      fs.mkdirSync(runtimeRoot, { recursive: true });
      fs.writeFileSync(path.join(runtimeRoot, "config.json"), JSON.stringify({ port: 65534, publicOrigin: "http://127.0.0.1:65534" }));
      const child = spawn(process.execPath, ["--require", preload, path.join(ROOT, "scripts", "web-experience.js"), "supervise",
        ...(failure === "tunnel" ? [] : ["--local"])], {
        cwd: ROOT, windowsHide: true, env: { ...process.env, LOCALAPPDATA: localRoot, XBB_TEST_FAILURE: failure },
        stdio: ["ignore", "pipe", "pipe"]
      });
      let output = "";
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", (chunk) => { output += chunk; });
      let timedOut = false;
      const completed = new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => resolve(code));
      });
      const timeout = setTimeout(() => { timedOut = true; child.kill(); }, 10000);
      try {
        if (failure === "manual-stop") {
          const deadline = Date.now() + 5000;
          while (!fs.existsSync(path.join(localRoot, "worker-started")) && Date.now() < deadline) await delay(20);
          assert.ok(fs.existsSync(path.join(localRoot, "worker-started")), "Worker must start before requesting a normal stop");
          const state = JSON.parse(fs.readFileSync(path.join(runtimeRoot, "runtime.json"), "utf8"));
          fs.writeFileSync(path.join(runtimeRoot, "stop-request.json"), JSON.stringify({ instance: state.instance }));
        }
        const code = await completed;
        assert.equal(timedOut, false, `${failure} supervisor must terminate after cleanup`);
        assert.equal(code, failure === "manual-stop" ? 0 : 1, `${failure} must expose the correct exit to ScheduledTasks: ${output}`);
        const state = JSON.parse(fs.readFileSync(path.join(runtimeRoot, "runtime.json"), "utf8"));
        assert.equal(state.status, failure === "manual-stop" ? "stopped" : "failed");
        const logs = fs.readFileSync(path.join(runtimeRoot, "supervisor.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
        if (failure === "manual-stop") assert.ok(!logs.some((event) => event.status === "failed"));
        else assert.ok(logs.some((event) => event.reason === `${failure}_exited` && event.code === (failure === "web" ? 17 : 23)));
        if (failure !== "web") assert.ok(fs.existsSync(path.join(localRoot, "worker-stopped")), "The web sibling must receive graceful shutdown");
      } finally {
        clearTimeout(timeout);
        if (child.exitCode === null && child.signalCode === null) { child.kill(); await completed; }
      }
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  process.stdout.write(`${JSON.stringify({ success: true, supervisor: "web crash, tunnel crash, sibling cleanup, intentional stop, failure diagnostics" })}\n`);
}

void run().catch((error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
