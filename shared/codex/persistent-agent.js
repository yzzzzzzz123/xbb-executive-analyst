"use strict";

const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const { AccessDeniedError } = require("../security/access-control.js");
const { sanitizeAgentText } = require("../security/output-sanitizer.js");
const { createToolGateway } = require("../xbb/tool-gateway.js");
const { QUERY_XBB_DYNAMIC_TOOL, queryToolContractHash } = require("../xbb/query-tool.js");
const { AppServerClient, AppServerRpcError } = require("./app-server-client.js");
const { LocalAppServerHost } = require("./app-server-host.js");
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

class PersistentCodexAgent extends EventEmitter {
  constructor(config, options = {}) {
    super();
    this.config = config;
    this.projectRoot = config.projectRoot || path.resolve(__dirname, "..", "..");
    this.skillPath = path.join(this.projectRoot, "skills", "xbb-executive-analyst", "SKILL.md");
    this.instructions = options.instructions || buildThreadInstructions(this.projectRoot);
    this.queryXbb = options.queryXbb || createToolGateway({ projectRoot: this.projectRoot });
    this.hostFactory = options.hostFactory || LocalAppServerHost;
    this.clientFactory = options.clientFactory || ((host) => new AppServerClient({ endpoint: host.endpoint, token: host.token }));
    this.verifyLogin = options.verifyLogin || verifyCodexChatGptLogin;
    this.readVersion = options.readVersion || readCodexVersion;
    this.loadState = options.loadState || loadAgentState;
    this.saveState = options.saveState || saveAgentState;
    this.statePath = config.agentStatePath;
    this.turnTimeoutMs = config.agentTurnTimeoutMs || 15 * 60 * 1000;
    this.contractHash = sha256(JSON.stringify({
      instructions: this.instructions,
      tool: queryToolContractHash(),
      model: config.codexModel,
      effort: config.codexReasoningEffort,
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
      () => this._submit(session, { question: question.trim(), access, messageId, waiter }),
      () => this._submit(session, { question: question.trim(), access, messageId, waiter })
    );
    try { await session.operation; } catch (error) { waiter.reject(error); }
    return waiter.promise;
  }

  async _submit(session, { question, access, messageId, waiter }) {
    if (!session.threadId) await this._startThread(session);
    const input = [
      { type: "skill", name: "xbb-executive-analyst", path: this.skillPath },
      {
        type: "text",
        text: [
          "【可信运行元数据】",
          `上海日期：${shanghaiDateLabel()}`,
          `授权范围：${accessLabel(access)}`,
          "【用户问题】",
          question
        ].join("\n"),
        text_elements: []
      }
    ];

    if (session.active?.turnId) {
      const active = session.active;
      active.waiters.push(waiter);
      session.access = access;
      try {
        await this.client.steerTurn({
          threadId: session.threadId,
          expectedTurnId: active.turnId,
          clientUserMessageId: messageId || null,
          input
        });
        await this._notifyWaiter(waiter, "已把新问题追加到当前 Codex 任务。", false);
        return;
      } catch (error) {
        active.waiters = active.waiters.filter((value) => value !== waiter);
        if (!(error instanceof AppServerRpcError)) throw error;
        if (session.active !== active) return this._submit(session, { question, access, messageId, waiter });
        throw new Error("上一条 Codex 任务刚刚结束，请重新发送本条问题。", { cause: error });
      }
    }

    session.access = access;
    const active = this._newActive(null, waiter);
    session.active = active;
    try {
      const result = await this.client.startTurn({
        threadId: session.threadId,
        clientUserMessageId: messageId || null,
        input,
        cwd: this.projectRoot,
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        model: this.config.codexModel,
        effort: this.config.codexReasoningEffort,
        summary: "none"
      });
      active.turnId = extractTurnId(result);
      if (session.active === active) active.timeout = setTimeout(() => { void this._timeoutTurn(session, active); }, this.turnTimeoutMs);
    } catch (error) {
      if (session.active === active) session.active = null;
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

  _newActive(turnId, waiter) {
    return {
      turnId,
      waiters: waiter ? [waiter] : [],
      messages: new Map(),
      finalText: "",
      lastText: "",
      toolCalls: 0,
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
    session.active.toolCalls += 1;
    if (session.active.toolCalls > 4) {
      this.client.respond(request.id, { success: false, contentItems: [{ type: "inputText", text: JSON.stringify({ status: "error", message: "工具调用轮次超过安全上限。" }) }] });
      return;
    }
    await this._notifyProgress(session, "正在查询销帮帮实时只读数据，请稍候……");
    try {
      const result = await this.queryXbb(args, session.access);
      this.client.respond(request.id, { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(result) }] });
    } catch (error) {
      const message = error instanceof AccessDeniedError ? error.message : (error?.message || "实时销帮帮查询失败。");
      this.client.respond(request.id, { success: false, contentItems: [{ type: "inputText", text: JSON.stringify({ status: "error", message }) }] });
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
      const text = sanitizeAgentText(params.item.text || session.active.messages.get(params.item.id)?.text || "");
      const phase = params.item.phase || session.active.messages.get(params.item.id)?.phase || null;
      if (text) {
        session.active.lastText = text;
        if (phase === "final_answer") session.active.finalText = text;
        else if (phase === "commentary") await this._notifyProgress(session, text);
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
    const answer = sanitizeAgentText(active.finalText || finalItem?.text || active.lastText || "");
    session.active = null;
    if (turn?.status === "completed" && answer) {
      for (const waiter of active.waiters) waiter.resolve(answer);
    } else {
      const error = new Error(turn?.status === "interrupted" ? "Codex 任务已中断。" : "Codex Agent 未生成可用最终答复。");
      for (const waiter of active.waiters) waiter.reject(error);
    }
  }

  async _timeoutTurn(session, active) {
    if (session.active !== active) return;
    try { if (active.turnId) await this.client.interruptTurn(session.threadId, active.turnId); } catch {}
    session.active = null;
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
  PersistentCodexAgent,
  accessLabel,
  extractActiveTurnId,
  extractThreadId,
  extractTurnId,
  principalKeyFromUserId,
  shanghaiDateLabel
};
