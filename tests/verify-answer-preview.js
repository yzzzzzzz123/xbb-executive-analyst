"use strict";

const assert = require("node:assert/strict");
const { performance } = require("node:perf_hooks");
const {
  extractAnswerPreview,
  MAX_PREVIEW_INPUT_BYTES,
  MAX_PREVIEW_OUTPUT_BYTES
} = require("../shared/codex/answer-preview.js");

const gate = { phase: "final_answer", itemType: "agentMessage" };
const parse = (source, options = {}) => extractAnswerPreview(source, { ...gate, ...options });
const document = (answer) => JSON.stringify({ answer, chart: null });

function everyPrefix(source, inspect) {
  for (let index = 0; index <= source.length; index += 1) inspect(parse(source.slice(0, index)), index);
}

function verify() {
  assert.deepEqual(parse('{"answer":"第一段已经完整。\\n\\n第二段仍在生成'), {
    status: "preview", text: "第一段已经完整。", reason: "safe_prefix"
  });
  assert.equal(parse('{"answer":"第一段还没有结束').status, "held");
  assert.equal(parse('{"answer":"完整结论。"').status, "preview");
  assert.equal(parse('{"answer":"完整结论。"', { finished: true }).status, "blocked");
  assert.equal(parse(document("完整结论。"), { finished: true }).status, "complete");
  assert.ok(Object.isFrozen(parse(document("完整结论。"))));
  for (const options of [{}, { ...gate, phase: "commentary" }, { ...gate, phase: "reasoning" }, { ...gate, itemType: "reasoning" }]) {
    assert.deepEqual(extractAnswerPreview(document("不可展示"), options), { status: "blocked", text: "", reason: "gate_mismatch" });
  }
  assert.equal(parse(null).reason, "invalid_input");

  const unicode = '中文 😀 👩‍💻 引号" 反斜杠\\ 正斜杠/\n\n末段。';
  const unicodeJson = document(unicode);
  let previous = "";
  everyPrefix(unicodeJson, (value) => {
    assert.notEqual(value.status, "blocked");
    if (value.text) {
      assert.ok(value.text.startsWith(previous), "新增 delta 不能改写已发布的安全前缀");
      assert.doesNotMatch(value.text, /[\ud800-\udfff](?![\udc00-\udfff])/u);
      previous = value.text;
    }
  });
  assert.equal(parse(unicodeJson).text, unicode);
  const escaped = '{"ans\\u0077er":"\\u4e2d\\u6587 \\uD83D\\uDE00 \\/ \\\\ \\"\\n\\n尾段","chart":null}';
  everyPrefix(escaped, (value) => assert.notEqual(value.status, "blocked"));
  assert.equal(parse(escaped).text, '中文 😀 / \\ "\n\n尾段');
  for (const broken of ['{"answer":"\\x', '{"answer":"\\u12xz', '{"answer":"\\uD800x', '{"answer":"\\uDC00', '{"answer":"\\uD800"', '{"answer":"raw\nline']) {
    assert.equal(parse(broken).status, "blocked");
  }
  for (const partial of ['{"answer":"\\', '{"answer":"\\u', '{"answer":"\\u12', '{"answer":"\\uD83D', '{"answer":"\\uD83D\\uDE']) {
    assert.equal(parse(partial).status, "held");
  }

  const secrets = [
    { raw: "sk-testPrivateValue123456789", marker: "[密钥已脱敏]" },
    { raw: "ghp_secretValueForSyntheticTests", marker: "[密钥已脱敏]" },
    { raw: "github_pat_synthetic12345", marker: "[密钥已脱敏]" },
    { raw: "13912345678", marker: "[手机号已脱敏]" },
    { raw: "139-1234-5678", marker: "[手机号已脱敏]" },
    { raw: "synthetic.person@example.test", marker: "[邮箱已脱敏]" },
    { raw: "用户@例子.测试", marker: "[邮箱已脱敏]" }
  ];
  for (const { raw, marker } of secrets) {
    const source = document(`安全开场。\n\n测试项 ${raw}。\n\n安全收尾。`);
    everyPrefix(source, (value) => {
      assert.notEqual(value.status, "blocked");
      assert.ok(!value.text.includes(raw));
      if (value.text.includes("测试项")) assert.ok(value.text.includes(marker), "完整段落发布前必须完成脱敏");
    });
    assert.ok(parse(source).text.includes(marker));
  }
  assert.equal(parse(document("短前缀 sk-abc")).text, "短前缀 [密钥已脱敏]");
  assert.equal(parse('{"answer":"联系 synthetic.person@').text, "");
  assert.equal(parse('{"answer":"联系 1391234').text, "");
  assert.equal(parse('{"answer":"凭据 sk-test').text, "");
  for (const raw of ["１３９１２３４５６７８", "synthetic＠example.test", "ｓｋ－syntheticValue", "ｇｈｐ＿syntheticValue"]) {
    everyPrefix(document(`测试项 ${raw}。\n\n后续正文。`), (value) => assert.ok(!value.text.includes(raw)));
    assert.equal(parse(document(raw)).reason, "normalized_sensitive_text");
  }
  assert.equal(parse(document('保留代码字面量 "Ａ"')).text, '保留代码字面量 "Ａ"');

  for (const marker of ["```", "````", "~~~"]) {
    const code = `${marker}sql\nSELECT '中文😀';\n\nSELECT 2;\n${marker}`;
    const opening = JSON.stringify(`介绍。\n\n${code}`).slice(0, -1);
    assert.equal(parse(`{"answer":${opening}`).text, "介绍。", "未结束的 closing fence 行仍需保留");
    const newline = JSON.stringify(`介绍。\n\n${code}\n`).slice(0, -1);
    assert.equal(parse(`{"answer":${newline}`).text, `介绍。\n\n${code}`);
    assert.equal(parse(document(code)).text, code);
  }
  const unclosedCode = "```sql\nSELECT 1;\n\n未结束代码";
  assert.equal(parse(`{"answer":${JSON.stringify(unclosedCode).slice(0, -1)}`).status, "held");
  assert.equal(parse(document(unclosedCode)).reason, "incomplete_code_fence");
  assert.equal(parse(document("```txt\nsk-syntheticExample\n```" )).text, "```txt\n[密钥已脱敏]\n```");

  for (const unsafe of [
    "<think>不应输出</think>结论", "<think>不应输出", "<THINK >不应输出", "< think>不应输出", "<", "＜think＞不应输出",
    "&lt;think&gt;不应输出", "&#60;think>不应输出", "&amp;lt;think&gt;不应输出", "<script>alert(1)</script>",
    "正文\n\n<iframe", "正文\n\n<\n\nscript", "API_KEY=synthetic-value", "password: synthetic-value", "Bearer synthetic-value", "正文\u202e重排"
  ]) {
    const value = parse(document(unsafe));
    assert.equal(value.status, "blocked");
    assert.equal(value.text, "");
    assert.ok(!JSON.stringify(value).includes("不应输出"));
  }
  everyPrefix(document("<think>私有内容</think>结论"), (value) => assert.equal(value.text, ""));
  assert.equal(parse(document("```html\n<div>页面</div>\n```" )).reason, "unsafe_markup");

  for (const invalid of [
    '{"chart":null,"answer":"结论"}', '{"answer":123,"chart":null}', '{"answer":null,"chart":null}',
    '{"answer":"结论","answer":"重复","chart":null}', '{"answer":"结论","chart":null,"answer":"重复"}',
    '{"answer":"结论","chart":{}}', '{"answer":"结论","chart":"null"}', '{"answer":"结论","other":null}',
    '{"answer":"结论"}', '{"answer":"结论","chart":null} trailing', '[{"answer":"结论","chart":null}]',
    '{"answer":"结论","chart":nulz}', '{"answer":"结论","chart":null,}', '{"answer":"结论",bad'
  ]) {
    assert.equal(parse(invalid).status, "blocked", "异常 envelope 不得回显任何尾字段或原始错误");
    assert.equal(parse(invalid).text, "");
  }
  for (const partial of ['', '{', '{"answer":"结论",', '{"answer":"结论","chart":nu']) {
    assert.equal(parse(partial, { finished: true }).status, "blocked");
  }
  assert.equal(parse(' { "answer" : "结论", "chart" : null } \r\n').status, "complete");

  assert.equal(parse("x".repeat(MAX_PREVIEW_INPUT_BYTES + 1)).reason, "input_limit");
  assert.equal(parse(document("中".repeat(MAX_PREVIEW_INPUT_BYTES / 2))).reason, "input_limit");
  const giantUnit = "a".repeat(MAX_PREVIEW_OUTPUT_BYTES + 1);
  assert.deepEqual(parse(document(giantUnit)), { status: "complete", text: "", reason: "output_limit" });
  const capped = parse(document(`可展示。\n\n${giantUnit}\n\n不应跳过中间大段。`));
  assert.equal(capped.text, "可展示。");
  assert.equal(capped.reason, "output_limit");
  assert.ok(Buffer.byteLength(capped.text) <= MAX_PREVIEW_OUTPUT_BYTES);
  const manyUnits = parse(document("合成句。\n\n".repeat(1000)));
  assert.ok(Buffer.byteLength(manyUnits.text) <= MAX_PREVIEW_OUTPUT_BYTES);
  assert.equal(manyUnits.status, "complete");
  const adversarial = ["x".repeat(35000), `${"a".repeat(34000)}@example.test`, "amp;".repeat(8000), "1".repeat(35000)];
  const started = performance.now();
  for (let repeat = 0; repeat < 8; repeat += 1) {
    for (const value of adversarial) assert.notEqual(parse(document(value)).status, "blocked");
  }
  assert.ok(performance.now() - started < 2000, "有界长词元不能触发灾难性邮箱正则回溯");

  console.log("answer preview: 7 groups passed (envelope, unicode/deltas, redaction, fences, fail-closed markup, invalid input, bounds)");
}

verify();
