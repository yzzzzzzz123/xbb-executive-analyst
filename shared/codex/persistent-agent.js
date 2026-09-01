"use strict";

const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const { AccessDeniedError } = require("../security/access-control.js");
const { sanitizeAgentText } = require("../security/output-sanitizer.js");
const { SkillKnowledgeBase } = require("../rag/skill-knowledge-base.js");
const { createToolGateway } = require("../xbb/tool-gateway.js");
const { QUERY_XBB_DYNAMIC_TOOL, queryToolContractHash } = require("../xbb/query-tool.js");
const { chooseTurnEffort, planFastQuery } = require("../xbb/fast-query-plan.js");
const { AppServerClient } = require("./app-server-client.js");
const { LocalAppServerHost } = require("./app-server-host.js");
const { WECOM_RESPONSE_SCHEMA, parseAgentResponse, responseContractHash } = require("./response-contract.js");
const { loadAgentState, saveAgentState } = require("./state-store.js");
const { buildThreadInstructions } = require("./thread-instructions.js");
const { readCodexVersion, verifyCodexChatGptLogin } = require("./runtime.js");

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function principalKeyFromUserId(userId, access) {
  if (typeof userId !== "string" || !userId) throw new Error("企业微信 USERID 不能为空。");
  return sha256(JSON.stringify({ channel: "wecom", userId, access: accessLabel(access) }));
}

function shanghaiDateLabel(now = new Date()) {
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function accessLabel(access) {
  if (access?.scope === "all") return "集团全部公司只读权限";
  if (access?.scope === "companies" && Array.isArray(access.companies)) return `仅限公司：${access.companies.join("、")}`;
  throw new Error("经营分析访问范围无效。");
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

class AgentBusyError extends Error {
  constructor() {
    super("上一条经营分析仍在处理中。");
    this.name = "AgentBusyError";
  }
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
    this.turnTimeoutMs = config.agentTurnTimeoutMs || 5 * 60 * 1000;
    this.contractHash = sha256(JSON.stringify({
      instructions: this.instructions,
      tool: queryToolContractHash(),
      response: responseContractHash(),
      model: config.codexModel,
      effort: config.codexReasoningEffort,
      interaction: "skill-rag-v1",
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
    this.warmedPrincipals = new Set();
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
      const session = { principalKey, threadId: stored.threadId, active: null, access: null, operation: Promise.resolve() };
      this.sessions.set(principalKey, session);
      try {
        const resumed = await this.client.resumeThread(stored.threadId, {
          cwd: this.projectRoot,
          model: this.config.codexModel,
          approvalPolicy: "never",
          sandbox: "read-only",
          developerInstructions: this.instructions,
          excludeTurns: false
        });
        const activeTurnId = extractActiveTurnId(resumed);
        if (activeTurnId) await this.client.interruptTurn(stored.threadId, activeTurnId).catch(() => {});
      } catch (error) {
        this.sessions.delete(principalKey);
        delete this.state.threads[principalKey];
      }
    }
    this.saveState(this.statePath, this.state);
    this.started = true;
    this.emit("ready", { codexVersion, resumedThreads: this.sessions.size });
  }

  async answer({ question, access, principalKey, messageId, onProgress }) {
    return this._enqueue({ question, access, principalKey, messageId, onProgress });
  }

  async warm(options = {}) {
    const startedAtMs = Date.now();
    this.emit("activity", { status: "agent_warming" });
    const stats = this.knowledgeBase.stats();
    if (stats.sources !== 5 || stats.chunks < 15 || stats.sourceBytes < 1000) throw new Error("完整 Skill RAG 知识库未成功预热。");
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
    this.emit("activity", { status: "agent_warmed", elapsedMs: Date.now() - startedAtMs });
    return Object.freeze({ ...stats, principals: principals.length });
  }

  async _enqueue({ question, access, principalKey, messageId, onProgress, warmup = false }) {
    if (!this.started || !this.client) throw new Error("Codex Agent 尚未就绪。");
    if (typeof question !== "string" || !question.trim()) throw new Error("经营问题不能为空。");
    if (!/^[a-f0-9]{64}$/.test(principalKey)) throw new Error("Codex Agent principal key 无效。");
    let session = this.sessions.get(principalKey);
    if (!session) {
      session = { principalKey, threadId: null, active: null, access: null, operation: Promise.resolve() };
      this.sessions.set(principalKey, session);
    }
    const waiter = { ...deferred(), onProgress };
    session.operation = session.operation.then(
      () => this._submit(session, { question: question.trim(), access, messageId, waiter, warmup }),
      () => this._submit(session, { question: question.trim(), access, messageId, waiter, warmup })
    );
    try { await session.operation; } catch (error) { waiter.reject(error); }
    return waiter.promise;
  }

  async _submit(session, { question, access, messageId, waiter, warmup }) {
    if (!session.threadId) await this._startThread(session);
    if (session.active) {
      this.emit("activity", { status: "agent_busy" });
      throw new AgentBusyError();
    }

    session.access = access;
    const active = this._newActive(null, waiter, { allowTools: !warmup });
    session.active = active;
    try {
      const retrieved = this.knowledgeBase.retrieve(question);
      const fastPlan = warmup ? null : planFastQuery(question);
      const turnEffort = warmup ? "none" : chooseTurnEffort(question, this.config.codexReasoningEffort);
      let prefetchedFactPack = null;
      if (fastPlan) {
        active.toolCalls += 1;
        active.toolStartedAtMs = Date.now();
        this.emit("activity", { status: "tool_started" });
        await this._notifyProgress(session, "正在查询销帮帮实时只读数据，请稍候……");
        try {
          prefetchedFactPack = await this.queryXbb(fastPlan, access);
          this.emit("activity", { status: "tool_completed", elapsedMs: Date.now() - active.toolStartedAtMs });
          await this._notifyProgress(session, "实时数据已取回，正在生成结论和图表……");
        } catch (error) {
          this.emit("activity", { status: "tool_failed", elapsedMs: Date.now() - active.toolStartedAtMs });
          throw error;
        }
      }
      const input = [
        {
          type: "text",
          text: [
            "【RAG 适用规则】",
            retrieved.text,
            ...(prefetchedFactPack ? [
              "【本轮 query_xbb 实时预取事实包】",
              JSON.stringify(prefetchedFactPack),
              "该事实包已在本轮按授权范围实时查询并通过完整性与隐私校验。直接分析；只有事实确实缺失或需要实体消歧时才再次调用 query_xbb，不要重复查询相同范围。"
            ] : []),
            "【可信运行元数据】",
            `上海日期：${shanghaiDateLabel()}`,
            `授权范围：${accessLabel(access)}`,
            "【用户问题】",
            question
          ].join("\n"),
          text_elements: []
        }
      ];
      const result = await this.client.startTurn({
        threadId: session.threadId,
        clientUserMessageId: messageId || null,
        input,
        cwd: this.projectRoot,
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        model: this.config.codexModel,
        effort: turnEffort,
        summary: "none",
        outputSchema: WECOM_RESPONSE_SCHEMA
      });
      active.turnId = extractTurnId(result);
      this.emit("activity", { status: "turn_started" });
      if (session.active === active) active.timeout = setTimeout(() => { void this._timeoutTurn(session, active); }, this.turnTimeoutMs);
    } catch (error) {
      if (session.active === active) {
        session.active = null;
        this.emit("activity", { status: "turn_failed", elapsedMs: Date.now() - active.startedAtMs });
      }
      throw error;
    }
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
    this.state.threads[session.principalKey] = { threadId: session.threadId, contractHash: this.contractHash };
    this.saveState(this.statePath, this.state);
    this.emit("threadReady", { principalKey: session.principalKey });
  }

  _newActive(turnId, waiter, options = {}) {
    return {
      turnId,
      waiters: waiter ? [waiter] : [],
      messages: new Map(),
      finalText: "",
      lastText: "",
      toolCalls: 0,
      allowTools: options.allowTools !== false,
      startedAtMs: Date.now(),
      toolStartedAtMs: null,
      timeout: null
    };
  }

  async _handleServerRequest(request) {
    if (request.method !== "item/tool/call") {
      this.client.reject(request.id, "企业微信经营分析 Agent 不支持此交互请求。");
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
      this.client.respond(request.id, { success: false, contentItems: [{ type: "inputText", text: JSON.stringify({ status: "error", message: "后台预热不允许查询业务数据。" }) }] });
      return;
    }
    active.toolCalls += 1;
    if (active.toolCalls > 4) {
      this.client.respond(request.id, { success: false, contentItems: [{ type: "inputText", text: JSON.stringify({ status: "error", message: "工具调用轮次超过安全上限。" }) }] });
      return;
    }
    active.toolStartedAtMs = Date.now();
    this.emit("activity", { status: "tool_started" });
    await this._notifyProgress(session, "正在查询销帮帮实时只读数据，请稍候……");
    try {
      const result = await this.queryXbb(args, session.access);
      this.client.respond(request.id, { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(result) }] });
      this.emit("activity", { status: "tool_completed", elapsedMs: Date.now() - active.toolStartedAtMs });
    } catch (error) {
      const message = error instanceof AccessDeniedError ? error.message : (error?.message || "实时销帮帮查询失败。");
      this.client.respond(request.id, { success: false, contentItems: [{ type: "inputText", text: JSON.stringify({ status: "error", message }) }] });
      this.emit("activity", { status: "tool_failed", elapsedMs: Date.now() - active.toolStartedAtMs });
    }
  }

  async _handleNotification({ method, params }) {
    const threadId = params?.threadId || params?.thread?.id;
    const session = [...this.sessions.values()].find((value) => value.threadId === threadId);
    if (!session) return;
    if (method === "turn/started") {
      const turnId = params?.turn?.id;
      if (session.active && typeof turnId === "string") session.active.turnId = turnId;
      return;
    }
    if (method === "item/started" && params?.item?.type === "agentMessage" && session.active && params.turnId === session.active.turnId) {
      session.active.messages.set(params.item.id, { text: "", phase: params.item.phase || null });
      return;
    }
    if (method === "item/agentMessage/delta" && session.active && params.turnId === session.active.turnId) {
      const current = session.active.messages.get(params.itemId) || { text: "", phase: null };
      current.text += String(params.delta || "");
      session.active.messages.set(params.itemId, current);
      return;
    }
    if (method === "item/completed" && params?.item?.type === "agentMessage" && session.active && params.turnId === session.active.turnId) {
      const text = String(params.item.text || session.active.messages.get(params.item.id)?.text || "").trim();
      const phase = params.item.phase || session.active.messages.get(params.item.id)?.phase || null;
      if (text) {
        session.active.lastText = text;
        if (phase === "final_answer") session.active.finalText = text;
        // 企业微信只显示桥接层的短状态，不转发模型内部 commentary。
      }
      return;
    }
    if (method === "turn/completed" && session.active && params?.turn?.id === session.active.turnId) this._completeTurn(session, params.turn);
  }

  _completeTurn(session, turn) {
    const active = session.active;
    if (!active) return;
    if (active.timeout) clearTimeout(active.timeout);
    const items = Array.isArray(turn?.items) ? turn.items : [];
    const agentMessages = items.filter((item) => item?.type === "agentMessage" && typeof item.text === "string");
    const finalItem = [...agentMessages].reverse().find((item) => item.phase === "final_answer") || agentMessages.at(-1);
    const rawAnswer = active.finalText || finalItem?.text || active.lastText || "";
    session.active = null;
    if (turn?.status === "completed" && rawAnswer) {
      try {
        const answer = parseAgentResponse(rawAnswer);
        this.emit("activity", { status: "turn_completed", elapsedMs: Date.now() - active.startedAtMs });
        for (const waiter of active.waiters) waiter.resolve(answer);
        return;
      } catch (error) {
        this.emit("activity", { status: "turn_failed", elapsedMs: Date.now() - active.startedAtMs });
        for (const waiter of active.waiters) waiter.reject(error);
        return;
      }
    } else {
      this.emit("activity", { status: "turn_failed", elapsedMs: Date.now() - active.startedAtMs });
      const error = new Error(turn?.status === "interrupted" ? "Codex 任务已中断。" : "Codex Agent 未生成可用最终答复。");
      for (const waiter of active.waiters) waiter.reject(error);
    }
  }

  async _timeoutTurn(session, active) {
    if (session.active !== active) return;
    try { if (active.turnId) await this.client.interruptTurn(session.threadId, active.turnId); } catch {}
    session.active = null;
    this.emit("activity", { status: "turn_failed", elapsedMs: Date.now() - active.startedAtMs });
    const error = new Error("Codex Agent 本轮处理超时。");
    for (const waiter of active.waiters) waiter.reject(error);
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

  _fatal(message) {
    if (this.closing || this.fatalError) return;
    this.fatalError = new Error(message);
    this.started = false;
    for (const session of this.sessions.values()) {
      if (!session.active) continue;
      for (const waiter of session.active.waiters) waiter.reject(this.fatalError);
      session.active = null;
    }
    this.emit("fatal", { message });
  }

  async close() {
    if (this.closing) return;
    this.closing = true;
    this.started = false;
    for (const session of this.sessions.values()) {
      if (!session.active) continue;
      if (session.active.timeout) clearTimeout(session.active.timeout);
      for (const waiter of session.active.waiters) waiter.reject(new Error("Codex Agent 服务正在停止。"));
      session.active = null;
    }
    try { if (this.client) await this.client.close(); } finally { if (this.host) await this.host.close(); }
  }
}

module.exports = {
  AgentBusyError,
  PersistentCodexAgent,
  accessLabel,
  extractActiveTurnId,
  extractThreadId,
  extractTurnId,
  principalKeyFromUserId,
  shanghaiDateLabel
};
