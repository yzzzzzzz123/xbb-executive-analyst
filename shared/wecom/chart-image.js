"use strict";

const crypto = require("node:crypto");
const sharp = require("sharp");
const { render, validateSpec } = require("../xbb/render-chart.js");

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

async function createWecomChartImage(spec) {
  validateSpec(spec);
  const svg = render(spec);
  const buffer = await sharp(Buffer.from(svg, "utf8"), { density: 96 })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
  if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) throw new Error("企微图表图片大小不符合限制。");
  const item = Object.freeze({
    msgtype: "image",
    image: {
      base64: buffer.toString("base64"),
      md5: crypto.createHash("md5").update(buffer).digest("hex")
    }
  });
  return Object.freeze({ buffer, item });
}

async function createWecomChartItem(spec) {
  return (await createWecomChartImage(spec)).item;
}

module.exports = { MAX_IMAGE_BYTES, createWecomChartImage, createWecomChartItem };
