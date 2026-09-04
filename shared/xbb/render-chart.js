"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { validateSpec } = require("../../skills/xbb-executive-chart/scripts/chart-contract.js");

const WIDTH = 1200;
const HEIGHT = 900;
const INNER_LEFT = 64;
const INNER_RIGHT = 1136;
const PLOT_BOTTOM = 790;
const FOOTER_TOP = 815;
const COLORS = Object.freeze([
  "#E85D2A", "#315D9B", "#168B83", "#D39518",
  "#685FB2", "#B24570", "#3F70AA", "#69778E"
]);
const MUTED_BAR = "#7183A4";
const LIGHT_ON_COLOR = "#FFFFFF";
const DARK_ON_COLOR = "#0B1220";

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function text(x, y, value, options = {}) {
  const anchor = options.anchor || "start";
  const size = options.size || 18;
  const weight = options.weight || 400;
  const fill = options.fill || "#24324A";
  const opacity = options.opacity === undefined ? 1 : options.opacity;
  const transform = options.rotate ? ` transform="rotate(${options.rotate} ${x} ${y})"` : "";
  return `<text x="${round(x)}" y="${round(y)}" text-anchor="${anchor}" font-size="${size}" font-weight="${weight}" fill="${fill}" opacity="${opacity}"${transform}>${escapeXml(value)}</text>`;
}

function line(x1, y1, x2, y2, options = {}) {
  const dash = options.dash ? ` stroke-dasharray="${options.dash}"` : "";
  return `<line x1="${round(x1)}" y1="${round(y1)}" x2="${round(x2)}" y2="${round(y2)}" stroke="${options.stroke || "#E4E8EF"}" stroke-width="${options.width || 1}"${dash}/>`;
}

function round(value) {
  if (!Number.isFinite(value)) throw new Error("图表数值范围超出可渲染范围");
  return Number(value.toFixed(2));
}

function visualWidth(value) {
  let width = 0;
  for (const character of String(value ?? "")) {
    const codePoint = character.codePointAt(0);
    width += codePoint > 0xFF || /[\u2E80-\u9FFF\uF900-\uFAFF\uFF01-\uFF60\uFFE0-\uFFE6]/u.test(character) ? 2 : 1;
  }
  return width;
}

function truncateVisual(value, maxWidth) {
  const source = String(value ?? "");
  if (visualWidth(source) <= maxWidth) return source;
  const target = Math.max(1, maxWidth - 2);
  let result = "";
  let width = 0;
  for (const character of source) {
    const characterWidth = visualWidth(character);
    if (width + characterWidth > target) break;
    result += character;
    width += characterWidth;
  }
  return `${result}…`;
}

function wrapVisual(value, maxWidth, maxLines) {
  const characters = [...String(value ?? "")];
  const lines = [];
  let cursor = 0;
  while (cursor < characters.length && lines.length < maxLines) {
    if (lines.length === maxLines - 1) {
      lines.push(truncateVisual(characters.slice(cursor).join(""), maxWidth));
      break;
    }
    let width = 0;
    let end = cursor;
    while (end < characters.length) {
      const characterWidth = visualWidth(characters[end]);
      if (width + characterWidth > maxWidth) break;
      width += characterWidth;
      end += 1;
    }
    lines.push(characters.slice(cursor, end).join("").trim());
    cursor = end;
  }
  return lines.filter(Boolean);
}

function formatValue(value, format, unit = "") {
  if (format === "money") {
    const sign = value < 0 ? "-" : "";
    const absolute = Math.abs(value);
    if (absolute >= 100000000) return `${sign}¥${trimZeros(absolute / 100000000, 2)}亿`;
    if (absolute >= 10000) return `${sign}¥${trimZeros(absolute / 10000, 1)}万`;
    return `${sign}¥${absolute.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}`;
  }
  if (format === "percent") return `${trimZeros(value, 2)}%`;
  const absolute = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (absolute >= 100000000) return `${sign}${trimZeros(absolute / 100000000, 2)}亿${unit}`;
  if (absolute >= 10000) return `${sign}${trimZeros(absolute / 10000, 1)}万${unit}`;
  return `${value.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}${unit}`;
}

function trimZeros(value, digits) {
  return Number(value.toFixed(digits)).toLocaleString("zh-CN", { maximumFractionDigits: digits });
}

function relativeLuminance(hex) {
  const channels = hex.slice(1).match(/../g).map((value) => parseInt(value, 16) / 255);
  const [red, green, blue] = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(first, second) {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  return (Math.max(firstLuminance, secondLuminance) + 0.05) / (Math.min(firstLuminance, secondLuminance) + 0.05);
}

function contrastText(background) {
  return contrastRatio(background, LIGHT_ON_COLOR) >= contrastRatio(background, DARK_ON_COLOR)
    ? LIGHT_ON_COLOR
    : DARK_ON_COLOR;
}

function createLayout(spec, series = []) {
  const insightLines = wrapVisual(spec.insight, 94, 2);
  const insightHeight = insightLines.length > 1 ? 84 : 64;
  const insightTop = 168;
  const legend = buildLegend(series, insightTop + insightHeight + 18);
  const plotTop = legend.height > 0
    ? legend.bottom + 18
    : insightTop + insightHeight + 22;
  return { insightLines, insightTop, insightHeight, legend, plotTop, plotBottom: PLOT_BOTTOM };
}

function buildLegend(series, startY) {
  if (series.length <= 1) return { markup: "", height: 0, bottom: startY };
  let x = INNER_LEFT;
  let y = startY + 14;
  let rows = 1;
  const marks = [];
  series.forEach((entry, index) => {
    const label = truncateVisual(entry.name, 20);
    const itemWidth = 34 + visualWidth(label) * 8;
    if (x !== INNER_LEFT && x + itemWidth > INNER_RIGHT) {
      x = INNER_LEFT;
      y += 30;
      rows += 1;
    }
    marks.push(`<rect x="${x}" y="${y - 12}" width="14" height="14" rx="4" fill="${COLORS[index % COLORS.length]}"/>`);
    marks.push(text(x + 23, y, label, { size: 14, fill: "#536074" }));
    x += itemWidth;
  });
  return { markup: marks.join(""), height: rows * 30, bottom: startY + rows * 30 };
}

function chartFrame(spec, content, layout) {
  const insightText = layout.insightLines.map((entry, index) => text(
    205,
    layout.insightTop + 38 + index * 24,
    entry,
    { size: 18, weight: 600, fill: "#5E2E1B" }
  )).join("");
  const note = spec.note
    ? text(INNER_LEFT, 874, truncateVisual(spec.note, 128), { size: 13, fill: "#727B8C" })
    : "";
  const description = [spec.subtitle, spec.insight, spec.note].filter(Boolean).join("；") || spec.title;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-labelledby="chart-title chart-desc" data-renderer="executive-v2">
  <title id="chart-title">${escapeXml(spec.title)}</title>
  <desc id="chart-desc">${escapeXml(description)}</desc>
  <rect width="${WIDTH}" height="${HEIGHT}" rx="30" fill="#F3F1ED"/>
  <rect x="20" y="20" width="1160" height="860" rx="24" fill="#FFFFFF" stroke="#E4DED5"/>
  <g font-family="Microsoft YaHei, PingFang SC, Noto Sans CJK SC, sans-serif">
    <rect x="64" y="44" width="112" height="30" rx="15" fill="#FCE8DF"/>
    ${text(120, 65, "经营辅助图", { anchor: "middle", size: 13, weight: 700, fill: "#B84920" })}
    ${text(INNER_LEFT, 116, truncateVisual(spec.title, 66), { size: 32, weight: 700, fill: "#172239" })}
    ${spec.subtitle ? text(INNER_LEFT, 148, truncateVisual(spec.subtitle, 112), { size: 15, fill: "#687386" }) : ""}
    <rect x="64" y="${layout.insightTop}" width="1072" height="${layout.insightHeight}" rx="14" fill="#FFF4EE" stroke="#F3CDBD"/>
    <rect x="64" y="${layout.insightTop}" width="7" height="${layout.insightHeight}" rx="3.5" fill="#E85D2A"/>
    ${text(92, layout.insightTop + 39, "关键发现", { size: 15, weight: 700, fill: "#B84920" })}
    ${insightText}
    ${layout.legend.markup}
    ${content}
    ${line(INNER_LEFT, FOOTER_TOP, INNER_RIGHT, FOOTER_TOP, { stroke: "#E5E8ED" })}
    ${text(INNER_LEFT, 848, "数据来源：销帮帮实时只读数据", { size: 13, weight: 600, fill: "#5E687A" })}
    ${note}
  </g>
</svg>`;
}

function renderBar(spec) {
  const layout = createLayout(spec, spec.series);
  const categories = spec.categories;
  const series = spec.series;
  const top = layout.plotTop + 6;
  const bottom = layout.plotBottom - 40;
  const categoryWidth = Math.min(220, Math.max(126, Math.max(...categories.map(visualWidth)) * 7.5));
  const left = INNER_LEFT + categoryWidth;
  const displayedValues = series.flatMap((entry) => entry.values.map((value) => truncateVisual(formatValue(value, spec.valueFormat, spec.unit), 22)));
  const reserve = Math.min(195, Math.max(90, Math.max(...displayedValues.map(visualWidth)) * 7.4 + 22));
  const right = INNER_RIGHT - reserve;
  const maxValue = Math.max(...series.flatMap((entry) => entry.values));
  const axisMax = niceUpper(maxValue);
  const rowHeight = (bottom - top) / categories.length;
  const grouped = series.length > 1;
  const highlightedIndex = grouped
    ? -1
    : series[0].values.indexOf(Math.max(...series[0].values));
  const groupHeight = Math.min(38, rowHeight * 0.7);
  const barHeight = grouped ? groupHeight / series.length : groupHeight;
  const marks = axisGridX(left, right, top, bottom, axisMax, spec.valueFormat, spec.unit);

  categories.forEach((category, categoryIndex) => {
    const center = top + rowHeight * categoryIndex + rowHeight / 2;
    marks.push(text(left - 18, center + 5, truncateVisual(category, 24), { anchor: "end", size: 15, fill: "#3F4B60" }));
    series.forEach((entry, seriesIndex) => {
      const value = entry.values[categoryIndex];
      const width = (right - left) * value / axisMax;
      const y = grouped
        ? center - groupHeight / 2 + seriesIndex * barHeight
        : center - barHeight / 2;
      const color = grouped
        ? COLORS[seriesIndex % COLORS.length]
        : categoryIndex === highlightedIndex ? COLORS[0] : MUTED_BAR;
      const opacity = !grouped && categoryIndex !== highlightedIndex ? 0.84 : 0.96;
      marks.push(`<rect x="${round(left)}" y="${round(y)}" width="${round(width)}" height="${round(Math.max(3, barHeight - 3))}" rx="${round(Math.min(7, barHeight / 2))}" fill="${color}" opacity="${opacity}"/>`);
      if (!grouped || barHeight >= 13) {
        marks.push(text(left + width + 9, y + barHeight * 0.69, truncateVisual(formatValue(value, spec.valueFormat, spec.unit), 22), { size: grouped ? 11 : 13, weight: 600, fill: "#3F4B60" }));
      }
    });
  });
  return chartFrame(spec, marks.join(""), layout);
}

function renderStackedBar(spec) {
  const layout = createLayout(spec, spec.series);
  const categories = spec.categories;
  const series = spec.series;
  const top = layout.plotTop + 6;
  const bottom = layout.plotBottom - 40;
  const categoryWidth = Math.min(220, Math.max(126, Math.max(...categories.map(visualWidth)) * 7.5));
  const left = INNER_LEFT + categoryWidth;
  const totals = categories.map((_, categoryIndex) => sumSeries(series, categoryIndex));
  const totalLabels = totals.map((value) => truncateVisual(formatValue(value, spec.valueFormat, spec.unit), 22));
  const reserve = Math.min(195, Math.max(90, Math.max(...totalLabels.map(visualWidth)) * 7.4 + 22));
  const right = INNER_RIGHT - reserve;
  const normalizePercent = spec.valueFormat === "percent";
  const axisMax = normalizePercent ? 100 : niceUpper(Math.max(...totals));
  const rowHeight = (bottom - top) / categories.length;
  const barHeight = Math.min(42, rowHeight * 0.62);
  const marks = axisGridX(left, right, top, bottom, axisMax, spec.valueFormat, spec.unit);

  categories.forEach((category, categoryIndex) => {
    const y = top + rowHeight * categoryIndex + (rowHeight - barHeight) / 2;
    marks.push(text(left - 18, y + barHeight * 0.66, truncateVisual(category, 24), { anchor: "end", size: 15, fill: "#3F4B60" }));
    let cursor = left;
    series.forEach((entry, seriesIndex) => {
      const value = entry.values[categoryIndex];
      const categoryTotal = totals[categoryIndex];
      const width = normalizePercent && categoryTotal > 0
        ? seriesIndex === series.length - 1
          ? right - cursor
          : (right - left) * value / categoryTotal
        : (right - left) * value / axisMax;
      const color = COLORS[seriesIndex % COLORS.length];
      marks.push(`<rect x="${round(cursor)}" y="${round(y)}" width="${round(width)}" height="${round(barHeight)}" rx="4" fill="${color}" opacity="0.95"/>`);
      const segmentLabel = truncateVisual(formatValue(value, spec.valueFormat, spec.unit), 16);
      if (series.length > 1 && width > visualWidth(segmentLabel) * 7.1 + 18) {
        marks.push(text(cursor + width / 2, y + barHeight * 0.66, segmentLabel, { anchor: "middle", size: 11, weight: 700, fill: contrastText(color) }));
      }
      cursor += width;
    });
    marks.push(text(cursor + 9, y + barHeight * 0.66, totalLabels[categoryIndex], { size: 13, weight: 600, fill: "#3F4B60" }));
  });
  return chartFrame(spec, marks.join(""), layout);
}

function sumSeries(series, index) {
  const total = series.reduce((sum, entry) => sum + entry.values[index], 0);
  if (!Number.isFinite(total)) throw new Error("图表数值合计超出可渲染范围");
  return total;
}

function axisGridX(left, right, top, bottom, maximum, format, unit) {
  const marks = [];
  for (let tick = 0; tick <= 4; tick += 1) {
    const value = maximum * tick / 4;
    const x = left + (right - left) * tick / 4;
    marks.push(line(x, top - 6, x, bottom, { stroke: "#E5E9F0", dash: "4 5" }));
    marks.push(text(x, bottom + 28, formatValue(value, format, unit), { anchor: "middle", size: 12, fill: "#788194" }));
  }
  return marks;
}

function niceUpper(value) {
  if (value <= 0) return 1;
  const step = niceStep(value / 4);
  const result = Math.max(step, Math.ceil(value / step) * step);
  return Number.isFinite(result) ? result : value;
}

function renderLine(spec) {
  const layout = createLayout(spec, spec.series);
  const top = layout.plotTop + 4;
  const bottom = layout.plotBottom - 44;
  const left = 132;
  const right = 930;
  const allValues = spec.series.flatMap((entry) => entry.values);
  const domain = niceDomain(allValues, spec.valueFormat, false);
  const xAt = (index) => left + (right - left) * index / (spec.categories.length - 1);
  const yAt = (value) => bottom - (bottom - top) * (value - domain.min) / (domain.max - domain.min);
  const marks = [];

  domain.ticks.forEach((value) => {
    const y = yAt(value);
    marks.push(line(left, y, right, y, { stroke: "#E5E9F0", dash: "4 5" }));
    marks.push(text(left - 14, y + 5, formatValue(value, spec.valueFormat, spec.unit), { anchor: "end", size: 12, fill: "#788194" }));
  });
  selectLineLabelIndices(spec.categories, xAt).forEach((index) => {
    marks.push(text(xAt(index), bottom + 31, truncateVisual(spec.categories[index], 14), { anchor: "middle", size: 12, fill: "#788194" }));
  });

  const showPointValues = spec.categories.length <= 8 && spec.series.length <= 2;
  const endpoints = [];
  spec.series.forEach((entry, seriesIndex) => {
    const color = COLORS[seriesIndex % COLORS.length];
    const points = entry.values.map((value, index) => `${round(xAt(index))},${round(yAt(value))}`).join(" ");
    marks.push(`<polyline points="${points}" fill="none" stroke="${color}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`);
    entry.values.forEach((value, index) => {
      const x = xAt(index);
      const y = yAt(value);
      marks.push(`<circle cx="${round(x)}" cy="${round(y)}" r="5" fill="#FFFFFF" stroke="${color}" stroke-width="3"/>`);
      if (showPointValues && index < entry.values.length - 1) {
        const offset = seriesIndex % 2 === 0 ? -12 : 21;
        marks.push(text(x, y + offset, formatValue(value, spec.valueFormat, spec.unit), { anchor: "middle", size: 11, weight: 600, fill: color }));
      }
    });
    const lastValue = entry.values[entry.values.length - 1];
    endpoints.push({ name: entry.name, value: lastValue, y: yAt(lastValue), stroke: color });
  });

  positionEndpointLabels(endpoints, top, bottom).forEach((entry) => {
    marks.push(line(right + 7, entry.y, right + 24, entry.labelY, { stroke: entry.stroke, width: 2 }));
    const label = truncateVisual(`${entry.name} · ${formatValue(entry.value, spec.valueFormat, spec.unit)}`, 24);
    marks.push(text(right + 30, entry.labelY + 5, label, { size: 13, weight: 700, fill: entry.stroke }));
  });
  return chartFrame(spec, marks.join(""), layout);
}

function positionEndpointLabels(entries, top, bottom) {
  const sorted = entries.map((entry) => ({ ...entry, labelY: entry.y })).sort((a, b) => a.y - b.y);
  const gap = 26;
  sorted.forEach((entry, index) => {
    entry.labelY = Math.max(entry.y, index === 0 ? top + 4 : sorted[index - 1].labelY + gap);
  });
  const overflow = sorted.length ? sorted[sorted.length - 1].labelY - (bottom - 4) : 0;
  if (overflow > 0) sorted.forEach((entry) => { entry.labelY -= overflow; });
  if (sorted.length && sorted[0].labelY < top + 4) {
    const shift = top + 4 - sorted[0].labelY;
    sorted.forEach((entry) => { entry.labelY += shift; });
  }
  return sorted;
}

function selectLineLabelIndices(categories, xAt) {
  if (categories.length === 2) return [0, 1];
  const maximumLabels = Math.min(9, categories.length);
  for (let targetCount = maximumLabels; targetCount >= 2; targetCount -= 1) {
    const indices = Array.from(
      { length: targetCount },
      (_, index) => Math.round(index * (categories.length - 1) / (targetCount - 1))
    );
    const sufficientlySpaced = indices.every((current, index) => {
      if (index === 0) return true;
      const previous = indices[index - 1];
      const previousLabel = truncateVisual(categories[previous], 14);
      const currentLabel = truncateVisual(categories[current], 14);
      const estimatedLabelGap = (visualWidth(previousLabel) + visualWidth(currentLabel)) * 3.3 + 16;
      return xAt(current) - xAt(previous) >= Math.max(84, estimatedLabelGap);
    });
    if (sufficientlySpaced) return indices;
  }
  return [0, categories.length - 1];
}

function niceDomain(values, format, includeZero) {
  let minimum = Math.min(...values);
  let maximum = Math.max(...values);
  if (includeZero) {
    minimum = Math.min(0, minimum);
    maximum = Math.max(0, maximum);
  }
  const rawSpan = maximum - minimum;
  if (!Number.isFinite(rawSpan)) throw new Error("图表数值范围超出可渲染范围");
  const padding = rawSpan === 0 ? Math.max(Math.abs(maximum) * 0.1, 1) : rawSpan * 0.15;
  let paddedMin = minimum - padding;
  let paddedMax = maximum + padding;
  if (format === "percent") {
    paddedMin = Math.max(0, paddedMin);
    paddedMax = Math.min(100, paddedMax);
  }
  if (paddedMin === paddedMax) {
    paddedMin -= 1;
    paddedMax += 1;
  }
  let step = niceStep((paddedMax - paddedMin) / 4);
  let domainMin = Math.floor(paddedMin / step) * step;
  let domainMax = Math.ceil(paddedMax / step) * step;
  if (format === "percent") {
    domainMin = Math.max(0, domainMin);
    domainMax = Math.min(100, domainMax);
  }
  if (domainMin === domainMax) {
    domainMin -= step;
    domainMax += step;
  }
  let count = Math.round((domainMax - domainMin) / step);
  if (count > 6) {
    step = niceStep((domainMax - domainMin) / 5);
    domainMin = Math.floor(domainMin / step) * step;
    domainMax = Math.ceil(domainMax / step) * step;
    count = Math.round((domainMax - domainMin) / step);
  }
  const ticks = Array.from({ length: count + 1 }, (_, index) => domainMin + step * index);
  return { min: domainMin, max: domainMax, ticks };
}

function niceStep(value) {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const fraction = value / magnitude;
  const niceFraction = fraction <= 1.5 ? 1 : fraction <= 2.25 ? 2 : fraction <= 3.5 ? 2.5 : fraction <= 7.5 ? 5 : 10;
  return niceFraction * magnitude;
}

function renderDonut(spec) {
  const layout = createLayout(spec);
  const total = spec.items.reduce((sum, entry) => sum + entry.value, 0);
  if (!Number.isFinite(total)) throw new Error("图表数值合计超出可渲染范围");
  const cx = 340;
  const cy = (layout.plotTop + layout.plotBottom) / 2;
  const radius = Math.min(164, (layout.plotBottom - layout.plotTop) * 0.35);
  const strokeWidth = 58;
  const circumference = 2 * Math.PI * radius;
  const marks = [`<circle cx="${cx}" cy="${round(cy)}" r="${round(radius)}" fill="none" stroke="#EEF1F5" stroke-width="${strokeWidth}"/>`];
  let offset = 0;
  spec.items.forEach((entry, index) => {
    const length = total > 0 ? circumference * entry.value / total : 0;
    marks.push(`<circle cx="${cx}" cy="${round(cy)}" r="${round(radius)}" fill="none" stroke="${COLORS[index % COLORS.length]}" stroke-width="${strokeWidth}" stroke-dasharray="${round(length)} ${round(circumference - length)}" stroke-dashoffset="${round(-offset)}" transform="rotate(-90 ${cx} ${round(cy)})"/>`);
    offset += length;
  });
  const centerValue = spec.valueFormat === "percent" ? 100 : total;
  marks.push(text(cx, cy - 5, formatValue(centerValue, spec.valueFormat, spec.unit), { anchor: "middle", size: 32, weight: 700, fill: "#172239" }));
  marks.push(text(cx, cy + 28, truncateVisual(spec.centerLabel, 20), { anchor: "middle", size: 14, fill: "#788194" }));

  const listTop = layout.plotTop + 2;
  const rowHeight = (layout.plotBottom - listTop - 4) / spec.items.length;
  spec.items.forEach((entry, index) => {
    const y = listTop + rowHeight * index + rowHeight / 2;
    const share = percentageText(entry.value, total);
    const value = spec.valueFormat === "percent"
      ? formatValue(entry.value, spec.valueFormat, spec.unit)
      : `${formatValue(entry.value, spec.valueFormat, spec.unit)} · ${share}`;
    marks.push(`<rect x="620" y="${round(y - 8)}" width="16" height="16" rx="4" fill="${COLORS[index % COLORS.length]}"/>`);
    marks.push(text(650, y + 5, truncateVisual(entry.name, 24), { size: 15, fill: "#3F4B60" }));
    marks.push(text(1105, y + 5, truncateVisual(value, 26), { anchor: "end", size: 15, weight: 700, fill: "#172239" }));
  });
  return chartFrame(spec, marks.join(""), layout);
}

function percentageText(value, total) {
  return total > 0 ? `${trimZeros(value / total * 100, 1)}%` : "0%";
}

function renderScatter(spec) {
  const layout = createLayout(spec);
  const bubblePadding = 32;
  const plotTop = layout.plotTop + 4;
  const plotBottom = layout.plotBottom - 48;
  const plotLeft = 145;
  const plotRight = 1100;
  const dataTop = plotTop + bubblePadding;
  const dataBottom = plotBottom - bubblePadding;
  const dataLeft = plotLeft + bubblePadding;
  const dataRight = plotRight - bubblePadding;
  const xDomain = niceDomain(spec.points.map((point) => point.x), spec.xFormat, true);
  const yDomain = niceDomain(spec.points.map((point) => point.y), spec.yFormat, true);
  const xAt = (value) => dataLeft + (dataRight - dataLeft) * (value - xDomain.min) / (xDomain.max - xDomain.min);
  const yAt = (value) => dataBottom - (dataBottom - dataTop) * (value - yDomain.min) / (yDomain.max - yDomain.min);
  const maximumSize = Math.max(...spec.points.map((point) => point.size));
  const marks = [];

  xDomain.ticks.forEach((value) => {
    const x = xAt(value);
    marks.push(line(x, plotTop, x, plotBottom, { stroke: "#E5E9F0", dash: "4 5" }));
    marks.push(text(x, plotBottom + 28, formatValue(value, spec.xFormat, spec.xUnit), { anchor: "middle", size: 12, fill: "#788194" }));
  });
  yDomain.ticks.forEach((value) => {
    const y = yAt(value);
    marks.push(line(plotLeft, y, plotRight, y, { stroke: "#E5E9F0", dash: "4 5" }));
    marks.push(text(plotLeft - 14, y + 5, formatValue(value, spec.yFormat, spec.yUnit), { anchor: "end", size: 12, fill: "#788194" }));
  });
  spec.points.forEach((point, index) => {
    const x = xAt(point.x);
    const y = yAt(point.y);
    const radius = maximumSize > 0 ? 7 + Math.sqrt(point.size / maximumSize) * 20 : 9;
    const color = COLORS[index % COLORS.length];
    marks.push(`<circle cx="${round(x)}" cy="${round(y)}" r="${round(radius)}" fill="${color}" opacity="0.75" stroke="#FFFFFF" stroke-width="2"/>`);
    if (spec.points.length <= 16) {
      const label = truncateVisual(point.label, 18);
      const labelWidth = visualWidth(label) * 6.2;
      const onRight = x + radius + 5 + labelWidth > plotRight;
      const labelAbove = y - radius - 14 >= plotTop;
      const labelY = labelAbove ? y - radius - 3 : y + radius + 14;
      marks.push(text(x + (onRight ? -radius - 5 : radius + 5), labelY, label, { anchor: onRight ? "end" : "start", size: 11, weight: 600, fill: "#465268" }));
    }
  });
  marks.push(text((plotLeft + plotRight) / 2, layout.plotBottom - 5, spec.xLabel, { anchor: "middle", size: 13, weight: 600, fill: "#687386" }));
  marks.push(text(33, (plotTop + plotBottom) / 2, spec.yLabel, { anchor: "middle", size: 13, weight: 600, fill: "#687386", rotate: -90 }));
  return chartFrame(spec, marks.join(""), layout);
}

function renderFunnel(spec) {
  const layout = createLayout(spec);
  const top = layout.plotTop + 4;
  const bottom = layout.plotBottom - 4;
  const rowHeight = (bottom - top) / spec.items.length;
  const center = 570;
  const maximumWidth = 590;
  const base = spec.items[0].value || 1;
  const marks = [];

  spec.items.forEach((entry, index) => {
    const previous = index === 0 ? entry.value : spec.items[index - 1].value;
    const topWidth = maximumWidth * previous / base;
    const bottomWidth = maximumWidth * entry.value / base;
    const y1 = top + index * rowHeight;
    const y2 = y1 + rowHeight - 8;
    const polygon = `${round(center - topWidth / 2)},${round(y1)} ${round(center + topWidth / 2)},${round(y1)} ${round(center + bottomWidth / 2)},${round(y2)} ${round(center - bottomWidth / 2)},${round(y2)}`;
    const color = COLORS[index % COLORS.length];
    marks.push(`<polygon points="${polygon}" fill="${color}" opacity="0.94"/>`);
    marks.push(text(INNER_LEFT, y1 + rowHeight * 0.56, truncateVisual(entry.name, 22), { size: 14, weight: 600, fill: "#3F4B60" }));
    const fill = Math.min(topWidth, bottomWidth) > 150 ? contrastText(color) : "#172239";
    marks.push(text(center, y1 + rowHeight * 0.56, formatValue(entry.value, spec.valueFormat, spec.unit), { anchor: "middle", size: 15, weight: 700, fill }));
    const conversion = index === 0
      ? "起始阶段"
      : previous > 0 ? `较上阶段 ${percentageText(entry.value, previous)}` : "较上阶段 —";
    marks.push(text(INNER_RIGHT, y1 + rowHeight * 0.56, conversion, { anchor: "end", size: 13, weight: index === 0 ? 500 : 700, fill: index === 0 ? "#788194" : "#526077" }));
  });
  return chartFrame(spec, marks.join(""), layout);
}

function assertSafeSvg(svg) {
  const withoutNamespace = svg.replace('xmlns="http://www.w3.org/2000/svg"', "");
  if (/<(?:script|foreignObject|iframe|object|embed)\b|\b(?:href|xlink:href)\s*=|\bon[a-z]+\s*=|\burl\s*\(|javascript:|data:/i.test(withoutNamespace)) {
    throw new Error("图表包含禁止的外部或可执行内容");
  }
  return svg;
}

function render(input) {
  const spec = validateSpec(input);
  let svg;
  if (spec.type === "bar") svg = renderBar(spec);
  else if (spec.type === "stacked-bar") svg = renderStackedBar(spec);
  else if (spec.type === "line") svg = renderLine(spec);
  else if (spec.type === "donut") svg = renderDonut(spec);
  else if (spec.type === "scatter") svg = renderScatter(spec);
  else svg = renderFunnel(spec);
  return assertSafeSvg(svg);
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
