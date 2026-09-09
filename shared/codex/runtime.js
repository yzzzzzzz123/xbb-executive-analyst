"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function sanitizeCodexEnvironment(source = process.env) {
  const allowed = [
    "APPDATA", "CODEX_HOME", "ComSpec", "HOMEDRIVE", "HOMEPATH", "LANG", "LC_ALL",
    "LOCALAPPDATA", "NUMBER_OF_PROCESSORS", "OS", "Path", "PATH", "PATHEXT",
    "PROCESSOR_ARCHITECTURE", "PROGRAMDATA", "ProgramFiles", "PROGRAMFILES",
    "ProgramFiles(x86)", "PROGRAMFILES(X86)", "SystemDrive", "SystemRoot", "TEMP", "TMP",
    "USERDOMAIN", "USERNAME", "USERPROFILE", "windir", "WINDIR",
    // 模型连接必须沿用部署环境的网络路由；丢弃代理会让 CLI 登录正常、
    // App Server 就绪正常，但每次生成都直连失败并反复重连。
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
    "http_proxy", "https_proxy", "all_proxy", "no_proxy"
  ];
  const result = {};
  for (const key of allowed) {
    if (typeof source[key] === "string" && source[key] !== "") result[key] = source[key];
  }
  return result;
}

function resolveCodexInvocation(config = {}, options = {}) {
  const override = options.codexCommand || config.codexCommand;
  if (override) {
    if (!path.isAbsolute(override)) throw new Error("XBB_CODEX_COMMAND 必须是绝对路径。");
    if (/\.(?:cmd|bat)$/i.test(override)) throw new Error("XBB_CODEX_COMMAND 必须指向 codex.exe 或 codex.js，不能使用 cmd/bat 包装脚本。");
    if (!fs.existsSync(override)) throw new Error("XBB_CODEX_COMMAND 指向的文件不存在。");
    return override.toLowerCase().endsWith(".js")
      ? { command: process.execPath, argsPrefix: [override] }
      : { command: override, argsPrefix: [] };
  }

  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    const packageRoot = path.join(appData, "npm", "node_modules", "@openai", "codex");
    const platformPackage = process.arch === "arm64" ? "codex-win32-arm64" : "codex-win32-x64";
    const architecture = process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
    const executable = path.join(packageRoot, "node_modules", "@openai", platformPackage, "vendor", architecture, "bin", "codex.exe");
    if (fs.existsSync(executable)) return { command: executable, argsPrefix: [] };
    const javascriptEntry = path.join(packageRoot, "bin", "codex.js");
    if (fs.existsSync(javascriptEntry)) return { command: process.execPath, argsPrefix: [javascriptEntry] };
    throw new Error("未找到本机 Codex CLI。请先安装 Codex 并完成 ChatGPT 登录。");
  }
  return { command: "codex", argsPrefix: [] };
}

function runCodexMetadataCommand(invocation, args, options = {}) {
  const result = (options.spawnSync || childProcess.spawnSync)(invocation.command, [...invocation.argsPrefix, ...args], {
    encoding: "utf8",
    env: sanitizeCodexEnvironment(options.env || process.env),
    windowsHide: true,
    timeout: 15000
  });
  if (result.error || result.status !== 0) throw new Error("本机 Codex 状态不可用。");
  return `${result.stdout || ""}\n${result.stderr || ""}`.trim();
}

function verifyCodexChatGptLogin(config = {}, options = {}) {
  const invocation = options.invocation || resolveCodexInvocation(config, options);
  const statusText = runCodexMetadataCommand(invocation, ["login", "status"], options);
  if (!/Logged in using ChatGPT/i.test(statusText)) {
    throw new Error("本机 Codex 当前不是 ChatGPT 登录模式；本机器人不读取独立模型 API Key。");
  }
  return Object.freeze({ mode: "chatgpt" });
}

function readCodexVersion(config = {}, options = {}) {
  const invocation = options.invocation || resolveCodexInvocation(config, options);
  const text = runCodexMetadataCommand(invocation, ["--version"], options);
  const match = text.match(/codex-cli\s+([^\s]+)/i);
  if (!match) throw new Error("无法识别本机 Codex 版本。");
  return match[1];
}

module.exports = {
  readCodexVersion,
  resolveCodexInvocation,
  sanitizeCodexEnvironment,
  verifyCodexChatGptLogin
};
