"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { validateSpec } = require("../../skills/xbb-executive-chart/scripts/chart-contract.js");
const { renderDesign } = require("./render-design.js");

function render(input) {
  const svg = renderDesign(validateSpec(input));
  const source = svg.replace('xmlns="http://www.w3.org/2000/svg"', "");
  if (/<(?:script|foreignObject|iframe|object|embed)\b|\b(?:href|xlink:href)\s*=|\bon[a-z]+\s*=|\burl\s*\(|javascript:|data:/i.test(source)) {
    throw new Error("图表包含禁止的外部或可执行内容");
  }
  return svg;
}

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--spec" || key === "--output") {
      result[key.slice(2)] = argv[index + 1];
      index += 1;
    } else {
      throw new Error(`不支持的参数：${key}`);
    }
  }
  if (!result.spec || !result.output) throw new Error("必须提供 --spec 和 --output");
  return result;
}

function atomicWrite(outputPath, value) {
  const resolved = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(temporary, value, { encoding: "utf8", flag: "wx" });
    fs.renameSync(temporary, resolved);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch (_) { /* no temporary file */ }
    throw error;
  }
  return resolved;
}

function main() {
  const args = parseArguments(process.argv.slice(2));
  const input = JSON.parse(fs.readFileSync(path.resolve(args.spec), "utf8"));
  const spec = validateSpec(input);
  const svg = render(spec);
  const output = atomicWrite(args.output, svg);
  process.stdout.write(`${JSON.stringify({ success: true, type: spec.type, output, bytes: Buffer.byteLength(svg, "utf8") })}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error && error.message ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = { render, validateSpec };
