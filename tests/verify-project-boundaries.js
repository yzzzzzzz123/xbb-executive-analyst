"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { builtinModules } = require("node:module");
const { validateSuiteManifest } = require("../scripts/run-tests.js");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const BUILTINS = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
// The existing responsibilities in AGENTS.md are enforceable dependency rules.
// Same-layer imports are allowed; lower layers must not import a consumer.
const ALLOWED_LAYERS = {
  config: new Set(),
  security: new Set(),
  observability: new Set(["security"]),
  xbb: new Set(["security", "observability", "chart-contract"]),
  rag: new Set(["security", "observability"]),
  codex: new Set(["security", "observability", "xbb", "rag", "chart-contract"]),
  wecom: new Set(["config", "security", "observability", "xbb", "rag", "codex"]),
  "chart-contract": new Set(),
};
const ALLOWED_PACKAGES = {
  codex: new Set(["ws"]),
  wecom: new Set(["@wecom/aibot-node-sdk", "sharp"]),
};
// Transport may format/render a result and recover orphaned workers at startup.
// It must never compile facts or invoke the business query gateway directly.
const WECOM_XBB_MODULES = new Set([
  "shared/xbb/query-progress.js",
  "shared/xbb/render-chart.js",
  "shared/xbb/chart-primitives.js",
  "shared/xbb/runner-isolation.js",
]);
const CODEX_XBB_MODULES = new Set([
  "shared/xbb/tool-gateway.js",
  "shared/xbb/runner-isolation.js",
  "shared/xbb/model-fact-view.js",
  "shared/xbb/query-tool.js",
  "shared/xbb/fast-query-plan.js",
  "shared/xbb/query-progress.js",
]);
const CHART_CONTRACT = "skills/xbb-executive-chart/scripts/chart-contract.js";

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(absolute) : /\.(?:js|cjs|mjs)$/.test(entry.name) ? [absolute] : [];
  });
}

function relative(file) {
  return path.relative(PROJECT_ROOT, file).split(path.sep).join("/");
}

function layerOf(file) {
  const name = relative(file);
  if (name === CHART_CONTRACT) return "chart-contract";
  if (name === "shared/config.js") return "config";
  const match = /^shared\/([^/]+)\//.exec(name);
  assert.ok(match && Object.hasOwn(ALLOWED_LAYERS, match[1]), `Unowned runtime module: ${name}`);
  return match[1];
}

const files = [...sourceFiles(path.join(PROJECT_ROOT, "shared")), path.join(PROJECT_ROOT, CHART_CONTRACT)];
const graph = new Map(files.map((file) => [file, []]));
let dependencies = 0;

for (const file of files) {
  const source = fs.readFileSync(file, "utf8");
  const sourceLayer = layerOf(file);
  // Runtime is CommonJS. Computed imports would hide dependencies from this gate.
  assert.notEqual(path.extname(file), ".mjs", `Add an ESM-aware boundary parser before introducing ESM runtime modules: ${relative(file)}`);
  assert.ok(!/\bimport\s*\(/.test(source), `Dynamic import is not covered by CommonJS boundary checks: ${relative(file)}`);
  const imports = [...source.matchAll(/\brequire\s*\(\s*(["'])([^"']+)\1\s*\)/g)];
  assert.equal(imports.length, [...source.matchAll(/\brequire\s*\(/g)].length, `Computed require is not covered by boundary checks: ${relative(file)}`);
  if (["codex", "wecom", "rag"].includes(sourceLayer)) {
    assert.ok(!/credentials\.json|process\.env\.XBB_(?:API_BASE|API_TOKEN|CORPID)\b/.test(source), `Business credentials bypass the approved runner: ${relative(file)}`);
  }
  for (const [, , specifier] of imports) {
    dependencies += 1;
    if (BUILTINS.has(specifier)) {
      if (["security", "observability", "rag", "chart-contract"].includes(sourceLayer)) {
        assert.ok(!/^(?:node:)?(?:https?|http2|net|tls|dgram|child_process|worker_threads)$/.test(specifier), `Foundation layer starts network/process work: ${relative(file)} -> ${specifier}`);
      }
      continue;
    }
    if (!specifier.startsWith(".")) {
      assert.ok(ALLOWED_PACKAGES[sourceLayer]?.has(specifier), `Undeclared external layer dependency: ${relative(file)} -> ${specifier}`);
      continue;
    }
    const target = require.resolve(path.resolve(path.dirname(file), specifier));
    assert.ok(graph.has(target), `Runtime reaches outside its owned modules: ${relative(file)} -> ${relative(target)}`);
    const targetLayer = layerOf(target);
    assert.ok(sourceLayer === targetLayer || ALLOWED_LAYERS[sourceLayer].has(targetLayer), `Layer violation: ${relative(file)} -> ${relative(target)}`);
    if (sourceLayer === "wecom" && targetLayer === "xbb") {
      assert.ok(WECOM_XBB_MODULES.has(relative(target)), `Transport directly invokes business internals: ${relative(file)} -> ${relative(target)}`);
    }
    if (sourceLayer === "codex" && targetLayer === "xbb") {
      assert.ok(CODEX_XBB_MODULES.has(relative(target)), `Agent bypasses its governed business interface: ${relative(file)} -> ${relative(target)}`);
    }
    graph.get(file).push(target);
  }
}

const complete = new Set();
function assertAcyclic(file, stack = []) {
  assert.ok(!stack.includes(file), `Runtime dependency cycle: ${[...stack, file].map(relative).join(" -> ")}`);
  if (complete.has(file)) return;
  for (const target of graph.get(file)) assertAcyclic(target, [...stack, file]);
  complete.add(file);
}
for (const file of files) assertAcyclic(file);

const suites = validateSuiteManifest();
process.stdout.write(`${JSON.stringify({ success: true, runtimeModules: files.length, dependencies, registeredSuites: suites, cycles: 0 })}\n`);
