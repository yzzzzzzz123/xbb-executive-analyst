"use strict";

const fs = require("node:fs");
const path = require("node:path");

const CHART_AGENT_MODEL = "gpt-6-astra";
const CHART_AGENT_EFFORT = "ultra";
const CHART_AGENT_CONFIG = Object.freeze({
  "agents.enabled": true,
  "agents.max_concurrent_threads_per_session": 1,
  "agents.default_subagent_model": CHART_AGENT_MODEL,
  "agents.default_subagent_reasoning_effort": CHART_AGENT_EFFORT
});

function chartAgentContract(projectRoot) {
  return fs.readFileSync(path.join(projectRoot, ".codex", "agents", "xbb-chart.toml"), "utf8");
}

module.exports = { CHART_AGENT_MODEL, CHART_AGENT_EFFORT, CHART_AGENT_CONFIG, chartAgentContract };
