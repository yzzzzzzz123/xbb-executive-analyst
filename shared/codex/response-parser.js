"use strict";

const { BaseOutputParser } = require("@langchain/core/output_parsers");
const { parseAgentResponse } = require("./response-contract.js");

class AgentResponseParser extends BaseOutputParser {
  constructor(options = {}) {
    super();
    this.lc_namespace = ["xbb", "output_parsers"];
    this.options = options;
  }

  _type() { return "xbb_text_and_chart"; }

  parse(text) { return parseAgentResponse(text, this.options); }

  getFormatInstructions() {
    return "返回包含 answer 和 chart 的 JSON；answer 必须独立完整回答问题，chart 可为空。";
  }
}

module.exports = { AgentResponseParser };
