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
    return { turnId: params.expectedTurnId };
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
      generalTurnTimeoutMs: 900000,
      codexModel: "gpt-5.6-sol",
      codexReasoningEffort: "medium"
    };
    const readyPerformancePack = (month = "2026-09", total = 123) => ({
      status: "ready",
      scope: { month, domains: ["performance"] },
      provenance: { live: true, readOnly: true, dataSource: "xbb-openapi", telephoneFieldsExported: false, credentialFieldsExported: false },
      facts: {
        performance: {
          summary: { total, course: total, consulting: 0, other: 0, courseShare: 100, consultingShare: 0, otherShare: 0 },
          ranking: [{ company: "公司A", total, course: total, consulting: 0, other: 0 }]
        }
      },
      limitations: [],
      integrity: { algorithm: "sha256", factPackSha256: "b".repeat(64) }
    });
    const isolatedAgent = (label, isolatedClient, options = {}) => {
      const isolatedProcess = new EventEmitter();
      isolatedProcess.exitCode = null;
      const isolatedHost = { endpoint: "ws://127.0.0.1:43125", token: "i".repeat(48), process: isolatedProcess, close: async () => {} };
      return new PersistentCodexAgent({
        ...config,
        agentStatePath: path.join(tempRoot, `${label}-state.json`),
        ...(options.config || {})
      }, {
        hostFactory: { start: async () => isolatedHost },
        clientFactory: () => isolatedClient,
        verifyLogin: () => ({ mode: "chatgpt" }),
        readVersion: () => "0.151.0",
        queryXbb: options.queryXbb || (async () => readyPerformancePack())
      });
    };
    fs.rmSync(statePath, { force: true });
    const agent = new PersistentCodexAgent(config, {
      hostFactory: { start: async () => fakeHost },
      clientFactory: () => fakeClient,
      verifyLogin: () => ({ mode: "chatgpt" }),
      readVersion: () => "0.151.0",
      queryXbb: async (args, access, invocation = {}) => {
        queryCalls.push({ args, access });
        await invocation.onProgress?.({ stage: "month_started", month: "2026-09", index: 1, completed: 0, total: 1 });
        await invocation.onProgress?.({ stage: "query_ready", completed: 1, total: 1 });
        return {
          status: "ready",
          scope: { month: "2026-09", domains: ["performance"] },
          provenance: { live: true, readOnly: true, dataSource: "xbb-openapi", telephoneFieldsExported: false, credentialFieldsExported: false },
          facts: {
            performance: {
              summary: { total: 123, course: 80, consulting: 40, other: 3, courseShare: 65.04, consultingShare: 32.52, otherShare: 2.44 },
              ranking: [{ company: "公司A", total: 123, course: 80, consulting: 40, other: 3 }]
            }
          },
          limitations: [],
          integrity: { algorithm: "sha256", factPackSha256: "b".repeat(64) }
        };
      }
    });
    await agent.start();
    assert.equal(fakeClient.connected, true);

    const access = { scope: "all" };
    const principal = principalKeyFromUserId("boss-user", access);
    assert.match(principal, /^[a-f0-9]{64}$/);
    assert.notEqual(principal, principalKeyFromUserId("boss-user", { scope: "companies", companies: ["公司A"] }));
    assert.notEqual(
      principalKeyFromUserId("boss-user", { scope: "companies", companies: ["甲", "乙"] }),
      principalKeyFromUserId("boss-user", { scope: "companies", companies: ["甲、乙"] })
    );
    assert.equal(
      principalKeyFromUserId("boss-user", { scope: "companies", companies: ["甲", "乙"] }),
      principalKeyFromUserId("boss-user", { scope: "companies", companies: ["乙", "甲"] })
    );

    const warmPromise = agent.warm({ access, principalKey: principal });
    await nextImmediate();
    assert.equal(fakeClient.startThreadCalls.length, 1);
    assert.equal(fakeClient.startTurnCalls[0].params.effort, "none");
    assert.match(fakeClient.startTurnCalls[0].params.input[0].text, /后台缓存预热/);
    assert.equal(queryCalls.length, 0);
    assert.equal(loadAgentState(statePath).threads[principal].turnInProgress, true);
    fakeClient.complete("thread-1", "turn-1", JSON.stringify({ answer: "ready", chart: null }));
    const ragStats = await warmPromise;
    assert.equal(ragStats.sources, 7);
    assert.equal(fakeClient.startTurnCalls[0].params.input.length, 3);
    assert.equal(fakeClient.startTurnCalls[0].params.input[2].name, "xbb-executive-chart");
    assert.equal(ragStats.principals, 1);
    assert.equal(loadAgentState(statePath).threads[principal].lastMode, null);
    assert.equal(loadAgentState(statePath).threads[principal].lastModeSource, null);
    assert.equal(loadAgentState(statePath).threads[principal].turnInProgress, false);

    const greetingPromise = agent.answer({ question: "你好", access, principalKey: principal, messageId: "msg-greeting" });
    await nextImmediate();
    assert.equal(fakeClient.startThreadCalls.length, 1);
    assert.equal(fakeClient.startThreadCalls[0].ephemeral, false);
    assert.equal(fakeClient.startThreadCalls[0].dynamicTools[0].name, "query_xbb");
    assert.equal(fakeClient.startTurnCalls[1].params.input.length, 1);
    assert.equal(fakeClient.startTurnCalls[1].params.input[0].type, "text");
    assert.match(fakeClient.startTurnCalls[1].params.input[0].text, /能力路由】通用 Codex/);
    assert.doesNotMatch(fakeClient.startTurnCalls[1].params.input[0].text, /销帮帮 Skill RAG 适用规则/);
    assert.equal(fakeClient.startTurnCalls[1].params.effort, "medium");
    assert.deepEqual(fakeClient.startTurnCalls[1].params.sandboxPolicy, { type: "readOnly", networkAccess: true });
    assert.deepEqual(fakeClient.startTurnCalls[1].params.outputSchema.required, ["answer", "chart"]);
    assert.equal(fakeClient.startTurnCalls[1].params.outputSchema.properties.chart.type, "null");
    assert.equal(Object.hasOwn(fakeClient.startTurnCalls[1].params.outputSchema.properties.chart, "anyOf"), false);
    assert.match(fakeClient.startTurnCalls[1].params.input[0].text, /chart 固定为 null/);
    assert.equal(agent.sessions.get(principal).active.timeoutMs, 900000);
    assert.equal(agent.sessions.get(principal).active.totalTimeoutMs, 900000);
    assert.ok(agent.sessions.get(principal).active.absoluteTimeout);
    assert.equal(loadAgentState(statePath).threads[principal].turnInProgress, true);
    fakeClient.emit("serverRequest", {
      id: 76,
      method: "item/tool/call",
      params: { threadId: "thread-1", turnId: "turn-2", callId: "call-general", namespace: null, tool: "query_xbb", arguments: { months: ["2026-09"], domains: ["performance"] } }
    });
    await nextImmediate();
    assert.equal(fakeClient.responses[0].id, 76);
    assert.equal(fakeClient.responses[0].result.success, false);
    assert.match(fakeClient.responses[0].result.contentItems[0].text, /不是销帮帮经营问题/);
    assert.equal(queryCalls.length, 0);
    fakeClient.complete("thread-1", "turn-2", JSON.stringify({ answer: "你好，我是通用 Codex 助手，也可以查询销帮帮经营数据。", chart: null }));
    const greetingResult = await greetingPromise;
    assert.match(greetingResult.answer, /通用 Codex/);
    assert.equal(greetingResult.routeMode, "general");
    assert.equal(queryCalls.length, 0);
    assert.equal(loadAgentState(statePath).threads[principal].lastMode, "general");
    assert.equal(loadAgentState(statePath).threads[principal].lastModeSource, "user");
    assert.equal(loadAgentState(statePath).threads[principal].turnInProgress, false);

    const progress = [];
    const businessPromise = agent.answer({ question: "集团9月业绩排名", access, principalKey: principal, messageId: "msg-business", onProgress: async (text) => progress.push(text) });
    await nextImmediate();
    assert.equal(queryCalls.length, 1);
    assert.deepEqual(queryCalls[0].args, { months: ["2026-09"], domains: ["performance"] });
    assert.equal(queryCalls[0].access.scope, "all");
    assert.equal(fakeClient.startTurnCalls[2].params.input.length, 3);
    assert.equal(fakeClient.startTurnCalls[2].params.input[1].type, "skill");
    assert.equal(fakeClient.startTurnCalls[2].params.input[1].name, "xbb-executive-analyst");
    assert.match(fakeClient.startTurnCalls[2].params.input[1].path, /skills[\\/]xbb-executive-analyst[\\/]SKILL\.md$/);
    assert.equal(fakeClient.startTurnCalls[2].params.input[2].type, "skill");
    assert.equal(fakeClient.startTurnCalls[2].params.input[2].name, "xbb-executive-chart");
    assert.match(fakeClient.startTurnCalls[2].params.input[2].path, /skills[\\/]xbb-executive-chart[\\/]SKILL\.md$/);
    assert.match(fakeClient.startTurnCalls[2].params.input[0].text, /\$xbb-executive-analyst/);
    assert.match(fakeClient.startTurnCalls[2].params.input[0].text, /\$xbb-executive-chart/);
    assert.match(fakeClient.startTurnCalls[2].params.input[0].text, /销帮帮 Skill RAG 适用规则/);
    assert.match(fakeClient.startTurnCalls[2].params.input[0].text, /本轮 query_xbb 实时预取事实包/);
    assert.equal(fakeClient.startTurnCalls[2].params.effort, "none");
    assert.deepEqual(fakeClient.startTurnCalls[2].params.sandboxPolicy, { type: "readOnly", networkAccess: false });
    assert.equal(fakeClient.startTurnCalls[2].params.outputSchema.properties.chart.anyOf.length, 7);
    assert.match(fakeClient.startTurnCalls[2].params.input[0].text, /业绩与收入结构/);
    assert.equal(agent.sessions.get(principal).active.timeoutMs, 30000);
    assert.equal(agent.sessions.get(principal).active.totalTimeoutMs, 20 * 60 * 1000, "业务生成预算与端到端绝对预算必须分离");
    assert.ok(agent.sessions.get(principal).active.absoluteTimeout);
    fakeClient.emit("serverRequest", {
      id: 77,
      method: "item/tool/call",
      params: { threadId: "thread-1", turnId: "turn-3", callId: "call-1", namespace: null, tool: "query_xbb", arguments: { months: ["2026-09"], domains: ["performance"] } }
    });
    await nextImmediate();
    assert.equal(queryCalls.length, 1);
    assert.equal(fakeClient.responses[1].id, 77);
    assert.equal(fakeClient.responses[1].result.success, true);
    const reusedPrefetch = JSON.parse(fakeClient.responses[1].result.contentItems[0].text);
    assert.equal(reusedPrefetch.reusedPrefetch, true);
    assert.ok(Buffer.byteLength(fakeClient.responses[1].result.contentItems[0].text, "utf8") < 512);
    assert.doesNotMatch(fakeClient.responses[1].result.contentItems[0].text, /"ranking"/);
    assert.match(progress.join("\n"), /正在分析：2026年9月/);
    assert.match(progress.join("\n"), /已完成 0\/1/);
    assert.match(progress.join("\n"), /数据已就绪/);
    fakeClient.complete("thread-1", "turn-3", JSON.stringify({
      answer: "9月集团业绩排名结论（MTD）。",
      chart: { type: "bar", title: "公司排名 13800138000", subtitle: "MTD", insight: "公司A业绩高于公司B", note: "", valueFormat: "money", unit: "", categories: ["公司A", "公司B"], series: [{ name: "业绩", values: [123, 80] }] }
    }));
    const businessResult = await businessPromise;
    assert.match(businessResult.answer, /MTD/);
    assert.equal(businessResult.routeMode, "xbb");
    assert.equal(businessResult.chart.type, "bar");
    assert.doesNotMatch(businessResult.chart.title, /13800138000/);

    const followUpPromise = agent.answer({ question: "1", access, principalKey: principal, messageId: "msg-business-follow-up" });
    await nextImmediate();
    assert.equal(fakeClient.startTurnCalls[3].params.input[1].type, "skill");
    assert.equal(fakeClient.startTurnCalls[3].params.input[2].name, "xbb-executive-chart");
    assert.match(fakeClient.startTurnCalls[3].params.input[0].text, /能力路由】销帮帮经营 Skill/);
    fakeClient.complete("thread-1", "turn-4", JSON.stringify({ answer: "继续解释上一条经营结论。", chart: null }));
    assert.match((await followUpPromise).answer, /经营结论/);

    const activities = [];
    agent.on("activity", (value) => activities.push(value));
    const first = agent.answer({ question: "继续分析商机", access, principalKey: principal, messageId: "msg-busy-1" });
    await nextImmediate();
    assert.equal(fakeClient.startTurnCalls[4].params.effort, "medium");
    const second = agent.answer({ question: "真实的说", access, principalKey: principal, messageId: "msg-follow-up-1" });
    await nextImmediate();
    assert.equal(fakeClient.steerTurnCalls.length, 1);
    assert.equal(fakeClient.steerTurnCalls[0].threadId, "thread-1");
    assert.equal(fakeClient.steerTurnCalls[0].expectedTurnId, "turn-5");
    assert.match(fakeClient.steerTurnCalls[0].input[0].text, /真实的说/);
    assert.match(fakeClient.steerTurnCalls[0].input[0].text, /最新要求/);
    assert.match((await first).answer, /最新一条消息/);
    const third = agent.answer({ question: "只看风险", access, principalKey: principal, messageId: "msg-follow-up-2" });
    await nextImmediate();
    assert.equal(fakeClient.steerTurnCalls.length, 2);
    assert.equal(fakeClient.steerTurnCalls[1].expectedTurnId, "turn-5");
    assert.match((await second).answer, /最新一条消息/);
    assert.equal(activities.filter((value) => value.status === "turn_steered").length, 2);
    assert.equal(activities.some((value) => value.status === "agent_busy"), false);
    assert.equal(fakeClient.startTurnCalls.length, 5);
    fakeClient.complete("thread-1", "turn-5", JSON.stringify({ answer: "商机风险分析结论，已按最新要求直说。", chart: null }));
    assert.match((await third).answer, /按最新要求直说/);

    const general = agent.answer({ question: "帮我写会议通知", access, principalKey: principal, messageId: "msg-general-before-queue" });
    await nextImmediate();
    assert.equal(fakeClient.startTurnCalls.length, 6);
    assert.match(fakeClient.startTurnCalls[5].params.input[0].text, /能力路由】通用 Codex/);
    const queuedProgress = [];
    const queuedBusiness = agent.answer({
      question: "集团9月业绩排名",
      access,
      principalKey: principal,
      messageId: "msg-queued-business",
      onProgress: async (text) => queuedProgress.push(text)
    });
    await nextImmediate();
    assert.equal(fakeClient.startTurnCalls.length, 6);
    assert.match(queuedProgress.join("\n"), /不同范围/);
    assert.equal(activities.some((value) => value.status === "turn_queued"), true);
    fakeClient.complete("thread-1", "turn-6", JSON.stringify({ answer: "会议通知已起草。", chart: null }));
    assert.match((await general).answer, /会议通知/);
    await nextImmediate();
    assert.equal(fakeClient.startTurnCalls.length, 7);
    assert.equal(fakeClient.startTurnCalls[6].params.input[1].name, "xbb-executive-analyst");
    assert.equal(fakeClient.startTurnCalls[6].params.input[2].name, "xbb-executive-chart");
    fakeClient.complete("thread-1", "turn-7", JSON.stringify({ answer: "排队后的经营问题已完成。", chart: null }));
    assert.match((await queuedBusiness).answer, /排队后的经营问题/);

    const invalidChartPromise = agent.answer({ question: "继续", access, principalKey: principal, messageId: "msg-invalid-chart" });
    await nextImmediate();
    assert.equal(fakeClient.startTurnCalls.at(-1).params.input[2].name, "xbb-executive-chart");
    fakeClient.complete("thread-1", "turn-8", JSON.stringify({
      answer: "图表关系校验失败时仍返回真实文字结论。",
      chart: {
        type: "funnel", title: "阶段推进", subtitle: "2026年9月｜集团", insight: "确认需求数量高于发现需求，不能形成真实漏斗", note: "",
        valueFormat: "number", unit: "单", items: [{ name: "发现需求", value: 10 }, { name: "确认需求", value: 12 }]
      }
    }));
    const invalidChartResult = await invalidChartPromise;
    assert.match(invalidChartResult.answer, /仍返回真实文字结论/);
    assert.equal(invalidChartResult.chart, null);
    assert.equal(activities.some((value) => value.status === "chart_failed"), true);

    fakeClient.emit("notification", {
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-1",
        turnId: "turn-8",
        tokenUsage: { last: { inputTokens: 900, totalTokens: 900 }, total: { inputTokens: 900, totalTokens: 900 }, modelContextWindow: 1000 }
      }
    });
    const rotatedPromise = agent.answer({ question: "集团9月业绩排名", access, principalKey: principal, messageId: "msg-context-rotation" });
    await nextImmediate();
    assert.equal(fakeClient.startThreadCalls.length, 2);
    assert.equal(fakeClient.startTurnCalls.at(-1).params.threadId, "thread-2");
    assert.equal(activities.some((value) => value.status === "context_rotated"), true);
    fakeClient.complete("thread-2", "turn-9", JSON.stringify({ answer: "换新上下文后仍完成9月业绩分析。", chart: null }));
    assert.match((await rotatedPromise).answer, /换新上下文/);

    const refusalPromise = agent.answer({ question: "集团9月业绩排名", access, principalKey: principal, messageId: "msg-false-refusal" });
    await nextImmediate();
    fakeClient.complete("thread-2", "turn-10", JSON.stringify({
      answer: "本次未能完成年度分析。事实包超过安全大小限制，建议缩小到一个主题继续查。",
      chart: null
    }));
    const recovered = await refusalPromise;
    assert.match(recovered.answer, /业绩：合计 ¥123/);
    assert.doesNotMatch(recovered.answer, /未能完成|缩小到一个主题/);
    assert.equal(recovered.chart, null);
    assert.equal(activities.some((value) => value.status === "answer_recovered"), true);
    assert.equal(agent.sessions.get(principal).threadId, null);

    const afterRecoveryPromise = agent.answer({ question: "你好", access, principalKey: principal, messageId: "msg-after-recovery" });
    await nextImmediate();
    assert.equal(fakeClient.startThreadCalls.length, 3);
    assert.equal(fakeClient.startTurnCalls.at(-1).params.threadId, "thread-3");
    fakeClient.complete("thread-3", "turn-11", JSON.stringify({ answer: "恢复后的新会话已就绪。", chart: null }));
    assert.match((await afterRecoveryPromise).answer, /新会话已就绪/);

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
    assert.equal(resumedClient.resumeThreadCalls.length, 0);
    assert.equal(resumedClient.startThreadCalls.length, 0);
    const resumedWarmStats = await resumed.warm({ access, principalKey: principal });
    assert.equal(resumedClient.startTurnCalls.length, 0);
    assert.equal(resumedWarmStats.principals, 1);
    const lazyResumePromise = resumed.answer({ question: "你好", access, principalKey: principal, messageId: "msg-lazy-resume" });
    await nextImmediate();
    assert.equal(resumedClient.resumeThreadCalls.length, 1);
    assert.equal(resumedClient.resumeThreadCalls[0].params.excludeTurns, true);
    assert.equal(resumedClient.startThreadCalls.length, 0);
    resumedClient.complete("thread-3", "turn-1", JSON.stringify({ answer: "懒恢复成功。", chart: null }));
    assert.match((await lazyResumePromise).answer, /懒恢复成功/);
    await resumed.close();

    const unfinishedStatePath = path.join(tempRoot, "unfinished-state.json");
    const unfinishedClient = new FakeAppServerClient();
    const unfinishedAgent = isolatedAgent("unfinished-source", unfinishedClient, { config: { agentStatePath: unfinishedStatePath } });
    await unfinishedAgent.start();
    const unfinishedPrincipal = principalKeyFromUserId("unfinished-user", access);
    const abandonedPromise = unfinishedAgent.answer({ question: "帮我写一段通知", access, principalKey: unfinishedPrincipal, messageId: "unfinished-active" });
    const abandonedOutcome = Promise.allSettled([abandonedPromise]);
    await nextImmediate();
    assert.equal(loadAgentState(unfinishedStatePath).threads[unfinishedPrincipal].turnInProgress, true);

    const recoveryClient = new FakeAppServerClient();
    const recoveryAgent = isolatedAgent("unfinished-recovery", recoveryClient, { config: { agentStatePath: unfinishedStatePath } });
    await recoveryAgent.start();
    const recoveredContextPromise = recoveryAgent.answer({ question: "你好", access, principalKey: unfinishedPrincipal, messageId: "unfinished-recovered" });
    await nextImmediate();
    assert.equal(recoveryClient.resumeThreadCalls.length, 0);
    assert.equal(recoveryClient.startThreadCalls.length, 1);
    recoveryClient.complete("thread-1", "turn-1", JSON.stringify({ answer: "未完成旧轮次已隔离，新会话正常。", chart: null }));
    assert.match((await recoveredContextPromise).answer, /新会话正常/);
    await recoveryAgent.close();
    await unfinishedAgent.close();
    assert.equal((await abandonedOutcome)[0].status, "rejected");

    const staleClient = new FakeAppServerClient();
    let staleQueryCount = 0;
    let releaseStaleQuery;
    let markStaleQueryStarted;
    const staleQueryStarted = new Promise((resolve) => { markStaleQueryStarted = resolve; });
    const staleAgent = isolatedAgent("stale-steer", staleClient, {
      queryXbb: async (args) => {
        staleQueryCount += 1;
        if (staleQueryCount > 1) {
          markStaleQueryStarted();
          await new Promise((resolve) => { releaseStaleQuery = resolve; });
        }
        return readyPerformancePack(args.months[0], 321);
      }
    });
    await staleAgent.start();
    const stalePrincipal = principalKeyFromUserId("stale-user", access);
    const originalScopePromise = staleAgent.answer({ question: "集团9月业绩排名", access, principalKey: stalePrincipal, messageId: "stale-a" });
    await nextImmediate();
    staleClient.emit("serverRequest", {
      id: 901,
      method: "item/tool/call",
      params: { threadId: "thread-1", turnId: "turn-1", tool: "query_xbb", arguments: { months: ["2026-08"], domains: ["opportunities"] } }
    });
    await staleQueryStarted;
    assert.equal(staleAgent.sessions.get(stalePrincipal).active.latestFactView, null, "新范围查询一发起就必须撤销旧事实回退");
    assert.equal(staleAgent.sessions.get(stalePrincipal).active.fallbackBlockedUntilFreshScope, true);
    const changedScopePromise = staleAgent.answer({ question: "集团7月商机分析", access, principalKey: stalePrincipal, messageId: "stale-b" });
    await nextImmediate();
    assert.equal(staleClient.steerTurnCalls.length, 1);
    assert.match((await originalScopePromise).answer, /最新一条消息/);
    assert.equal(staleAgent.sessions.get(stalePrincipal).active.prefetchedFactAvailable, false);
    releaseStaleQuery();
    await nextImmediate();
    await nextImmediate();
    assert.equal(staleClient.responses.at(-1).id, 901);
    assert.equal(staleClient.responses.at(-1).result.success, true);
    const staleToolResult = JSON.parse(staleClient.responses.at(-1).result.contentItems[0].text);
    assert.equal(staleToolResult.status, "superseded");
    assert.equal(Object.hasOwn(staleToolResult, "facts"), false);
    assert.equal(staleAgent.sessions.get(stalePrincipal).active.latestFactView, null);
    staleClient.complete("thread-1", "turn-1", "not-json");
    await assert.rejects(changedScopePromise, /结构化结果/);
    assert.equal(staleQueryCount, 2);
    await staleAgent.close();

    const timeoutClient = new FakeAppServerClient();
    let releaseInterrupt;
    timeoutClient.interruptTurn = async (threadId, turnId) => {
      timeoutClient.interruptTurnCalls.push({ threadId, turnId });
      await new Promise((resolve) => { releaseInterrupt = resolve; });
      return {};
    };
    const timeoutAgent = isolatedAgent("timeout-race", timeoutClient);
    const timeoutActivities = [];
    timeoutAgent.on("activity", (value) => timeoutActivities.push(value));
    await timeoutAgent.start();
    const timeoutPrincipal = principalKeyFromUserId("timeout-user", access);
    const timeoutAnswer = timeoutAgent.answer({ question: "你好", access, principalKey: timeoutPrincipal, messageId: "timeout-race" });
    await nextImmediate();
    const timeoutSession = timeoutAgent.sessions.get(timeoutPrincipal);
    const timeoutActive = timeoutSession.active;
    const timeoutOperation = timeoutAgent._timeoutTurn(timeoutSession, timeoutActive);
    await nextImmediate();
    timeoutClient.complete("thread-1", "turn-1", JSON.stringify({ answer: "抢在中断确认前正常完成。", chart: null }));
    assert.match((await timeoutAnswer).answer, /正常完成/);
    releaseInterrupt();
    await timeoutOperation;
    assert.equal(timeoutSession.turnCount, 1);
    assert.equal(timeoutSession.threadId, "thread-1");
    assert.equal(timeoutActivities.some((value) => value.status === "context_invalidated"), false);
    assert.equal(timeoutActivities.some((value) => value.status === "turn_failed"), false);
    await timeoutAgent.close();

    const failingClient = new FakeAppServerClient();
    failingClient.startTurn = async function startTurn(params) {
      this.startTurnCalls.push({ id: null, params });
      throw new Error("simulated turn/start failure");
    };
    const failingAgent = isolatedAgent("turn-start-failure", failingClient);
    const fatalEvents = [];
    failingAgent.on("fatal", (value) => fatalEvents.push(value));
    await failingAgent.start();
    const failingPrincipal = principalKeyFromUserId("failing-user", access);
    await assert.rejects(
      failingAgent.answer({ question: "你好", access, principalKey: failingPrincipal, messageId: "failure-1" }),
      /simulated turn\/start failure/
    );
    assert.equal(fatalEvents.length, 0);
    await assert.rejects(
      failingAgent.answer({ question: "再试一次", access, principalKey: failingPrincipal, messageId: "failure-2" }),
      /simulated turn\/start failure/
    );
    assert.equal(failingClient.startTurnCalls.length, 2);
    assert.equal(fatalEvents.length, 1);
    assert.equal(failingAgent.started, false);
    await failingAgent.close();

    const closingClient = new FakeAppServerClient();
    let closingQueries = 0;
    const closingAgent = isolatedAgent("close-queue", closingClient, {
      queryXbb: async () => {
        closingQueries += 1;
        return readyPerformancePack();
      }
    });
    await closingAgent.start();
    const closingPrincipal = principalKeyFromUserId("closing-user", access);
    const activeAtClose = closingAgent.answer({ question: "帮我写会议通知", access, principalKey: closingPrincipal, messageId: "close-active" });
    await nextImmediate();
    const activeBeforeClose = closingAgent.sessions.get(closingPrincipal).active;
    const queuedAtClose = closingAgent.answer({ question: "集团9月业绩排名", access, principalKey: closingPrincipal, messageId: "close-queued" });
    await nextImmediate();
    const closeOutcomes = Promise.allSettled([activeAtClose, queuedAtClose]);
    await closingAgent.close();
    const settledAtClose = await closeOutcomes;
    assert.deepEqual(settledAtClose.map((item) => item.status), ["rejected", "rejected"]);
    assert.equal(closingQueries, 0);
    assert.equal(closingClient.startTurnCalls.length, 1);
    assert.equal(closingAgent.sessions.get(closingPrincipal).active, null);
    assert.equal(activeBeforeClose.timeout, null);

    const fatalQueueClient = new FakeAppServerClient();
    let fatalQueueQueries = 0;
    const fatalQueueAgent = isolatedAgent("fatal-queue", fatalQueueClient, {
      queryXbb: async () => {
        fatalQueueQueries += 1;
        return readyPerformancePack();
      }
    });
    await fatalQueueAgent.start();
    const fatalQueuePrincipal = principalKeyFromUserId("fatal-queue-user", access);
    const activeAtFatal = fatalQueueAgent.answer({ question: "帮我写会议通知", access, principalKey: fatalQueuePrincipal, messageId: "fatal-active" });
    await nextImmediate();
    const activeBeforeFatal = fatalQueueAgent.sessions.get(fatalQueuePrincipal).active;
    const queuedAtFatal = fatalQueueAgent.answer({ question: "集团9月业绩排名", access, principalKey: fatalQueuePrincipal, messageId: "fatal-queued" });
    await nextImmediate();
    const fatalQueueOutcomes = Promise.allSettled([activeAtFatal, queuedAtFatal]);
    fatalQueueAgent._fatal("simulated fatal shutdown");
    assert.deepEqual((await fatalQueueOutcomes).map((item) => item.status), ["rejected", "rejected"]);
    assert.equal(fatalQueueQueries, 0);
    assert.equal(fatalQueueClient.startTurnCalls.length, 1);
    assert.equal(fatalQueueAgent.sessions.get(fatalQueuePrincipal).active, null);
    assert.equal(activeBeforeFatal.timeout, null);
    await fatalQueueAgent.close();

    const absoluteClient = new FakeAppServerClient();
    let absoluteQuerySignal;
    const absoluteAgent = isolatedAgent("absolute-deadline", absoluteClient, {
      config: { agentTurnTimeoutMs: 1000, agentTotalTimeoutMs: 30 },
      queryXbb: async (_args, _access, invocation = {}) => new Promise((_resolve, reject) => {
        absoluteQuerySignal = invocation.signal;
        const fail = () => reject(invocation.signal.reason || new Error("aborted"));
        if (invocation.signal.aborted) fail();
        else invocation.signal.addEventListener("abort", fail, { once: true });
      })
    });
    await absoluteAgent.start();
    const absolutePrincipal = principalKeyFromUserId("absolute-user", access);
    const absoluteStartedAt = Date.now();
    const absoluteAnswer = absoluteAgent.answer({ question: "集团9月业绩排名", access, principalKey: absolutePrincipal, messageId: "absolute-deadline" });
    const keepAbsoluteTimerAlive = setTimeout(() => {}, 1000);
    await assert.rejects(
      absoluteAnswer,
      (error) => /本轮处理超时/.test(error?.message || "") && error?.timeoutMs === 30
    );
    clearTimeout(keepAbsoluteTimerAlive);
    assert.equal(absoluteQuerySignal.aborted, true);
    assert.ok(Date.now() - absoluteStartedAt < 500, "预取必须受非滑动端到端截止约束");
    assert.equal(absoluteClient.startTurnCalls.length, 0);
    assert.equal(absoluteAgent.sessions.get(absolutePrincipal).active, null);
    await absoluteAgent.close();

    const cancelClient = new FakeAppServerClient();
    let dynamicQuerySignal;
    let markDynamicQueryStarted;
    const dynamicQueryStarted = new Promise((resolve) => { markDynamicQueryStarted = resolve; });
    const cancelAgent = isolatedAgent("cancel-in-flight", cancelClient, {
      queryXbb: async (_args, _access, invocation = {}) => new Promise((_resolve, reject) => {
        dynamicQuerySignal = invocation.signal;
        markDynamicQueryStarted();
        const fail = () => reject(invocation.signal.reason || new Error("aborted"));
        if (invocation.signal.aborted) fail();
        else invocation.signal.addEventListener("abort", fail, { once: true });
      })
    });
    await cancelAgent.start();
    const cancelPrincipal = principalKeyFromUserId("cancel-user", access);
    const cancelAnswer = cancelAgent.answer({ question: "请做集团经营分析", access, principalKey: cancelPrincipal, messageId: "cancel-active" });
    await nextImmediate();
    assert.equal(cancelClient.startTurnCalls.length, 1);
    const cancelActive = cancelAgent.sessions.get(cancelPrincipal).active;
    assert.ok(cancelActive.timeout, "模型生成阶段必须保留独立超时");
    assert.ok(cancelActive.absoluteTimeout, "整轮必须同时存在非滑动绝对截止");
    cancelClient.emit("serverRequest", {
      id: 902,
      method: "item/tool/call",
      params: { threadId: "thread-1", turnId: "turn-1", tool: "query_xbb", arguments: { months: ["2026-09"], domains: ["opportunities"] } }
    });
    await dynamicQueryStarted;
    assert.equal(cancelActive.timeout, null, "工具执行期间只暂停生成阶段计时器");
    assert.ok(cancelActive.absoluteTimeout);
    const cancelOutcome = Promise.allSettled([cancelAnswer]);
    await cancelAgent.close();
    assert.equal((await cancelOutcome)[0].status, "rejected");
    assert.equal(dynamicQuerySignal.aborted, true);
    await nextImmediate();
    assert.equal(cancelClient.responses.some((response) => response.id === 902), false, "关闭后的迟到工具不得 respond");

    const lateProgressClient = new FakeAppServerClient();
    let lateProgressQueries = 0;
    const lateProgressAgent = isolatedAgent("late-progress-cancel", lateProgressClient, {
      queryXbb: async () => {
        lateProgressQueries += 1;
        throw new Error("query must not start after close");
      }
    });
    await lateProgressAgent.start();
    const lateProgressPrincipal = principalKeyFromUserId("late-progress-user", access);
    const lateProgressAnswer = lateProgressAgent.answer({
      question: "请做集团经营分析",
      access,
      principalKey: lateProgressPrincipal,
      messageId: "late-progress-active"
    });
    await nextImmediate();
    const lateProgressActive = lateProgressAgent.sessions.get(lateProgressPrincipal).active;
    let releaseLateProgress;
    let markLateProgressEntered;
    const lateProgressEntered = new Promise((resolve) => { markLateProgressEntered = resolve; });
    lateProgressActive.waiters[0].onProgress = async () => {
      markLateProgressEntered();
      await new Promise((resolve) => { releaseLateProgress = resolve; });
    };
    lateProgressClient.emit("serverRequest", {
      id: 903,
      method: "item/tool/call",
      params: { threadId: "thread-1", turnId: "turn-1", tool: "query_xbb", arguments: { months: ["2026-09"], domains: ["opportunities"] } }
    });
    await lateProgressEntered;
    const lateProgressOutcome = Promise.allSettled([lateProgressAnswer]);
    await lateProgressAgent.close();
    releaseLateProgress();
    assert.equal((await lateProgressOutcome)[0].status, "rejected");
    await nextImmediate();
    assert.equal(lateProgressQueries, 0, "关闭发生在进度 await 期间时不得再启动迟到查询");
    assert.equal(lateProgressClient.responses.some((response) => response.id === 903), false, "关闭后的迟到工具不得 respond");

    const floodClient = new FakeAppServerClient();
    const floodAgent = isolatedAgent("bounded-request-queue", floodClient);
    await floodAgent.start();
    const floodPrincipal = principalKeyFromUserId("flood-user", access);
    const floodPromises = [floodAgent.answer({ question: "帮我写一句通知", access, principalKey: floodPrincipal, messageId: "flood-active" })];
    await nextImmediate();
    let floodSettled = 0;
    for (let index = 0; index < 1000; index += 1) {
      const promise = floodAgent.answer({ question: `集团${(index % 9) + 1}月业绩排名`, access, principalKey: floodPrincipal, messageId: `flood-${index}` });
      promise.then(() => { floodSettled += 1; }, () => { floodSettled += 1; });
      floodPromises.push(promise);
    }
    await nextImmediate();
    const floodSession = floodAgent.sessions.get(floodPrincipal);
    assert.ok(floodSession.requestQueue.length <= 8, "单主体等待队列必须保持硬上限");
    assert.ok(floodSettled >= 990, "洪泛时较早排队请求必须由 latest-wins 有界收敛");
    assert.equal(floodClient.startTurnCalls.length, 1);
    const floodOutcomes = Promise.allSettled(floodPromises);
    await floodAgent.close();
    assert.equal((await floodOutcomes).length, 1001);

    const boundsClient = new FakeAppServerClient();
    const boundsAgent = isolatedAgent("hard-bounds", boundsClient);
    await boundsAgent.start();
    const boundsPrincipal = principalKeyFromUserId("bounds-user", access);
    await assert.rejects(
      boundsAgent.answer({ question: "问".repeat(11000), access, principalKey: boundsPrincipal, messageId: "oversized-question" }),
      /32768 字节/
    );
    assert.equal(boundsClient.startThreadCalls.length, 0);
    const boundedAnswers = [boundsAgent.answer({ question: "帮我写一句通知", access, principalKey: boundsPrincipal, messageId: "bounded-base" })];
    await nextImmediate();
    for (let index = 0; index < 40; index += 1) {
      boundsClient.emit("notification", {
        method: "item/started",
        params: { threadId: "thread-1", turnId: "turn-1", item: { type: "agentMessage", id: `stream-${index}` } }
      });
    }
    boundsClient.emit("notification", {
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "stream-0", delta: "流".repeat(100000) }
    });
    await nextImmediate();
    const boundedActive = boundsAgent.sessions.get(boundsPrincipal).active;
    assert.equal(boundedActive.messages.size, 32);
    assert.ok(Buffer.byteLength(boundedActive.messages.get("stream-0").text, "utf8") <= 64 * 1024);
    assert.ok(boundedActive.streamedMessageBytes <= 128 * 1024);
    boundsClient.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { type: "agentMessage", id: "oversized-completed", text: "终".repeat(100000), phase: "commentary" }
      }
    });
    await nextImmediate();
    assert.ok(Buffer.byteLength(boundedActive.lastText, "utf8") <= 64 * 1024);
    for (let index = 1; index <= 8; index += 1) {
      boundedAnswers.push(boundsAgent.answer({ question: `补充要求${index}`, access, principalKey: boundsPrincipal, messageId: `bounded-steer-${index}` }));
      await nextImmediate();
      assert.match((await boundedAnswers[index - 1]).answer, /最新一条消息/);
    }
    const overSteerBudget = boundsAgent.answer({ question: "补充要求9", access, principalKey: boundsPrincipal, messageId: "bounded-steer-9" });
    await nextImmediate();
    assert.equal(boundsClient.steerTurnCalls.length, 8);
    assert.equal(boundsClient.startTurnCalls.length, 1);
    boundsClient.complete("thread-1", "turn-1", JSON.stringify({ answer: "前八条补充已完成。", chart: null }));
    assert.match((await boundedAnswers.at(-1)).answer, /前八条补充/);
    await nextImmediate();
    assert.equal(boundsClient.startTurnCalls.length, 2);
    boundsClient.complete("thread-1", "turn-2", JSON.stringify({ answer: "第九条补充使用新 Turn 完成。", chart: null }));
    assert.match((await overSteerBudget).answer, /新 Turn/);
    await boundsAgent.close();

    process.stdout.write(`${JSON.stringify({ success: true, checks: 128, runtime: "persistent-steerable-general-codex-with-xbb-skill" })}\n`);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
})().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
