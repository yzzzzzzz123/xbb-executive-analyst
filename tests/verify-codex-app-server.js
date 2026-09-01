"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AppServerClient } = require("../shared/codex/app-server-client.js");
const { buildAppServerCommand } = require("../shared/codex/app-server-host.js");
const { PersistentCodexAgent, principalKeyFromUserId } = require("../shared/codex/persistent-agent.js");
const { sanitizeCodexEnvironment } = require("../shared/codex/runtime.js");
const { emptyState, loadAgentState, saveAgentState } = require("../shared/codex/state-store.js");

function nextImmediate() {
  return new Promise((resolve) => setImmediate(resolve));
}

class FakeWebSocket extends EventEmitter {
  static OPEN = 1;
  static CLOSED = 3;

  constructor(endpoint, options) {
    super();
    this.endpoint = endpoint;
    this.options = options;
    this.readyState = FakeWebSocket.OPEN;
    this.sent = [];
    FakeWebSocket.instance = this;
    setImmediate(() => this.emit("open"));
  }

  send(raw) {
    const message = JSON.parse(raw);
    this.sent.push(message);
    if (message.method === "initialize") {
      setImmediate(() => this.emit("message", Buffer.from(JSON.stringify({ id: message.id, result: { userAgent: "fake" } })), false));
    }
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    setImmediate(() => this.emit("close"));
  }
}

class FakeAppServerClient extends EventEmitter {
  constructor() {
    super();
    this.connected = false;
    this.startThreadCalls = [];
    this.resumeThreadCalls = [];
    this.startTurnCalls = [];
    this.steerTurnCalls = [];
    this.interruptTurnCalls = [];
    this.responses = [];
    this.turnCounter = 0;
    this.threadCounter = 0;
  }

  async connect() { this.connected = true; }
  async close() { this.connected = false; }
  async startThread(params) {
    this.startThreadCalls.push(params);
    return { thread: { id: `thread-${++this.threadCounter}` } };
  }
  async resumeThread(threadId, params) {
    this.resumeThreadCalls.push({ threadId, params });
    return { thread: { id: threadId, turns: [] } };
  }
  async startTurn(params) {
    const id = `turn-${++this.turnCounter}`;
    this.startTurnCalls.push({ id, params });
    return { turn: { id } };
  }
  async steerTurn(params) {
    this.steerTurnCalls.push(params);
    return {};
  }
  async interruptTurn(threadId, turnId) {
    this.interruptTurnCalls.push({ threadId, turnId });
    return {};
  }
  respond(id, result) { this.responses.push({ id, result }); }
  reject(id, message, code) { this.responses.push({ id, error: { message, code } }); }

  complete(threadId, turnId, text) {
    const item = { type: "agentMessage", id: `item-${turnId}`, text, phase: "final_answer" };
    this.emit("notification", { method: "item/completed", params: { threadId, turnId, item } });
    this.emit("notification", { method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [item] } } });
  }
}

(async () => {
  const verifier = "a".repeat(64);
  const command = buildAppServerCommand({ command: "codex.exe", argsPrefix: [] }, "ws://127.0.0.1:43123", verifier);
  assert.deepEqual(command.args, ["app-server", "--listen", "ws://127.0.0.1:43123", "--ws-auth", "capability-token", "--ws-token-sha256", verifier]);
  assert.equal(command.args.some((value) => value.includes("raw-capability-token")), false);

  const safeEnv = sanitizeCodexEnvironment({ PATH: "safe", LOCALAPPDATA: "local", XBB_WECOM_BOT_SECRET: "do-not-inherit", OPENAI_API_KEY: "do-not-inherit" });
  assert.equal(safeEnv.PATH, "safe");
  assert.equal(Object.hasOwn(safeEnv, "XBB_WECOM_BOT_SECRET"), false);
  assert.equal(Object.hasOwn(safeEnv, "OPENAI_API_KEY"), false);

  const client = new AppServerClient({ endpoint: "ws://127.0.0.1:43123", token: "t".repeat(48), WebSocketImpl: FakeWebSocket });
  await client.connect();
  assert.equal(FakeWebSocket.instance.options.headers.Authorization, `Bearer ${"t".repeat(48)}`);
  assert.equal(FakeWebSocket.instance.sent[0].method, "initialize");
  assert.equal(FakeWebSocket.instance.sent[0].params.capabilities.experimentalApi, true);
  assert.equal(Object.hasOwn(FakeWebSocket.instance.sent[0], "jsonrpc"), false);
  assert.equal(FakeWebSocket.instance.sent[1].method, "initialized");
  let retryNotification = null;
  client.on("serverErrorNotification", (value) => { retryNotification = value; });
  FakeWebSocket.instance.emit("message", Buffer.from(JSON.stringify({ method: "error", params: { willRetry: true, error: { message: "Reconnecting" } } })), false);
  assert.equal(retryNotification.willRetry, true);
  await client.close();

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "xbb-app-server-test-"));
  try {
    const statePath = path.join(tempRoot, "agent-state.json");
    const state = emptyState();
    const testPrincipal = "f".repeat(64);
    state.threads[testPrincipal] = { threadId: "thread-old", contractHash: "contract-old" };
    saveAgentState(statePath, state);
    state.threads[testPrincipal].threadId = "thread-new";
    saveAgentState(statePath, state);
    assert.equal(loadAgentState(statePath).threads[testPrincipal].threadId, "thread-new");
    assert.equal(fs.readdirSync(tempRoot).some((name) => name.includes(".tmp-")), false);

    const fakeClient = new FakeAppServerClient();
    const fakeProcess = new EventEmitter();
    fakeProcess.exitCode = null;
    const fakeHost = { endpoint: "ws://127.0.0.1:43124", token: "h".repeat(48), process: fakeProcess, close: async () => {} };
    const queryCalls = [];
    const config = {
      projectRoot: path.resolve(__dirname, ".."),
      agentStatePath: statePath,
      agentTurnTimeoutMs: 30000,
      codexModel: "gpt-5.6-sol",
      codexReasoningEffort: "medium"
    };
    fs.rmSync(statePath, { force: true });
    const agent = new PersistentCodexAgent(config, {
      hostFactory: { start: async () => fakeHost },
      clientFactory: () => fakeClient,
      verifyLogin: () => ({ mode: "chatgpt" }),
      readVersion: () => "0.151.0",
      queryXbb: async (args, access) => {
        queryCalls.push({ args, access });
        return { status: "ready", facts: { total: 123 } };
      }
    });
    await agent.start();
    assert.equal(fakeClient.connected, true);

    const access = { scope: "all" };
    const principal = principalKeyFromUserId("boss-user", access);
    assert.match(principal, /^[a-f0-9]{64}$/);
    assert.notEqual(principal, principalKeyFromUserId("boss-user", { scope: "companies", companies: ["公司A"] }));

    const greetingPromise = agent.answer({ question: "你好", access, principalKey: principal, messageId: "msg-greeting" });
    await nextImmediate();
    assert.equal(fakeClient.startThreadCalls.length, 1);
    assert.equal(fakeClient.startThreadCalls[0].ephemeral, false);
    assert.equal(fakeClient.startThreadCalls[0].dynamicTools[0].name, "query_xbb");
    assert.equal(fakeClient.startTurnCalls[0].params.input[0].type, "skill");
    assert.deepEqual(fakeClient.startTurnCalls[0].params.sandboxPolicy, { type: "readOnly", networkAccess: false });
    assert.deepEqual(fakeClient.startTurnCalls[0].params.outputSchema.required, ["answer", "chart"]);
    fakeClient.complete("thread-1", "turn-1", JSON.stringify({ answer: "你好，我是销帮帮经营分析助手。你可以直接问经营问题。", chart: null }));
    assert.match((await greetingPromise).answer, /经营分析助手/);
    assert.equal(queryCalls.length, 0);

    const progress = [];
    const businessPromise = agent.answer({ question: "集团9月业绩排名", access, principalKey: principal, messageId: "msg-business", onProgress: async (text) => progress.push(text) });
    await nextImmediate();
    fakeClient.emit("serverRequest", {
      id: 77,
      method: "item/tool/call",
      params: { threadId: "thread-1", turnId: "turn-2", callId: "call-1", namespace: null, tool: "query_xbb", arguments: { months: ["2026-09"], domains: ["performance"] } }
    });
    await nextImmediate();
    assert.equal(queryCalls.length, 1);
    assert.equal(queryCalls[0].access.scope, "all");
    assert.equal(fakeClient.responses[0].id, 77);
    assert.equal(fakeClient.responses[0].result.success, true);
    assert.match(progress.join("\n"), /正在查询销帮帮实时只读数据/);
    fakeClient.complete("thread-1", "turn-2", JSON.stringify({
      answer: "9月集团业绩排名结论（MTD）。",
      chart: { type: "bar", title: "公司排名 13800138000", categories: ["公司A", "公司B"], series: [{ name: "业绩", values: [123, 80] }], items: [], points: [], valueFormat: "money", unit: "", subtitle: "MTD", note: "", centerLabel: "", xLabel: "", yLabel: "", xFormat: "number", yFormat: "number", xUnit: "", yUnit: "" }
    }));
    const businessResult = await businessPromise;
    assert.match(businessResult.answer, /MTD/);
    assert.equal(businessResult.chart.type, "bar");
    assert.doesNotMatch(businessResult.chart.title, /13800138000/);

    const activities = [];
    agent.on("activity", (value) => activities.push(value));
    const first = agent.answer({ question: "继续分析商机", access, principalKey: principal, messageId: "msg-busy-1" });
    await nextImmediate();
    const second = agent.answer({ question: "同时看跟进质量", access, principalKey: principal, messageId: "msg-busy-2" });
    const secondRejection = assert.rejects(second, /仍在处理中/);
    await nextImmediate();
    await secondRejection;
    assert.equal(fakeClient.steerTurnCalls.length, 0);
    assert.equal(activities.some((value) => value.status === "agent_busy"), true);
    fakeClient.complete("thread-1", "turn-3", JSON.stringify({ answer: "商机分析结论。", chart: null }));
    assert.equal((await first).answer, "商机分析结论。");

    await agent.close();
    assert.equal(fakeClient.connected, false);

    const resumedClient = new FakeAppServerClient();
    const resumed = new PersistentCodexAgent(config, {
      hostFactory: { start: async () => fakeHost },
      clientFactory: () => resumedClient,
      verifyLogin: () => ({ mode: "chatgpt" }),
      readVersion: () => "0.151.0",
      queryXbb: async () => ({ status: "ready" })
    });
    await resumed.start();
    assert.equal(resumedClient.resumeThreadCalls.length, 1);
    assert.equal(resumedClient.startThreadCalls.length, 0);
    await resumed.close();

    process.stdout.write(`${JSON.stringify({ success: true, checks: 36, runtime: "persistent-codex-app-server" })}\n`);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
})().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
