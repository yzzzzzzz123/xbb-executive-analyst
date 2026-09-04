"use strict";

const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const { AccessDeniedError } = require("../security/access-control.js");
const { sanitizeAgentText } = require("../security/output-sanitizer.js");
const { SOURCE_FILES, SkillKnowledgeBase } = require("../rag/skill-knowledge-base.js");
const { routeSkill } = require("../rag/skill-router.js");
const { createToolGateway } = require("../xbb/tool-gateway.js");
const { MAX_MODEL_FACT_VIEW_BYTES, buildModelFactView } = require("../xbb/model-fact-view.js");
const { QUERY_XBB_DYNAMIC_TOOL, queryToolContractHash } = require("../xbb/query-tool.js");
const { chooseTurnEffort, planFastQuery } = require("../xbb/fast-query-plan.js");
const { formatContextAnalysisProgress, formatGeneralAnalysisProgress, formatQueryProgress } = require("../xbb/query-progress.js");
const { AppServerClient } = require("./app-server-client.js");
const { LocalAppServerHost } = require("./app-server-host.js");
const { buildVerifiedFallbackAnswer, falseTechnicalRefusalReason, hasUsableFacts } = require("./recovery-answer.js");
const { GENERAL_RESPONSE_SCHEMA, WECOM_RESPONSE_SCHEMA, parseAgentResponse, responseContractHash } = require("./response-contract.js");
const { loadAgentState, saveAgentState } = require("./state-store.js");
const { buildThreadInstructions } = require("./thread-instructions.js");
const { readCodexVersion, verifyCodexChatGptLogin } = require("./runtime.js");

const MAX_SESSION_ESTIMATED_INPUT_BYTES = 256 * 1024;
const MAX_SESSION_TURNS = 24;
const CONTEXT_ROTATION_RATIO = 0.7;
const MAX_TURN_FACT_BYTES = 128 * 1024;
const MAX_INTENT_MEMORY = 8;
const MAX_USER_QUESTION_BYTES = 32 * 1024;
const MAX_STEER_COUNT = 8;
const MAX_STEER_INPUT_BYTES = 64 * 1024;
const MAX_AGENT_MESSAGE_ITEMS = 32;
const MAX_AGENT_MESSAGE_BYTES = 64 * 1024;
const MAX_AGENT_STREAM_BYTES = 128 * 1024;
const MAX_CONSECUTIVE_TURN_START_FAILURES = 2;
const MAX_SESSION_QUEUED_REQUESTS = 8;
const DEFAULT_BUSINESS_TOTAL_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_GENERAL_TOTAL_TIMEOUT_MS = 15 * 60 * 1000;

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function queryFingerprint(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const allowed = new Set(["months", "domains", "company", "person", "forceRefresh"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return null;
  const months = Array.isArray(value.months) ? value.months.map(String).sort() : [];
  const domains = Array.isArray(value.domains) ? value.domains.map(String).sort() : [];
  if (!months.length || !domains.length) return null;
  return sha256(JSON.stringify({
    months,
    domains,
    company: typeof value.company === "string" ? value.company.trim() : "",
    person: typeof value.person === "string" ? value.person.trim() : "",
    forceRefresh: value.forceRefresh === true
  }));
}

function canonicalAccess(access) {
  if (access?.scope === "all") return { scope: "all", companies: [] };
  if (access?.scope === "companies" && Array.isArray(access.companies)) {
    const companies = [...new Set(access.companies.map((company) => typeof company === "string" ? company.trim() : "").filter(Boolean))].sort();
    if (companies.length) return { scope: "companies", companies };
  }
  throw new Error("经营分析访问范围无效。");
}

function principalKeyFromUserId(userId, access) {
  if (typeof userId !== "string" || !userId) throw new Error("企业微信 USERID 不能为空。");
  return sha256(JSON.stringify({ channel: "wecom", userId, access: canonicalAccess(access) }));
}

function shanghaiDateLabel(now = new Date()) {
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function accessLabel(access) {
  const canonical = canonicalAccess(access);
  if (canonical.scope === "all") return "集团全部公司只读权限";
  return `仅限公司：${canonical.companies.join("、")}`;
}

function extractThreadId(result) {
  const threadId = result?.thread?.id;
  if (typeof threadId !== "string" || !threadId) throw new Error("Codex App Server 未返回 thread.id。");
  return threadId;
}

function extractTurnId(result) {
  const turnId = result?.turn?.id || result?.turnId;
  if (typeof turnId !== "string" || !turnId) throw new Error("Codex App Server 未返回 turn.id。");
  return turnId;
}

function extractActiveTurnId(result) {
  const turns = Array.isArray(result?.thread?.turns) ? result.thread.turns : [];
  const active = [...turns].reverse().find((turn) => turn?.status === "inProgress" && typeof turn.id === "string");
  return active?.id || null;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolveValue, rejectValue) => { resolve = resolveValue; reject = rejectValue; });
  return { promise, resolve, reject };
}

function abortError(message = "销帮帮查询已取消。") {
  const error = new Error(message);
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

function inputBytes(input) {
  return Buffer.byteLength(JSON.stringify(input || []), "utf8");
}

function utf8Prefix(value, maxBytes) {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return "";
  const text = String(value || "");
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let result = "";
  let bytes = 0;
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function steerInput(question) {
  return [{
    type: "text",
    text: [
      "【用户追问/修正】",
      question,
      "请把这条消息作为当前用户的最新要求：与原问题冲突时以本条为准；最终回答同时回应仍然有效的原问题和本条追问。"
    ].join("\n"),
    text_elements: []
  }];
}

function boundedIntentQuestion(question) {
  const sanitized = sanitizeAgentText(String(question || ""), { maxBytes: 800 });
  return sanitized || "";
}

function createSession(principalKey, stored = {}) {
  return {
    principalKey,
    threadId: stored.threadId || null,
    active: null,
    access: null,
    lastMode: stored.lastModeSource === "user" ? (stored.lastMode || null) : null,
    operation: Promise.resolve(),
    requestQueue: [],
    draining: false,
    turnCount: Number.isInteger(stored.turnCount) ? stored.turnCount : 0,
    estimatedInputBytes: Number.isInteger(stored.estimatedInputBytes) ? stored.estimatedInputBytes : 0,
    tokenUsage: null,
    intentMemory: [],
    resumed: Boolean(stored.threadId),
    needsResume: Boolean(stored.threadId),
    turnInProgress: stored.turnInProgress === true
  };
}

class AgentTurnFailureError extends Error {
  constructor(message, routeMode, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "AgentTurnFailureError";
    this.routeMode = routeMode === "xbb" ? "xbb" : "general";
  }
}

class AgentTurnTimeoutError extends AgentTurnFailureError {
  constructor(routeMode, timeoutMs) {
    super("Codex Agent 本轮处理超时。", routeMode);
    this.name = "AgentTurnTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

function routedTurnError(error, businessMode) {
  if (error instanceof AccessDeniedError || error instanceof AgentTurnFailureError) return error;
  return new AgentTurnFailureError(error?.message || "Codex Agent 未能完成本轮处理。", businessMode ? "xbb" : "general", { cause: error });
}

const FOLLOW_UP_HANDOFF_RESULT = Object.freeze({
  answer: "已收到你的补充要求，正在继续分析。完整结果会回复到你最新一条消息。",
  chart: null
});

function withRouteMode(result, businessMode) {
  return Object.freeze({
    answer: result.answer,
    chart: result.chart ?? null,
    routeMode: businessMode ? "xbb" : "general"
  });
}

class PersistentCodexAgent extends EventEmitter {
  constructor(config, options = {}) {
    super();
    this.config = config;
    this.projectRoot = config.projectRoot || path.resolve(__dirname, "..", "..");
    this.knowledgeBase = options.knowledgeBase || new SkillKnowledgeBase(this.projectRoot);
    this.instructions = options.instructions || buildThreadInstructions(this.projectRoot);
    this.queryXbb = options.queryXbb || createToolGateway({ projectRoot: this.projectRoot });
    this.hostFactory = options.hostFactory || LocalAppServerHost;
    this.clientFactory = options.clientFactory || ((host) => new AppServerClient({ endpoint: host.endpoint, token: host.token }));
    this.verifyLogin = options.verifyLogin || verifyCodexChatGptLogin;
    this.readVersion = options.readVersion || readCodexVersion;
    this.loadState = options.loadState || loadAgentState;
    this.saveState = options.saveState || saveAgentState;
    this.statePath = config.agentStatePath;
    this.businessTurnTimeoutMs = config.agentTurnTimeoutMs || 5 * 60 * 1000;
    this.generalTurnTimeoutMs = config.generalTurnTimeoutMs || 15 * 60 * 1000;
    this.businessTotalTimeoutMs = config.agentTotalTimeoutMs || DEFAULT_BUSINESS_TOTAL_TIMEOUT_MS;
    this.generalTotalTimeoutMs = config.generalTotalTimeoutMs || Math.max(DEFAULT_GENERAL_TOTAL_TIMEOUT_MS, this.generalTurnTimeoutMs);
    this.contractHash = sha256(JSON.stringify({
      instructions: this.instructions,
      tool: queryToolContractHash(),
      response: responseContractHash(),
      model: config.codexModel,
      effort: config.codexReasoningEffort,
      interaction: "bounded-context-recoverable-xbb-skill-v4",
      knowledge: this.knowledgeBase.digest,
      sandbox: "read-only",
      approvalPolicy: "never"
    }));
    this.state = null;
    this.host = null;
    this.client = null;
    this.sessions = new Map();
    this.started = false;
    this.closing = false;
    this.fatalError = null;
    this.consecutiveAppServerFailures = 0;
    this.warmedPrincipals = new Set();
  }

  _emit(event, payload) {
    try { return super.emit(event, payload); } catch { return false; }
  }

  async start() {
    if (this.started) return;
    this.verifyLogin(this.config);
    const codexVersion = this.readVersion(this.config);
    this.state = this.loadState(this.statePath);
    this.state.codexVersion = codexVersion;
    try {
      this.host = await this.hostFactory.start({ ...this.config, projectRoot: this.projectRoot });
      this.client = this.clientFactory(this.host);
      this.client.on("notification", (event) => { void this._handleNotification(event); });
      this.client.on("serverRequest", (request) => {
        void this._handleServerRequest(request).catch(() => {
          try { this.client.reject(request.id, "经营分析工具请求处理失败。"); } catch {}
        });
      });
      this.client.on("transportError", () => this._fatal("Codex App Server 传输错误。"));
      this.client.on("protocolError", () => this._fatal("Codex App Server 协议错误。"));
      this.client.on("disconnected", () => { if (!this.closing) this._fatal("Codex App Server 连接已断开。"); });
      this.host.process.once("exit", () => { if (!this.closing) this._fatal("Codex App Server 进程已退出。"); });
      await this.client.connect();
    } catch (error) {
      if (this.client) await this.client.close().catch(() => {});
      if (this.host) await this.host.close().catch(() => {});
      throw error;
    }

    for (const [principalKey, stored] of Object.entries(this.state.threads)) {
      if (stored.contractHash !== this.contractHash) {
        delete this.state.threads[principalKey];
        continue;
      }
      const session = createSession(principalKey, stored);
      this.sessions.set(principalKey, session);
      // 只登记，不在启动关键路径逐个恢复历史 Thread。对应主体第一次发消息时
      // 再 excludeTurns 懒恢复，避免授权用户越多机器人上线越慢。
      this.warmedPrincipals.add(principalKey);
    }
    this.saveState(this.statePath, this.state);
    this.started = true;
    this._emit("ready", { codexVersion, resumedThreads: this.sessions.size });
  }

  async answer({ question, access, principalKey, messageId, onProgress }) {
    return this._enqueue({ question, access, principalKey, messageId, onProgress });
  }

  _assertOperational() {
    if (this.fatalError) throw this.fatalError;
    if (!this.started || !this.client || this.closing) throw new Error("Codex Agent 尚未就绪。");
  }

  async warm(options = {}) {
    const startedAtMs = Date.now();
    this._emit("activity", { status: "agent_warming" });
    const stats = this.knowledgeBase.stats();
    if (stats.sources !== SOURCE_FILES.length || stats.chunks < 15 || stats.sourceBytes < 1000) throw new Error("完整 Skill RAG 知识库未成功预热。");
    const principals = Array.isArray(options.principals)
      ? options.principals
      : options.access && options.principalKey
        ? [{ access: options.access, principalKey: options.principalKey }]
        : [];
    for (const principal of principals) {
      if (this.warmedPrincipals.has(principal.principalKey)) continue;
      const result = await this._enqueue({
        question: "后台缓存预热：加载业绩、产品、课程、交付、商机、回答和图表规则。这不是经营查询，不得调用 query_xbb，不得输出经营数字；只返回 ready，chart 必须为 null。",
        access: principal.access,
        principalKey: principal.principalKey,
        messageId: null,
        onProgress: null,
        warmup: true
      });
      if (result.chart !== null) throw new Error("Codex Thread 后台预热错误地生成了图表。");
      this.warmedPrincipals.add(principal.principalKey);
    }
    this._emit("activity", { status: "agent_warmed", elapsedMs: Date.now() - startedAtMs });
    return Object.freeze({ ...stats, principals: principals.length });
  }

  async _enqueue({ question, access, principalKey, messageId, onProgress, warmup = false }) {
    this._assertOperational();
    if (typeof question !== "string" || !question.trim()) throw new Error("问题不能为空。");
    if (Buffer.byteLength(question.trim(), "utf8") > MAX_USER_QUESTION_BYTES) {
      throw new Error(`问题长度不能超过 ${MAX_USER_QUESTION_BYTES} 字节。`);
    }
    if (!/^[a-f0-9]{64}$/.test(principalKey)) throw new Error("Codex Agent principal key 无效。");
    let session = this.sessions.get(principalKey);
    if (!session) {
      session = createSession(principalKey);
      this.sessions.set(principalKey, session);
    }
    const waiter = { ...deferred(), onProgress };
    const request = { question: question.trim(), access, messageId, waiter, warmup };
    if (session.requestQueue.length >= MAX_SESSION_QUEUED_REQUESTS) {
      const displaced = session.requestQueue.splice(0);
      for (const stale of displaced) {
        const priorMode = session.active ? (session.active.businessMode ? "xbb" : "general") : session.lastMode;
        const route = stale.warmup ? "xbb" : routeSkill(stale.question, priorMode).mode;
        stale.waiter.resolve(withRouteMode(FOLLOW_UP_HANDOFF_RESULT, route === "xbb"));
      }
      this._emit("activity", { status: "turn_queued", reason: "latest_wins_bound" });
    }
    session.requestQueue.push(request);
    this._drainSessionQueue(session);
    return waiter.promise;
  }

  _drainSessionQueue(session) {
    if (session.draining) return session.operation;
    session.draining = true;
    session.operation = (async () => {
      while (session.requestQueue.length) {
        const request = session.requestQueue.shift();
        try { await this._submit(session, request); } catch (error) { request.waiter.reject(error); }
      }
    })().finally(() => {
      session.draining = false;
      if (session.requestQueue.length && !this.closing && !this.fatalError) this._drainSessionQueue(session);
    });
    return session.operation;
  }

  _rejectQueuedRequests(session, error) {
    for (const request of session.requestQueue.splice(0)) request.waiter.reject(error);
  }

  async _submit(session, { question, access, messageId, waiter, warmup }) {
    this._assertOperational();
    await this._ensureThread(session);
    this._assertOperational();
    if (session.active) {
      const active = session.active;
      const activeMode = active.businessMode ? "xbb" : "general";
      const incomingRoute = warmup ? Object.freeze({ mode: "xbb", reason: "skill-warmup" }) : routeSkill(question, activeMode);
      if (!warmup && !active.warmup && incomingRoute.mode === activeMode) {
        const nextSteerInput = steerInput(question);
        const nextSteerBytes = inputBytes(nextSteerInput);
        if (active.steerCount < MAX_STEER_COUNT && active.steerInputBytes + nextSteerBytes <= MAX_STEER_INPUT_BYTES) {
          return this._steerActiveTurn(session, active, { question, access, messageId, waiter, warmup }, nextSteerInput, nextSteerBytes);
        }
        await this._notifyWaiter(waiter, "当前分析已接收较多补充要求；这条消息将在当前结果完成后使用新 Turn 继续处理。", false);
        this._emit("activity", { status: "turn_queued", reason: "steer_budget" });
        await active.done.promise;
        this._assertOperational();
        return this._submit(session, { question, access, messageId, waiter, warmup });
      }
      await this._notifyWaiter(waiter, "已收到新问题。它与当前分析属于不同范围，将在上一条完成后自动继续处理。", false);
      this._emit("activity", { status: "turn_queued" });
      await active.done.promise;
      this._assertOperational();
      return this._submit(session, { question, access, messageId, waiter, warmup });
    }

    session.access = access;
    const route = warmup ? Object.freeze({ mode: "xbb", reason: "skill-warmup" }) : routeSkill(question, session.lastMode);
    const businessMode = route.mode === "xbb";
    const timeoutMs = businessMode ? this.businessTurnTimeoutMs : this.generalTurnTimeoutMs;
    const totalTimeoutMs = businessMode ? this.businessTotalTimeoutMs : this.generalTotalTimeoutMs;
    const active = this._newActive(null, waiter, { allowTools: businessMode && !warmup, businessMode, routeReason: route.reason, warmup, timeoutMs, totalTimeoutMs });
    session.active = active;
    this._armAbsoluteTimeout(session, active);
    let turnStartFailureCandidate = false;
    try {
      const fastPlan = businessMode && !warmup ? planFastQuery(question) : null;
      const retrieved = businessMode ? this.knowledgeBase.retrieve(question, {
        domains: fastPlan?.domains || [],
        periodCount: fastPlan?.months?.length || 1
      }) : null;
      active.queryPlan = fastPlan;
      active.question = question;
      const turnEffort = warmup ? "none" : businessMode ? chooseTurnEffort(question, this.config.codexReasoningEffort) : this.config.codexReasoningEffort;
      let prefetchedFactPack = null;
      let prefetchedFactView = null;
      if (fastPlan) {
        active.toolCalls += 1;
        active.toolStartedAtMs = Date.now();
        this._emit("activity", { status: "tool_started" });
        await this._notifyQueryProgress(session, fastPlan, access, {
          stage: "run_started",
          completed: 0,
          total: fastPlan.months.length
        });
        try {
          const subscription = this._beginActiveQuery(active);
          try {
            prefetchedFactPack = await this.queryXbb(fastPlan, access, {
              signal: subscription.signal,
              onProgress: (event) => session.active === active && !active.abortController.signal.aborted
                ? this._notifyQueryProgress(session, fastPlan, access, event)
                : undefined
            });
          } finally {
            subscription.cleanup();
          }
          active.prefetchedQueryFingerprint = queryFingerprint(fastPlan);
          prefetchedFactView = buildModelFactView(prefetchedFactPack);
          prefetchedFactPack = null;
          active.prefetchedFactAvailable = true;
          active.prefetchedFactView = prefetchedFactView;
          active.latestFactView = prefetchedFactView;
          active.fallbackFactFingerprint = active.prefetchedQueryFingerprint;
          active.successfulFactQueryCount = 1;
          active.factBytesSent = Buffer.byteLength(JSON.stringify(prefetchedFactView), "utf8");
          this._emit("activity", { status: "tool_completed", elapsedMs: Date.now() - active.toolStartedAtMs });
        } catch (error) {
          this._emit("activity", { status: "tool_failed", elapsedMs: Date.now() - active.toolStartedAtMs });
          throw error;
        }
        this._assertOperational();
        if (session.active !== active) return;
      }
      if (!warmup && !fastPlan) {
        await this._notifyProgress(session, businessMode ? formatContextAnalysisProgress() : formatGeneralAnalysisProgress());
        this._assertOperational();
        if (session.active !== active) return;
      }
      const continuity = !warmup && session.intentMemory.length && (question.length <= 16 || route.reason === "follow-up")
        ? [
            "【最近意图（仅用于理解省略的指代，经营数字必须重新查询）】",
            ...session.intentMemory.slice(-2).map((item) => `- ${item.question}`)
          ]
        : [];
      const text = businessMode
        ? [
            "$xbb-executive-analyst",
            "$xbb-executive-chart",
            "【能力路由】销帮帮经营 Skill",
            "本轮如需辅助图，必须由 xbb-executive-chart 完成数据充足性判断、选型和最小规格；不适合时 chart 必须为 null。",
            "【销帮帮 Skill RAG 适用规则】",
            retrieved.text,
            ...(prefetchedFactView ? [
              "【本轮 query_xbb 实时预取事实包】",
              JSON.stringify(prefetchedFactView),
              "这是完整事实包经过确定性预算投影后的模型视图，summary、月度趋势、核心排名及覆盖元数据已保留。它已按授权范围实时查询并通过完整性与隐私校验；不要重复查询相同范围。"
            ] : []),
            ...continuity,
            "【可信运行元数据】",
            `上海日期：${shanghaiDateLabel()}`,
            `授权范围：${accessLabel(access)}`,
            "【用户问题】",
            question
          ].join("\n")
        : [
            "【能力路由】通用 Codex",
            "本轮不是销帮帮经营查询，不注入经营或辅助图 Skill，不得调用 query_xbb，chart 固定为 null。请直接使用通用能力回答用户。",
            "【用户问题】",
            question
          ].join("\n");
      const input = [{ type: "text", text, text_elements: [] }];
      if (businessMode) {
        input.push({
          type: "skill",
          name: "xbb-executive-analyst",
          path: path.join(this.projectRoot, "skills", "xbb-executive-analyst", "SKILL.md")
        });
        input.push({
          type: "skill",
          name: "xbb-executive-chart",
          path: path.join(this.projectRoot, "skills", "xbb-executive-chart", "SKILL.md")
        });
      }
      const upcomingBytes = inputBytes(input);
      if (this._shouldRotateThread(session, upcomingBytes, { businessMode, hasFacts: Boolean(prefetchedFactView), warmup })) {
        await this._replaceThread(session, "context_budget");
        this._assertOperational();
        if (session.active !== active) return;
      }
      const turnParams = {
        threadId: session.threadId,
        clientUserMessageId: messageId || null,
        input,
        cwd: this.projectRoot,
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly", networkAccess: businessMode ? false : true },
        model: this.config.codexModel,
        effort: turnEffort,
        summary: "none",
        outputSchema: businessMode ? WECOM_RESPONSE_SCHEMA : GENERAL_RESPONSE_SCHEMA
      };
      active.inputBytes = upcomingBytes;
      active.replayTurnParams = turnParams;
      session.turnInProgress = true;
      this._persistSession(session);
      turnStartFailureCandidate = true;
      const result = await this.client.startTurn(turnParams);
      const startedTurnId = extractTurnId(result);
      if (session.active !== active || active.abortController.signal.aborted) {
        try { await this.client.interruptTurn(turnParams.threadId, startedTurnId); } catch {}
        return;
      }
      active.turnId = startedTurnId;
      turnStartFailureCandidate = false;
      this.consecutiveAppServerFailures = 0;
      this._emit("activity", { status: "turn_started" });
      this._armTurnTimeout(session, active);
    } catch (error) {
      if (active.deadlineExceeded) {
        if (active.deadlineHandling) await active.deadlineHandling;
        return;
      }
      const fatalTurnStartFailure = turnStartFailureCandidate
        && ++this.consecutiveAppServerFailures >= MAX_CONSECUTIVE_TURN_START_FAILURES;
      if (session.active === active) {
        if (this._resolveVerifiedFallback(session, active, "turn_start_failed")) {
          this._invalidateThread(session, "turn_start_failed");
          if (fatalTurnStartFailure) this._fatal("Codex App Server 连续无法启动 Turn。");
          return;
        }
        this._finishActive(session, active);
        this._emit("activity", { status: "turn_failed", elapsedMs: Date.now() - active.startedAtMs, reason: "turn_start_failed" });
        if (turnStartFailureCandidate) this._invalidateThread(session, "turn_start_failed");
      }
      if (fatalTurnStartFailure) this._fatal("Codex App Server 连续无法启动 Turn。");
      throw routedTurnError(error, businessMode);
    }
  }

  async _steerActiveTurn(session, active, request, input = steerInput(request.question), steerBytes = inputBytes(input)) {
    if (!active.turnId) throw new AgentTurnFailureError("Codex 活动 Turn 尚未就绪，无法追加追问。", active.businessMode ? "xbb" : "general");
    active.steerInFlight = true;
    let steerError = null;
    let accepted = false;
    try {
      const result = await this.client.steerTurn({
        threadId: session.threadId,
        expectedTurnId: active.turnId,
        input
      });
      if (result?.turnId !== active.turnId) throw new Error("Codex App Server 未确认目标活动 Turn。");
      if (session.active === active) {
        const previousWaiters = active.waiters;
        active.waiters = [request.waiter];
        active.steerCount += 1;
        active.steerInputBytes += steerBytes;
        active.inputBytes += steerBytes;
        const incomingPlan = active.businessMode ? planFastQuery(request.question) : null;
        const priorFingerprint = queryFingerprint(active.queryPlan);
        const incomingFingerprint = queryFingerprint(incomingPlan);
        if (!priorFingerprint || priorFingerprint !== incomingFingerprint) {
          this._cancelActiveQuery(active, "用户已更新销帮帮查询范围。");
          if (priorFingerprint) active.supersededFactFingerprints.add(priorFingerprint);
          if (incomingFingerprint) active.supersededFactFingerprints.delete(incomingFingerprint);
          active.factGeneration += 1;
          active.fallbackBlockedUntilFreshScope = true;
          active.requiredFallbackQueryFingerprint = incomingFingerprint;
          active.prefetchedQueryFingerprint = null;
          active.prefetchedFactAvailable = false;
          active.prefetchedFactView = null;
          active.latestFactView = null;
          active.fallbackFactFingerprint = null;
          active.successfulFactQueryCount = 0;
        }
        active.queryPlan = incomingPlan;
        active.question = request.question;
        session.access = request.access;
        this._armTurnTimeout(session, active);
        this._emit("activity", { status: "turn_steered" });
        await Promise.all(previousWaiters.map((previous) => this._notifyWaiter(previous, FOLLOW_UP_HANDOFF_RESULT.answer, false)));
        for (const previous of previousWaiters) previous.resolve(withRouteMode(FOLLOW_UP_HANDOFF_RESULT, active.businessMode));
        await this._notifyWaiter(
          request.waiter,
          "追问已加入当前分析。\n正在结合原问题和你的最新要求重新组织结论，最终结果将回复到本条消息。",
          false
        );
        accepted = true;
      }
    } catch (error) {
      steerError = error;
    } finally {
      active.steerInFlight = false;
      if (active.pendingCompletion && session.active === active) {
        const pendingCompletion = active.pendingCompletion;
        active.pendingCompletion = null;
        this._completeTurn(session, pendingCompletion);
      }
    }
    if (accepted) return;
    if (session.active !== active) {
      return this._submit(session, request);
    }
    throw routedTurnError(steerError || new Error("Codex 追问追加失败。"), active.businessMode);
  }

  async _startThread(session) {
    const result = await this.client.startThread({
      model: this.config.codexModel,
      allowProviderModelFallback: false,
      cwd: this.projectRoot,
      approvalPolicy: "never",
      sandbox: "read-only",
      developerInstructions: this.instructions,
      ephemeral: false,
      dynamicTools: [QUERY_XBB_DYNAMIC_TOOL]
    });
    session.threadId = extractThreadId(result);
    session.turnCount = 0;
    session.estimatedInputBytes = 0;
    session.tokenUsage = null;
    session.resumed = false;
    session.needsResume = false;
    session.turnInProgress = false;
    this._persistSession(session);
    this._emit("threadReady", { principalKey: session.principalKey });
  }

  async _ensureThread(session) {
    if (!session.threadId) {
      try {
        await this._startThread(session);
      } catch (error) {
        this._fatal("Codex App Server 无法创建 Thread。");
        throw error;
      }
      return;
    }
    if (!session.needsResume) return;
    if (session.turnInProgress) {
      this._invalidateThread(session, "unfinished_turn_after_restart");
      await this._startThread(session);
      this._emit("activity", { status: "context_rotated", reason: "unfinished_turn_after_restart" });
      return;
    }
    try {
      const resumed = await this.client.resumeThread(session.threadId, {
        cwd: this.projectRoot,
        model: this.config.codexModel,
        approvalPolicy: "never",
        sandbox: "read-only",
        developerInstructions: this.instructions,
        excludeTurns: true
      });
      const activeTurnId = extractActiveTurnId(resumed);
      if (activeTurnId) await this.client.interruptTurn(session.threadId, activeTurnId).catch(() => {});
      session.needsResume = false;
      session.resumed = true;
      this._emit("activity", { status: "context_resumed" });
    } catch {
      this._invalidateThread(session, "resume_failed");
      try {
        await this._startThread(session);
      } catch (error) {
        this._fatal("Codex App Server 无法恢复或重建 Thread。");
        throw error;
      }
    }
  }

  async _replaceThread(session, reason) {
    session.threadId = null;
    session.turnCount = 0;
    session.estimatedInputBytes = 0;
    session.tokenUsage = null;
    session.turnInProgress = false;
    delete this.state.threads[session.principalKey];
    await this._startThread(session);
    this._emit("activity", { status: "context_rotated", reason });
  }

  _invalidateThread(session, reason) {
    session.threadId = null;
    session.turnCount = 0;
    session.estimatedInputBytes = 0;
    session.tokenUsage = null;
    session.resumed = false;
    session.needsResume = false;
    session.turnInProgress = false;
    if (this.state?.threads) {
      delete this.state.threads[session.principalKey];
      try { this.saveState(this.statePath, this.state); } catch {}
    }
    this._emit("activity", { status: "context_invalidated", reason });
  }

  _persistSession(session) {
    this.state.threads[session.principalKey] = {
      threadId: session.threadId,
      contractHash: this.contractHash,
      lastMode: session.lastMode,
      lastModeSource: session.lastMode ? "user" : null,
      turnCount: session.turnCount,
      estimatedInputBytes: session.estimatedInputBytes,
      turnInProgress: session.turnInProgress === true
    };
    this.saveState(this.statePath, this.state);
  }

  _shouldRotateThread(session, upcomingBytes, options = {}) {
    if (!session.threadId || options.warmup) return false;
    if (session.resumed && options.businessMode && options.hasFacts) return true;
    const usage = session.tokenUsage;
    const last = usage?.last || usage;
    const contextWindow = Number(usage?.modelContextWindow);
    const usedTokens = Number(last?.totalTokens ?? last?.inputTokens);
    const upcomingTokens = Math.ceil(Number(upcomingBytes || 0) / 2);
    if (Number.isFinite(contextWindow) && contextWindow > 0 && Number.isFinite(usedTokens)
        && usedTokens + upcomingTokens >= contextWindow * CONTEXT_ROTATION_RATIO) return true;
    if (session.turnCount >= MAX_SESSION_TURNS) return true;
    return session.estimatedInputBytes > 0
      && session.estimatedInputBytes + Number(upcomingBytes || 0) > MAX_SESSION_ESTIMATED_INPUT_BYTES;
  }

  _rememberIntent(session, active) {
    if (active.warmup || !active.question) return;
    const question = boundedIntentQuestion(active.question);
    if (!question) return;
    session.intentMemory.push({ question, queryPlan: active.queryPlan || null });
    if (session.intentMemory.length > MAX_INTENT_MEMORY) session.intentMemory.splice(0, session.intentMemory.length - MAX_INTENT_MEMORY);
  }

  _recordSuccessfulTurn(session, active) {
    session.turnInProgress = false;
    session.turnCount += 1;
    session.estimatedInputBytes += Number(active.inputBytes || 0);
    if (!active.warmup) {
      session.lastMode = active.businessMode ? "xbb" : "general";
      this._rememberIntent(session, active);
    }
    try { this._persistSession(session); } catch {}
  }

  _recordTerminalTurn(session) {
    session.turnInProgress = false;
    try { this._persistSession(session); } catch {}
  }

  _finishActive(session, active) {
    if (active.timeout) clearTimeout(active.timeout);
    if (active.absoluteTimeout) clearTimeout(active.absoluteTimeout);
    active.timeout = null;
    active.absoluteTimeout = null;
    this._abortActive(active, "Codex Agent 本轮已结束。");
    active.prefetchedFactAvailable = false;
    active.prefetchedFactView = null;
    active.latestFactView = null;
    if (session.active === active) session.active = null;
    active.done.resolve();
  }

  _resolveVerifiedFallback(session, active, reason) {
    if (!hasUsableFacts(active.latestFactView)) return false;
    let answer;
    try { answer = buildVerifiedFallbackAnswer(active.latestFactView); } catch { return false; }
    this._recordSuccessfulTurn(session, active);
    const waiters = active.waiters.slice();
    this._finishActive(session, active);
    this._emit("activity", { status: "answer_recovered", reason, elapsedMs: Date.now() - active.startedAtMs });
    for (const waiter of waiters) waiter.resolve(withRouteMode({ answer, chart: null }, active.businessMode));
    return true;
  }

  _newActive(turnId, waiter, options = {}) {
    const done = deferred();
    return {
      turnId,
      waiters: waiter ? [waiter] : [],
      messages: new Map(),
      finalText: "",
      lastText: "",
      toolCalls: 0,
      allowTools: options.allowTools !== false,
      businessMode: options.businessMode === true,
      routeReason: options.routeReason || "general-intent",
      warmup: options.warmup === true,
      steerCount: 0,
      steerInputBytes: 0,
      steerInFlight: false,
      pendingCompletion: null,
      done,
      prefetchedQueryFingerprint: null,
      prefetchedFactAvailable: false,
      prefetchedFactView: null,
      latestFactView: null,
      factGeneration: 0,
      fallbackBlockedUntilFreshScope: false,
      requiredFallbackQueryFingerprint: null,
      fallbackFactFingerprint: null,
      successfulFactQueryCount: 0,
      supersededFactFingerprints: new Set(),
      factBytesSent: 0,
      queryPlan: null,
      question: "",
      inputBytes: 0,
      replayTurnParams: null,
      startedAtMs: Date.now(),
      toolStartedAtMs: null,
      timeoutMs: Number(options.timeoutMs || 0),
      timeout: null,
      totalTimeoutMs: Number(options.totalTimeoutMs || options.timeoutMs || 0),
      deadlineAtMs: Date.now() + Number(options.totalTimeoutMs || options.timeoutMs || 0),
      absoluteTimeout: null,
      deadlineExceeded: false,
      deadlineTimeoutMs: null,
      deadlineHandling: null,
      abortController: new AbortController(),
      queryAbortController: null,
      streamedMessageBytes: 0,
      inFlightToolCount: 0
    };
  }

  _abortActive(active, message) {
    this._cancelActiveQuery(active, message);
    if (!active.abortController.signal.aborted) active.abortController.abort(abortError(message));
  }

  _cancelActiveQuery(active, message = "销帮帮查询范围已更新。") {
    if (active.queryAbortController && !active.queryAbortController.signal.aborted) {
      active.queryAbortController.abort(abortError(message));
    }
  }

  _beginActiveQuery(active) {
    this._cancelActiveQuery(active, "新的销帮帮查询已接替上一查询。");
    const controller = new AbortController();
    const propagateAbort = () => {
      if (!controller.signal.aborted) controller.abort(active.abortController.signal.reason || abortError());
    };
    if (active.abortController.signal.aborted) propagateAbort();
    else active.abortController.signal.addEventListener("abort", propagateAbort, { once: true });
    active.queryAbortController = controller;
    return Object.freeze({
      signal: controller.signal,
      cleanup: () => {
        active.abortController.signal.removeEventListener("abort", propagateAbort);
        if (active.queryAbortController === controller) active.queryAbortController = null;
      }
    });
  }

  _pauseTurnTimeout(active) {
    if (active.timeout) clearTimeout(active.timeout);
    active.timeout = null;
  }

  _armTurnTimeout(session, active) {
    this._pauseTurnTimeout(active);
    if (session.active !== active || active.deadlineExceeded || active.inFlightToolCount > 0) return;
    active.timeout = setTimeout(() => {
      active.timeout = null;
      if (session.active !== active || active.deadlineExceeded) return;
      active.deadlineExceeded = true;
      active.deadlineTimeoutMs = active.timeoutMs;
      this._abortActive(active, "Codex Agent 本轮生成阶段超过时限。");
      active.deadlineHandling = this._timeoutTurn(session, active).catch(() => {});
    }, active.timeoutMs);
    active.timeout.unref?.();
  }

  _armAbsoluteTimeout(session, active) {
    if (active.absoluteTimeout) clearTimeout(active.absoluteTimeout);
    if (session.active !== active || active.deadlineExceeded) return;
    const remainingMs = Math.max(0, active.deadlineAtMs - Date.now());
    active.absoluteTimeout = setTimeout(() => {
      active.absoluteTimeout = null;
      if (session.active !== active || active.deadlineExceeded) return;
      active.deadlineExceeded = true;
      active.deadlineTimeoutMs = active.totalTimeoutMs;
      this._abortActive(active, "Codex Agent 本轮端到端处理超过绝对时限。");
      active.deadlineHandling = this._timeoutTurn(session, active).catch(() => {});
    }, remainingMs);
    active.absoluteTimeout.unref?.();
  }

  async _handleServerRequest(request) {
    if (request.method !== "item/tool/call") {
      this.client.reject(request.id, "企业微信 Codex Agent 不支持此交互请求。");
      return;
    }
    const { threadId, turnId, tool, arguments: args } = request.params || {};
    const session = [...this.sessions.values()].find((value) => value.threadId === threadId);
    if (!session?.active || session.active.turnId !== turnId || tool !== "query_xbb" || !session.access) {
      this.client.reject(request.id, "未授权或失效的经营分析工具请求。");
      return;
    }
    const active = session.active;
    if (!active.allowTools) {
      const message = active.businessMode ? "后台预热不允许查询业务数据。" : "本轮不是销帮帮经营问题，不能调用 query_xbb。";
      this.client.respond(request.id, { success: false, contentItems: [{ type: "inputText", text: JSON.stringify({ status: "error", message }) }] });
      return;
    }
    if (active.inFlightToolCount > 0) {
      this.client.respond(request.id, { success: false, contentItems: [{ type: "inputText", text: JSON.stringify({ status: "error", message: "同一轮已有实时查询正在执行；请先使用该查询返回的事实。" }) }] });
      return;
    }
    active.toolCalls += 1;
    if (active.toolCalls > 4) {
      this.client.respond(request.id, { success: false, contentItems: [{ type: "inputText", text: JSON.stringify({ status: "error", message: "工具调用轮次超过安全上限。" }) }] });
      return;
    }
    const toolQueryFingerprint = queryFingerprint(args);
    if (toolQueryFingerprint && active.supersededFactFingerprints.has(toolQueryFingerprint)) {
      this.client.respond(request.id, {
        success: true,
        contentItems: [{
          type: "inputText",
          text: JSON.stringify({
            status: "superseded",
            message: "该查询范围已被用户最新要求替代；未返回旧范围事实，请按最新问题重新调用 query_xbb。"
          })
        }]
      });
      return;
    }
    const priorFallbackFingerprint = active.fallbackFactFingerprint;
    if (active.latestFactView && (!toolQueryFingerprint || toolQueryFingerprint !== priorFallbackFingerprint)) {
      if (priorFallbackFingerprint) active.supersededFactFingerprints.add(priorFallbackFingerprint);
      if (toolQueryFingerprint) active.supersededFactFingerprints.delete(toolQueryFingerprint);
      active.factGeneration += 1;
      active.fallbackBlockedUntilFreshScope = true;
      active.requiredFallbackQueryFingerprint = toolQueryFingerprint;
      active.prefetchedQueryFingerprint = null;
      active.prefetchedFactAvailable = false;
      active.prefetchedFactView = null;
      active.latestFactView = null;
    }
    const factGeneration = active.factGeneration;
    active.inFlightToolCount += 1;
    active.toolStartedAtMs = Date.now();
    this._pauseTurnTimeout(active);
    this._emit("activity", { status: "tool_started" });
    active.queryPlan = args;
    try {
      await this._notifyQueryProgress(session, args, session.access, {
        stage: "run_started",
        completed: 0,
        total: Array.isArray(args?.months) ? args.months.length : 1
      });
      if (session.active !== active || active.abortController.signal.aborted) return;
      if (active.prefetchedFactAvailable && queryFingerprint(args) === active.prefetchedQueryFingerprint) {
        await this._notifyQueryProgress(session, args, session.access, {
          stage: "query_ready",
          completed: Array.isArray(args?.months) ? args.months.length : 1,
          total: Array.isArray(args?.months) ? args.months.length : 1
        });
        if (session.active !== active || active.abortController.signal.aborted) return;
        this.client.respond(request.id, {
          success: true,
          contentItems: [{
            type: "inputText",
            text: JSON.stringify({
              status: "ready",
              reusedPrefetch: true,
              sourceFactPackSha256: active.prefetchedFactView?.sourceFactPackSha256 || null,
              message: "同一范围的已校验事实视图已在本轮输入中，请直接使用，不重复注入。"
            })
          }]
        });
        this._emit("activity", { status: "tool_completed", elapsedMs: Date.now() - active.toolStartedAtMs });
        return;
      }
      const subscription = this._beginActiveQuery(active);
      let result;
      try {
        result = await this.queryXbb(args, session.access, {
          signal: subscription.signal,
          onProgress: (event) => session.active === active
            && !active.abortController.signal.aborted
            && active.factGeneration === factGeneration
            ? this._notifyQueryProgress(session, args, session.access, event)
            : undefined
        });
      } finally {
        subscription.cleanup();
      }
      if (session.active !== active || active.abortController.signal.aborted) return;
      if (active.factGeneration !== factGeneration) {
        this.client.respond(request.id, {
          success: true,
          contentItems: [{
            type: "inputText",
            text: JSON.stringify({
              status: "superseded",
              message: "查询执行期间用户已更新范围；旧范围结果已丢弃，请按最新问题重新调用 query_xbb。"
            })
          }]
        });
        this._emit("activity", { status: "tool_completed", elapsedMs: Date.now() - active.toolStartedAtMs });
        return;
      }
      const remainingBytes = MAX_TURN_FACT_BYTES - active.factBytesSent;
      if (remainingBytes < 16 * 1024) throw new Error("本轮事实预算已被当前查询占用；请使用已返回的完整汇总继续回答。");
      const view = buildModelFactView(result, { maxBytes: Math.min(MAX_MODEL_FACT_VIEW_BYTES, remainingBytes) });
      const viewText = JSON.stringify(view);
      const fallbackScopeMatches = !active.fallbackBlockedUntilFreshScope
        || (active.requiredFallbackQueryFingerprint && toolQueryFingerprint === active.requiredFallbackQueryFingerprint);
      if (session.active === active && active.factGeneration === factGeneration && fallbackScopeMatches) {
        const conflictsWithPriorFacts = active.successfulFactQueryCount > 0
          && active.fallbackFactFingerprint
          && active.fallbackFactFingerprint !== toolQueryFingerprint;
        active.successfulFactQueryCount += 1;
        if (conflictsWithPriorFacts) {
          active.latestFactView = null;
          active.fallbackBlockedUntilFreshScope = true;
          active.requiredFallbackQueryFingerprint = null;
          active.fallbackFactFingerprint = null;
        } else {
          active.latestFactView = view;
          active.fallbackFactFingerprint = toolQueryFingerprint;
          active.fallbackBlockedUntilFreshScope = false;
          active.requiredFallbackQueryFingerprint = null;
        }
      }
      active.factBytesSent += Buffer.byteLength(viewText, "utf8");
      active.inputBytes += Buffer.byteLength(viewText, "utf8");
      this.client.respond(request.id, { success: true, contentItems: [{ type: "inputText", text: viewText }] });
      this._emit("activity", { status: "tool_completed", elapsedMs: Date.now() - active.toolStartedAtMs });
    } catch (error) {
      if (session.active !== active || active.abortController.signal.aborted) return;
      if (active.factGeneration !== factGeneration) {
        this.client.respond(request.id, {
          success: true,
          contentItems: [{
            type: "inputText",
            text: JSON.stringify({
              status: "superseded",
              message: "查询执行期间用户已更新范围；旧范围订阅已取消，请按最新问题重新调用 query_xbb。"
            })
          }]
        });
        return;
      }
      const message = error instanceof AccessDeniedError ? error.message : (error?.message || "实时销帮帮查询失败。");
      this.client.respond(request.id, { success: false, contentItems: [{ type: "inputText", text: JSON.stringify({ status: "error", message }) }] });
      this._emit("activity", { status: "tool_failed", elapsedMs: Date.now() - active.toolStartedAtMs });
    } finally {
      active.inFlightToolCount = Math.max(0, active.inFlightToolCount - 1);
      this._armTurnTimeout(session, active);
    }
  }

  async _handleNotification({ method, params }) {
    const threadId = params?.threadId || params?.thread?.id;
    const session = [...this.sessions.values()].find((value) => value.threadId === threadId);
    if (!session) return;
    if (method === "thread/tokenUsage/updated") {
      const usage = params?.tokenUsage;
      if (usage && typeof usage === "object") session.tokenUsage = usage;
      return;
    }
    if (method === "turn/started") {
      const turnId = params?.turn?.id;
      if (session.active && typeof turnId === "string" && (!session.active.turnId || session.active.turnId === turnId)) {
        session.active.turnId = turnId;
      }
      return;
    }
    if (method === "item/started" && params?.item?.type === "agentMessage" && session.active && params.turnId === session.active.turnId) {
      if (session.active.messages.has(params.item.id) || session.active.messages.size < MAX_AGENT_MESSAGE_ITEMS) {
        session.active.messages.set(params.item.id, { text: "", phase: params.item.phase || null });
      }
      return;
    }
    if (method === "item/agentMessage/delta" && session.active && params.turnId === session.active.turnId) {
      const active = session.active;
      let current = active.messages.get(params.itemId);
      if (!current) {
        if (active.messages.size >= MAX_AGENT_MESSAGE_ITEMS) return;
        current = { text: "", phase: null };
      }
      const remainingBytes = Math.min(
        MAX_AGENT_MESSAGE_BYTES - Buffer.byteLength(current.text, "utf8"),
        MAX_AGENT_STREAM_BYTES - active.streamedMessageBytes
      );
      const delta = utf8Prefix(params.delta, remainingBytes);
      current.text += delta;
      active.streamedMessageBytes += Buffer.byteLength(delta, "utf8");
      active.messages.set(params.itemId, current);
      return;
    }
    if (method === "item/completed" && params?.item?.type === "agentMessage" && session.active && params.turnId === session.active.turnId) {
      const text = utf8Prefix(params.item.text || session.active.messages.get(params.item.id)?.text || "", MAX_AGENT_MESSAGE_BYTES).trim();
      const phase = params.item.phase || session.active.messages.get(params.item.id)?.phase || null;
      if (text) {
        session.active.lastText = text;
        if (phase === "final_answer") session.active.finalText = text;
        // 企业微信只显示桥接层的短状态，不转发模型内部 commentary。
      }
      return;
    }
    if (method === "turn/completed" && session.active && params?.turn?.id === session.active.turnId) {
      if (session.active.steerInFlight) session.active.pendingCompletion = params.turn;
      else this._completeTurn(session, params.turn);
    }
  }

  _completeTurn(session, turn) {
    const active = session.active;
    if (!active) return;
    if (active.timeout) clearTimeout(active.timeout);
    const items = Array.isArray(turn?.items) ? turn.items : [];
    const agentMessages = items.filter((item) => item?.type === "agentMessage" && typeof item.text === "string");
    const finalItem = [...agentMessages].reverse().find((item) => item.phase === "final_answer") || agentMessages.at(-1);
    const rawAnswer = active.finalText || utf8Prefix(finalItem?.text || "", MAX_AGENT_MESSAGE_BYTES) || active.lastText || "";
    if (turn?.status === "completed" && rawAnswer) {
      try {
        const answer = parseAgentResponse(rawAnswer, {
          onChartInvalid: () => this._emit("activity", { status: "chart_failed" })
        });
        const refusalReason = active.businessMode ? falseTechnicalRefusalReason(answer.answer, active.latestFactView) : null;
        if (refusalReason) {
          if (this._resolveVerifiedFallback(session, active, refusalReason)) {
            this._invalidateThread(session, refusalReason);
            return;
          }
          throw new Error("Codex Agent 对完整事实返回了技术性拒答。");
        }
        this._recordSuccessfulTurn(session, active);
        const waiters = active.waiters.slice();
        this._finishActive(session, active);
        this._emit("activity", { status: "turn_completed", elapsedMs: Date.now() - active.startedAtMs });
        for (const waiter of waiters) waiter.resolve(withRouteMode(answer, active.businessMode));
        return;
      } catch (error) {
        if (this._resolveVerifiedFallback(session, active, "invalid_model_response")) {
          this._invalidateThread(session, "invalid_model_response");
          return;
        }
        const waiters = active.waiters.slice();
        this._recordTerminalTurn(session);
        this._finishActive(session, active);
        this._emit("activity", { status: "turn_failed", elapsedMs: Date.now() - active.startedAtMs, reason: "invalid_model_response" });
        const routedError = routedTurnError(error, active.businessMode);
        for (const waiter of waiters) waiter.reject(routedError);
        return;
      }
    } else {
      if (this._resolveVerifiedFallback(session, active, `turn_${turn?.status || "empty"}`)) {
        this._invalidateThread(session, `turn_${turn?.status || "empty"}`);
        return;
      }
      const waiters = active.waiters.slice();
      this._recordTerminalTurn(session);
      this._finishActive(session, active);
      this._emit("activity", { status: "turn_failed", elapsedMs: Date.now() - active.startedAtMs, reason: `turn_${turn?.status || "empty"}` });
      const error = new AgentTurnFailureError(
        turn?.status === "interrupted" ? "Codex 任务已中断。" : "Codex Agent 未生成可用最终答复。",
        active.businessMode ? "xbb" : "general"
      );
      for (const waiter of waiters) waiter.reject(error);
    }
  }

  async _timeoutTurn(session, active) {
    if (session.active !== active) return;
    active.deadlineExceeded = true;
    this._abortActive(active, "Codex Agent 本轮绝对截止时间已到。");
    try { if (active.turnId) await this.client.interruptTurn(session.threadId, active.turnId); } catch {}
    if (session.active !== active) return;
    if (this._resolveVerifiedFallback(session, active, "turn_timeout")) {
      this._invalidateThread(session, "turn_timeout");
      return;
    }
    const waiters = active.waiters.slice();
    this._finishActive(session, active);
    this._invalidateThread(session, "turn_timeout");
    this._emit("activity", { status: "turn_failed", elapsedMs: Date.now() - active.startedAtMs, reason: "turn_timeout" });
    const error = new AgentTurnTimeoutError(
      active.businessMode ? "xbb" : "general",
      active.deadlineTimeoutMs || active.timeoutMs
    );
    for (const waiter of waiters) waiter.reject(error);
  }

  async _notifyWaiter(waiter, text, sanitize = true) {
    if (typeof waiter.onProgress !== "function") return;
    const content = sanitize ? sanitizeAgentText(text, { maxBytes: 4000 }) : text;
    if (!content) return;
    try { await waiter.onProgress(content); } catch {}
  }

  async _notifyProgress(session, text) {
    if (!session.active) return;
    await Promise.all(session.active.waiters.map((waiter) => this._notifyWaiter(waiter, text)));
  }

  async _notifyQueryProgress(session, input, access, event) {
    const text = formatQueryProgress(input, event, access);
    if (text) await this._notifyProgress(session, text);
  }

  _fatal(message) {
    if (this.closing || this.fatalError) return;
    this.fatalError = new Error(message);
    this.started = false;
    for (const session of this.sessions.values()) {
      this._rejectQueuedRequests(session, this.fatalError);
      if (!session.active) continue;
      const active = session.active;
      this._abortActive(active, message);
      for (const waiter of active.waiters) waiter.reject(this.fatalError);
      this._invalidateThread(session, "agent_fatal");
      this._finishActive(session, active);
    }
    this._emit("fatal", { message });
  }

  async close() {
    if (this.closing) return;
    this.closing = true;
    this.started = false;
    const closingError = new Error("Codex Agent 服务正在停止。");
    for (const session of this.sessions.values()) {
      this._rejectQueuedRequests(session, closingError);
      if (!session.active) continue;
      const active = session.active;
      this._abortActive(active, closingError.message);
      for (const waiter of active.waiters) waiter.reject(closingError);
      this._invalidateThread(session, "agent_closing");
      this._finishActive(session, active);
    }
    try { if (this.client) await this.client.close(); } finally { if (this.host) await this.host.close(); }
  }
}

module.exports = {
  AgentTurnFailureError,
  AgentTurnTimeoutError,
  PersistentCodexAgent,
  accessLabel,
  extractActiveTurnId,
  extractThreadId,
  extractTurnId,
  principalKeyFromUserId,
  shanghaiDateLabel
};
