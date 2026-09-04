"use strict";

const crypto = require("node:crypto");
const zlib = require("node:zlib");
const sharp = require("sharp");
const { render, validateSpec } = require("../xbb/render-chart.js");
const { sanitizeAgentText } = require("../security/output-sanitizer.js");

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

function truncateVisual(value, maxWidth) {
  const source = String(value ?? "");
  if (visualWidth(source) <= maxWidth) return source;
  let result = "";
  let width = 0;
  for (const character of source) {
    const characterWidth = visualWidth(character);
    if (width + characterWidth > maxWidth - 2) break;
    result += character;
    width += characterWidth;
  }
  return `${result.trimEnd()}…`;
}

function visualWidth(value) {
  let width = 0;
  for (const character of String(value ?? "")) {
    width += character.codePointAt(0) > 0xFF ? 2 : 1;
  }
  return width;
}

function wrapVisual(value, maxWidth = 54, maxLines = 14) {
  const paragraphs = String(value || "").replace(/\r/g, "").split("\n");
  const lines = [];
  let truncated = false;
  for (let paragraphIndex = 0; paragraphIndex < paragraphs.length; paragraphIndex += 1) {
    const paragraph = paragraphs[paragraphIndex];
    if (!paragraph.trim()) {
      if (lines.length && lines.at(-1) !== "") lines.push("");
      continue;
    }
    let line = "";
    let width = 0;
    for (const character of paragraph.trim()) {
      const characterWidth = visualWidth(character);
      if (line && width + characterWidth > maxWidth) {
        lines.push(line);
        line = "";
        width = 0;
        if (lines.length >= maxLines) {
          truncated = true;
          break;
        }
      }
      line += character;
      width += characterWidth;
    }
    if (line && lines.length < maxLines) lines.push(line);
    if (lines.length >= maxLines && (truncated || paragraphIndex < paragraphs.length - 1)) {
      truncated = true;
      break;
    }
  }
  if (truncated && lines.length) {
    const last = lines.length - 1;
    while (visualWidth(lines[last]) > maxWidth - 2) lines[last] = [...lines[last]].slice(0, -1).join("");
    lines[last] = `${lines[last].trimEnd()}…`;
  }
  return lines.slice(0, maxLines);
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

async function createWecomAnswerImage(answer, options = {}) {
  const safeAnswer = sanitizeAgentText(answer, { maxBytes: 18000 });
  if (!safeAnswer) throw new Error("销帮帮结论速览图缺少可显示文字。");
  const title = sanitizeAgentText(options.title || "销帮帮经营答复", { maxBytes: 240 });
  const subtitle = sanitizeAgentText(options.subtitle || "结论速览｜完整内容以同条文字答复为准", { maxBytes: 360 });
  const lines = wrapVisual(safeAnswer);
  const lineHeight = 43;
  const content = lines.map((line, index) => line
    ? `<text x="82" y="${238 + index * lineHeight}" font-size="25" font-weight="${index === 0 ? 650 : 450}" fill="#24324A">${escapeXml(line)}</text>`
    : "").join("");
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900" viewBox="0 0 1200 900" role="img">
  <rect width="1200" height="900" fill="#F3F1ED"/>
  <rect x="20" y="20" width="1160" height="860" rx="24" fill="#FFFFFF" stroke="#E4DED5"/>
  <g font-family="Microsoft YaHei, PingFang SC, Noto Sans CJK SC, sans-serif">
    <rect x="64" y="46" width="144" height="32" rx="16" fill="#FCE8DF"/>
    <text x="136" y="68" text-anchor="middle" font-size="14" font-weight="700" fill="#B84920">实时只读分析</text>
    <text x="64" y="126" font-size="34" font-weight="700" fill="#172239">${escapeXml(truncateVisual(title, 56))}</text>
    <text x="64" y="164" font-size="16" fill="#687386">${escapeXml(truncateVisual(subtitle, 124))}</text>
    <rect x="64" y="194" width="1072" height="568" rx="18" fill="#F8FAFC" stroke="#E3E9F1"/>
    <rect x="64" y="194" width="8" height="568" rx="4" fill="#E85D2A"/>
    ${content}
    <line x1="64" y1="815" x2="1136" y2="815" stroke="#E5E8ED"/>
    <text x="64" y="850" font-size="14" font-weight="600" fill="#5E687A">来源：销帮帮实时只读分析｜图片不补造文字答复之外的数字</text>
  </g>
</svg>`;
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
  createWecomEmergencyImage
};
