"use strict";

const sharp = require("sharp");
const { render, validateSpec } = require("../xbb/render-chart.js");

async function renderChart(spec) {
  validateSpec(spec);
  const buffer = await sharp(Buffer.from(render(spec), "utf8"), { density: 96 })
    .png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
  if (!buffer.length || buffer.length > 10 * 1024 * 1024) throw new Error("图表大小超出限制。");
  return buffer;
}

module.exports = { renderChart };
