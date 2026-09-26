"use strict";

// Loads the browser IIFEs into Node's globalThis in the same order as
// offscreen.html, so tests exercise the exact shipped code.
const path = require("node:path");

const root = path.join(__dirname, "..");
const FILES = [
  "lib/sites.js",
  "lib/paths.js",
  "lib/images.js",
  "adapters/imagefap.js",
  "adapters/xasiat.js",
  "adapters/viper.js",
  "lib/limiter.js",
  "lib/store.js",
  "lib/handlers.js",
  "lib/engine.js"
];

for (const file of FILES) {
  require(path.join(root, file));
}

function waitFor(predicate, { timeout = 8000, interval = 10 } = {}) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      let value;
      try {
        value = predicate();
      } catch (error) {
        reject(error);
        return;
      }
      if (value) {
        resolve(value);
        return;
      }
      if (Date.now() - started > timeout) {
        reject(new Error("waitFor timeout"));
        return;
      }
      setTimeout(tick, interval);
    };
    tick();
  });
}

module.exports = { waitFor, root };
