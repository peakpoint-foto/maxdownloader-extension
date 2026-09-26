"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
require("./helpers");

const { HostLimiter } = globalThis.MaxDownloaderLimiter;

test("limiter spaces requests by delay and caps concurrency", async () => {
  const limiter = new HostLimiter({ config: () => ({ delayMs: 40, maxConcurrency: 2, adaptive: false }), random: () => 0 });
  const starts = [];
  let inFlight = 0;
  let peak = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    await limiter.acquire("a.com");
    starts.push(Date.now());
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    limiter.release("a.com", "ok");
  }));
  starts.sort((a, b) => a - b);
  assert.ok(peak <= 2);
  for (let index = 1; index < starts.length; index += 1) {
    assert.ok(starts[index] - starts[index - 1] >= 30, "gap " + (starts[index] - starts[index - 1]));
  }
});

test("rate outcome halves adaptive concurrency and blocks the host", async () => {
  const limiter = new HostLimiter({ config: () => ({ delayMs: 0, maxConcurrency: 4, adaptive: true }) });
  await limiter.acquire("b.com");
  assert.equal(limiter.host("b.com").limit, 2);
  limiter.release("b.com", "rate", { retryAfterMs: 50 });
  assert.equal(limiter.host("b.com").limit, 1);
  const started = Date.now();
  await limiter.acquire("b.com");
  assert.ok(Date.now() - started >= 40);
  limiter.release("b.com", "ok");
});

test("adaptive concurrency grows after a clean streak", async () => {
  const limiter = new HostLimiter({ config: () => ({ delayMs: 0, maxConcurrency: 3, adaptive: true }) });
  for (let index = 0; index < 25; index += 1) {
    await limiter.acquire("c.com");
    limiter.release("c.com", "ok");
  }
  assert.equal(limiter.host("c.com").limit, 3);
});

test("hold parks every request until unhold", async () => {
  const limiter = new HostLimiter({ config: () => ({ delayMs: 0, maxConcurrency: 2, adaptive: false }) });
  limiter.hold("d.com");
  let got = false;
  const pending = limiter.acquire("d.com").then(() => {
    got = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(got, false);
  limiter.unhold("d.com");
  await pending;
  assert.equal(got, true);
});

test("acquire rejects when the job is cancelled", async () => {
  const limiter = new HostLimiter({ config: () => ({ delayMs: 0, maxConcurrency: 1, adaptive: false }) });
  limiter.hold("e.com");
  const controller = new AbortController();
  const pending = limiter.acquire("e.com", controller.signal);
  controller.abort();
  await assert.rejects(pending, (error) => error.name === "AbortError");
});
