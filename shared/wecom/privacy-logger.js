"use strict";

function createPrivacyLogger() {
  return Object.freeze({
    debug() {},
    info() {},
    warn() {},
    error() {}
  });
}

module.exports = { createPrivacyLogger };
