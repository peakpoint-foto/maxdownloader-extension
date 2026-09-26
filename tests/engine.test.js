"use strict";

// Engine tests with a fake network and a fake site handler: they check the
// scheduling, persistence and failure rules, independent of any real HTML.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { waitFor } = require("./helpers");

const { Engine } = globalThis.MaxDownloaderEngine;
const { MemoryStore } = globalThis.MaxDownloaderStore;

const GALLERY = "https://www.imagefap.com/pictures/100/test-album";

// Pages are JSON strings; parseHtml returns the parsed object as the "doc".
function fakeHandler(overrides = {}) {
  return {
    site: "imagefap",
    pageKey: (url) => url,
    listPage: ({ doc }) => ({ title: doc.title, items: doc.items || [], pageUrls: doc.pages || [], totalHint: doc.total || 0 }),
    needsResolve: (item) => !item.imageUrl,
    async resolve(item, helpers) {
      const page = await helpers.fetchPage(item.pageUrl);
      if (!page.doc.image) {
        throw Object.assign(new Error("Không tìm thấy ảnh full-size"), { code: "NO_IMAGE" });
      }
      return { imageUrl: page.doc.image, harvested: page.doc.harvest || [] };
    },
    fileName: (item) => `${item.seq + 1}_${item.photoId}.jpg`,
    historyKey: (item) => "imagefap:" + item.photoId,
    isExpiredDownload: (result) => result.status === 403,
    ...overrides
  };
}

function makeEnv({ routes, store = new MemoryStore(), download, handler = fakeHandler(), settings } = {}) {
  const calls = { fetch: [], download: [], notify: [] };
  const verification = JSON.stringify({ captcha: true });
  const env = {
    store,
    handlers: { imagefap: handler },
    parseHtml: (text) => {
      const data = JSON.parse(text);
      // Minimal DOM surface for sites.verificationKind.
      return {
        ...data,
        title: data.captcha ? "Human verification" : data.title || "",
        body: { textContent: data.captcha ? "Please complete the captcha" : "", innerText: "" },
        querySelector: () => null
      };
    },
    async fetchPage(url) {
      calls.fetch.push(url);
      const route = routes[url];
      const value = typeof route === "function" ? route(calls.fetch.filter((u) => u === url).length) : route;
      if (value === undefined) {
        return { ok: false, status: 404, url, text: "{}" };
      }
      if (value === "captcha") {
        return { ok: true, status: 200, url, text: verification };
      }
      if (value && value.status) {
        return { ok: false, status: value.status, url, text: "{}", retryAfterMs: value.retryAfterMs || 0 };
      }
      return { ok: true, status: 200, url, text: JSON.stringify(value) };
    },
    async probeImage() {
      return true;
    },
    async download(request) {
      calls.download.push(request);
      return download ? download(request, calls.download.length) : { ok: true };
    },
    notify: (note) => calls.notify.push(note),
    emit: () => undefined
  };
  return { env, calls, store, settings };
}

async function startEngine(env, settings = {}) {
  await env.store.kvSet("settings", { delayMs: 0, downloadDelayMs: 0, adaptive: false, notify: true, ...settings });
  const engine = new Engine(env);
  await engine.init();
  return engine;
}

function photo(id) {
  return { photoId: String(id), pageUrl: `https://www.imagefap.com/photo/${id}/` };
}

function photoPage(id) {
  return { image: `https://cdn.imagefap.com/images/full/1/${id}.jpg` };
}

function standardRoutes() {
  return {
    [GALLERY]: { title: "Test Album", items: [photo(1), photo(2), photo(3)], pages: [GALLERY + "?page=1"], total: 5 },
    [GALLERY + "?page=1"]: { title: "Test Album", items: [photo(4), photo(5)], pages: [GALLERY] },
    "https://www.imagefap.com/photo/1/": photoPage(1),
    "https://www.imagefap.com/photo/2/": photoPage(2),
    "https://www.imagefap.com/photo/3/": photoPage(3),
    "https://www.imagefap.com/photo/4/": photoPage(4),
    "https://www.imagefap.com/photo/5/": photoPage(5)
  };
}

test("full pipeline: pages, resolve, download, history", async () => {
  const { env, calls } = makeEnv({ routes: standardRoutes() });
  const engine = await startEngine(env);
  const { job } = await engine.enqueue({ url: GALLERY });
  await waitFor(() => engine.jobs.get(job.id).status === "done");
  const summary = engine.summary(engine.jobs.get(job.id));
  assert.equal(summary.counts.done, 5);
  assert.equal(summary.title, "Test Album");
  assert.equal(calls.download.length, 5);
  assert.match(calls.download[0].filename, /^ImageFap\/Test Album\/\d_\d\.jpg$/);
  assert.equal(engine.history.size, 5);
  assert.equal(calls.fetch.filter((url) => url === GALLERY).length, 1, "gallery read once");
  assert.equal(calls.notify.length, 1);
});

test("a photo page without a full-size image fails once instead of looping", async () => {
  const routes = standardRoutes();
  routes["https://www.imagefap.com/photo/3/"] = { title: "deleted" };
  const { env, calls } = makeEnv({ routes });
  const engine = await startEngine(env);
  const { job } = await engine.enqueue({ url: GALLERY });
  await waitFor(() => engine.jobs.get(job.id).status === "done-with-errors");
  assert.equal(calls.fetch.filter((url) => url.endsWith("/photo/3/")).length, 1);
  const summary = engine.summary(engine.jobs.get(job.id));
  assert.equal(summary.counts.failed, 1);
  assert.equal(summary.counts.done, 4);
});

test("429 on a page is waited out and retried", async () => {
  const routes = standardRoutes();
  const original = routes[GALLERY + "?page=1"];
  routes[GALLERY + "?page=1"] = (count) => (count === 1 ? { status: 429, retryAfterMs: 20 } : original);
  const { env } = makeEnv({ routes });
  const engine = await startEngine(env);
  const { job } = await engine.enqueue({ url: GALLERY });
  await waitFor(() => engine.jobs.get(job.id).status === "done");
  assert.equal(engine.summary(engine.jobs.get(job.id)).counts.done, 5);
});

test("captcha pauses the job and a solved challenge resumes the same request", async () => {
  const routes = standardRoutes();
  const original = routes[GALLERY + "?page=1"];
  let solved = false;
  routes[GALLERY + "?page=1"] = () => (solved ? original : "captcha");
  const { env, calls } = makeEnv({ routes });
  const engine = await startEngine(env);
  const { job } = await engine.enqueue({ url: GALLERY });
  await waitFor(() => engine.jobs.get(job.id).status === "captcha");
  assert.equal(engine.captchas.size, 1);
  assert.ok(calls.notify.some((note) => /CAPTCHA/.test(note.title)));
  // A normal page in some tab must not count as solved.
  assert.equal(engine.captchaTabState({ tabId: 9, url: GALLERY, isVerification: false }), false);
  engine.captchaTabState({ tabId: 7, url: GALLERY, isVerification: true });
  solved = true;
  assert.equal(engine.captchaTabState({ tabId: 7, url: GALLERY, isVerification: false }), true);
  await waitFor(() => engine.jobs.get(job.id).status === "done", { timeout: 10000 });
  assert.equal(engine.summary(engine.jobs.get(job.id)).counts.done, 5);
  assert.equal(calls.fetch.filter((url) => url === GALLERY).length, 1, "first page not re-read");
});

test("photos in the history are skipped without opening their pages", async () => {
  const { env, calls } = makeEnv({ routes: standardRoutes() });
  const engine = await startEngine(env);
  await engine.importHistory(["1", "imagefap:2"]);
  const { job } = await engine.enqueue({ url: GALLERY });
  await waitFor(() => engine.jobs.get(job.id).status === "done");
  const counts = engine.summary(engine.jobs.get(job.id)).counts;
  assert.equal(counts.skipped, 2);
  assert.equal(counts.done, 3);
  assert.equal(calls.fetch.filter((url) => url.endsWith("/photo/1/") || url.endsWith("/photo/2/")).length, 0);
});

test("expired links trigger one album re-read that brings fresh URLs", async () => {
  const routes = {
    [GALLERY]: (count) => ({
      title: "Tokens",
      items: [1, 2].map((id) => ({ ...photo(id), imageUrl: `https://cdn.xas/${id}.jpg?t=${count}` }))
    })
  };
  const { env, calls } = makeEnv({
    routes,
    download: (request) => (request.url.endsWith("t=1") ? { ok: false, status: 403 } : { ok: true })
  });
  const engine = await startEngine(env);
  const { job } = await engine.enqueue({ url: GALLERY });
  await waitFor(() => engine.jobs.get(job.id).status === "done");
  assert.equal(engine.summary(engine.jobs.get(job.id)).counts.done, 2);
  assert.equal(calls.fetch.filter((url) => url === GALLERY).length, 2);
});

test("a restarted engine resumes from the persisted frontier", async () => {
  const store = new MemoryStore();
  let block = true;
  const first = makeEnv({
    routes: standardRoutes(),
    store,
    download: async () => {
      while (block) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return { ok: true };
    }
  });
  const engine1 = await startEngine(first.env, { downloadConcurrency: 1 });
  const { job } = await engine1.enqueue({ url: GALLERY });
  await waitFor(() => engine1.jobs.get(job.id).scan.done && engine1.countsFor(engine1.jobs.get(job.id)).resolved === 5);
  await engine1.flush();
  // Simulate the offscreen document dying: engine1 is abandoned mid-download.
  engine1.ready = false;
  const second = makeEnv({ routes: standardRoutes(), store });
  const engine2 = new Engine(second.env);
  await engine2.init();
  await waitFor(() => engine2.jobs.get(job.id).status === "done");
  assert.equal(engine2.summary(engine2.jobs.get(job.id)).counts.done, 5);
  assert.equal(second.calls.fetch.length, 0, "nothing re-scanned or re-resolved");
  block = false;
});

test("two jobs on one host share the request schedule", async () => {
  const routes = standardRoutes();
  const other = "https://www.imagefap.com/pictures/200/other";
  routes[other] = { title: "Other", items: [photo(6), photo(7)] };
  routes["https://www.imagefap.com/photo/6/"] = photoPage(6);
  routes["https://www.imagefap.com/photo/7/"] = photoPage(7);
  let inFlight = 0;
  let peak = 0;
  const { env } = makeEnv({ routes });
  const baseFetch = env.fetchPage;
  env.fetchPage = async (url, options) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    try {
      return await baseFetch(url, options);
    } finally {
      inFlight -= 1;
    }
  };
  const engine = await startEngine(env, { scanConcurrency: 2, maxActiveJobs: 2 });
  const a = await engine.enqueue({ url: GALLERY });
  const b = await engine.enqueue({ url: other });
  await waitFor(() => engine.jobs.get(a.job.id).status === "done" && engine.jobs.get(b.job.id).status === "done");
  assert.ok(peak <= 2, "peak " + peak);
});

test("harvested neighbour URLs save photo-page requests", async () => {
  const routes = standardRoutes();
  routes["https://www.imagefap.com/photo/1/"] = {
    ...photoPage(1),
    harvest: [2, 3, 4, 5].map((id) => ({ photoId: String(id), imageUrl: `https://cdn.imagefap.com/images/full/1/${id}.jpg` }))
  };
  const { env, calls } = makeEnv({ routes });
  const engine = await startEngine(env, { scanConcurrency: 1 });
  const { job } = await engine.enqueue({ url: GALLERY });
  await waitFor(() => engine.jobs.get(job.id).status === "done");
  assert.equal(engine.summary(engine.jobs.get(job.id)).counts.done, 5);
  assert.ok(calls.fetch.filter((url) => url.includes("/photo/")).length < 5);
});

test("legacy 0.5.x catalogs import as resumable jobs", async () => {
  const { env, calls } = makeEnv({ routes: {} });
  const engine = await startEngine(env);
  const result = await engine.importData({
    version: 1,
    catalogs: [{
      key: "imagefap:x",
      site: "imagefap",
      sourceUrl: GALLERY,
      albumTitle: "Old Album",
      items: [
        { photoId: "11", pageUrl: "https://www.imagefap.com/photo/11/", imageUrl: "https://cdn.imagefap.com/images/full/1/11.jpg", fileName: "001_11.jpg" },
        { photoId: "12", pageUrl: "https://www.imagefap.com/photo/12/", imageUrl: "https://cdn.imagefap.com/images/full/1/12.jpg", fileName: "002_12.jpg" }
      ]
    }]
  });
  assert.deepEqual(result, { jobs: 1, items: 2 });
  const job = engine.findJobByUrl(GALLERY);
  assert.equal(job.status, "paused");
  engine.resumeJob(job.id);
  await waitFor(() => engine.jobs.get(job.id).status === "done");
  assert.equal(calls.download.length, 2);
  assert.equal(calls.download[0].filename, "ImageFap/Old Album/001_11.jpg");
});

test("cancel stops new work and the job can be resumed later", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { env, calls } = makeEnv({
    routes: standardRoutes(),
    download: async (request, count) => {
      if (count === 1) {
        await gate;
      }
      return { ok: true };
    }
  });
  env.cancelDownloads = async () => release();
  const engine = await startEngine(env, { downloadConcurrency: 1 });
  const { job } = await engine.enqueue({ url: GALLERY });
  await waitFor(() => calls.download.length === 1);
  await engine.cancelJob(job.id);
  assert.equal(engine.jobs.get(job.id).status, "cancelled");
  engine.resumeJob(job.id);
  await waitFor(() => engine.jobs.get(job.id).status === "done");
  assert.equal(engine.summary(engine.jobs.get(job.id)).counts.done, 5);
});
