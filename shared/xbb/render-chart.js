"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { validateSpec } = require("../../skills/xbb-executive-chart/scripts/chart-contract.js");
const { renderDesign } = require("./render-design.js");
const { WIDTH, LEFT, RIGHT, FONT, ACCENT, MUTED, escapeXml, wrap, lines, text, rect, line } = require("./chart-primitives.js");

function renderComposite(spec) {
  const titleRows = wrap(spec.title, RIGHT - LEFT, 36);
  const subtitleRows = spec.subtitle ? wrap(spec.subtitle, RIGHT - LEFT, 26) : [];
  const subtitleY = 104 + titleRows.length * 48;
  const indexY = subtitleY + subtitleRows.length * 36 + 25;
  const indexRows = spec.panels.flatMap((panel, index) => wrap(`${String(index + 1).padStart(2, "0")}  ${panel.title}`, RIGHT - LEFT, 24));
  let y = indexY + indexRows.length * 36 + 32;
  const panels = spec.panels.map((panel, index) => {
    const svg = renderDesign(panel, { section: index + 1 });
    const height = Number(svg.match(/<svg[^>]* height="([\d.]+)"/)[1]);
    // Generated markup only; each panel keeps its full size and its own caveats.
    const nested = svg.replace(/^<\?xml[^>]+>\s*/, "")
      .replace('xmlns="http://www.w3.org/2000/svg"', "")
      .replace(/chart-title|chart-desc/g, (id) => `panel-${index}-${id}`)
      .replace("<svg ", `<svg x="0" y="${y}" `);
    y += height + 26;
    return nested;
  });
  const noteRows = spec.note ? wrap(spec.note, RIGHT - LEFT, 24) : [];
  const height = y + noteRows.length * 34 + 96;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" role="img" aria-labelledby="composite-title" data-renderer="executive-composite-v2">
<title id="composite-title">${escapeXml(spec.title)}</title>
${rect(0, 0, WIDTH, height, "#FAFCFA")}
<g font-family="${FONT}">${text(LEFT, 48, "XBB / 综合经营分析", { size: 24, fill: ACCENT, weight: 700 })}
${lines(LEFT, 104, titleRows, { size: 36, weight: 700, leading: 48 })}
${lines(LEFT, subtitleY, subtitleRows, { size: 26, fill: MUTED, leading: 36 })}
${lines(LEFT, indexY, indexRows, { size: 24, fill: ACCENT, leading: 36 })}</g>
${panels.join("\n")}
<g font-family="${FONT}">${line(LEFT, y - 15, RIGHT, y - 15)}
${text(LEFT, y + 22, "数据来源 / 销帮帮实时只读数据", { size: 22, fill: MUTED })}
${lines(LEFT, y + 59, noteRows, { size: 24, fill: MUTED, leading: 34 })}</g></svg>`;
}

function render(input) {
  const spec = validateSpec(input);
  const svg = spec.type === "composite" ? renderComposite(spec) : renderDesign(spec);
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
