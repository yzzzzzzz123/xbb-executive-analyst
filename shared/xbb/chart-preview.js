"use strict";

const sharp = require("sharp");
const { render } = require("./render-chart.js");

async function renderChartPreview(spec) {
  const preview = await sharp(Buffer.from(render(spec))).resize({ width: 390 }).png().toBuffer();
  if (preview.length > 2 * 1024 * 1024) throw new Error("手机预览过大，请减少重复内容并保留所有问题的有效证据。");
  return preview;
}

module.exports = { renderChartPreview };
