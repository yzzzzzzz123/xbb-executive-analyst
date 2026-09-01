"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const http = require("node:http");
const net = require("node:net");
const { resolveCodexInvocation, sanitizeCodexEnvironment } = require("./runtime.js");

function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
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

function probeReady(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const request = http.get({ hostname: "127.0.0.1", port, path: "/readyz", timeout: timeoutMs }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.once("timeout", () => request.destroy());
    request.once("error", () => resolve(false));
  });
}

class LocalAppServerHost {
  constructor({ process: child, endpoint, token, port, stderrBytes = 0 }) {
    this.process = child;
    this.endpoint = endpoint;
    this.token = token;
    this.port = port;
    this.stderrBytes = stderrBytes;
  }

  static async start(config = {}, options = {}) {
    const port = await (options.reservePort || reserveLoopbackPort)();
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("无法分配 Codex App Server 回环端口。");
    const endpoint = `ws://127.0.0.1:${port}`;
    const token = (options.randomBytes || crypto.randomBytes)(48).toString("base64url");
    const verifier = crypto.createHash("sha256").update(token, "utf8").digest("hex");
    const invocation = options.invocation || resolveCodexInvocation(config, options);
    const command = buildAppServerCommand(invocation, endpoint, verifier);
    const child = (options.spawn || childProcess.spawn)(command.command, command.args, {
      cwd: config.projectRoot,
      env: sanitizeCodexEnvironment(options.env || process.env),
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"]
    });
    const host = new LocalAppServerHost({ process: child, endpoint, token, port });
    if (child.stderr) child.stderr.on("data", (chunk) => { host.stderrBytes += chunk.length; });
    let spawnError = null;
    child.once("error", (error) => { spawnError = error; });
    try {
      await host.waitReady({
        timeoutMs: options.readyTimeoutMs || 15000,
        probe: options.probe || probeReady,
        getSpawnError: () => spawnError
      });
      return host;
    } catch (error) {
      await host.close();
      throw error;
    }
  }

  async waitReady({ timeoutMs, probe, getSpawnError = () => null }) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const spawnError = getSpawnError();
      if (spawnError) throw new Error("无法启动 Codex App Server 进程。", { cause: spawnError });
      if (this.process.exitCode !== null) throw new Error(`Codex App Server 启动失败（退出码 ${this.process.exitCode}）。`);
      if (await probe(this.port)) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await this.close();
    throw new Error("等待 Codex App Server 就绪超时。");
  }

  async close() {
    if (!this.process || this.process.exitCode !== null) return;
    this.process.kill();
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.process.exitCode === null) this.process.kill("SIGKILL");
        resolve();
      }, 2000);
      this.process.once("close", () => { clearTimeout(timer); resolve(); });
    });
  }
}

module.exports = { LocalAppServerHost, buildAppServerCommand, probeReady, reserveLoopbackPort };
