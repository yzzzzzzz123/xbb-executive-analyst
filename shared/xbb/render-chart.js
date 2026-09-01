"use strict";

const fs = require("node:fs");
const path = require("node:path");

const WIDTH = 1200;
const HEIGHT = 720;
const COLORS = ["#F15A24", "#253A74", "#18A999", "#E4A11B", "#5A67D8", "#C24172", "#3B82F6", "#64748B"];

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatValue(value, format, unit = "") {
  const n = number(value);
  if (format === "money") {
    const absolute = Math.abs(n);
    if (absolute >= 100000000) return `¥${(n / 100000000).toFixed(2).replace(/\.00$/, "")}亿`;
    if (absolute >= 10000) return `¥${(n / 10000).toFixed(1).replace(/\.0$/, "")}万`;
    return `¥${Math.round(n).toLocaleString("zh-CN")}`;
  }
  if (format === "percent") return `${n.toFixed(1).replace(/\.0$/, "")}%`;
  const text = Math.abs(n) >= 10000 ? `${(n / 10000).toFixed(1).replace(/\.0$/, "")}万` : n.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
  return `${text}${unit || ""}`;
}

function text(x, y, value, options = {}) {
  const anchor = options.anchor || "start";
  const size = options.size || 18;
  const weight = options.weight || 400;
  const fill = options.fill || "#24324A";
  const opacity = options.opacity === undefined ? 1 : options.opacity;
  const transform = options.rotate ? ` transform="rotate(${options.rotate} ${x} ${y})"` : "";
  return `<text x="${x}" y="${y}" text-anchor="${anchor}" font-size="${size}" font-weight="${weight}" fill="${fill}" opacity="${opacity}"${transform}>${escapeXml(value)}</text>`;
}

function line(x1, y1, x2, y2, options = {}) {
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${options.stroke || "#DDE3EC"}" stroke-width="${options.width || 1}"${options.dash ? ` stroke-dasharray="${options.dash}"` : ""}/>`;
}

function truncate(value, limit = 16) {
  const str = String(value ?? "");
  return str.length > limit ? `${str.slice(0, limit - 1)}…` : str;
}

function validateSpec(spec) {
  const types = new Set(["bar", "stacked-bar", "line", "donut", "scatter", "funnel"]);
  if (!spec || !types.has(spec.type)) throw new Error("图表 type 必须是 bar、stacked-bar、line、donut、scatter 或 funnel");
  if (!String(spec.title || "").trim()) throw new Error("图表必须提供 title");
  if (["bar", "stacked-bar", "line"].includes(spec.type)) {
    if (!Array.isArray(spec.categories) || !spec.categories.length || spec.categories.length > 30) throw new Error("图表 categories 必须包含 1—30 项");
    if (!Array.isArray(spec.series) || !spec.series.length || spec.series.length > 8) throw new Error("图表 series 必须包含 1—8 项");
    for (const series of spec.series) {
      if (!Array.isArray(series.values) || series.values.length !== spec.categories.length) throw new Error("每个 series.values 必须与 categories 等长");
    }
  }
  if (spec.type === "donut" && (!Array.isArray(spec.items) || !spec.items.length || spec.items.length > 12)) throw new Error("环形图 items 必须包含 1—12 项");
  if (spec.type === "scatter" && (!Array.isArray(spec.points) || !spec.points.length || spec.points.length > 80)) throw new Error("散点图 points 必须包含 1—80 项");
  if (spec.type === "funnel" && (!Array.isArray(spec.items) || !spec.items.length || spec.items.length > 10)) throw new Error("漏斗图 items 必须包含 1—10 项");
}

function chartFrame(spec, content, legend = "") {
  const subtitle = String(spec.subtitle || "");
  const note = String(spec.note || "");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-labelledby="chart-title chart-desc">
  <title id="chart-title">${escapeXml(spec.title)}</title>
  <desc id="chart-desc">${escapeXml(subtitle || note || spec.title)}</desc>
  <rect width="${WIDTH}" height="${HEIGHT}" rx="28" fill="#F7F5F1"/>
  <rect x="20" y="20" width="1160" height="680" rx="22" fill="#FFFFFF" stroke="#E7E1D8"/>
  <g font-family="Microsoft YaHei, PingFang SC, Noto Sans CJK SC, sans-serif">
    ${text(64, 74, spec.title, { size: 30, weight: 700, fill: "#18233A" })}
    ${subtitle ? text(64, 108, subtitle, { size: 16, fill: "#6B7280" }) : ""}
    ${legend}
    ${content}
    ${note ? text(64, 674, truncate(note, 85), { size: 14, fill: "#7B8190" }) : ""}
  </g>
</svg>`;
}

function legendMarkup(series, startX = 700, y = 82) {
  let x = startX;
  return series.map((item, index) => {
    const label = truncate(item.name || `系列 ${index + 1}`, 12);
    const color = item.color || COLORS[index % COLORS.length];
    const markup = `<rect x="${x}" y="${y - 12}" width="12" height="12" rx="3" fill="${color}"/>${text(x + 20, y, label, { size: 14, fill: "#5D6472" })}`;
    x += 40 + label.length * 15;
    return markup;
  }).join("");
}

function renderBar(spec) {
  const categories = spec.categories.map(String);
  const series = spec.series;
  const left = 230;
  const right = 1110;
  const top = 145;
  const bottom = 620;
  const grouped = series.length > 1;
  const max = Math.max(1, ...series.flatMap((item) => item.values.map(number)));
  const rowHeight = (bottom - top) / categories.length;
  const groupHeight = Math.min(34, rowHeight * 0.68);
  const barHeight = grouped ? groupHeight / series.length : groupHeight;
  const marks = [];
  for (let tick = 0; tick <= 4; tick += 1) {
    const value = max * tick / 4;
    const x = left + (right - left) * tick / 4;
    marks.push(line(x, top - 8, x, bottom, { stroke: "#E8EBF0", dash: "4 5" }));
    marks.push(text(x, bottom + 28, formatValue(value, spec.valueFormat, spec.unit), { anchor: "middle", size: 13, fill: "#7B8190" }));
  }
  categories.forEach((category, categoryIndex) => {
    const center = top + rowHeight * categoryIndex + rowHeight / 2;
    marks.push(text(left - 18, center + 5, truncate(category, 14), { anchor: "end", size: 15, fill: "#3C465A" }));
    series.forEach((item, seriesIndex) => {
      const value = number(item.values[categoryIndex]);
      const width = Math.max(0, (right - left) * value / max);
      const y = grouped ? center - groupHeight / 2 + seriesIndex * barHeight : center - barHeight / 2;
      const color = item.color || COLORS[seriesIndex % COLORS.length];
      marks.push(`<rect x="${left}" y="${y}" width="${width}" height="${Math.max(4, barHeight - 3)}" rx="${Math.min(7, barHeight / 2)}" fill="${color}" opacity="0.92"/>`);
      if (value !== 0) marks.push(text(Math.min(right - 4, left + width + 10), y + barHeight * 0.68, formatValue(value, spec.valueFormat, spec.unit), { size: 12, fill: "#485168" }));
    });
  });
  return chartFrame(spec, marks.join(""), legendMarkup(series));
}

function renderStackedBar(spec) {
  const categories = spec.categories.map(String);
  const series = spec.series;
  const left = 230;
  const right = 1110;
  const top = 150;
  const bottom = 620;
  const totals = categories.map((_, categoryIndex) => sumSeries(series, categoryIndex));
  const max = Math.max(1, ...totals);
  const rowHeight = (bottom - top) / categories.length;
  const barHeight = Math.min(38, rowHeight * 0.62);
  const marks = [];
  for (let tick = 0; tick <= 4; tick += 1) {
    const x = left + (right - left) * tick / 4;
    marks.push(line(x, top - 8, x, bottom, { stroke: "#E8EBF0", dash: "4 5" }));
    marks.push(text(x, bottom + 28, formatValue(max * tick / 4, spec.valueFormat, spec.unit), { anchor: "middle", size: 13, fill: "#7B8190" }));
  }
  categories.forEach((category, categoryIndex) => {
    const y = top + rowHeight * categoryIndex + (rowHeight - barHeight) / 2;
    marks.push(text(left - 18, y + barHeight * 0.65, truncate(category, 14), { anchor: "end", size: 15, fill: "#3C465A" }));
    let cursor = left;
    series.forEach((item, seriesIndex) => {
      const value = number(item.values[categoryIndex]);
      const width = (right - left) * value / max;
      const color = item.color || COLORS[seriesIndex % COLORS.length];
      marks.push(`<rect x="${cursor}" y="${y}" width="${Math.max(0, width)}" height="${barHeight}" rx="5" fill="${color}" opacity="0.92"/>`);
      if (width > 54 && value !== 0) marks.push(text(cursor + width / 2, y + barHeight * 0.65, formatValue(value, spec.valueFormat, spec.unit), { anchor: "middle", size: 12, weight: 600, fill: "#FFFFFF" }));
      cursor += width;
    });
    marks.push(text(Math.min(right, cursor) + 10, y + barHeight * 0.65, formatValue(totals[categoryIndex], spec.valueFormat, spec.unit), { size: 12, fill: "#485168" }));
  });
  return chartFrame(spec, marks.join(""), legendMarkup(series));
}

function sumSeries(series, index) {
  return series.reduce((total, item) => total + Math.max(0, number(item.values[index])), 0);
}

function renderLine(spec) {
  const categories = spec.categories.map(String);
  const series = spec.series;
  const left = 105;
  const right = 1120;
  const top = 155;
  const bottom = 600;
  const values = series.flatMap((item) => item.values.map(number));
  const minRaw = Math.min(0, ...values);
  const maxRaw = Math.max(1, ...values);
  const span = maxRaw - minRaw || 1;
  const xAt = (index) => left + (right - left) * (categories.length === 1 ? 0.5 : index / (categories.length - 1));
  const yAt = (value) => bottom - (bottom - top) * (number(value) - minRaw) / span;
  const marks = [];
  for (let tick = 0; tick <= 4; tick += 1) {
    const y = bottom - (bottom - top) * tick / 4;
    const value = minRaw + span * tick / 4;
    marks.push(line(left, y, right, y, { stroke: "#E8EBF0", dash: "4 5" }));
    marks.push(text(left - 14, y + 5, formatValue(value, spec.valueFormat, spec.unit), { anchor: "end", size: 13, fill: "#7B8190" }));
  }
  categories.forEach((category, index) => {
    if (categories.length <= 12 || index % Math.ceil(categories.length / 10) === 0 || index === categories.length - 1) {
      marks.push(text(xAt(index), bottom + 32, truncate(category, 10), { anchor: "middle", size: 13, fill: "#7B8190" }));
    }
  });
  series.forEach((item, seriesIndex) => {
    const color = item.color || COLORS[seriesIndex % COLORS.length];
    const points = item.values.map((value, index) => `${xAt(index)},${yAt(value)}`).join(" ");
    marks.push(`<polyline points="${points}" fill="none" stroke="${color}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`);
    item.values.forEach((value, index) => {
      marks.push(`<circle cx="${xAt(index)}" cy="${yAt(value)}" r="5" fill="#FFFFFF" stroke="${color}" stroke-width="3"/>`);
    });
  });
  return chartFrame(spec, marks.join(""), legendMarkup(series));
}

function renderDonut(spec) {
  const items = spec.items.map((item, index) => ({ name: String(item.name || `项目 ${index + 1}`), value: Math.max(0, number(item.value)), color: item.color || COLORS[index % COLORS.length] }));
  const total = items.reduce((sum, item) => sum + item.value, 0) || 1;
  const cx = 385;
  const cy = 375;
  const radius = 170;
  const strokeWidth = 64;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  const marks = [];
  items.forEach((item) => {
    const length = circumference * item.value / total;
    marks.push(`<circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="${item.color}" stroke-width="${strokeWidth}" stroke-dasharray="${length} ${circumference - length}" stroke-dashoffset="${-offset}" transform="rotate(-90 ${cx} ${cy})"/>`);
    offset += length;
  });
  marks.push(text(cx, cy - 4, formatValue(items.reduce((sum, item) => sum + item.value, 0), spec.valueFormat, spec.unit), { anchor: "middle", size: 34, weight: 700, fill: "#18233A" }));
  marks.push(text(cx, cy + 30, spec.centerLabel || "合计", { anchor: "middle", size: 15, fill: "#7B8190" }));
  items.forEach((item, index) => {
    const y = 190 + index * 48;
    marks.push(`<rect x="690" y="${y - 15}" width="16" height="16" rx="4" fill="${item.color}"/>`);
    marks.push(text(720, y, truncate(item.name, 16), { size: 16, fill: "#39445A" }));
    marks.push(text(1080, y, `${formatValue(item.value, spec.valueFormat, spec.unit)} · ${percentageText(item.value, total)}`, { anchor: "end", size: 16, weight: 600, fill: "#18233A" }));
  });
  return chartFrame(spec, marks.join(""));
}

function percentageText(value, total) {
  return `${(total > 0 ? value / total * 100 : 0).toFixed(1).replace(/\.0$/, "")}%`;
}

function renderScatter(spec) {
  const points = spec.points.map((point, index) => ({
    x: number(point.x),
    y: number(point.y),
    size: Math.max(5, Math.min(30, Math.sqrt(Math.max(0, number(point.size) || 1)) * 3)),
    label: String(point.label || `点 ${index + 1}`),
    color: point.color || COLORS[index % COLORS.length]
  }));
  const left = 115;
  const right = 1110;
  const top = 155;
  const bottom = 600;
  const minX = Math.min(0, ...points.map((point) => point.x));
  const maxX = Math.max(1, ...points.map((point) => point.x));
  const minY = Math.min(0, ...points.map((point) => point.y));
  const maxY = Math.max(1, ...points.map((point) => point.y));
  const xAt = (value) => left + (right - left) * (value - minX) / (maxX - minX || 1);
  const yAt = (value) => bottom - (bottom - top) * (value - minY) / (maxY - minY || 1);
  const marks = [];
  for (let tick = 0; tick <= 4; tick += 1) {
    const x = left + (right - left) * tick / 4;
    const y = bottom - (bottom - top) * tick / 4;
    marks.push(line(x, top, x, bottom, { stroke: "#E8EBF0", dash: "4 5" }));
    marks.push(line(left, y, right, y, { stroke: "#E8EBF0", dash: "4 5" }));
    marks.push(text(x, bottom + 30, formatValue(minX + (maxX - minX) * tick / 4, spec.xFormat || "number", spec.xUnit), { anchor: "middle", size: 13, fill: "#7B8190" }));
    marks.push(text(left - 14, y + 5, formatValue(minY + (maxY - minY) * tick / 4, spec.yFormat || spec.valueFormat, spec.yUnit), { anchor: "end", size: 13, fill: "#7B8190" }));
  }
  points.forEach((point) => {
    const x = xAt(point.x);
    const y = yAt(point.y);
    marks.push(`<circle cx="${x}" cy="${y}" r="${point.size}" fill="${point.color}" opacity="0.72" stroke="#FFFFFF" stroke-width="2"/>`);
    if (points.length <= 20) marks.push(text(x + point.size + 4, y - point.size - 2, truncate(point.label, 12), { size: 12, fill: "#4B5568" }));
  });
  if (spec.xLabel) marks.push(text((left + right) / 2, 660, spec.xLabel, { anchor: "middle", size: 14, fill: "#6B7280" }));
  if (spec.yLabel) marks.push(text(34, (top + bottom) / 2, spec.yLabel, { anchor: "middle", size: 14, fill: "#6B7280", rotate: -90 }));
  return chartFrame(spec, marks.join(""));
}

function renderFunnel(spec) {
  const items = spec.items.map((item, index) => ({ name: String(item.name || `阶段 ${index + 1}`), value: Math.max(0, number(item.value)), color: item.color || COLORS[index % COLORS.length] }));
  const max = Math.max(1, ...items.map((item) => item.value));
  const cx = 600;
  const top = 155;
  const bottom = 610;
  const rowHeight = (bottom - top) / items.length;
  const marks = [];
  items.forEach((item, index) => {
    const topWidth = 820 * (index === 0 ? item.value : items[index - 1].value) / max;
    const bottomWidth = 820 * item.value / max;
    const y1 = top + index * rowHeight;
    const y2 = y1 + rowHeight - 8;
    const points = `${cx - topWidth / 2},${y1} ${cx + topWidth / 2},${y1} ${cx + bottomWidth / 2},${y2} ${cx - bottomWidth / 2},${y2}`;
    marks.push(`<polygon points="${points}" fill="${item.color}" opacity="0.9"/>`);
    marks.push(text(cx, y1 + rowHeight * 0.55, `${truncate(item.name, 18)}  ${formatValue(item.value, spec.valueFormat, spec.unit)}`, { anchor: "middle", size: 17, weight: 600, fill: "#FFFFFF" }));
  });
  return chartFrame(spec, marks.join(""));
}

function render(spec) {
  validateSpec(spec);
  if (spec.type === "bar") return renderBar(spec);
  if (spec.type === "stacked-bar") return renderStackedBar(spec);
  if (spec.type === "line") return renderLine(spec);
  if (spec.type === "donut") return renderDonut(spec);
  if (spec.type === "scatter") return renderScatter(spec);
  return renderFunnel(spec);
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
  const spec = JSON.parse(fs.readFileSync(path.resolve(args.spec), "utf8"));
  const svg = render(spec);
  const securityScan = svg.replace('xmlns="http://www.w3.org/2000/svg"', "");
  if (/<(?:script|foreignObject)\b|\b(?:href|xlink:href)\s*=|https?:\/\//i.test(securityScan)) throw new Error("图表包含禁止的外部或可执行内容");
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
