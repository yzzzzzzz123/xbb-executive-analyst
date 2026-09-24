"use strict";

// Local operator commands; no management endpoint is exposed through the tunnel.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const http = require("node:http");
const { spawn, fork } = require("node:child_process");
const { defaultLocalRoot, requireOutsideProject } = require("../shared/config.js");
const { digest } = require("../shared/security/web-access.js");

const ROOT = path.resolve(__dirname, "..");
const DIRECTORY = requireOutsideProject(path.join(defaultLocalRoot(), "web"), "网页运行目录");
const CONFIG = path.join(DIRECTORY, "config.json");
const STATE = path.join(DIRECTORY, "runtime.json");
const STOP = path.join(DIRECTORY, "stop-request.json");
const TUNNEL = path.join(DIRECTORY, "bin", "cloudflared.exe");
const TUNNEL_SHA256 = "2837888cc0f5d58f15b6dc478376de90b4d3ba5241c7947455d1e0a0df429712";
const TUNNEL_DOWNLOAD = "https://github.com/cloudflare/cloudflared/releases/download/2026.9.1/cloudflared-windows-amd64.exe";
const SUPERVISOR_LOG = path.join(DIRECTORY, "supervisor.jsonl");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function read(file) { try { return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")); } catch { return null; } }
function write(file, value) { const temp = `${file}.${process.pid}.tmp`; fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 }); fs.renameSync(temp, file); }
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
function exited(child) { return !child || child.exitCode !== null || child.signalCode !== null; }
function logStatus(value) {
  try {
    if (fs.existsSync(SUPERVISOR_LOG) && fs.statSync(SUPERVISOR_LOG).size > 512 * 1024) fs.renameSync(SUPERVISOR_LOG, `${SUPERVISOR_LOG}.1`);
    fs.appendFileSync(SUPERVISOR_LOG, `${JSON.stringify({ at: new Date().toISOString(), ...value })}\n`, { mode: 0o600 });
  } catch { /* Diagnostics must not prevent shutdown or task recovery. */ }
}
function health(state) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port: state.port, path: "/api/health", headers: { Host: new URL(state.publicOrigin).host }, timeout: 2500 }, (res) => {
      let text = ""; res.on("data", (b) => { if (text.length < 1000) text += b; });
      res.on("end", () => { try { resolve(res.statusCode === 200 && JSON.parse(text).ready === true); } catch { resolve(false); } });
    });
    req.on("timeout", () => req.destroy()); req.on("error", () => resolve(false));
  });
}

async function installTunnel() {
  if (fs.existsSync(TUNNEL) && digest(fs.readFileSync(TUNNEL)) === TUNNEL_SHA256) return;
  fs.mkdirSync(path.dirname(TUNNEL), { recursive: true, mode: 0o700 });
  process.stdout.write("正在下载并校验 Cloudflare 临时入口组件…\n");
  const response = await fetch(TUNNEL_DOWNLOAD, { signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw new Error("临时入口组件下载失败。");
  const buffer = Buffer.from(await response.arrayBuffer());
  if (digest(buffer) !== TUNNEL_SHA256) throw new Error("临时入口组件校验失败。");
  fs.writeFileSync(TUNNEL, buffer);
}

async function supervise() {
  const config = read(CONFIG);
  if (!config) throw new Error("网页配置不存在。");
  const state = { instance: crypto.randomUUID(), pid: process.pid, port: config.port, publicOrigin: config.publicOrigin, status: "starting", startedAt: new Date().toISOString() };
  write(STATE, state);
  let stopping = false;
  let web;
  let tunnel;
  let interval;
  let hardStop;
  const stop = async (status = "stopped") => {
    if (stopping) return;
    stopping = true; clearInterval(interval);
    // ScheduledTasks retries only nonzero exits. A cleaned-up failure is still
    // a failure; previously this path returned 0 and left the site offline.
    process.exitCode = status === "failed" ? 1 : 0;
    hardStop = setTimeout(() => { web?.kill(); tunnel?.kill(); state.status = status; write(STATE, state); process.exit(status === "failed" ? 1 : 0); }, 20000);
    try { if (web?.connected) web.send("shutdown"); } catch {}
    if (!exited(tunnel)) tunnel.kill();
    if (!exited(web)) await new Promise((resolve) => web.once("exit", resolve));
    clearTimeout(hardStop); state.status = status; write(STATE, state);
    logStatus({ status, instance: state.instance });
  };
  const failed = (reason, code = null, signal = null) => {
    if (stopping) return;
    logStatus({ status: "failed", instance: state.instance, reason, code, signal });
    void stop("failed");
  };
  process.on("SIGINT", () => void stop()); process.on("SIGTERM", () => void stop());
  interval = setInterval(() => { if (read(STOP)?.instance === state.instance) void stop(); }, 1000);
  try {
    if (!process.argv.includes("--local")) {
      tunnel = spawn(TUNNEL, ["tunnel", "--no-autoupdate", "--protocol", "http2", "--url", `http://127.0.0.1:${config.port}`], {
        cwd: DIRECTORY, windowsHide: true, stdio: ["ignore", "ignore", "pipe"]
      });
      const origin = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("临时外网入口连接超时。")), 60000);
        let tail = "";
        tunnel.once("error", () => { clearTimeout(timer); reject(new Error("临时入口无法启动。")); });
        tunnel.once("exit", () => { clearTimeout(timer); reject(new Error("临时入口已退出。")); });
        tunnel.stderr.on("data", (buffer) => {
          tail = (tail + buffer.toString()).slice(-8000);
          const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(tail);
          if (match) { clearTimeout(timer); resolve(match[0]); }
        });
      });
      config.publicOrigin = origin; write(CONFIG, config); state.publicOrigin = origin; write(STATE, state);
      tunnel.on("exit", (code, signal) => failed("tunnel_exited", code, signal));
    }
    const log = fs.openSync(path.join(DIRECTORY, "service.log"), "a", 0o600);
    web = fork(path.join(ROOT, "shared", "web", "server.js"), [], {
      cwd: ROOT, windowsHide: true, env: { ...process.env, XBB_WEB_CONFIG_PATH: CONFIG }, stdio: ["ignore", log, log, "ipc"]
    });
    fs.closeSync(log);
    web.once("error", () => failed("web_spawn_failed"));
    web.once("exit", (code, signal) => failed("web_exited", code, signal));
    const deadline = Date.now() + 125000;
    while (!stopping && Date.now() < deadline) {
      if (await health(state)) {
        if (stopping) return;
        state.status = "ready"; write(STATE, state);
        logStatus({ status: "ready", instance: state.instance });
        return;
      }
      await delay(1000);
    }
    if (!stopping) { logStatus({ status: "failed", instance: state.instance, reason: "startup_timeout" }); await stop("failed"); }
  } catch { logStatus({ status: "failed", instance: state.instance, reason: "startup_failed" }); await stop("failed"); }
}

async function main() {
  if (process.platform !== "win32") throw new Error("体验服务需要在已有模型登录和只读凭据的 Windows 用户下运行。");
  const action = process.argv[2] || "status";
  fs.mkdirSync(DIRECTORY, { recursive: true, mode: 0o700 });
  if (action === "supervise") { await supervise(); return; }
  const existing = read(STATE);
  if (action === "status") {
    process.stdout.write(`${JSON.stringify(existing ? { ...existing, ready: await health(existing) } : { status: "not_started" })}\n`); return;
  }
  if (action === "stop") {
    if (!existing || !alive(existing.pid) || ["stopped", "failed"].includes(existing.status)) { process.stdout.write("体验服务已停止。\n"); return; }
    write(STOP, { instance: existing.instance });
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) { if (!alive(existing.pid) || ["stopped", "failed"].includes(read(STATE)?.status)) { process.stdout.write("体验服务与外网入口已停止。\n"); return; } await delay(500); }
    throw new Error("停止请求已发出，服务仍在清理本轮查询，请用 web:status 确认。");
  }
  if (!["start", "local"].includes(action)) throw new Error("支持 start、local、status、stop。");
  if (existing && alive(existing.pid) && !["stopped", "failed"].includes(existing.status)) {
    process.stdout.write(`${JSON.stringify({ status: existing.status, url: existing.publicOrigin, note: "服务已启动。访问码仅首次启动时显示；重启会生成新码。" })}\n`); return;
  }
  if (action === "start") await installTunnel();
  const code = `XBB-${crypto.randomBytes(15).toString("hex").match(/.{1,5}/g).join("-")}`;
  const config = { schemaVersion: "1.0", port: 8091, publicOrigin: "http://127.0.0.1:8091",
    invitations: [{ id: "invited-customers", codeHash: digest(code), scope: "all", expiresAt: new Date(Date.now() + 7 * 86400000).toISOString() }] };
  write(CONFIG, config);
  const supervisor = spawn(process.execPath, [__filename, "supervise", ...(action === "local" ? ["--local"] : [])], {
    cwd: ROOT, windowsHide: true, detached: true, stdio: "ignore"
  });
  supervisor.unref();
  process.stdout.write("正在连接模型与体验入口…\n");
  const deadline = Date.now() + 200000;
  while (Date.now() < deadline) {
    const state = read(STATE);
    if (state?.pid === supervisor.pid && state.status === "ready") {
      process.stdout.write(`${JSON.stringify({ url: state.publicOrigin, accessCode: code, expiresAt: config.invitations[0].expiresAt, scope: "集团全部公司只读", stop: "npm run web:stop" }, null, 2)}\n`); return;
    }
    if (state?.pid === supervisor.pid && state.status === "failed") throw new Error("体验服务启动失败，请查看仓库外的 web/service.log。");
    await delay(1000);
  }
  const state = read(STATE);
  if (state?.pid === supervisor.pid) write(STOP, { instance: state.instance });
  throw new Error("启动超时，已请求停止本次入口。");
}

if (require.main === module) void main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
