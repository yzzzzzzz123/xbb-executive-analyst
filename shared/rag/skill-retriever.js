"use strict";

const { BaseRetriever } = require("@langchain/core/retrievers");
const { Document } = require("@langchain/core/documents");
const { RunnableBranch, RunnableLambda, RunnableSequence } = require("@langchain/core/runnables");

class SkillRuleRetriever extends BaseRetriever {
  constructor(knowledgeBase, options = {}) {
    super({});
    this.knowledgeBase = knowledgeBase;
    this.options = options;
    this.lc_namespace = ["xbb", "retrievers"];
  }

  async _getRelevantDocuments(question) {
    const context = this.knowledgeBase.retrieve(question, this.options);
    // A bounded rule bundle preserves the mandatory sections, source order and
    // byte budget selected by the existing hybrid retriever. No live facts are
    // indexed, embedded, cached or persisted by this adapter.
    return [new Document({
      pageContent: context.text,
      metadata: { sources: context.sources, domains: context.domains, bytes: context.bytes,
        digest: context.digest, retrieval: context.retrieval }
    })];
  }
}

function createRuleContextChain(knowledgeBase) {
  const business = RunnableSequence.from([
    RunnableLambda.from((input) => new SkillRuleRetriever(knowledgeBase, input.options).invoke(input.question)),
    RunnableLambda.from((documents) => ({ ...documents[0].metadata, text: documents[0].pageContent }))
  ], "retrieve_business_rules");
  return RunnableBranch.from([
    [(input) => input.businessMode, business],
    RunnableLambda.from(() => null)
  ]);
}

module.exports = { SkillRuleRetriever, createRuleContextChain };
