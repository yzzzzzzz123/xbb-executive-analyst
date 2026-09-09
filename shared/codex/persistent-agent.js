"use strict";

const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const { AccessDeniedError } = require("../security/access-control.js");
const { sanitizeAgentText } = require("../security/output-sanitizer.js");
const { SOURCE_FILES, SkillKnowledgeBase } = require("../rag/skill-knowledge-base.js");
const { routeSkill } = require("../rag/skill-router.js");
const {
  GATEWAY_FAIL_CLOSED_CODE,
  PROCESS_TREE_UNCONFIRMED_CODE,
  createToolGateway
} = require("../xbb/tool-gateway.js");
const { RUNNER_ISOLATION_ERROR_CODE } = require("../xbb/runner-isolation.js");
const { MAX_MODEL_FACT_VIEW_BYTES, buildModelFactView } = require("../xbb/model-fact-view.js");
const { QUERY_XBB_DYNAMIC_TOOL, queryToolContractHash } = require("../xbb/query-tool.js");
const { chooseTurnEffort, hasExplicitPeriod, planFastQuery, validateRequestedMonths } = require("../xbb/fast-query-plan.js");
const { formatContextAnalysisProgress, formatGeneralAnalysisProgress, formatQueryProgress } = require("../xbb/query-progress.js");
const { AppServerClient } = require("./app-server-client.js");
const { LocalAppServerHost } = require("./app-server-host.js");
const { classifyModelError, safeModelErrorCode } = require("./model-error.js");
const { buildVerifiedFallbackAnswer, falseTechnicalRefusalReason, hasUsableFacts } = require("./recovery-answer.js");
const { GENERAL_RESPONSE_SCHEMA, WECOM_RESPONSE_SCHEMA, parseAgentResponse, responseContractHash } = require("./response-contract.js");
const { loadAgentState, saveAgentState } = require("./state-store.js");
const { buildThreadInstructions } = require("./thread-instructions.js");
const {
  MAX_USER_QUESTION_BYTES,
  buildComplexTaskGuidance,
  chooseGeneralTurnEffort,
  formatTaskContext,
  formatUserMessage,
  isTaskContinuation,
  updateTaskContext
} = require("./context-policy.js");
const { readCodexVersion, verifyCodexChatGptLogin } = require("./runtime.js");

const MAX_SESSION_ESTIMATED_INPUT_BYTES = 256 * 1024;
const MAX_SESSION_TURNS = 24;
const CONTEXT_ROTATION_RATIO = 0.7;
const MAX_TURN_FACT_BYTES = 128 * 1024;
const MAX_STEER_COUNT = 8;
const MAX_STEER_INPUT_BYTES = 64 * 1024;
const MAX_AGENT_MESSAGE_ITEMS = 32;
const MAX_AGENT_MESSAGE_BYTES = 64 * 1024;
const MAX_AGENT_STREAM_BYTES = 128 * 1024;
const MAX_CONSECUTIVE_TURN_START_FAILURES = 2;
const MAX_SESSION_QUEUED_REQUESTS = 8;
const DEFAULT_BUSINESS_TOTAL_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_GENERAL_TOTAL_TIMEOUT_MS = 15 * 60 * 1000;
const QUERY_TIMING_TERMINAL_STAGES = new Set(["completed", "failed", "cancelled", "expired", "rejected"]);
const DOMAIN_QUERY_HINTS = Object.freeze({
  performance: "业绩",
  "product-sales": "产品成交",
  courses: "开课参课",
  delivery: "交付邀约",
  opportunities: "商机"
});
const PREFETCH_SCOPE_CORRECTION_PATTERN = /^(?:(?:请|麻烦)(?:帮我)?)?(?:改(?:成|为|看)?|换(?:成|为|个|看)?|切换(?:到|为)?|只看|再(?:只)?看|按|重新(?:只)?看|现在(?:只)?看)/u;
const ENTITY_SCOPE_PATTERN = /(?:分?公司|业务员|员工|人员|负责人|创建人|举办方|销售(?!机会|数量|金额|额|业绩|阶段|趋势|排名|排行|占比|质量|漏斗|预测|分析))/u;

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

function steerInput(question, context = null) {
  return [{
    type: "text",
    text: [
      "【用户追问/修正】",
      formatUserMessage(question),
      ...(buildComplexTaskGuidance(question, context) ? [buildComplexTaskGuidance(question, context)] : []),
      "请把这条消息作为当前用户的最新要求：与原问题冲突时以本条为准；最终回答同时回应仍然有效的原问题和本条追问。"
    ].join("\n"),
    text_elements: []
  }];
}

function normalizedCorrectionText(question) {
  return String(question || "").trim().replace(/\s+/g, "");
}

function isPrefetchScopeCorrection(question) {
  const text = normalizedCorrectionText(question);
  if (!text) return false;
  return PREFETCH_SCOPE_CORRECTION_PATTERN.test(text)
    || (ENTITY_SCOPE_PATTERN.test(text) && /(?:呢|怎么样|什么情况|情况)[？?!！。.]?$/u.test(text));
}

function isGenericEntityDimension(question) {
  const text = normalizedCorrectionText(question).replace(PREFETCH_SCOPE_CORRECTION_PATTERN, "").replace(/^[：:,，]/u, "");
  return /^(?:(?:集团)?(?:各(?:个)?|全部|所有))(?:分?公司|销售(?:员|人员)?|业务员|员工|人员)(?:排名|排行|占比|分布|情况|汇总|分析|怎么样|呢|看)?[？?!！。.]?$/u.test(text)
    || /^(?:分?公司|销售(?:员|人员)?|业务员|员工|人员)(?:排名|排行|占比|分布|汇总|分析)[？?!！。.]?$/u.test(text);
}

function isEntityScopeCorrection(question) {
  const text = normalizedCorrectionText(question);
  return isPrefetchScopeCorrection(text) && ENTITY_SCOPE_PATTERN.test(text) && !isGenericEntityDimension(text);
}

function initialPreStartContext(question) {
  return updateTaskContext(null, question, { mode: "xbb" });
}

function appendPreStartContext(context, question) {
  return updateTaskContext(context, question, { mode: "xbb", continuation: true });
}

function inheritedCorrectionPlan(question, activePlan) {
  if (!activePlan || !Array.isArray(activePlan.months) || !Array.isArray(activePlan.domains)) return planFastQuery(question);
  const directPlan = planFastQuery(question);
  const domains = directPlan?.domains?.length ? [...directPlan.domains] : [...activePlan.domains];
  const text = String(question || "");
  const standaloneMonth = !hasExplicitPeriod(text)
    ? [...text.matchAll(/(?<!\d)(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月/g)].at(-1)
    : null;
  const hasPeriodCorrection = hasExplicitPeriod(text) || Boolean(standaloneMonth);
  let months = [...activePlan.months];
  if (hasPeriodCorrection) {
    const hints = domains.map((domain) => DOMAIN_QUERY_HINTS[domain] || "").filter(Boolean).join(" ");
    const inheritedPlan = planFastQuery(`${hints} ${text}`);
    if (inheritedPlan?.months?.length) months = [...inheritedPlan.months];
    if (standaloneMonth) {
      const month = Number(standaloneMonth[2]);
      if (month < 1 || month > 12) throw new Error("月份必须在 1 至 12 之间。");
      const contextualYear = String(activePlan.months.at(-1) || "").slice(0, 4);
      const year = standaloneMonth[1] || contextualYear;
      months = validateRequestedMonths([`${year}-${String(month).padStart(2, "0")}`]);
    }
  }
  return Object.freeze({
    ...activePlan,
    months: Object.freeze(months),
    domains: Object.freeze(domains)
  });
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
    taskContext: null,
    accessFingerprint: null,
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
    this.modelErrorCode = safeModelErrorCode(options.modelErrorCode);
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
      interaction: "bounded-task-context-recoverable-xbb-skill-v5",
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
    this.startPromise = null;
    this.startupController = null;
    this.closePromise = null;
    this.fatalError = null;
    this.consecutiveAppServerFailures = 0;
    this.warmedPrincipals = new Set();
    const toolGatewayFactory = options.toolGatewayFactory || createToolGateway;
    this.queryXbb = options.queryXbb || toolGatewayFactory({
      projectRoot: this.projectRoot,
      serviceLeasePath: this.config.serviceLeasePath,
      onIsolationFailure: () => this._fatal("销帮帮查询进程隔离状态失效，服务将自动重启。")
    });
  }

  _emit(event, payload) {
    try { return super.emit(event, payload); } catch { return false; }
  }

  _assertStartupActive(signal) {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : abortError("Codex Agent 启动已取消。");
    if (this.fatalError) throw this.fatalError;
    if (this.closing) throw new Error("Codex Agent 服务正在停止。");
  }

  async start(options = {}) {
    if (this.started) return;
    if (this.startPromise) return this.startPromise;
    const externalSignal = options.signal;
    const startupController = new AbortController();
    const relayAbort = () => startupController.abort(
      externalSignal?.reason instanceof Error ? externalSignal.reason : abortError("Codex Agent 启动已取消。")
    );
    if (externalSignal?.aborted) relayAbort();
    else externalSignal?.addEventListener("abort", relayAbort, { once: true });
    this.startupController = startupController;
    const operation = this._startWithSignal(startupController.signal);
    this.startPromise = operation;
    try {
      return await operation;
    } finally {
      externalSignal?.removeEventListener("abort", relayAbort);
      if (this.startupController === startupController) this.startupController = null;
      if (this.startPromise === operation) this.startPromise = null;
    }
  }

  async _startWithSignal(signal) {
    this._assertStartupActive(signal);
    this.verifyLogin(this.config);
    this._assertStartupActive(signal);
    const codexVersion = this.readVersion(this.config);
    this._assertStartupActive(signal);
    this.state = this.loadState(this.statePath);
    this.state.codexVersion = codexVersion;
    let startupHost = null;
    let startupClient = null;
    try {
      startupHost = await this.hostFactory.start(
        { ...this.config, projectRoot: this.projectRoot },
        { signal }
      );
      this._assertStartupActive(signal);
      this.host = startupHost;
      startupClient = this.clientFactory(startupHost);
      this._assertStartupActive(signal);
      this.client = startupClient;
      startupClient.on("notification", (event) => { void this._handleNotification(event); });
      startupClient.on("serverRequest", (request) => {
        void this._handleServerRequest(request).catch(() => {
          try { startupClient.reject(request.id, "经营分析工具请求处理失败。"); } catch {}
        });
      });
      startupClient.on("transportError", () => this._fatal("Codex App Server 传输错误。"));
      startupClient.on("protocolError", () => this._fatal("Codex App Server 协议错误。"));
      startupClient.on("disconnected", () => { if (!this.closing) this._fatal("Codex App Server 连接已断开。"); });
      startupHost.process.once("exit", () => { if (!this.closing) this._fatal("Codex App Server 进程已退出。"); });
      await startupClient.connect({ signal });
      this._assertStartupActive(signal);
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
      this._assertStartupActive(signal);
      this.saveState(this.statePath, this.state);
      this._assertStartupActive(signal);
      this.started = true;
      this._emit("ready", { codexVersion, resumedThreads: this.sessions.size });
    } catch (error) {
      this.started = false;
      if (startupClient) await startupClient.close().catch(() => {});
      if (startupHost) await startupHost.close().catch(() => {});
      if (this.client === startupClient) this.client = null;
      if (this.host === startupHost) this.host = null;
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : abortError("Codex Agent 启动已取消。");
      if (this.fatalError) throw this.fatalError;
      if (this.closing) throw new Error("Codex Agent 服务正在停止。");
      throw error;
    }
  }

  async answer({ question, access, principalKey, messageId, onProgress, onTiming }) {
    return this._enqueue({ question, access, principalKey, messageId, onProgress, onTiming });
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

  async _enqueue({ question, access, principalKey, messageId, onProgress, onTiming, warmup = false }) {
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
    const accessFingerprint = sha256(JSON.stringify(canonicalAccess(access)));
    if (session.accessFingerprint && session.accessFingerprint !== accessFingerprint) {
      throw new AccessDeniedError("授权范围已变化，必须使用对应权限的独立会话。", "session_scope_mismatch");
    }
    session.accessFingerprint = accessFingerprint;
    const waiter = { ...deferred(), onProgress, onTiming };
    const request = { question: question.trim(), access, messageId, waiter, warmup };
    if (this._takeOverChangedPrefetch(session, request)) return waiter.promise;
    this._queueRequest(session, request);
    this._drainSessionQueue(session);
    return waiter.promise;
  }

  _resolveHandoff(session, request) {
    const priorMode = session.active ? (session.active.businessMode ? "xbb" : "general") : session.lastMode;
    const route = request.warmup ? "xbb" : routeSkill(request.question, priorMode).mode;
    request.waiter.resolve(withRouteMode(FOLLOW_UP_HANDOFF_RESULT, route === "xbb"));
  }

  _queueRequest(session, request, options = {}) {
    if (session.requestQueue.length >= MAX_SESSION_QUEUED_REQUESTS) {
      const displaced = session.requestQueue.splice(0);
      for (const stale of displaced) this._resolveHandoff(session, stale);
      this._emit("activity", { status: "turn_queued", reason: "latest_wins_bound" });
    }
    if (options.front) session.requestQueue.unshift(request);
    else session.requestQueue.push(request);
  }

  _takeOverChangedPrefetch(session, request) {
    const active = session.active;
    if (!active?.prefetchInFlight || active.warmup || request.warmup || active.turnId) return false;
    const activeMode = active.businessMode ? "xbb" : "general";
    const priorReplacement = active.preStartReplacement;
    const basePlan = priorReplacement && Object.hasOwn(priorReplacement, "fastPlanOverride")
      ? priorReplacement.fastPlanOverride
      : active.queryPlan;
    const incomingPlan = active.businessMode ? inheritedCorrectionPlan(request.question, basePlan) : null;
    const scopeChanged = queryFingerprint(incomingPlan) !== queryFingerprint(basePlan);
    const correctionIntent = active.businessMode && isPrefetchScopeCorrection(request.question);
    const entityScopeCorrection = correctionIntent && isEntityScopeCorrection(request.question);
    const incomingRoute = routeSkill(request.question, activeMode);
    const correctionRouteOverride = active.businessMode && correctionIntent && (scopeChanged || entityScopeCorrection);
    if (incomingRoute.mode !== activeMode && !correctionRouteOverride) return false;
    if (!scopeChanged && !entityScopeCorrection) return false;

    const priorContext = priorReplacement
      ? appendPreStartContext(priorReplacement.preStartContext || active.taskContext || initialPreStartContext(active.question), priorReplacement.question)
      : active.taskContext || initialPreStartContext(active.question);
    if (priorReplacement) this._resolveHandoff(session, priorReplacement);
    request.routeModeOverride = activeMode;
    request.fastPlanOverride = incomingPlan;
    request.preStartContext = priorContext;
    request.requiresDynamicEntityQuery = entityScopeCorrection || priorReplacement?.requiresDynamicEntityQuery === true;
    active.preStartReplacement = request;
    active.prefetchSuperseded = true;
    this._cancelActiveQuery(active, "用户已在 Turn 启动前更新销帮帮查询范围。");
    active.prefetchWake?.resolve("superseded");
    const previousWaiters = active.waiters.splice(0);
    for (const previous of previousWaiters) {
      previous.resolve(withRouteMode(FOLLOW_UP_HANDOFF_RESULT, active.businessMode));
    }
    this._emit("activity", { status: "turn_queued", reason: "prefetch_scope_replaced" });
    return true;
  }

  _handoffSupersededPrefetch(session, active) {
    if (!active.prefetchSuperseded) return false;
    const replacement = active.preStartReplacement;
    active.preStartReplacement = null;
    if (session.active === active) {
      this._finishActive(session, active);
      if (replacement) this._queueRequest(session, replacement, { front: true });
    } else if (replacement) {
      replacement.waiter.reject(this.fatalError || new Error("Codex Agent 预取接管已终止。"));
    }
    return true;
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
    if (session.active?.preStartReplacement) {
      const replacement = session.active.preStartReplacement;
      session.active.preStartReplacement = null;
      replacement.waiter.reject(error);
    }
  }

  async _submit(session, request) {
    const {
      question,
      access,
      messageId,
      waiter,
      warmup,
      routeModeOverride,
      fastPlanOverride,
      preStartContext,
      requiresDynamicEntityQuery = false
    } = request;
    this._assertOperational();
    await this._ensureThread(session);
    this._assertOperational();
    if (session.active) {
      const active = session.active;
      const activeMode = active.businessMode ? "xbb" : "general";
      const incomingRoute = warmup ? Object.freeze({ mode: "xbb", reason: "skill-warmup" }) : routeSkill(question, activeMode);
      if (!warmup && !active.warmup && incomingRoute.mode === activeMode) {
        const nextTaskContext = updateTaskContext(active.taskContext, question, { mode: activeMode, continuation: true });
        const nextSteerInput = steerInput(question, nextTaskContext);
        const nextSteerBytes = inputBytes(nextSteerInput);
        if (active.steerCount < MAX_STEER_COUNT && active.steerInputBytes + nextSteerBytes <= MAX_STEER_INPUT_BYTES) {
          return this._steerActiveTurn(session, active, { question, access, messageId, waiter, warmup, taskContext: nextTaskContext }, nextSteerInput, nextSteerBytes);
        }
        await this._notifyWaiter(waiter, "当前分析已接收较多补充要求；这条消息将在当前结果完成后使用新 Turn 继续处理。", false);
        this._emit("activity", { status: "turn_queued", reason: "steer_budget" });
        await active.done.promise;
        this._assertOperational();
        return this._submit(session, request);
      }
      await this._notifyWaiter(waiter, "已收到新问题。它与当前分析属于不同范围，将在上一条完成后自动继续处理。", false);
      this._emit("activity", { status: "turn_queued" });
      await active.done.promise;
      this._assertOperational();
      return this._submit(session, request);
    }

    session.access = access;
    const route = warmup
      ? Object.freeze({ mode: "xbb", reason: "skill-warmup" })
      : routeModeOverride === "xbb"
        ? Object.freeze({ mode: "xbb", reason: "prestart-correction" })
        : routeSkill(question, session.lastMode);
    const businessMode = route.mode === "xbb";
    const timeoutMs = businessMode ? this.businessTurnTimeoutMs : this.generalTurnTimeoutMs;
    const totalTimeoutMs = businessMode ? this.businessTotalTimeoutMs : this.generalTotalTimeoutMs;
    const active = this._newActive(null, waiter, { allowTools: businessMode && !warmup, businessMode, routeReason: route.reason, warmup, timeoutMs, totalTimeoutMs });
    session.active = active;
    this._armAbsoluteTimeout(session, active);
    let turnStartFailureCandidate = false;
    try {
      const hasFastPlanOverride = Object.hasOwn(request, "fastPlanOverride");
      const semanticPlan = businessMode && !warmup
        ? (hasFastPlanOverride ? fastPlanOverride : planFastQuery(question))
        : null;
      const fastPlan = requiresDynamicEntityQuery ? null : semanticPlan;
      const retrieved = businessMode ? this.knowledgeBase.retrieve(question, {
        domains: semanticPlan?.domains || [],
        periodCount: semanticPlan?.months?.length || 1
      }) : null;
      active.queryPlan = semanticPlan;
      active.question = question;
      const continuation = !warmup && (Boolean(preStartContext) || isTaskContinuation(question, session.taskContext, route.mode, route.reason));
      const priorTaskContext = preStartContext || (continuation ? session.taskContext : null);
      active.taskContext = warmup ? null : updateTaskContext(priorTaskContext, question, { mode: route.mode, continuation });
      const turnEffort = warmup ? "none" : businessMode ? chooseTurnEffort(question, this.config.codexReasoningEffort) : chooseGeneralTurnEffort(question, this.config.codexReasoningEffort);
      let prefetchedFactPack = null;
      let prefetchedFactView = null;
      if (fastPlan) {
        const prefetchWake = deferred();
        active.prefetchInFlight = true;
        active.prefetchWake = prefetchWake;
        const subscription = this._beginActiveQuery(active);
        active.toolCalls += 1;
        active.toolStartedAtMs = Date.now();
        this._emit("activity", { status: "tool_started" });
        try {
          await this._notifyQueryProgress(session, fastPlan, access, {
            stage: "run_started",
            completed: 0,
            total: fastPlan.months.length
          });
          if (this._handoffSupersededPrefetch(session, active)) return;
          if (subscription.signal.aborted) throw subscription.signal.reason || active.abortController.signal.reason || abortError();
          const queryOutcome = Promise.resolve()
            .then(() => this.queryXbb(fastPlan, access, {
              signal: subscription.signal,
              schedulingProgress: true,
              onTiming: this._queryTimingCallback(session, active, subscription.signal),
              onProgress: (event) => session.active === active && !active.abortController.signal.aborted
                ? this._notifyQueryProgress(session, fastPlan, access, event)
                : undefined
            }))
            .then(
              (value) => ({ kind: "result", value }),
              (error) => {
                this._fatalOnRunnerTermination(error);
                return { kind: "error", error };
              }
            );
          const outcome = await Promise.race([
            queryOutcome,
            prefetchWake.promise.then((kind) => ({ kind }))
          ]);
          if (this._handoffSupersededPrefetch(session, active)) return;
          if (outcome.kind === "aborted") throw active.abortController.signal.reason || abortError();
          if (outcome.kind === "error") throw outcome.error;
          prefetchedFactPack = outcome.value;
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
          this._fatalOnRunnerTermination(error);
          this._emit("activity", { status: "tool_failed", elapsedMs: Date.now() - active.toolStartedAtMs });
          throw error;
        } finally {
          subscription.cleanup();
          if (active.prefetchWake === prefetchWake) active.prefetchWake = null;
          active.prefetchInFlight = false;
        }
        this._assertOperational();
        if (session.active !== active) return;
      }
      if (!warmup && !fastPlan) {
        await this._notifyProgress(session, businessMode ? formatContextAnalysisProgress() : formatGeneralAnalysisProgress());
        this._assertOperational();
        if (session.active !== active) return;
      }
      const continuity = continuation && priorTaskContext && !preStartContext ? [formatTaskContext(priorTaskContext)] : [];
      const taskGuidance = buildComplexTaskGuidance(question, active.taskContext);
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
            ...(preStartContext ? [
              "【本轮启动前仍有效的意图链（按出现顺序应用，后续修正优先）】",
              formatTaskContext(preStartContext),
              prefetchedFactView
                ? "以下最新问题优先；较早问题中已被覆盖的期间或范围仅是语义上下文，不得沿用。经营事实只能使用本轮最新范围的预取事实包。"
                : "以下最新问题优先；较早问题中已被覆盖的期间、公司或人员范围不得沿用，也不得使用旧范围事实。"
            ] : []),
            ...(requiresDynamicEntityQuery ? [
              "【最新实体范围必须动态查询】",
              "本轮因公司或销售人员范围修正而未注入宽范围事实。必须合并上述意图链中的仍有效期间和业务域，并在给出经营数字或结论前调用 query_xbb：最新消息明确点名实体时才传入准确 company/person；若只是各公司或销售人员的分组维度，则按当前授权集团范围查询。只有用户明确要求单一实体但名称无法唯一识别时才做最小澄清，不得猜名或沿用旧事实。"
            ] : []),
            ...continuity,
            "【可信运行元数据】",
            `上海日期：${shanghaiDateLabel()}`,
            `授权范围：${accessLabel(access)}`,
            "【用户问题】",
            formatUserMessage(question)
          ].join("\n")
        : [
            "【能力路由】通用 Codex",
            "本轮不是销帮帮经营查询，不注入经营或辅助图 Skill，不得调用 query_xbb，chart 固定为 null。请直接使用通用能力回答用户。",
            ...continuity,
            ...(taskGuidance ? [taskGuidance] : []),
            "【用户问题】",
            formatUserMessage(question)
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
    // Reject an invalid/future scope before sending a steer or transferring the
    // answer owner. A rejected correction must leave the original turn intact.
    const incomingPlan = active.businessMode ? planFastQuery(request.question) : null;
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
        active.taskContext = request.taskContext || updateTaskContext(active.taskContext, request.question, {
          mode: active.businessMode ? "xbb" : "general", continuation: true
        });
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
    if (active.warmup || !active.taskContext) return;
    session.taskContext = active.taskContext;
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
      modelErrorCode: null,
      modelRetrying: false,
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
      taskContext: null,
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
      prefetchInFlight: false,
      prefetchWake: null,
      prefetchSuperseded: false,
      preStartReplacement: null,
      streamedMessageBytes: 0,
      inFlightToolCount: 0
    };
  }

  _abortActive(active, message) {
    this._cancelActiveQuery(active, message);
    if (!active.abortController.signal.aborted) active.abortController.abort(abortError(message));
    active.prefetchWake?.resolve("aborted");
  }

  _cancelActiveQuery(active, message = "销帮帮查询范围已更新。") {
    if (active.queryAbortController && !active.queryAbortController.signal.aborted) {
      active.queryAbortController.abort(abortError(message));
    }
  }

  _fatalOnRunnerTermination(error) {
    if (![PROCESS_TREE_UNCONFIRMED_CODE, GATEWAY_FAIL_CLOSED_CODE, RUNNER_ISOLATION_ERROR_CODE].includes(error?.code)) return false;
    this._fatal("销帮帮查询网关已进入隔离保护状态，服务将自动重启。");
    return true;
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
          schedulingProgress: true,
          onTiming: this._queryTimingCallback(session, active, subscription.signal, factGeneration),
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
      if (this._fatalOnRunnerTermination(error)) return;
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
    if (method === "error" && session.active && params.turnId === session.active.turnId) {
      const active = session.active;
      active.modelErrorCode = classifyModelError(params.error);
      if (params.willRetry === true) {
        active.modelRetrying = true;
        this._emit("activity", { status: "model_retrying", modelErrorCode: active.modelErrorCode });
        await this._notifyProgress(session, "模型服务连接暂时异常，正在自动重试……\n恢复后将继续处理当前问题。");
      }
      return;
    }
    if (session.active?.modelRetrying && params.turnId === session.active.turnId
        && ((method === "item/started" && ["agentMessage", "reasoning"].includes(params.item?.type))
          || method === "item/agentMessage/delta")) {
      session.active.modelRetrying = false;
      session.active.modelErrorCode = null;
      this._emit("activity", { status: "model_responding" });
      void this._notifyProgress(session, "模型连接已恢复，正在生成答复……");
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
      const modelErrorCode = classifyModelError(turn?.error) || active.modelErrorCode;
      // 已失败的 Thread 不再伪装成可继续使用的上下文；重新登录或连接恢复后
      // 下一条消息会新建 Thread，避免再次沿用失效状态。
      this._invalidateThread(session, "model_turn_failed");
      this._finishActive(session, active);
      this._emit("activity", { status: "turn_failed", elapsedMs: Date.now() - active.startedAtMs, reason: `turn_${turn?.status || "empty"}`, modelErrorCode });
      const error = new AgentTurnFailureError(
        turn?.status === "interrupted" ? "Codex 任务已中断。" : "Codex Agent 未生成可用最终答复。",
        active.businessMode ? "xbb" : "general",
        { modelErrorCode }
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

  _queryTimingCallback(session, active, signal, factGeneration = active.factGeneration) {
    // Bind timing to the subscribers that created this query, not the active
    // waiters after a same-turn steer. Otherwise a new request inherits old work.
    const waiters = active.waiters.slice();
    let terminalForwarded = false;
    return (event) => {
      if (terminalForwarded || !QUERY_TIMING_TERMINAL_STAGES.has(event?.stage)
          || session.active !== active || active.factGeneration !== factGeneration
          || active.abortController.signal.aborted || signal.aborted) return;
      terminalForwarded = true;
      for (const waiter of waiters) {
        if (typeof waiter.onTiming !== "function") continue;
        try { Promise.resolve(waiter.onTiming(event)).catch(() => {}); } catch {}
      }
    };
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
    if (this.startupController && !this.startupController.signal.aborted) {
      this.startupController.abort(this.fatalError);
    }
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
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.started = false;
    const closingError = new Error("Codex Agent 服务正在停止。");
    if (this.startupController && !this.startupController.signal.aborted) {
      this.startupController.abort(closingError);
    }
    this.closePromise = (async () => {
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
    })();
    return this.closePromise;
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
