"use strict";

// Isolated native delegation check. No CRM queries and no WeCom delivery.
const fs = require("node:fs");
const path = require("node:path");
const { LocalAppServerHost } = require("../shared/codex/app-server-host.js");
const { AppServerClient } = require("../shared/codex/app-server-client.js");
const { CHART_AGENT_CONFIG, CHART_AGENT_MODEL, CHART_AGENT_EFFORT } = require("../shared/codex/chart-agent-config.js");

async function main() {
  const projectRoot = path.resolve(__dirname, "..");
  const runtime = JSON.parse(fs.readFileSync(path.join(process.env.LOCALAPPDATA, "Codex", "xbb-executive-analyst", "bot-config.json"), "utf8").replace(/^\uFEFF/, ""));
  const config = { projectRoot, codexCommand: runtime.codexCommand, codexProxyUrl: runtime.codexProxyUrl };
  const host = await LocalAppServerHost.start(config);
  const client = new AppServerClient({ endpoint: host.endpoint, token: host.token });
  let timer;
  try {
    await client.connect();
    const modelList = await client.request("model/list", {});
    const model = modelList.data?.find((item) => item.model === CHART_AGENT_MODEL || item.id === CHART_AGENT_MODEL);
    if (!model?.supportedReasoningEfforts?.some((item) => item.reasoningEffort === CHART_AGENT_EFFORT)) throw new Error("当前 Codex 登录未提供图表所需 ultra，禁止静默降级。");
    let parentId;
    const calls = [];
    const children = new Map();
    const done = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("原生图表子 Agent 验证超时。")), 300000);
      client.on("notification", (event) => {
        const item = event.params?.item;
        if (item?.type === "subAgentActivity" && event.method === "item/completed") {
          children.set(item.agentThreadId, item.kind);
          process.stdout.write(`${JSON.stringify({ activity: item.kind })}\n`);
        }
        if (item?.type === "collabAgentToolCall" && event.method === "item/completed") {
          const metadata = { tool: item.tool, status: item.status, model: item.model, effort: item.reasoningEffort,
            completedAgents: Object.values(item.agentsStates || {}).filter((agent) => agent.status === "completed").length };
          calls.push(metadata);
          process.stdout.write(`${JSON.stringify(metadata)}\n`);
        }
        if (event.method === "turn/completed" && event.params?.threadId === parentId) {
          if (event.params.turn.status !== "completed") reject(new Error("主 Agent 的验证轮次未完成。"));
          else resolve();
        }
      });
    });
    // Install a handler immediately to avoid an unhandled rejection on startup errors.
    done.catch(() => {});
    const thread = await client.startThread({ model: "gpt-6-astra", cwd: projectRoot, approvalPolicy: "never", sandbox: "read-only",
      config: CHART_AGENT_CONFIG, ephemeral: true,
      developerInstructions: "这是原生子 Agent 能力验收，不查询任何经营数据。必须调用项目专职 xbb_chart 子 Agent，模型 gpt-6-astra，reasoning_effort ultra，fork_turns none。将空事实交给它验证诚实缺数处理，然后等待返回，结束时只输出 ready。禁止执行 shell、访问网络或外部数据。" });
    parentId = thread.thread.id;
    await client.startTurn({ threadId: parentId, model: "gpt-6-astra", effort: "xhigh", approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      input: [{ type: "text", text: "请实际委派 xbb_chart。交付任务：这是离线合同检查，无任何经营事实，用户有总体与趋势两个问题；不得编造数值，返回 chart:null 并说明缺少本轮数据。待它完成后结束本轮。", text_elements: [] }] });
    await done;
    let verified = calls.some((call) => call.tool === "spawnAgent" && call.status === "completed" && call.model === CHART_AGENT_MODEL && call.effort === CHART_AGENT_EFFORT);
    for (const [threadId, kind] of children) {
      const result = await client.request("thread/read", { threadId, includeTurns: false });
      const child = result.thread;
      const metadata = { childModel: child.model, childEffort: child.reasoningEffort, completed: kind === "completed", nativeParentMatched: child.parentThreadId === parentId };
      process.stdout.write(`${JSON.stringify(metadata)}\n`);
      verified ||= metadata.childModel === CHART_AGENT_MODEL && metadata.childEffort === CHART_AGENT_EFFORT && metadata.nativeParentMatched && metadata.completed;
    }
    if (!verified) throw new Error("未观察到指定 gpt-6-astra/ultra 原生子 Agent 完成。");
    process.stdout.write(`${JSON.stringify({ success: true, mainEffort: "xhigh", chartModel: CHART_AGENT_MODEL, chartEffort: CHART_AGENT_EFFORT, nativeDelegation: true })}\n`);
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => {});
    await host.close().catch(() => {});
  }
}

main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
