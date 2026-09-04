"use strict";

const net = require("node:net");

const DEFAULT_INSTANCE_ENDPOINT = "\\\\.\\pipe\\codex-xbb-executive-analyst-wecom";

function acquireInstanceLock(endpoint = DEFAULT_INSTANCE_ENDPOINT) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.destroy());
    const fail = (error) => {
      server.close(() => {});
      if (error?.code === "EADDRINUSE") {
        reject(new Error("企业微信机器人已有实例在运行。"));
        return;
      }
      reject(error);
    };
    server.once("error", fail);
    server.listen(endpoint, () => {
      server.removeListener("error", fail);
      server.on("error", () => {});
      resolve(server);
    });
  });
}

function releaseInstanceLock(server) {
  return new Promise((resolve) => {
    if (!server?.listening) return resolve();
    server.close(() => resolve());
  });
}

module.exports = { DEFAULT_INSTANCE_ENDPOINT, acquireInstanceLock, releaseInstanceLock };
