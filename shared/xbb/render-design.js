"use strict";

const { LEFT, RIGHT, INK, MUTED, ACCENT, PALETTE, round, visualWidth, wrap, text, lines, rect, line, formatValue, percentage, sum, contrastText, headerLayout, chartFrame } = require("./chart-primitives.js");
const CONTEXT = "#9CB5BA";
const TRACK = "#E9EFEC";

function focusIndices(spec) {
  if (spec.focus) return {
    series: spec.series ? spec.series.findIndex((s) => s.name === spec.focus.series) : 0,
    item: spec.categories ? spec.categories.indexOf(spec.focus.category) : (spec.items || spec.points).findIndex((e) => (e.name || e.label) === spec.focus.category)
  };
  if (spec.type === "line") return { series: 0, item: spec.categories.length - 1 };
  const values = spec.type === "donut" ? spec.items.map((e) => e.value) : [];
  return { series: 0, item: values.length ? values.indexOf(Math.max(...values)) : -1 };
}
function legend(series, y) {
  if (series.length <= 1) return { markup: "", bottom: y };
  const marks = [];
  let x = LEFT;
  for (let i = 0; i < series.length; i += 1) {
    const rows = wrap(series[i].name, 300, 20);
    const width = Math.min(330, Math.max(...rows.map(visualWidth)) * 10 + 38);
    if (x > LEFT && x + width > RIGHT) { x = LEFT; y += 38; }
    marks.push(rect(x, y - 15, 14, 14, PALETTE[i], 3));
    marks.push(lines(x + 24, y, rows, { size: 20, fill: MUTED, leading: 28 }));
    if (rows.length > 1) { x = LEFT; y += rows.length * 28 + 16; } else x += width;
  }
  return { markup: marks.join(""), bottom: y + 36 };
}
function evidence(name, value, x, y, width = 350) {
  const rows = wrap(name, width, 20);
  return { markup: lines(x, y, rows, { size: 20, fill: MUTED, leading: 28 }) + text(x, y + rows.length * 28 + 15, value, { size: 43, weight: 700, fit: width }), bottom: y + rows.length * 28 + 38 };
}
function renderBar(spec) {
  const header = headerLayout(spec);
  const key = legend(spec.series, header.bottom + 12);
  const marks = [key.markup];
  const focus = focusIndices(spec);
  const maximum = Math.max(...spec.series.flatMap((e) => e.values)) || 1;
  const grouped = spec.series.length > 1;
  let y = key.bottom + 12;
  spec.categories.forEach((category, index) => {
    const selected = index === focus.item;
    const labelRows = wrap(category, grouped ? RIGHT - LEFT - 30 : RIGHT - LEFT - 240, 26);
    let rowHeight = labelRows.length * 36 + (grouped ? spec.series.length * 49 + 22 : 55);
    const showGap = selected && spec.focus && !grouped;
    if (showGap) rowHeight += 35;
    if (selected) marks.push(rect(LEFT - 16, y - 30, RIGHT - LEFT + 32, rowHeight, "#EDF5F2", 12));
    marks.push(lines(LEFT, y, labelRows, { size: 26, weight: selected ? 700 : 500, leading: 36 }));
    if (!grouped) {
      const value = spec.series[0].values[index];
      marks.push(text(RIGHT, y, formatValue(value, spec.valueFormat, spec.unit), { anchor: "end", size: 32, weight: 700, fill: selected ? ACCENT : INK, fit: 224 }));
      const barY = y + (labelRows.length - 1) * 36 + 21;
      marks.push(rect(LEFT, barY, RIGHT - LEFT, 15, TRACK, 3));
      marks.push(rect(LEFT, barY, (RIGHT - LEFT) * value / maximum, 15, selected ? ACCENT : CONTEXT, 3, ` data-value="${value}" data-baseline="0"`));
      if (showGap) {
        const sorted = [...spec.series[0].values].sort((a, b) => b - a);
        const gap = value === sorted[0] ? value - sorted[1] : sorted[0] - value;
        const gapValue = spec.valueFormat === "percent" ? `${formatValue(gap, "number")} 个百分点` : formatValue(gap, spec.valueFormat, spec.unit);
        const caption = gap === 0 ? "并列最高" : value === sorted[0] ? `领先下一位 ${gapValue}` : `距最高差 ${gapValue}`;
        marks.push(text(LEFT, barY + 47, caption, { size: 21, fill: ACCENT }));
      }
    } else {
      spec.series.forEach((entry, si) => {
        const value = entry.values[index];
        const barY = y + labelRows.length * 36 + si * 49;
        const plotWidth = RIGHT - LEFT - 230;
        marks.push(rect(LEFT, barY - 17, plotWidth * value / maximum, 18, PALETTE[si], 3, ` data-value="${value}" data-baseline="0"`));
        marks.push(text(RIGHT, barY, formatValue(value, spec.valueFormat, spec.unit), { size: 25, weight: selected && si === focus.series ? 700 : 500, anchor: "end", fit: 215 }));
      });
    }
    y += rowHeight;
  });
  return chartFrame(spec, marks.join(""), header, y - 20);
}
function renderStackedBar(spec) {
  const header = headerLayout(spec);
  const key = legend(spec.series, header.bottom + 12);
  const marks = [key.markup];
  const totals = spec.categories.map((_, i) => sum(spec.series.map((s) => s.values[i])));
  const maximum = Math.max(...totals) || 1;
  const focus = focusIndices(spec);
  let y = key.bottom + 14;
  spec.categories.forEach((category, i) => {
    const rows = wrap(category, RIGHT - LEFT - 230, 26);
    marks.push(lines(LEFT, y, rows, { size: 26, weight: i === focus.item ? 700 : 500, leading: 36 }));
    marks.push(text(RIGHT, y, formatValue(spec.valueFormat === "percent" ? 100 : totals[i], spec.valueFormat, spec.unit), { anchor: "end", size: 30, weight: 700, fit: 220 }));
    const barY = y + (rows.length - 1) * 36 + 24;
    let cursor = LEFT;
    spec.series.forEach((entry, si) => {
      const value = entry.values[i];
      const width = (RIGHT - LEFT) * value / (spec.valueFormat === "percent" ? totals[i] : maximum);
      const color = PALETTE[si];
      marks.push(rect(cursor, barY, width, 38, color, 0, ` data-value="${value}"`));
      const label = formatValue(value, spec.valueFormat, spec.unit);
      if (width >= visualWidth(label) * 11 + 20) marks.push(text(cursor + width / 2, barY + 27, label, { anchor: "middle", size: 22, weight: 650, fill: contrastText(color) }));
      if (spec.focus && i === focus.item && si === focus.series) marks.push(line(cursor, barY + 45, cursor + width, barY + 45, { color, width: 4 }));
      cursor += width;
    });
    if (spec.focus && i === focus.item) {
      const entry = spec.series[focus.series];
      const description = `${entry.name} ${formatValue(entry.values[i], spec.valueFormat, spec.unit)}${spec.valueFormat === "percent" ? "" : ` · 占本项 ${percentage(entry.values[i], totals[i])}`}`;
      const rows = wrap(description, RIGHT - LEFT, 21);
      marks.push(lines(LEFT, barY + 77, rows, { size: 21, fill: ACCENT, leading: 29 }));
      y = barY + 112 + (rows.length - 1) * 29;
    } else y = barY + 83;
  });
  return chartFrame(spec, marks.join(""), header, y - 20);
}
function niceStep(value) {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const fraction = value / magnitude;
  return (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10) * magnitude;
}
function domain(values, format, zero = false) {
  const min = zero ? Math.min(0, ...values) : Math.min(...values);
  const max = zero ? Math.max(0, ...values) : Math.max(...values);
  const span = max - min;
  if (!Number.isFinite(span)) throw new Error("图表数值范围超出可渲染范围");
  const pad = span === 0 ? Math.max(Math.abs(max) * 0.15, 1) : span * 0.18;
  const step = niceStep((span + pad * 2) / 4);
  let low = Math.floor((min - pad) / step) * step, high = Math.ceil((max + pad) / step) * step;
  if (min >= 0) low = Math.max(0, low);
  if (zero) { low = Math.min(low, 0); high = Math.max(high, 0); }
  if (format === "percent") { low = Math.max(0, low); high = Math.min(100, high); }
  if (low === high) high = low + 1;
  if (![low, high, high - low].every(Number.isFinite)) throw new Error("图表数值范围超出可渲染范围");
  const ticks = [];
  for (let value = low, i = 0; value <= high + step * 1e-8 && i < 10; value += step, i += 1) ticks.push(Math.min(value, high));
  return { min: low, max: high, ticks };
}
function axisFormatter(values, format, unit) {
  const ordered = [...new Set(values)].sort((a, b) => a - b);
  const step = ordered.length > 1 ? Math.min(...ordered.slice(1).map((v, i) => v - ordered[i])) : 1;
  const max = Math.max(...ordered.map(Math.abs));
  const scale = format !== "percent" && max >= 1e8 && step >= 1e4 ? 1e8 : format !== "percent" && max >= 1e4 && step >= 1 ? 1e4 : 1;
  const digits = Math.max(0, Math.min(10, Math.ceil(-Math.log10(step / scale)) + 1));
  const rounded = ordered.map((value) => Number((value / scale).toFixed(digits)));
  if (new Set(rounded).size !== ordered.length || ordered.some((value, i) => value !== 0 && rounded[i] === 0)) {
    const precision = Math.max(1, Math.min(15, Math.ceil(Math.log10(max / step)) + 1));
    return (value) => `${format === "money" ? "¥" : ""}${value === 0 ? "0" : value.toExponential(precision)}${format === "percent" ? "%" : format === "money" ? "" : unit}`;
  }
  return (value) => `${format === "money" ? "¥" : ""}${(value / scale).toLocaleString("zh-CN", { maximumFractionDigits: digits })}${scale === 1e8 ? "亿" : scale === 1e4 ? "万" : ""}${format === "percent" ? "%" : format === "money" ? "" : unit}`;
}
function shortLabel(value, width, size) {
  if (visualWidth(value) * size / 2 <= width) return value;
  let label = "";
  for (const c of value) { if (visualWidth(label + c + "…") * size / 2 > width) break; label += c; }
  return `${label}…`;
}
function tickIndices(categories, width) {
  for (let count = Math.min(8, categories.length); count >= 2; count -= 1) {
    const indices = Array.from({ length: count }, (_, i) => Math.round(i * (categories.length - 1) / (count - 1)));
    if (indices.every((curr, i) => i === 0 || (curr - indices[i - 1]) * width / (categories.length - 1) >= Math.max(80, Math.min(140, (visualWidth(categories[curr]) + visualWidth(categories[indices[i - 1]])) * 5.5 + 15)))) return indices;
  }
  return [0, categories.length - 1];
}
function endpointLabels(entries, top, bottom) {
  const sorted = entries.map((e) => ({ ...e, labelY: e.y })).sort((a, b) => a.y - b.y);
  sorted.forEach((e, i) => { e.labelY = Math.max(e.y, i ? sorted[i - 1].labelY + 62 : top); });
  const overflow = sorted.at(-1).labelY - bottom;
  if (overflow > 0) sorted.forEach((e) => { e.labelY -= overflow; });
  return sorted;
}
function renderLine(spec) {
  const header = headerLayout(spec), focus = focusIndices(spec), selected = spec.series[focus.series];
  const selectedValue = selected.values[focus.item];
  const display = axisFormatter(spec.series.flatMap((s) => s.values), spec.valueFormat, spec.unit);
  const metric = evidence(`${selected.name} / ${spec.categories[focus.item]}`, display(selectedValue), LEFT, header.bottom + 4);
  const marks = [metric.markup];
  if (focus.item > 0) {
    const difference = selectedValue - selected.values[focus.item - 1];
    if (!Number.isFinite(difference)) throw new Error("图表数值差额超出可渲染范围");
    const sign = difference > 0 ? "+" : difference < 0 ? "−" : "";
    const value = spec.valueFormat === "percent" ? `${sign}${formatValue(Math.abs(difference), "number")} 个百分点` : `${sign}${formatValue(Math.abs(difference), spec.valueFormat, spec.unit)}`;
    const change = evidence(`较 ${spec.categories[focus.item - 1]}`, value, 493, header.bottom + 4, 359);
    marks.push(change.markup); metric.bottom = Math.max(metric.bottom, change.bottom);
  }
  const key = legend(spec.series, metric.bottom + 26); marks.push(key.markup);
  const top = key.bottom + 20, bottom = top + 320, left = 137, right = spec.series.length > 1 ? 642 : 806;
  const limits = domain(spec.series.flatMap((s) => s.values), spec.valueFormat);
  const axisValue = axisFormatter(limits.ticks, spec.valueFormat, spec.unit);
  const xAt = (i) => left + (right - left) * i / (spec.categories.length - 1);
  const yAt = (v) => bottom - (bottom - top) * (v - limits.min) / (limits.max - limits.min);
  limits.ticks.forEach((v) => { const y = yAt(v); marks.push(line(left, y, right, y), text(left - 16, y + 7, axisValue(v), { size: 19, fill: MUTED, anchor: "end", fit: 105 })); });
  marks.push(line(xAt(focus.item), top, xAt(focus.item), bottom, { color: "#B1CDCD", dash: "4 6" }));
  const ends = [];
  spec.series.forEach((entry, si) => {
    const color = PALETTE[si];
    const points = entry.values.map((v, i) => `${round(xAt(i))},${round(yAt(v))}`).join(" ");
    marks.push(`<polyline points="${points}" fill="none" stroke="${color}" stroke-width="${si === focus.series ? 4.5 : 2.5}" stroke-linecap="round" stroke-linejoin="round"/>`);
    entry.values.forEach((v, i) => {
      const active = si === focus.series && i === focus.item;
      if (active) marks.push(`<circle cx="${round(xAt(i))}" cy="${round(yAt(v))}" r="13" fill="#D5EBE7"/>`);
      if (active || entry.values.length <= 12 || i === entry.values.length - 1) marks.push(`<circle cx="${round(xAt(i))}" cy="${round(yAt(v))}" r="${active ? 6 : 3.5}" fill="${active ? color : "#FAFCFA"}" stroke="${color}" stroke-width="2"/>`);
    });
    ends.push({ name: entry.name, value: entry.values.at(-1), y: yAt(entry.values.at(-1)), color });
  });
  if (spec.series.length > 1) endpointLabels(ends, top + 15, bottom - 25).forEach((e) => {
    marks.push(line(right + 8, e.y, right + 24, e.labelY, { color: e.color, width: 1.5 }));
    marks.push(text(right + 30, e.labelY - 6, shortLabel(e.name, RIGHT - right - 30, 18), { size: 18, fill: e.color }));
    marks.push(text(right + 30, e.labelY + 22, display(e.value), { size: 23, weight: 700, fill: e.color, fit: RIGHT - right - 30 }));
  });
  else {
    const peak = selected.values.indexOf(Math.max(...selected.values)), labels = [focus.item];
    const hasVariation = new Set(selected.values).size > 1;
    if (hasVariation && peak !== focus.item) labels.push(peak);
    const boxes = [];
    labels.forEach((i) => {
      const label = `${hasVariation && i === peak ? "峰值 " : ""}${display(selected.values[i])}`;
      const width = visualWidth(label) * 11.5 + 24;
      const x = Math.max(left, Math.min(right - width, xAt(i) - width / 2));
      const candidates = [Math.max(top - 8, yAt(selected.values[i]) - 46), Math.min(bottom - 34, yAt(selected.values[i]) + 17), top - 8];
      const y = candidates.find((candidate) => !boxes.some((b) => intersects({ x, y: candidate, w: width, h: 36 }, b)));
      if (y === undefined) return;
      boxes.push({ x, y, w: width, h: 36 });
      marks.push(line(xAt(i), yAt(selected.values[i]), Math.max(x + 8, Math.min(x + width - 8, xAt(i))), y > yAt(selected.values[i]) ? y : y + 33, { color: "#70A7AC", width: 1 }));
      marks.push(rect(x, y, width, 33, "#FAFCFA", 4), text(x + 12, y + 24, label, { size: 23, weight: 700, fill: ACCENT }));
    });
  }
  const ticks = tickIndices(spec.categories, right - left);
  ticks.forEach((i) => marks.push(lines(xAt(i), bottom + 33, wrap(spec.categories[i], 100, 19), { size: 19, fill: MUTED, anchor: "middle", leading: 26 })));
  const labelHeight = Math.max(...ticks.map((i) => wrap(spec.categories[i], 100, 19).length)) * 26;
  return chartFrame(spec, marks.join(""), header, bottom + labelHeight + 20);
}
function renderDonut(spec) {
  const header = headerLayout(spec), total = sum(spec.items.map((e) => e.value)), focus = focusIndices(spec), chosen = spec.items[focus.item];
  const cy = header.bottom + 158, cx = 238, radius = 113, circumference = 2 * Math.PI * radius;
  const marks = []; let offset = 0;
  spec.items.forEach((entry, i) => {
    const length = circumference * entry.value / total;
    if (entry.value > 0) marks.push(`<circle cx="${cx}" cy="${round(cy)}" r="${radius}" fill="none" stroke="${PALETTE[i]}" stroke-width="38" stroke-dasharray="${round(length)} ${round(circumference - length)}" stroke-dashoffset="${round(-offset)}" transform="rotate(-90 ${cx} ${round(cy)})"/>`);
    offset += length;
  });
  marks.push(text(cx, cy + 3, formatValue(spec.valueFormat === "percent" ? 100 : total, spec.valueFormat, spec.unit), { anchor: "middle", size: 38, weight: 700, fit: 176 }));
  const centerRows = wrap(spec.centerLabel, 165, 19);
  if (centerRows.length <= 2) marks.push(lines(cx, cy + 35, centerRows, { size: 19, fill: MUTED, anchor: "middle", leading: 27 }));
  else {
    marks.push(text(cx, cy + 35, "合计", { size: 19, fill: MUTED, anchor: "middle" }));
  }
  marks.push(text(443, cy - 57, spec.focus ? "关注构成" : "最大构成", { size: 19, fill: MUTED }));
  const chosenRows = wrap(chosen.name, RIGHT - 443, 28);
  marks.push(lines(443, cy - 15, chosenRows, { size: 28, weight: 600, leading: 38 }));
  marks.push(text(443, cy + chosenRows.length * 38 + 22, spec.valueFormat === "percent" ? formatValue(chosen.value, "percent") : percentage(chosen.value, total), { size: 58, weight: 700, fill: PALETTE[focus.item], fit: 390 }));
  let y = Math.max(cy + 182, cy + chosenRows.length * 38 + 77);
  if (centerRows.length > 2) {
    const outsideRows = wrap(spec.centerLabel, RIGHT - LEFT, 21);
    marks.push(lines(LEFT, y, outsideRows, { size: 21, fill: MUTED, leading: 29 }));
    y += outsideRows.length * 29 + 28;
  }
  marks.push(text(LEFT + 26, y, "构成项", { size: 18, fill: MUTED }), text(RIGHT, y, spec.valueFormat === "percent" ? "占比" : "数值 · 占比", { size: 18, fill: MUTED, anchor: "end" })); y += 42;
  spec.items.forEach((entry, i) => {
    const rows = wrap(entry.name, 370, 25), height = Math.max(76, rows.length * 35 + 28);
    marks.push(line(LEFT, y - 26, RIGHT, y - 26), rect(LEFT, y - 17, 12, 12, PALETTE[i], 3));
    marks.push(lines(LEFT + 26, y, rows, { size: 25, weight: i === focus.item ? 700 : 500, leading: 35 }));
    marks.push(text(RIGHT, y, formatValue(entry.value, spec.valueFormat, spec.unit), { size: 29, weight: 700, anchor: "end", fit: 360 }));
    if (spec.valueFormat !== "percent") marks.push(text(RIGHT, y + 29, percentage(entry.value, total), { size: 20, fill: MUTED, anchor: "end" })); y += height;
  });
  return chartFrame(spec, marks.join(""), header, y - 30);
}
function renderFunnel(spec) {
  const header = headerLayout(spec), base = spec.items[0].value, focus = focusIndices(spec);
  const metric = evidence("首阶段 → 末阶段保留率", percentage(spec.items.at(-1).value, base), LEFT, header.bottom + 4);
  const marks = [metric.markup], left = 350, width = RIGHT - left; let y = metric.bottom + 42;
  spec.items.forEach((entry, i) => {
    const rows = wrap(entry.name, 264, 25), rowHeight = Math.max(108, rows.length * 35 + 60);
    marks.push(text(LEFT, y, String(i + 1).padStart(2, "0"), { size: 18, fill: MUTED }), lines(LEFT + 40, y, rows, { size: 25, weight: 600, leading: 35 }));
    marks.push(text(RIGHT, y, formatValue(entry.value, spec.valueFormat, spec.unit), { size: 30, weight: 700, anchor: "end", fit: width }));
    marks.push(rect(left, y + 18, width, 17, TRACK, 2), rect(left, y + 18, width * entry.value / base, 17, i === focus.item ? ACCENT : CONTEXT, 2, ` data-value="${entry.value}" data-baseline="0"`));
    if (i > 0) marks.push(text(left, y + 65, `较上阶段保留 ${percentage(entry.value, spec.items[i - 1].value)}`, { size: 20, fill: MUTED, fit: width })); y += rowHeight;
  });
  return chartFrame(spec, marks.join(""), header, y - 32);
}
function intersects(a, b) { return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y; }
function renderScatter(spec) {
  const header = headerLayout(spec), focus = focusIndices(spec), marks = [];
  const xTitleRows = wrap(spec.xLabel, RIGHT - LEFT, 22), yTitleRows = wrap(spec.yLabel, RIGHT - LEFT, 22);
  marks.push(lines(LEFT, header.bottom + 5, yTitleRows, { size: 22, fill: MUTED, leading: 30 }));
  const top = header.bottom + yTitleRows.length * 30 + 40, bottom = top + 365, left = 137, right = 814;
  const dx = domain(spec.points.map((p) => p.x), spec.xFormat, true), dy = domain(spec.points.map((p) => p.y), spec.yFormat, true);
  const xValue = axisFormatter(dx.ticks, spec.xFormat, spec.xUnit), yValue = axisFormatter(dy.ticks, spec.yFormat, spec.yUnit);
  const xAt = (v) => left + 27 + (right - left - 54) * (v - dx.min) / (dx.max - dx.min);
  const yAt = (v) => bottom - 27 - (bottom - top - 54) * (v - dy.min) / (dy.max - dy.min);
  dx.ticks.forEach((v) => { const x = xAt(v); marks.push(line(x, top, x, bottom), text(x, bottom + 32, xValue(v), { anchor: "middle", size: 19, fill: MUTED, fit: 95 })); });
  dy.ticks.forEach((v) => { const y = yAt(v); marks.push(line(left, y, right, y), text(left - 14, y + 7, yValue(v), { anchor: "end", size: 19, fill: MUTED, fit: 104 })); });
  const maxSize = Math.max(...spec.points.map((p) => p.size)), scaledSize = new Set(spec.points.map((p) => p.size)).size > 1 && maxSize > 0;
  const circles = spec.points.map((p, i) => ({ i, x: xAt(p.x), y: yAt(p.y), r: scaledSize ? 25 * Math.sqrt(p.size / maxSize) : 7 }));
  const occupied = circles.map((p) => ({ x: p.x - p.r - 3, y: p.y - p.r - 3, w: p.r * 2 + 6, h: p.r * 2 + 6 }));
  circles.forEach((p) => {
    if (p.i === focus.item) marks.push(`<circle cx="${round(p.x)}" cy="${round(p.y)}" r="${round(p.r + 7)}" fill="#D5EBE7"/>`);
    marks.push(`<circle cx="${round(p.x)}" cy="${round(p.y)}" r="${round(p.r || 3)}" fill="${p.r === 0 ? "none" : p.i === focus.item ? ACCENT : "#7299A2"}" opacity="0.85" stroke="${p.r === 0 ? MUTED : "#FAFCFA"}" stroke-width="1.5"/>`);
  });
  [...circles].sort((a, b) => Number(b.i === focus.item) - Number(a.i === focus.item)).forEach((p) => {
    if (spec.points.length > 16 && p.i !== focus.item) return;
    const label = spec.points[p.i].label, width = Math.min(220, visualWidth(label) * 10);
    const candidates = [{ x: p.x + p.r + 10, y: p.y - 13, w: width, h: 25 }, { x: p.x - p.r - width - 10, y: p.y - 13, w: width, h: 25 }, { x: p.x - width / 2, y: p.y - p.r - 34, w: width, h: 25 }, { x: p.x - width / 2, y: p.y + p.r + 9, w: width, h: 25 }];
    const box = candidates.find((b) => b.x >= left && b.x + b.w <= right && b.y >= top && b.y + b.h <= bottom && !occupied.some((a) => intersects(a, b)));
    if (box) { marks.push(text(box.x, box.y + 20, label, { size: 20, fill: p.i === focus.item ? ACCENT : MUTED, fit: 220 })); occupied.push(box); }
  });
  marks.push(lines(RIGHT, bottom + 73, xTitleRows, { size: 22, anchor: "end", fill: MUTED, leading: 30 }));
  let bodyBottom = bottom + 74 + xTitleRows.length * 30;
  if (scaledSize && spec.points.some((p) => p.size === 0)) {
    marks.push(text(LEFT, bodyBottom, "空心点：大小指标为 0", { size: 19, fill: MUTED })); bodyBottom += 32;
  }
  if (focus.item >= 0) {
    const p = spec.points[focus.item], label = `${p.label}：${spec.xLabel} ${formatValue(p.x, spec.xFormat, spec.xUnit)} · ${spec.yLabel} ${formatValue(p.y, spec.yFormat, spec.yUnit)}`;
    const rows = wrap(label, RIGHT - LEFT - 32, 22);
    marks.push(rect(LEFT, bodyBottom, RIGHT - LEFT, rows.length * 32 + 24, "#EDF5F2", 8), lines(LEFT + 16, bodyBottom + 31, rows, { size: 22, fill: ACCENT, leading: 32 })); bodyBottom += rows.length * 32 + 24;
  }
  return chartFrame(spec, marks.join(""), header, bodyBottom);
}
function renderDesign(spec) {
  return { bar: renderBar, "stacked-bar": renderStackedBar, line: renderLine, donut: renderDonut, funnel: renderFunnel, scatter: renderScatter }[spec.type](spec);
}
module.exports = { renderDesign };
