"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const http = require("node:http");
const net = require("node:net");
const { resolveCodexInvocation, sanitizeCodexEnvironment } = require("./runtime.js");

function signalError(signal, fallback = "Codex App Server 启动已取消。") {
  return signal?.reason instanceof Error ? signal.reason : new Error(fallback);
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signalError(signal);
}

function withAbort(operation, signal) {
  if (!signal) return Promise.resolve(operation);
  if (signal.aborted) return Promise.reject(signalError(signal));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, signalError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(operation).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error)
    );
  });
}

function abortableDelay(delayMs, signal) {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, delayMs));
  if (signal.aborted) return Promise.reject(signalError(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signalError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function reserveLoopbackPort(options = {}) {
  const signal = options.signal;
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () => {
      try { server.close(); } catch {}
      finish(reject, signalError(signal));
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    server.once("error", (error) => finish(reject, error));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? finish(reject, error) : finish(resolve, port));
    });
  });
}

function buildAppServerCommand(invocation, endpoint, verifier) {
  return {
    command: invocation.command,
    args: [
      ...invocation.argsPrefix,
      "app-server", "--listen", endpoint,
      "--ws-auth", "capability-token",
      "--ws-token-sha256", verifier
    ]
  };
}

function probeReady(port, timeoutMs = 800, options = {}) {
  const signal = options.signal;
  if (signal?.aborted) return Promise.reject(signalError(signal));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      callback(value);
    };
    const request = http.get({ hostname: "127.0.0.1", port, path: "/readyz", timeout: timeoutMs }, (response) => {
      response.resume();
      finish(resolve, response.statusCode === 200);
    });
    request.once("timeout", () => request.destroy());
    request.once("error", () => finish(resolve, false));
    const onAbort = () => {
      request.destroy();
      finish(reject, signalError(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

class LocalAppServerHost {
  constructor({
    process: child,
    endpoint,
    token,
    port,
    stderrBytes = 0,
    closeGraceMs = 2000,
    killConfirmTimeoutMs = 2000,
    clock = { setTimeout, clearTimeout }
  }) {
    this.process = child;
    this.endpoint = endpoint;
    this.token = token;
    this.port = port;
    this.stderrBytes = stderrBytes;
    this.closeGraceMs = closeGraceMs;
    this.killConfirmTimeoutMs = killConfirmTimeoutMs;
    this.clock = clock;
    this.closePromise = null;
  }

  static async start(config = {}, options = {}) {
    const signal = options.signal;
    throwIfAborted(signal);
    const port = await withAbort((options.reservePort || reserveLoopbackPort)({ signal }), signal);
    throwIfAborted(signal);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("无法分配 Codex App Server 回环端口。");
    const endpoint = `ws://127.0.0.1:${port}`;
    const token = (options.randomBytes || crypto.randomBytes)(48).toString("base64url");
    const verifier = crypto.createHash("sha256").update(token, "utf8").digest("hex");
    const invocation = options.invocation || resolveCodexInvocation(config, options);
    const command = buildAppServerCommand(invocation, endpoint, verifier);
    const child = (options.spawn || childProcess.spawn)(command.command, command.args, {
      cwd: config.projectRoot,
      env: sanitizeCodexEnvironment(options.env || process.env, config),
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"]
    });
    const host = new LocalAppServerHost({
      process: child,
      endpoint,
      token,
      port,
      closeGraceMs: options.closeGraceMs,
      killConfirmTimeoutMs: options.killConfirmTimeoutMs,
      clock: options.clock
    });
    if (child.stderr) child.stderr.on("data", (chunk) => { host.stderrBytes += chunk.length; });
    let spawnError = null;
    child.once("error", (error) => { spawnError = error; });
    try {
      throwIfAborted(signal);
      await host.waitReady({
        timeoutMs: options.readyTimeoutMs || 15000,
        probe: options.probe || probeReady,
        getSpawnError: () => spawnError,
        signal
      });
      throwIfAborted(signal);
      return host;
    } catch (error) {
      await host.close();
      throw error;
    }
  }

  async waitReady({ timeoutMs, probe, getSpawnError = () => null, signal }) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      throwIfAborted(signal);
      const spawnError = getSpawnError();
      if (spawnError) throw new Error("无法启动 Codex App Server 进程。", { cause: spawnError });
      if (this.process.exitCode !== null) throw new Error(`Codex App Server 启动失败（退出码 ${this.process.exitCode}）。`);
      if (await withAbort(probe(this.port, 800, { signal }), signal)) return;
      await abortableDelay(50, signal);
    }
    await this.close();
    throw new Error("等待 Codex App Server 就绪超时。");
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      if (!this.process || this.process.exitCode !== null) return;
      if (await this._signalAndConfirm(undefined, this.closeGraceMs)) return;
      if (await this._signalAndConfirm("SIGKILL", this.killConfirmTimeoutMs)) return;
      throw new Error("Codex App Server 子进程终止未得到确认。");
    })();
    return this.closePromise;
  }

  _signalAndConfirm(signal, timeoutMs) {
    if (!this.process || this.process.exitCode !== null) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const finish = (confirmed) => {
        if (settled) return;
        settled = true;
        if (timer !== null) this.clock.clearTimeout(timer);
        this.process.removeListener("exit", onExit);
        this.process.removeListener("close", onExit);
        resolve(confirmed);
      };
      const onExit = () => finish(true);
      this.process.once("exit", onExit);
      this.process.once("close", onExit);
      let accepted = false;
      try {
        accepted = signal === undefined ? this.process.kill() : this.process.kill(signal);
      } catch {
        finish(false);
        return;
      }
      if (settled) return;
      if (this.process.exitCode !== null) {
        finish(true);
        return;
      }
      if (accepted !== true) {
        finish(false);
        return;
      }
      timer = this.clock.setTimeout(() => finish(this.process.exitCode !== null), timeoutMs);
    });
  }
}

module.exports = { LocalAppServerHost, buildAppServerCommand, probeReady, reserveLoopbackPort };
