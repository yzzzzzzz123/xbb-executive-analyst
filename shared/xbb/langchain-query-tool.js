"use strict";

const { DynamicStructuredTool } = require("@langchain/core/tools");
const { QUERY_XBB_DYNAMIC_TOOL, QUERY_XBB_INPUT_SCHEMA } = require("./query-tool.js");
const { invokeLocal } = require("../langchain/local-execution.js");

function createQueryTool(gateway, access, options = {}) {
  return new DynamicStructuredTool({
    name: QUERY_XBB_DYNAMIC_TOOL.name,
    description: QUERY_XBB_DYNAMIC_TOOL.description,
    // The framework validator annotates JSON Schema; keep the shared contract immutable.
    schema: structuredClone(QUERY_XBB_INPUT_SCHEMA),
    func: async (args) => {
      // Access and cancellation are trusted closure values, never model args.
      if (options.signal?.aborted) throw options.signal.reason || new Error("销帮帮查询已取消。");
      return gateway(args, access, options);
    }
  });
}

function invokeQueryTool(gateway, args, access, options) {
  return invokeLocal(createQueryTool(gateway, access, options), args);
}

module.exports = { createQueryTool, invokeQueryTool };
