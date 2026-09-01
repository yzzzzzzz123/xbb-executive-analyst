"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { WecomCrypto, pkcs7Pad, pkcs7Unpad } = require("../shared/wecom/crypto.js");

const token = "unit-test-token";
const keyBytes = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1));
const encodingAesKey = keyBytes.toString("base64").replace(/=$/, "");
const random = Buffer.from(Array.from({ length: 16 }, (_, index) => 240 - index));
const codec = new WecomCrypto({ token, encodingAesKey, receiveId: "", randomBytes: () => Buffer.from(random) });
const plaintext = JSON.stringify({ msgid: "m1", msgtype: "text", text: { content: "集团本月业绩排名" } });
const encrypted = codec.encrypt(plaintext);

assert.equal(codec.decrypt(encrypted), plaintext);
const timestamp = "1788192000";
const nonce = "nonce-1";
const signature = codec.sign(timestamp, nonce, encrypted);
assert.equal(signature, crypto.createHash("sha1").update([token, timestamp, nonce, encrypted].sort().join(""), "utf8").digest("hex"));
assert.equal(codec.decryptVerified(encrypted, signature, timestamp, nonce), plaintext);
assert.throws(() => codec.decryptVerified(encrypted, "0".repeat(40), timestamp, nonce), /签名校验失败/);

const padded = pkcs7Pad(Buffer.alloc(32, 7));
assert.equal(padded.length, 64);
assert.deepEqual(pkcs7Unpad(padded), Buffer.alloc(32, 7));

const rawCipher = Buffer.from(encrypted, "base64");
const decipher = crypto.createDecipheriv("aes-256-cbc", keyBytes, keyBytes.subarray(0, 16));
decipher.setAutoPadding(false);
const rawPlain = pkcs7Unpad(Buffer.concat([decipher.update(rawCipher), decipher.final()]));
assert.deepEqual(rawPlain.subarray(0, 16), random);
assert.equal(rawPlain.readUInt32BE(16), Buffer.byteLength(plaintext, "utf8"));
assert.equal(rawPlain.subarray(20, 20 + Buffer.byteLength(plaintext, "utf8")).toString("utf8"), plaintext);

const response = codec.encryptResponse(plaintext, timestamp, nonce);
assert.deepEqual(Object.keys(response), ["encrypt", "msgsignature", "timestamp", "nonce"]);
assert.equal(codec.decryptVerified(response.encrypt, response.msgsignature, response.timestamp, response.nonce), plaintext);

process.stdout.write(`${JSON.stringify({ success: true, checks: 11 })}\n`);
