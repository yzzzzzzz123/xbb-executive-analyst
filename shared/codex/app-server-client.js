"use strict";

const { EventEmitter } = require("node:events");
const WebSocket = require("ws");

function signalError(signal, fallback = "Codex App Server 连接已取消。") {
  return signal?.reason instanceof Error ? signal.reason : new Error(fallback);
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signalError(signal);
}

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

  async connect(options = {}) {
    if (this.connected) return;
    const signal = options.signal;
    throwIfAborted(signal);
    const socket = new this.WebSocketImpl(this.endpoint, {
      headers: { Authorization: `Bearer ${this.token}` },
      perMessageDeflate: false,
      maxPayload: 128 * 1024 * 1024
    });
    this.socket = socket;
    socket.on("message", (data, isBinary) => { if (!isBinary) this._handleMessage(String(data)); });
    socket.on("close", () => this._handleClose());
    socket.on("error", (error) => this.emit("transportError", new Error("Codex App Server WebSocket 连接失败。", { cause: error })));
    try {
      await new Promise((resolve, reject) => {
        let settled = false;
        const finish = (callback, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          socket.off("open", onOpen);
          socket.off("error", onError);
          signal?.removeEventListener("abort", onAbort);
          callback(value);
        };
        const onOpen = () => finish(resolve);
        const onError = () => finish(reject, new Error("连接 Codex App Server 失败。"));
        const onAbort = () => finish(reject, signalError(signal));
        const timer = setTimeout(() => finish(reject, new Error("连接 Codex App Server 超时。")), 10000);
        socket.once("open", onOpen);
        socket.once("error", onError);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
      throwIfAborted(signal);
      await this.request("initialize", {
        clientInfo: { name: "xbb-wecom-bridge", title: "XBB WeCom Codex Agent", version: "1.0.0" },
        capabilities: { experimentalApi: true, requestAttestation: false }
      }, { id: "initialize", timeoutMs: 10000, signal });
      throwIfAborted(signal);
      this._send({ method: "initialized" });
      this.connected = true;
    } catch (error) {
      this.socket = null;
      this.connected = false;
      try {
        if (typeof socket.terminate === "function") socket.terminate();
        else socket.close();
      } catch {}
      if (signal?.aborted) throw signalError(signal);
      throw error;
    }
  }

  request(method, params = {}, options = {}) {
    const signal = options.signal;
    if (signal?.aborted) return Promise.reject(signalError(signal, `${method} 请求已取消。`));
    if (!this.socket || this.socket.readyState !== this.WebSocketImpl.OPEN) return Promise.reject(new Error("Codex App Server 尚未连接。"));
    const id = options.id ?? this.nextId++;
    if (this.pending.has(id)) return Promise.reject(new Error("Codex App Server 请求 ID 重复。"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this._takePending(id);
        if (!pending) return;
        reject(new Error(`${method} 请求超时。`));
      }, options.timeoutMs || this.requestTimeoutMs);
      const onAbort = () => {
        const pending = this._takePending(id);
        if (!pending) return;
        reject(signalError(signal, `${method} 请求已取消。`));
      };
      this.pending.set(id, { method, resolve, reject, timer, signal, onAbort });
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        this._send({ id, method, params });
      } catch (error) {
        this._takePending(id);
        reject(error);
      }
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

  _takePending(id) {
    const pending = this.pending.get(id);
    if (!pending) return null;
    clearTimeout(pending.timer);
    pending.signal?.removeEventListener("abort", pending.onAbort);
    this.pending.delete(id);
    return pending;
  }

  _handleMessage(raw) {
    let message;
    try { message = JSON.parse(raw); } catch { this.emit("protocolError", new Error("Codex App Server 返回了无效 JSON。")); return; }
    if (!message || typeof message !== "object" || Array.isArray(message)) { this.emit("protocolError", new Error("Codex App Server 消息不是对象。")); return; }
    const hasId = (typeof message.id === "string" || Number.isInteger(message.id));
    if (hasId && !message.method && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))) {
      const pending = this._takePending(message.id);
      if (!pending) return;
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
    for (const id of [...this.pending.keys()]) {
      const pending = this._takePending(id);
      if (!pending) continue;
      pending.reject(new Error("Codex App Server 连接已关闭。"));
    }
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
