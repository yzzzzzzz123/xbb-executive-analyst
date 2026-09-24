"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const { createWebServer } = require("../shared/web/server.js");
const { createWebAccess, validateInvitations, digest } = require("../shared/security/web-access.js");
const { customerToolConfig, InvitedWebClient } = require("../shared/codex/invited-web-client.js");

async function run() {
  let now = Date.now();
  const code = crypto.randomBytes(24).toString("hex");
  const invitation = { id: "test-invite", codeHash: digest(code), scope: "all", expiresAt: new Date(now + 86400000).toISOString() };
  assert.throws(() => validateInvitations([{ ...invitation, scope: "companies" }]));
  assert.throws(() => validateInvitations([invitation, invitation]));
  const revoked = [];
  const authorization = createWebAccess({ invitations: [invitation], now: () => now, sessionTtlMs: 1000, onRevoke: (s) => revoked.push(s.id) });
  assert.equal(authorization.login("invalid"), null);
  const authSession = authorization.login(code);
  assert.equal(authSession.access.scope, "all");
  now += 1001;
  assert.equal(authorization.get(authSession.id), null);
  assert.deepEqual(revoked, [authSession.id]);

  const restricted = customerToolConfig({ mcp_servers: { desktop: { command: "secret-command", required: true } }, plugins: { example: { enabled: true } }, apps: { connected: { enabled: true } } });
  assert.equal(restricted["features.shell_tool"], false);
  assert.equal(restricted["features.js_repl"], false);
  assert.equal(restricted["features.view_image"], false);
  assert.equal(restricted["features.plugins"], false);
  assert.equal(restricted.web_search, "disabled");
  assert.deepEqual(restricted.mcp_servers.desktop, { enabled: false, required: false });
  assert.equal(restricted.plugins.example.enabled, false);
  const client = new InvitedWebClient({ endpoint: "ws://127.0.0.1:9999", token: "x".repeat(40), projectRoot: __dirname });
  assert.throws(() => client.restricted({}));
  client.customerConfig = restricted;
  const rpc = [];
  client.request = async (method, params) => { rpc.push({ method, params }); return {}; };
  await client.startThread({ config: { "features.shell_tool": true, "agents.enabled": true } });
  await client.resumeThread("test-thread", { config: { "features.shell_tool": true } });
  for (const item of rpc) { assert.equal(item.params.config["features.shell_tool"], false); assert.equal(item.params.config.mcp_servers.desktop.enabled, false); }
  assert.equal(rpc[0].params.config["agents.enabled"], true);

  const calls = [];
  const pending = [];
  let mode = "normal";
  let ready = true;
  const origin = "https://experience.example";
  const config = { publicOrigin: origin, invitations: [invitation] };
  const agent = { answer(args) {
    calls.push(args); args.onProgress("读取本机 private-path / personal-token 不得透出");
    if (mode === "error") return Promise.reject(new Error("private-path secret-token"));
    if (mode === "pending") return new Promise((resolve) => pending.push({ resolve, args }));
    return Promise.resolve({ answer: "测试答复 <script>bad()</script>", chart: { test: true }, routeMode: "xbb" });
  } };
  const app = createWebServer({ config, agent, now: () => now, isReady: () => ready, renderImage: async () => Buffer.from("test-png") });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  let base = `http://127.0.0.1:${app.server.address().port}`;
  async function request(route, { method = "GET", body, session, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request(base + route, { method, headers: { Host: "experience.example", Origin: origin,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(session ? { Cookie: session.cookie, "X-CSRF-Token": session.csrf } : {}), ...headers } }, (res) => {
        let text = ""; res.on("data", (chunk) => { text += chunk; });
        res.on("end", () => resolve({ status: res.statusCode, headers: { get: (key) => Array.isArray(res.headers[key]) ? res.headers[key].join(", ") : res.headers[key] }, text,
          data: res.headers["content-type"]?.includes("json") ? JSON.parse(text) : null }));
      });
      req.on("error", reject); req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  async function login() {
    const result = await request("/api/login", { method: "POST", body: { code } });
    assert.equal(result.status, 200);
    const cookie = result.headers.get("set-cookie");
    assert.match(cookie, /HttpOnly; SameSite=Strict/); assert.match(cookie, /Secure/);
    return { cookie: cookie.split(";")[0], csrf: result.data.csrf };
  }
  async function submit(session, question = "本月业绩", extra = {}) {
    return request("/api/messages", { method: "POST", session, body: { question, requestId: crypto.randomUUID(), ...extra } });
  }
  async function finished(id, session) {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const result = await request(`/api/jobs/${id}`, { session });
      if (result.data?.status !== "running") return result;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("test job did not finish");
  }
  try {
    const page = await request("/");
    assert.equal(page.status, 200); assert.match(page.text, /访问码/);
    assert.match(page.headers.get("content-security-policy"), /default-src 'none'/);
    assert.equal((await request("/api/session")).status, 401);
    assert.equal((await submit(null)).status, 401); assert.equal(calls.length, 0);
    assert.equal((await request("/", { headers: { Host: "attacker.example" } })).status, 403);
    assert.equal((await request("/api/login", { method: "POST", body: { code }, headers: { Origin: "https://attacker.example" } })).status, 403);
    assert.equal((await request("/api/login", { method: "POST", body: { code: "invalid" } })).status, 401);
    assert.equal((await request("/?code=secret")).status, 400);
    assert.equal((await request("/../../package.json")).status, 401);
    const a = await login(); const b = await login();
    assert.notEqual(a.cookie, b.cookie); assert.notEqual(a.csrf, b.csrf);
    assert.equal((await request("/api/messages", { method: "POST", session: a, body: { question: "test", requestId: crypto.randomUUID() }, headers: { "X-CSRF-Token": "wrong" } })).status, 403);
    assert.equal((await submit(a, "提问", { access: { scope: "all" }, principalKey: "forged" })).status, 400);
    assert.equal((await submit(a, "x".repeat(4001))).status, 400);
    assert.equal((await submit(a, "x".repeat(22000))).status, 413);
    assert.equal(calls.length, 0);
    const requestId = crypto.randomUUID();
    const first = await submit(a, "本月业绩", { requestId }); assert.equal(first.status, 202);
    const duplicate = await submit(a, "本月业绩", { requestId }); assert.equal(duplicate.data.id, first.data.id); assert.equal(calls.length, 1);
    const result = await finished(first.data.id, a); assert.equal(result.data.status, "done"); assert.ok(result.data.answer);
    assert.equal((await request(`/api/jobs/${first.data.id}`, { session: b })).status, 404);
    assert.equal((await request(result.data.chartUrl, { session: b })).status, 404);
    assert.equal((await request(result.data.chartUrl)).status, 401);
    assert.equal((await request(result.data.chartUrl, { session: a })).text, "test-png");
    assert.equal((await request(result.data.chartUrl, { session: a })).headers.get("cache-control"), "no-store");
    await submit(b);
    assert.notEqual(calls[0].principalKey, calls[1].principalKey);
    assert.match(calls[0].access.userId, /^web:/); assert.equal(calls[0].access.scope, "all");
    assert.match(calls[0].principalKey, /^[a-f0-9]{64}$/);
    mode = "pending";
    const running = await submit(a);
    assert.equal((await submit(a)).status, 409);
    const progress = await request(`/api/jobs/${running.data.id}`, { session: a });
    assert.doesNotMatch(progress.text, /private-path|personal-token/);
    assert.equal((await request(`/api/jobs/${running.data.id}/cancel`, { method: "POST", body: {}, session: b })).status, 404);
    await request(`/api/jobs/${running.data.id}/cancel`, { method: "POST", body: {}, session: a });
    const cancelled = await finished(running.data.id, a); assert.equal(cancelled.data.status, "cancelled");
    assert.equal(pending[0].args.signal.aborted, true);
    pending[0].resolve({ answer: "late private answer", chart: null });
    assert.equal((await request(`/api/jobs/${running.data.id}`, { session: a })).data.answer, null);
    const replaced = await submit(b);
    await request("/api/reset", { method: "POST", body: {}, session: b });
    assert.equal(pending[1].args.signal.aborted, true);
    assert.equal((await request(`/api/jobs/${replaced.data.id}`, { session: b })).status, 404);
    mode = "error";
    const errorJob = await submit(b);
    const failed = await finished(errorJob.data.id, b); assert.equal(failed.data.status, "error"); assert.doesNotMatch(failed.text, /private-path|secret-token/);
    assert.notEqual(calls[1].principalKey, calls.at(-1).principalKey);
    ready = false;
    assert.equal((await submit(b)).status, 503);
    ready = true;
    const beforeRevokedBody = calls.length;
    let finishBody;
    const revokedBody = new Promise((resolve, reject) => {
      const req = http.request(base + "/api/messages", { method: "POST", headers: { Host: "experience.example", Origin: origin,
        "Content-Type": "application/json", Cookie: a.cookie, "X-CSRF-Token": a.csrf } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
      req.on("error", reject);
      const body = JSON.stringify({ question: "revoked while uploading", requestId: crypto.randomUUID() });
      req.write(body.slice(0, 5)); finishBody = () => req.end(body.slice(5));
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await request("/api/logout", { method: "POST", body: {}, session: a });
    finishBody();
    assert.equal(await revokedBody, 401);
    assert.equal(calls.length, beforeRevokedBody, "Revoked requests must not enter the model after body upload");
    assert.equal((await request("/api/session", { session: a })).status, 401);
    invitation.disabled = true;
    assert.equal((await request("/api/session", { session: b })).status, 401);
    assert.equal((await request("/api/login", { method: "POST", body: { code } })).status, 401);
  } finally { await app.close(); }
  let deadlineSignal;
  const deadlineApp = createWebServer({ config: { ...config, invitations: [{ ...invitation, disabled: false }] },
    agent: { answer(args) { deadlineSignal = args.signal; return new Promise(() => {}); } }, requestTimeoutMs: 25 });
  await new Promise((resolve) => deadlineApp.server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${deadlineApp.server.address().port}`;
  try {
    const session = await login();
    const started = await submit(session);
    const timeout = await finished(started.data.id, session);
    assert.equal(timeout.data.status, "error"); assert.match(timeout.data.error, /超时/);
    assert.equal(deadlineSignal.aborted, true);
  } finally { await deadlineApp.close(); }
  process.stdout.write(`${JSON.stringify({ success: true, web: "auth, scope, isolation, CSRF, chart ownership, cancellation, deadlines, native tool restrictions" })}\n`);
}

void run().catch((error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
