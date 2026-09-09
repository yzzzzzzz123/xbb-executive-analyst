"use strict";

const WIDTH = 900;
const LEFT = 48;
const RIGHT = 852;
const INK = "#16363C";
const MUTED = "#62777B";
const ACCENT = "#087F8C";
const PALETTE = Object.freeze([ACCENT, "#536EC1", "#C88B36", "#8C699D", "#567B62", "#B36C70", "#7989A8", "#8A8274"]);
const FONT = "Segoe UI, Microsoft YaHei, PingFang SC, Noto Sans CJK SC, sans-serif";

function escapeXml(value) {
  return String(value ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
function round(value) {
  if (!Number.isFinite(value)) throw new Error("图表数值范围超出可渲染范围");
  return Number(value.toFixed(3));
}
function visualWidth(value) {
  return [...String(value ?? "")].reduce((sum, c) => sum + (c.codePointAt(0) > 255 ? 2 : /[MW@%]/.test(c) ? 1.5 : 1.12), 0);
}
function wrap(value, pixels, size) {
  const result = [];
  for (const paragraph of String(value ?? "").split(/\r?\n/)) {
    let row = "";
    for (const c of paragraph) {
      if (row && visualWidth(row + c) * size / 2 > pixels) {
        if (/[，。；：！？、）》】」』%]/u.test(c) && [...row].length > 1) {
          const characters = [...row]; row = characters.pop(); result.push(characters.join(""));
        } else { result.push(row); row = ""; }
      }
      row += c;
    }
    result.push(row);
  }
  return result;
}
function text(x, y, value, opts = {}) {
  const size = opts.size || 24;
  const fit = opts.fit && visualWidth(value) * size / 2 > opts.fit ? ` textLength="${round(opts.fit)}" lengthAdjust="spacingAndGlyphs"` : "";
  return `<text x="${round(x)}" y="${round(y)}" font-size="${size}" font-weight="${opts.weight || 400}" fill="${opts.fill || INK}" text-anchor="${opts.anchor || "start"}"${fit}>${escapeXml(value)}</text>`;
}
function lines(x, y, rows, opts = {}) {
  return rows.map((row, i) => text(x, y + i * (opts.leading || (opts.size || 24) * 1.45), row, opts)).join("");
}
function rect(x, y, width, height, fill, radius = 0, attrs = "") {
  return `<rect x="${round(x)}" y="${round(y)}" width="${round(Math.max(0, width))}" height="${round(height)}" rx="${radius}" fill="${fill}"${attrs}/>`;
}
function line(x1, y1, x2, y2, opts = {}) {
  return `<line x1="${round(x1)}" y1="${round(y1)}" x2="${round(x2)}" y2="${round(y2)}" stroke="${opts.color || "#DBE4E1"}" stroke-width="${opts.width || 1}"${opts.dash ? ` stroke-dasharray="${opts.dash}"` : ""}/>`;
}
function number(value, digits = 1) {
  if (value !== 0 && Math.abs(value) < 0.01) return value.toExponential(1);
  return value.toLocaleString("zh-CN", { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}
function formatValue(value, format, unit = "") {
  const absolute = Math.abs(value);
  if (format === "percent") return `${number(value, 2)}%`;
  const prefix = format === "money" ? "¥" : "";
  const suffix = format === "money" ? "" : unit;
  if (absolute >= 100000000) return `${prefix}${number(value / 100000000, 2)}亿${suffix}`;
  if (absolute >= 10000) return `${prefix}${number(value / 10000, 2)}万${suffix}`;
  return `${prefix}${number(value, 2)}${suffix}`;
}
function percentage(value, total) { return total > 0 ? `${number(value / total * 100, 1)}%` : "—"; }
function sum(values) {
  const total = values.reduce((acc, value) => acc + value, 0);
  if (!Number.isFinite(total)) throw new Error("图表数值合计超出可渲染范围");
  return total;
}
function contrastText(hex) {
  const [r, g, b] = hex.slice(1).match(/../g).map((v) => parseInt(v, 16) / 255).map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.179 ? "#000000" : "#FFFFFF";
}
function headerLayout(spec) {
  const titleRows = wrap(spec.title, RIGHT - LEFT, 36);
  const subtitleRows = spec.subtitle ? wrap(spec.subtitle, RIGHT - LEFT, 19) : [];
  const titleY = 106;
  const subtitleY = titleY + (titleRows.length - 1) * 48 + 34;
  const insightY = subtitleY + subtitleRows.length * 28 + 50;
  const insightRows = wrap(spec.insight, RIGHT - LEFT - 32, 30);
  const bottom = insightY + (insightRows.length - 1) * 44 + 44;
  return { titleRows, subtitleRows, titleY, subtitleY, insightY, insightRows, bottom };
}
function chartFrame(spec, marks, header, bodyBottom, detail = "") {
  const noteRows = spec.note ? wrap(spec.note, RIGHT - LEFT, 19) : [];
  const footerY = Math.max(700, bodyBottom + 36);
  const height = footerY + 76 + noteRows.length * 28;
  const kinds = { bar: "类别比较", "stacked-bar": "结构比较", line: "时间趋势", donut: "整体构成", scatter: "指标关系", funnel: "阶段转化" };
  const desc = [spec.title, spec.subtitle, spec.insight, spec.note, detail].filter(Boolean).join("；");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" role="img" aria-labelledby="chart-title chart-desc" data-renderer="executive-v3">
<title id="chart-title">${escapeXml(spec.title)}</title><desc id="chart-desc">${escapeXml(desc)}</desc>
${rect(0, 0, WIDTH, height, "#FAFCFA")}${rect(LEFT, 0, 62, 7, ACCENT)}
<g font-family="${FONT}" style="font-variant-numeric:tabular-nums">
${text(LEFT, 48, "XBB / 经营洞察", { size: 18, weight: 700, fill: ACCENT })}
${text(RIGHT, 48, kinds[spec.type] || "经营分析", { size: 17, fill: MUTED, anchor: "end" })}
${lines(LEFT, header.titleY, header.titleRows, { size: 36, weight: 700, leading: 48 })}
${lines(LEFT, header.subtitleY, header.subtitleRows, { size: 19, fill: MUTED, leading: 28 })}
${text(LEFT, header.insightY - 42, "关键发现", { size: 17, fill: ACCENT, weight: 700 })}
${rect(LEFT, header.insightY - 25, 4, header.insightRows.length * 44 - 6, ACCENT, 2)}
${lines(LEFT + 20, header.insightY, header.insightRows, { size: 30, weight: 650, leading: 44 })}
${marks}
${line(LEFT, footerY, RIGHT, footerY)}
${text(LEFT, footerY + 34, "数据来源 / 销帮帮实时只读数据", { size: 18, fill: MUTED })}
${lines(LEFT, footerY + 65, noteRows, { size: 19, fill: MUTED, leading: 28 })}
</g></svg>`;
}
module.exports = { WIDTH, LEFT, RIGHT, INK, MUTED, ACCENT, PALETTE, FONT, escapeXml, round, visualWidth, wrap, text, lines, rect, line, number, formatValue, percentage, sum, contrastText, headerLayout, chartFrame };
