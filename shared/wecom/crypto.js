"use strict";

const crypto = require("node:crypto");

const PAD_BLOCK_SIZE = 32;

function pkcs7Pad(buffer) {
  const amount = PAD_BLOCK_SIZE - (buffer.length % PAD_BLOCK_SIZE || PAD_BLOCK_SIZE);
  const padLength = amount === 0 ? PAD_BLOCK_SIZE : amount;
  return Buffer.concat([buffer, Buffer.alloc(padLength, padLength)]);
}

function pkcs7Unpad(buffer) {
  if (!buffer.length) throw new Error("企业微信密文填充为空。");
  const count = buffer[buffer.length - 1];
  if (count < 1 || count > PAD_BLOCK_SIZE || count > buffer.length) throw new Error("企业微信密文填充无效。");
  for (let index = buffer.length - count; index < buffer.length; index += 1) {
    if (buffer[index] !== count) throw new Error("企业微信密文填充无效。");
  }
  return buffer.subarray(0, buffer.length - count);
}

function constantTimeHexEqual(left, right) {
  if (!/^[a-f0-9]{40}$/i.test(String(left)) || !/^[a-f0-9]{40}$/i.test(String(right))) return false;
  const a = Buffer.from(String(left).toLowerCase(), "ascii");
  const b = Buffer.from(String(right).toLowerCase(), "ascii");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

class WecomCrypto {
  constructor({ token, encodingAesKey, receiveId = "", randomBytes = crypto.randomBytes }) {
    if (typeof token !== "string" || !token) throw new Error("企业微信 Token 不能为空。");
    if (typeof encodingAesKey !== "string" || !/^[A-Za-z0-9+/]{43}$/.test(encodingAesKey)) throw new Error("EncodingAESKey 格式无效。");
    const key = Buffer.from(`${encodingAesKey}=`, "base64");
    if (key.length !== 32) throw new Error("EncodingAESKey 解码后必须是 32 字节。");
    this.token = token;
    this.key = key;
    this.iv = key.subarray(0, 16);
    this.receiveId = String(receiveId);
    this.randomBytes = randomBytes;
  }

  sign(timestamp, nonce, encrypted) {
    return crypto.createHash("sha1").update([this.token, String(timestamp), String(nonce), String(encrypted)].sort().join(""), "utf8").digest("hex");
  }

  verifySignature(signature, timestamp, nonce, encrypted) {
    if (!constantTimeHexEqual(signature, this.sign(timestamp, nonce, encrypted))) throw new Error("企业微信消息签名校验失败。");
  }

  encrypt(plaintext) {
    const message = Buffer.from(String(plaintext), "utf8");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(message.length, 0);
    const random = this.randomBytes(16);
    if (!Buffer.isBuffer(random) || random.length !== 16) throw new Error("企业微信加密随机数必须是 16 字节。");
    const input = pkcs7Pad(Buffer.concat([random, length, message, Buffer.from(this.receiveId, "utf8")]));
    const cipher = crypto.createCipheriv("aes-256-cbc", this.key, this.iv);
    cipher.setAutoPadding(false);
    return Buffer.concat([cipher.update(input), cipher.final()]).toString("base64");
  }

  decrypt(encrypted) {
    if (typeof encrypted !== "string" || !encrypted) throw new Error("企业微信 encrypt 字段为空。");
    let cipherText;
    try { cipherText = Buffer.from(encrypted, "base64"); } catch { throw new Error("企业微信 encrypt 不是有效 Base64。") }
    if (!cipherText.length || cipherText.length % 16 !== 0) throw new Error("企业微信密文长度无效。");
    const decipher = crypto.createDecipheriv("aes-256-cbc", this.key, this.iv);
    decipher.setAutoPadding(false);
    const plain = pkcs7Unpad(Buffer.concat([decipher.update(cipherText), decipher.final()]));
    if (plain.length < 20) throw new Error("企业微信明文结构无效。");
    const messageLength = plain.readUInt32BE(16);
    const messageEnd = 20 + messageLength;
    if (messageEnd > plain.length) throw new Error("企业微信明文消息长度无效。");
    const receivedId = plain.subarray(messageEnd).toString("utf8");
    if (receivedId !== this.receiveId) throw new Error("企业微信 ReceiveId 校验失败。");
    return plain.subarray(20, messageEnd).toString("utf8");
  }

  decryptVerified(encrypted, signature, timestamp, nonce) {
    this.verifySignature(signature, timestamp, nonce, encrypted);
    return this.decrypt(encrypted);
  }

  encryptResponse(plaintext, timestamp, nonce) {
    const encrypted = this.encrypt(plaintext);
    return {
      encrypt: encrypted,
      msgsignature: this.sign(timestamp, nonce, encrypted),
      timestamp: Number(timestamp),
      nonce: String(nonce)
    };
  }
}

module.exports = { PAD_BLOCK_SIZE, WecomCrypto, constantTimeHexEqual, pkcs7Pad, pkcs7Unpad };
