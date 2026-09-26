"use strict";

// End-to-end test: real Chromium + the unpacked extension against the fixture
// sites. Needs Node 18+, openssl and Playwright (`npm i -g playwright`).
//   node e2e/run.js            (CHROME=/path/to/chrome to pick a binary)
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const assert = require("node:assert/strict");
const fixture = require("./fixture-server");

let playwright;
try {
  playwright = require("playwright");
} catch {
  playwright = require(path.join(require("node:child_process").execSync("npm root -g").toString().trim(), "playwright"));
}

const EXT = path.resolve(__dirname, "..");
const CHROME = process.env.CHROME || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const DEBUG_PORT = 9333;
const results = [];

function step(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

async function waitFor(fn, { timeout = 30000, interval = 250, label = "condition" } = {}) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeout) {
    last = await fn();
    if (last) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error("Timeout waiting for " + label);
}

function listFiles(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of fs.existsSync(current) ? fs.readdirSync(current, { withFileTypes: true }) : []) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        out.push(path.relative(dir, full).split(path.sep).join("/"));
      }
    }
  };
  walk(dir);
  return out.sort();
}

async function main() {
  const { server, control, state } = await fixture.start();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "maxdl-profile-"));
  const downloads = fs.mkdtempSync(path.join(os.tmpdir(), "maxdl-downloads-"));
  fs.mkdirSync(path.join(profile, "Default"), { recursive: true });
  fs.writeFileSync(path.join(profile, "Default", "Preferences"), JSON.stringify({
    download: { default_directory: downloads, prompt_for_download: false, directory_upgrade: true },
    profile: { exit_type: "Normal" }
  }));

  const chrome = spawn(CHROME, [
    "--headless=new",
    "--no-sandbox",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${profile}`,
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    "--host-resolver-rules=MAP * 127.0.0.1:8443, EXCLUDE 127.0.0.1",
    "--ignore-certificate-errors",
    "--no-proxy-server",
    "about:blank"
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let chromeLog = "";
  chrome.stderr.on("data", (chunk) => {
    chromeLog += chunk.toString();
  });

  let browser;
  let debugPanel = null;
  try {
    browser = await waitFor(async () => playwright.chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`).catch(() => null), { label: "chrome devtools", timeout: 20000 });
    const context = browser.contexts()[0];
    // Playwright redirects downloads into its own temp folder; hand them back to
    // the browser so chrome.downloads saves under the profile's Downloads dir.
    const cdp = await browser.newBrowserCDPSession();
    await cdp.send("Browser.setDownloadBehavior", { behavior: "default" });
    // connectOverCDP does not report workers that started before it attached,
    // so read the extension id from the DevTools target list.
    const extensionId = await waitFor(async () => {
      const targets = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`).then((response) => response.json()).catch(() => []);
      const sw = targets.find((target) => target.type === "service_worker" && target.url.endsWith("/background.js"));
      return sw ? new URL(sw.url).host : null;
    }, { label: "extension service worker", timeout: 15000 });
    step("extension loaded", Boolean(extensionId), extensionId);

    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/popup.html?window=1`);
    debugPanel = panel;
    const send = (type, payload = {}) => panel.evaluate(([t, p]) => chrome.runtime.sendMessage({ scope: "maxdl", target: "engine", type: t, ...p }), [type, payload]);
    await panel.evaluate(() => chrome.runtime.sendMessage({ scope: "maxdl", target: "bg", type: "ensure-engine" }));
    const initial = await send("get-state");
    step("engine running in offscreen document", Boolean(initial && initial.ready));
    await send("update-settings", { patch: { delayMs: 100, downloadDelayMs: 0, notify: false, scanConcurrency: 1 } });

    const tabIdFor = (pattern) => panel.evaluate(async (p) => {
      const tabs = await chrome.tabs.query({ url: p });
      return tabs.length ? tabs[0].id : null;
    }, pattern);
    const job = async (id) => (await send("get-state")).jobs.find((entry) => entry.id === id);

    // ---------------------------------------------------------------- ImageFap
    const album = await context.newPage();
    await album.goto("https://www.imagefap.com/pictures/555/Test-Gallery?gid=555");
    const albumTab = await tabIdFor("https://www.imagefap.com/*");
    const fap = await send("enqueue", { url: album.url(), tabId: albumTab, includeAlbum: true });
    step("imagefap job created", Boolean(fap && fap.job), fap && fap.job && fap.job.id);
    const fapDone = await waitFor(async () => {
      const current = await job(fap.job.id);
      return current && ["done", "done-with-errors", "error"].includes(current.status) ? current : null;
    }, { label: "imagefap job", timeout: 60000 });
    step("imagefap job finishes (deleted photo fails once, no loop)", fapDone.status === "done-with-errors" && fapDone.counts.done === 5 && fapDone.counts.failed === 1,
      `${fapDone.status} done=${fapDone.counts.done} failed=${fapDone.counts.failed} :: ${fapDone.message}`);
    const photoHits = state.requests.filter((request) => request.path.startsWith("/photo/1004"));
    step("deleted photo page requested exactly once", photoHits.length === 1, String(photoHits.length));
    const harvested = state.requests.filter((request) => request.path.startsWith("/photo/1002"));
    step("neighbour URL harvested (photo 1002 page never opened)", harvested.length === 0, String(harvested.length));
    step("429 on page 2 was waited out", state.gallery429Served && fapDone.counts.total === 6);
    const viaTab = state.requests.filter((request) => request.host === "www.imagefap.com" && request.path.startsWith("/photo/") && request.site === "same-origin");
    step("site pages read through the album tab (same-origin)", viaTab.length >= 3, `${viaTab.length} same-origin photo requests`);
    const fapFiles = listFiles(downloads).filter((file) => file.startsWith("ImageFap/"));
    step("imagefap files saved under ImageFap/<album>/", fapFiles.length === 5 && fapFiles.every((file) => /^ImageFap\/Test Gallery\/\d{3}_\d+\.jpg$/.test(file)), fapFiles.join(", "));

    // Re-run: everything is in the history, nothing is fetched again.
    const before = state.requests.length;
    await send("enqueue", { url: album.url(), tabId: albumTab, mode: "rescan" });
    const rescanned = await waitFor(async () => {
      const current = await job(fap.job.id);
      return current && current.status !== "queued" && current.status !== "running" ? current : null;
    }, { label: "rescan", timeout: 30000 });
    const photoRequests = state.requests.slice(before).filter((request) => request.path.startsWith("/photo/") && !request.path.startsWith("/photo/1004"));
    step("rescan skips downloaded photos without opening their pages", photoRequests.length === 0 && listFiles(downloads).filter((file) => file.startsWith("ImageFap/")).length === 5,
      `${rescanned.status}, photo requests=${photoRequests.length}`);

    // ------------------------------------------------------------------ Xasiat
    const xasiatPage = await context.newPage();
    await xasiatPage.goto("https://www.xasiat.com/albums/777/cosplay-test-album/");
    const xasTab = await tabIdFor("https://www.xasiat.com/*");
    const xas = await send("enqueue", { url: xasiatPage.url(), tabId: xasTab });
    const captchaJob = await waitFor(async () => {
      const current = await job(xas.job.id);
      return current && current.status === "captcha" ? current : null;
    }, { label: "captcha state", timeout: 30000 });
    step("captcha detected mid-album and job paused", Boolean(captchaJob.captcha && captchaJob.captcha.url), captchaJob.captcha && captchaJob.captcha.url);
    // The user opens the challenge in a tab, solves it, and the page moves on.
    const challenge = await context.newPage();
    await challenge.goto(captchaJob.captcha.url);
    const challengeTab = await panel.evaluate(async () => {
      const tabs = await chrome.tabs.query({ url: "https://www.xasiat.com/albums/*" });
      return tabs.filter((tab) => tab.url.includes("page=2")).map((tab) => tab.id)[0] || null;
    });
    await send("captcha-tab-opened", { host: captchaJob.captcha.host, tabId: challengeTab });
    await new Promise((resolve) => setTimeout(resolve, 800));
    const stillWaiting = await job(xas.job.id);
    step("job keeps waiting while the challenge is unsolved", stillWaiting.status === "captcha", stillWaiting.status);
    await fetch("http://127.0.0.1:8444/solve");
    await challenge.reload();
    const xasDone = await waitFor(async () => {
      const current = await job(xas.job.id);
      return current && ["done", "done-with-errors", "error"].includes(current.status) ? current : null;
    }, { label: "xasiat job", timeout: 60000 });
    step("solved captcha auto-resumes and job completes", xasDone.status === "done" && xasDone.counts.done === 4, `${xasDone.status} ${xasDone.counts.done}/4 :: ${xasDone.message}`);
    const firstPageReads = state.requests.filter((request) => request.host === "www.xasiat.com" && request.path === "/albums/777/cosplay-test-album/");
    step("expired token triggered an album re-read", firstPageReads.length >= 2 && state.expiredTokens.has("tokA"), `${firstPageReads.length} reads of page 1`);
    const xasFiles = listFiles(downloads).filter((file) => file.startsWith("Xasiat/"));
    step("xasiat files saved", xasFiles.length === 4, xasFiles.join(", "));

    // ------------------------------------------------------------------- Viper
    const viperPage = await context.newPage();
    await viperPage.goto("https://viper.to/threads/12345-Test-Thread");
    const viperTab = await tabIdFor("https://viper.to/*");
    const vip = await send("enqueue", { url: viperPage.url(), tabId: viperTab });
    const vipDone = await waitFor(async () => {
      const current = await job(vip.job.id);
      return current && ["done", "done-with-errors", "error"].includes(current.status) ? current : null;
    }, { label: "viper job", timeout: 60000 });
    step("viper thread done (imx + pixhost rules + viewer page on a third host)", vipDone.status === "done" && vipDone.counts.done === 3, `${vipDone.status} ${vipDone.counts.done}/3 :: ${JSON.stringify(vipDone.errors)}`);
    const vipFiles = listFiles(downloads).filter((file) => file.startsWith("[Misc][Sets]-Post Alpha/"));
    step("viper files grouped by forum + post title", vipFiles.length === 3, vipFiles.join(", "));
    const probes = state.requests.filter((request) => request.host === "files.pixhost.to" && request.method === "HEAD");
    step("unknown image host validated from the background (no CORS failure)", probes.length >= 1, `${probes.length} HEAD`);

    // --------------------------------------------- engine restart mid-download
    const slow = await send("enqueue", { url: "https://www.imagefap.com/pictures/556/Slow-Gallery", tabId: null });
    await waitFor(async () => {
      const current = await job(slow.job.id);
      return current && current.counts.resolved >= 2 ? current : null;
    }, { label: "slow job downloading", timeout: 30000 });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    // Kill the offscreen document (what a crash or browser shutdown does), then
    // let the panel bring the engine back.
    const killAt = Date.now();
    if (process.env.E2E_VERBOSE) {
      const snap = await send("export");
      console.log("items before kill", JSON.stringify(snap.jobs.find((entry) => entry.job.id === slow.job.id).items.map((item) => [item.photoId, item.status, item.downloadId])));
    }
    await panel.evaluate(() => chrome.offscreen.closeDocument());
    await new Promise((resolve) => setTimeout(resolve, 500));
    await panel.evaluate(() => chrome.runtime.sendMessage({ scope: "maxdl", target: "bg", type: "ensure-engine" }));
    // Also stop the service worker mid-download, as Chrome does after 30s idle.
    await new Promise((resolve) => setTimeout(resolve, 700));
    const { targetInfos } = await cdp.send("Target.getTargets");
    const swTarget = targetInfos.find((target) => target.type === "service_worker" && target.url.includes(extensionId));
    let swStopped = false;
    if (swTarget) {
      swStopped = (await cdp.send("Target.closeTarget", { targetId: swTarget.targetId }).catch(() => ({ success: false }))).success !== false;
    }
    step("service worker stopped mid-download", swStopped);
    const slowDone = await waitFor(async () => {
      const current = await job(slow.job.id).catch(() => null);
      return current && ["done", "done-with-errors", "error"].includes(current.status) ? current : null;
    }, { label: "slow job after restart", timeout: 60000 });
    const slowFiles = listFiles(downloads).filter((file) => file.startsWith("ImageFap/Slow Gallery/"));
    step("engine restart resumes the job without duplicate files", slowDone.status === "done" && slowFiles.length === 4 && !slowFiles.some((file) => / \(\d+\)\./.test(file)),
      `${slowDone.status} files=${slowFiles.join(", ")}`);
    const stray = listFiles(downloads).filter((file) => !file.includes("/"));
    step("no file lands outside its album folder", stray.length === 0, stray.join(", "));
    const slowFetches = state.requests.filter((request) => request.path.startsWith("/images/full/9/9/"));
    if (process.env.E2E_VERBOSE) {
      console.log("kill at +0; image requests:", slowFetches.map((request) => `${request.path} ${request.at - killAt}ms`).join(" | "));
    }
    // Downloads whose response headers had not arrived yet are invisible to
    // chrome.downloads (and a worker stop can drop a pending download() call),
    // so they may be fetched once more; duplicate copies are removed.
    step("restarts repeat only downloads Chrome had not registered yet", slowFetches.length <= 6, `${slowFetches.length} image requests`);

    // ------------------------------------------------------------- UI render
    await panel.reload();
    await panel.waitForSelector(".job", { timeout: 10000 });
    const cards = await panel.$$eval(".job .job-title", (nodes) => nodes.map((node) => node.textContent));
    step("side panel renders the queue", cards.length === 4, cards.join(" | "));

    // Window-mode panel follows the active album tab.
    await viperPage.bringToFront();
    const popupPromise = context.waitForEvent("page", { timeout: 10000 });
    await panel.evaluate(() => chrome.windows.create({ url: chrome.runtime.getURL("popup.html?window=1"), type: "popup", width: 420, height: 900 }));
    const popupWindow = await popupPromise;
    await popupWindow.waitForLoadState();
    const currentSite = await waitFor(async () => {
      const text = await popupWindow.textContent("#current-site").catch(() => "");
      return text ? text : null;
    }, { label: "current tab in panel", timeout: 10000 }).catch(() => "");
    const jobLine = await popupWindow.textContent("#current-job-line").catch(() => "");
    step("panel detects the active album tab and its job", currentSite === "Viper" && /Hoàn tất/.test(jobLine), `${currentSite} / ${jobLine}`);
    if (process.env.E2E_SCREENSHOT) {
      await popupWindow.setViewportSize({ width: 400, height: 1100 });
      await popupWindow.screenshot({ path: process.env.E2E_SCREENSHOT, fullPage: true });
      await popupWindow.click("#gear");
      await popupWindow.screenshot({ path: process.env.E2E_SCREENSHOT.replace(/\.png$/, "-settings.png"), fullPage: true });
      await popupWindow.click("#gear");
    }

    // ------------------------------------------------------ legacy migration
    await panel.evaluate(async () => {
      await chrome.storage.local.set({
        maxdlMigrated: false,
        imagefapDownloadedPhotoIds: ["424242", "xasiat:1"],
        imagefapAlbumCatalogs: [{
          key: "imagefap:https://imagefap.com/pictures/999/old",
          site: "imagefap",
          sourceUrl: "https://www.imagefap.com/pictures/999/old-album",
          albumTitle: "Old Album",
          items: [{ photoId: "424242", pageUrl: "https://www.imagefap.com/photo/424242/", imageUrl: "https://cdn.imagefap.com/images/full/1/2/424242.jpg", fileName: "001_424242.jpg" }]
        }]
      });
      // Same trigger the worker uses after the engine boots.
      await chrome.runtime.sendMessage({ scope: "maxdl", target: "bg", type: "engine-ready" });
    });
    const migrated = await send("get-state");
    const oldJob = migrated.jobs.find((entry) => entry.title === "Old Album");
    step("0.5.x catalogs + history migrate into jobs", Boolean(oldJob) && oldJob.counts.done === 1, oldJob ? `${oldJob.status} done=${oldJob.counts.done}` : "missing");

    // -------------------------------------------------------- export / import
    const exported = await send("export");
    step("catalog export (v2)", exported && exported.version === 2 && exported.jobs.length === 5, `${exported && exported.jobs.length} jobs`);

    const logs = await send("get-logs", { limit: 500 });
    const errors = logs.logs.filter((entry) => entry.level === "error");
    step("no engine errors logged", errors.length === 0, errors.map((entry) => entry.message + " " + JSON.stringify(entry.data)).join(" | "));
  } catch (error) {
    step("e2e run", false, error.stack || String(error));
    if (process.env.E2E_VERBOSE && debugPanel) {
      const dump = await debugPanel.evaluate(async () => ({
        state: await chrome.runtime.sendMessage({ scope: "maxdl", target: "engine", type: "get-state" }),
        logs: await chrome.runtime.sendMessage({ scope: "maxdl", target: "engine", type: "get-logs", limit: 40 })
      })).catch((dumpError) => ({ dumpError: String(dumpError) }));
      console.log(JSON.stringify(dump, null, 1).slice(0, 12000));
    }
  } finally {
    if (browser) {
      await browser.close().catch(() => undefined);
    }
    chrome.kill("SIGKILL");
    server.close();
    control.close();
  }
  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length && process.env.E2E_VERBOSE) {
    console.log(chromeLog.slice(-4000));
  }
  process.exit(failed.length ? 1 : 0);
}

main();
