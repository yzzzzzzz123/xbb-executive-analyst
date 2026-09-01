"use strict";

const { EventEmitter } = require("node:events");
const WebSocket = require("ws");

class AppServerRpcError extends Error {
  constructor(method, error) {
    super(`${method} failed (${Number.isInteger(error?.code) ? error.code : -32000}): ${String(error?.message || "unknown error")}`);
    this.name = "AppServerRpcError";
    this.method = method;
    this.code = Number.isInteger(error?.code) ? error.code : -32000;
  }
}

class AppServerClient extends EventEmitter {
  constructor({ endpoint, token, WebSocketImpl = WebSocket, requestTimeoutMs = 30000 }) {
    super();
    if (!/^ws:\/\/127\.0\.0\.1:\d+$/.test(endpoint)) throw new Error("Codex App Server 只允许 127.0.0.1 回环 WebSocket。");
    if (typeof token !== "string" || token.length < 32) throw new Error("Codex App Server capability token 无效。");
    this.endpoint = endpoint;
    this.token = token;
    this.WebSocketImpl = WebSocketImpl;
    this.requestTimeoutMs = requestTimeoutMs;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.connected = false;
  }

  async connect() {
    if (this.connected) return;
    const socket = new this.WebSocketImpl(this.endpoint, {
      headers: { Authorization: `Bearer ${this.token}` },
      perMessageDeflate: false,
      maxPayload: 128 * 1024 * 1024
    });
    this.socket = socket;
    socket.on("message", (data, isBinary) => { if (!isBinary) this._handleMessage(String(data)); });
    socket.on("close", () => this._handleClose());
    socket.on("error", (error) => this.emit("transportError", new Error("Codex App Server WebSocket 连接失败。", { cause: error })));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("连接 Codex App Server 超时。")), 10000);
      socket.once("open", () => { clearTimeout(timer); resolve(); });
      socket.once("error", () => { clearTimeout(timer); reject(new Error("连接 Codex App Server 失败。")); });
    });
    await this.request("initialize", {
      clientInfo: { name: "xbb-wecom-bridge", title: "XBB WeCom Codex Agent", version: "1.0.0" },
      capabilities: { experimentalApi: true, requestAttestation: false }
    }, { id: "initialize", timeoutMs: 10000 });
    this._send({ method: "initialized" });
    this.connected = true;
  }

  request(method, params = {}, options = {}) {
    if (!this.socket || this.socket.readyState !== this.WebSocketImpl.OPEN) return Promise.reject(new Error("Codex App Server 尚未连接。"));
    const id = options.id ?? this.nextId++;
    if (this.pending.has(id)) return Promise.reject(new Error("Codex App Server 请求 ID 重复。"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 请求超时。`));
      }, options.timeoutMs || this.requestTimeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      this._send({ id, method, params });
    });
  }

  notify(method, params = undefined) {
    this._send(params === undefined ? { method } : { method, params });
  }

  respond(id, result) {
    this._send({ id, result });
  }

  reject(id, message, code = -32000) {
    this._send({ id, error: { code, message } });
  }

  startThread(params) { return this.request("thread/start", params); }
  resumeThread(threadId, params = {}) { return this.request("thread/resume", { threadId, ...params }); }
  startTurn(params) { return this.request("turn/start", params); }
  steerTurn(params) { return this.request("turn/steer", params); }
  interruptTurn(threadId, turnId) { return this.request("turn/interrupt", { threadId, turnId }); }

  _send(value) {
    if (!this.socket || this.socket.readyState !== this.WebSocketImpl.OPEN) throw new Error("Codex App Server WebSocket 不可用。");
    this.socket.send(JSON.stringify(value));
  }

  _handleMessage(raw) {
    let message;
    try { message = JSON.parse(raw); } catch { this.emit("protocolError", new Error("Codex App Server 返回了无效 JSON。")); return; }
    if (!message || typeof message !== "object" || Array.isArray(message)) { this.emit("protocolError", new Error("Codex App Server 消息不是对象。")); return; }
    const hasId = (typeof message.id === "string" || Number.isInteger(message.id));
    if (hasId && !message.method && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new AppServerRpcError(pending.method, message.error));
      else pending.resolve(message.result);
      return;
    }
    if (typeof message.method === "string" && hasId) {
      this.emit("serverRequest", { id: message.id, method: message.method, params: message.params || {} });
      return;
    }
    if (typeof message.method === "string" && !hasId) {
      const event = { method: message.method, params: message.params || {} };
      this.emit("notification", event);
      if (message.method === "error") this.emit("serverErrorNotification", event.params);
      else this.emit(message.method, event.params);
      return;
    }
    this.emit("protocolError", new Error("无法识别 Codex App Server 消息。"));
  }

  _handleClose() {
    this.connected = false;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Codex App Server 连接已关闭。"));
    }
    this.pending.clear();
    this.emit("disconnected");
  }

  async close() {
    const socket = this.socket;
    this.socket = null;
    this.connected = false;
    if (!socket || socket.readyState === this.WebSocketImpl.CLOSED) return;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 1500);
      socket.once("close", () => { clearTimeout(timer); resolve(); });
      socket.close();
    });
  }
}

module.exports = { AppServerClient, AppServerRpcError };
