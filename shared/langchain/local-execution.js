"use strict";

const { AsyncLocalStorage } = require("node:async_hooks");
const { AsyncLocalStorageProviderSingleton } = require("@langchain/core/singletons");
const { RunTree } = require("langsmith/run_trees");
const { withRunTree } = require("langsmith/traceable");

AsyncLocalStorageProviderSingleton.initializeGlobalInstance(new AsyncLocalStorage());

// Questions, live facts and answers must not reach ambient tracing callbacks.
// Isolate each invocation without modifying process-wide environment settings.
function assertLocalExecution() {
  if (process.env.LANGCHAIN_VERBOSE === "true") {
    throw new Error("经营分析不允许 LangChain verbose 输出问题或实时事实，请关闭后重试。");
  }
}

function invokeLocal(runnable, input) {
  assertLocalExecution();
  const root = new RunTree({ name: "xbb_local_execution", tracingEnabled: false });
  return AsyncLocalStorageProviderSingleton.getInstance().run(undefined, () => withRunTree(root, () =>
    runnable.invoke(input, { callbacks: [], tags: [], metadata: {}, maxConcurrency: 1 })
  ));
}

module.exports = { assertLocalExecution, invokeLocal };
