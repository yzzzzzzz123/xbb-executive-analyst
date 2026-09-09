"use strict";

const crypto = require("node:crypto");
const zlib = require("node:zlib");
const sharp = require("sharp");
const { render, validateSpec } = require("../xbb/render-chart.js");
const { sanitizeAgentText } = require("../security/output-sanitizer.js");
const visual = require("../xbb/chart-primitives.js");

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

function escapeXml(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}


function imageItem(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_IMAGE_BYTES) throw new Error("企微图片大小不符合限制。");
  return Object.freeze({
    msgtype: "image",
    image: {
      base64: buffer.toString("base64"),
      md5: crypto.createHash("md5").update(buffer).digest("hex")
    }
  });
}

async function createWecomChartImage(spec) {
  validateSpec(spec);
  const svg = render(spec);
  const buffer = await sharp(Buffer.from(svg, "utf8"), { density: 96 })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
  if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) throw new Error("企微图表图片大小不符合限制。");
  const item = imageItem(buffer);
  return Object.freeze({ buffer, item });
}

function renderAnswerSvg(answer, options = {}) {
  const safeAnswer = sanitizeAgentText(answer, { maxBytes: 18000 });
  if (!safeAnswer) throw new Error("销帮帮结论速览图缺少可显示文字。");
  const title = sanitizeAgentText(options.title || "销帮帮经营答复", { maxBytes: 240 });
  const subtitle = sanitizeAgentText(options.subtitle || "结论速览 · 完整内容见文字答复", { maxBytes: 360 });
  const { LEFT, RIGHT, WIDTH, FONT, ACCENT, MUTED, rect, text, lines, line, wrap } = visual;
  const titleRows = wrap(title, RIGHT - LEFT, 36);
  const subtitleRows = wrap(subtitle, RIGHT - LEFT, 20);
  const subtitleY = 110 + titleRows.length * 48;
  const bodyY = subtitleY + subtitleRows.length * 30 + 54;
  // Reflow a bounded excerpt; the previous fixed-height box overflowed on 14 lines.
  const plainAnswer = safeAnswer.replace(/^\s{0,3}#{1,6}\s+/gm, "").replace(/\*\*(.*?)\*\*/g, "$1");
  const allRows = plainAnswer.split(/\r?\n/).flatMap((p) => p.trim() ? wrap(p.trim(), RIGHT - LEFT - 48, 30) : [""]);
  const excerpt = allRows.slice(0, 18);
  if (allRows.length > 18) excerpt[17] = `${[...excerpt[17]].slice(0, -1).join("")}…`;
  let y = bodyY;
  const content = [];
  let first = true;
  for (const row of excerpt) {
    if (!row) { y += 22; continue; }
    content.push(text(LEFT + 24, y, row, { size: first ? 30 : 27, weight: first ? 650 : 400 }));
    y += 43; first = false;
  }
  const footerY = Math.max(536, y + 44), height = footerY + 91;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" role="img" aria-labelledby="answer-title" data-renderer="executive-summary-v3">
<title id="answer-title">${escapeXml(title)}</title>${rect(0, 0, WIDTH, height, "#FAFCFA")}${rect(LEFT, 0, 62, 7, ACCENT)}
<g font-family="${FONT}">${text(LEFT, 48, "XBB / 结论速览", { size: 18, fill: ACCENT, weight: 700 })}
${lines(LEFT, 110, titleRows, { size: 36, weight: 700, leading: 48 })}${lines(LEFT, subtitleY, subtitleRows, { size: 20, fill: MUTED, leading: 30 })}
${rect(LEFT, bodyY - 34, RIGHT - LEFT, y - bodyY + 54, "#EDF5F2", 12)}${content.join("")}
${line(LEFT, footerY, RIGHT, footerY)}${text(LEFT, footerY + 36, "销帮帮经营答复", { size: 18, fill: MUTED })}
${text(LEFT, footerY + 66, "文字摘录 · 完整结论及限制见同条答复", { size: 18, fill: MUTED })}</g></svg>`;
}

async function createWecomAnswerImage(answer, options = {}) {
  const svg = renderAnswerSvg(answer, options);
  const buffer = await sharp(Buffer.from(svg, "utf8"), { density: 96 })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
  return Object.freeze({ buffer, item: imageItem(buffer), kind: "answer-summary" });
}

let crcTable;
function crc32(buffer) {
  if (!crcTable) {
    crcTable = Array.from({ length: 256 }, (_, index) => {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xEDB88320 ^ (value >>> 1)) : (value >>> 1);
      return value >>> 0;
    });
  }
  let value = 0xFFFFFFFF;
  for (const byte of buffer) value = crcTable[(value ^ byte) & 0xFF] ^ (value >>> 8);
  return (value ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function createEmergencyPng() {
  const width = 600;
  const height = 240;
  const pixels = Buffer.alloc((width * 4 + 1) * height);
  const glyphs = [
    ["10001", "01010", "00100", "00100", "01010", "10001", "10001"],
    ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
    ["11110", "10001", "10001", "11110", "10001", "10001", "11110"]
  ];
  const scale = 14;
  const glyphWidth = 5 * scale;
  const gap = 20;
  const startX = Math.floor((width - (glyphWidth * 3 + gap * 2)) / 2);
  const startY = 62;
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    pixels[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 4;
      const inside = x >= 28 && x < width - 28 && y >= 28 && y < height - 28;
      pixels[offset] = inside ? 255 : 232;
      pixels[offset + 1] = inside ? 244 : 93;
      pixels[offset + 2] = inside ? 238 : 42;
      pixels[offset + 3] = 255;
    }
  }
  glyphs.forEach((glyph, glyphIndex) => glyph.forEach((row, rowIndex) => [...row].forEach((bit, columnIndex) => {
    if (bit !== "1") return;
    const left = startX + glyphIndex * (glyphWidth + gap) + columnIndex * scale;
    const top = startY + rowIndex * scale;
    for (let y = top; y < top + scale; y += 1) for (let x = left; x < left + scale; x += 1) {
      const offset = y * (width * 4 + 1) + 1 + x * 4;
      pixels[offset] = 23;
      pixels[offset + 1] = 34;
      pixels[offset + 2] = 57;
      pixels[offset + 3] = 255;
    }
  })));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(pixels, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

let emergencyImage;
function createWecomEmergencyImage() {
  if (emergencyImage) return emergencyImage;
  const buffer = createEmergencyPng();
  emergencyImage = Object.freeze({ buffer, item: imageItem(buffer), kind: "safe-placeholder" });
  return emergencyImage;
}

async function createWecomChartItem(spec) {
  return (await createWecomChartImage(spec)).item;
}

module.exports = {
  MAX_IMAGE_BYTES,
  createWecomAnswerImage,
  createWecomChartImage,
  createWecomChartItem,
  createWecomEmergencyImage,
  renderAnswerSvg
};
