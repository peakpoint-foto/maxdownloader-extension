"use strict";

// Service worker: deliberately thin and stateless. The engine lives in the
// offscreen document (offscreen.js); this worker only
//   - creates/keeps the offscreen document,
//   - performs chrome.* calls the offscreen document cannot make
//     (downloads, tabs, notifications),
//   - forwards browser events (download finished, tab closed) to the engine,
//   - opens the side panel and serves the context menu.
// Being killed by Chrome at any moment is harmless: nothing here holds job state.
importScripts("lib/sites.js");

const SCOPE = "maxdl";
const OFFSCREEN_URL = "offscreen.html";
const WATCHDOG_ALARM = "maxdl:watchdog";
const PENDING_FILENAME_TTL_MS = 5 * 60 * 1000;
const TAB_FETCH_TIMEOUT_MS = 25000;
const MENU_PAGE = "maxdl-page";
const MENU_LINK = "maxdl-link";

const { siteFromUrl, supportedTargetUrl } = globalThis.MaxDownloaderSites;

const SITE_PATTERNS = [
  "https://imagefap.com/*",
  "https://*.imagefap.com/*",
  "https://xasiat.com/*",
  "https://*.xasiat.com/*",
  "https://viper.to/threads/*",
  "https://*.viper.to/threads/*"
];

const pendingFilenames = new Map();
let creatingEngine = null;

// ------------------------------------------------------------ offscreen engine

async function engineExists() {
  if (chrome.offscreen && typeof chrome.offscreen.hasDocument === "function") {
    return chrome.offscreen.hasDocument();
  }
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    return contexts.length > 0;
  }
  return false;
}

function sendToEngine(type, payload = {}) {
  return chrome.runtime.sendMessage({ scope: SCOPE, target: "engine", type, ...payload });
}

async function waitEngineReady(timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const response = await sendToEngine("ping").catch(() => null);
    if (response && response.ready) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

async function ensureEngine() {
  if (!(await engineExists())) {
    if (!creatingEngine) {
      creatingEngine = chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: ["DOM_PARSER", "BLOBS"],
        justification: "Chạy bộ quét/tải ảnh lâu dài: phân tích HTML album và ghi file."
      }).catch((error) => {
        // Two callers raced: the document exists now, which is what we wanted.
        if (!/single offscreen/i.test(String(error && error.message))) {
          throw error;
        }
      }).finally(() => {
        creatingEngine = null;
      });
    }
    await creatingEngine;
  }
  return waitEngineReady();
}

async function resumeEngineIfActive() {
  const { maxdlActive } = await chrome.storage.local.get("maxdlActive").catch(() => ({}));
  if (maxdlActive) {
    await ensureEngine().catch(() => undefined);
  }
}

// ---------------------------------------------------------------- migration

async function migrateLegacyData() {
  const stored = await chrome.storage.local.get([
    "maxdlMigrated",
    "imagefapDownloadedPhotoIds",
    "imagefapAlbumCatalogs",
    "imagefapPopupSettings"
  ]).catch(() => ({}));
  if (stored.maxdlMigrated) {
    return;
  }
  const catalogs = Array.isArray(stored.imagefapAlbumCatalogs) ? stored.imagefapAlbumCatalogs : [];
  const historyKeys = Array.isArray(stored.imagefapDownloadedPhotoIds) ? stored.imagefapDownloadedPhotoIds : [];
  const old = stored.imagefapPopupSettings || null;
  const settings = old
    ? {
      downloadConcurrency: Number(old.concurrency) || undefined,
      scanConcurrency: Number(old.scanConcurrency) || undefined,
      delayMs: Number.isFinite(Number(old.delay)) ? Number(old.delay) : undefined,
      retryCount: Number.isFinite(Number(old.retryCount)) ? Number(old.retryCount) : undefined,
      skipDownloaded: typeof old.skipDownloaded === "boolean" ? old.skipDownloaded : undefined
    }
    : null;
  if (settings) {
    for (const key of Object.keys(settings)) {
      if (settings[key] === undefined) {
        delete settings[key];
      }
    }
  }
  if (catalogs.length || historyKeys.length || settings) {
    const result = await sendToEngine("migrate", { catalogs, historyKeys, settings }).catch(() => null);
    if (!result || !result.ok) {
      return;
    }
  }
  // Old keys are kept as a backup; the flag stops a second import.
  await chrome.storage.local.set({ maxdlMigrated: true }).catch(() => undefined);
}

// ------------------------------------------------------------------ downloads

function filenameKey(url) {
  try {
    return new URL(url).href;
  } catch {
    return String(url || "");
  }
}

// Pending names also live in storage.session: if Chrome stops this worker
// between download() and onDeterminingFilename, the new worker still knows
// where the file belongs instead of dropping it in the Downloads root.
const PENDING_KEY = "maxdlPendingNames";

async function persistPending() {
  const plain = {};
  for (const [key, entries] of pendingFilenames) {
    plain[key] = entries;
  }
  await chrome.storage.session.set({ [PENDING_KEY]: plain }).catch(() => undefined);
}

// Loaded once per worker start; later writes merge on top of it.
const pendingLoaded = chrome.storage.session.get(PENDING_KEY).then((stored) => {
  const plain = (stored && stored[PENDING_KEY]) || {};
  for (const [key, entries] of Object.entries(plain)) {
    if (Array.isArray(entries) && entries.length) {
      pendingFilenames.set(key, [...entries, ...(pendingFilenames.get(key) || [])]);
    }
  }
}).catch(() => undefined);

function rememberPendingFilename(url, filename) {
  const cutoff = Date.now() - PENDING_FILENAME_TTL_MS;
  for (const [key, entries] of pendingFilenames) {
    const fresh = entries.filter((entry) => entry.at >= cutoff);
    if (fresh.length) {
      pendingFilenames.set(key, fresh);
    } else {
      pendingFilenames.delete(key);
    }
  }
  const key = filenameKey(url);
  const entries = pendingFilenames.get(key) || [];
  entries.push({ filename, at: Date.now() });
  pendingFilenames.set(key, entries);
}

function takePendingFilename(url) {
  const key = filenameKey(url);
  const entries = pendingFilenames.get(key);
  if (!entries || !entries.length) {
    return "";
  }
  const entry = entries.shift();
  if (!entries.length) {
    pendingFilenames.delete(key);
  }
  return entry.filename;
}

// Only downloads this extension started carry a pending name; every other
// download in the browser gets suggest() with no change.
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  if (item.byExtensionId !== chrome.runtime.id) {
    suggest();
    return undefined;
  }
  const filename = takePendingFilename(item.url) || (item.finalUrl ? takePendingFilename(item.finalUrl) : "");
  if (filename) {
    void persistPending();
    suggest({ filename, conflictAction: "uniquify" });
    return undefined;
  }
  // Worker just restarted: wait for the persisted names, then answer.
  void (async () => {
    await pendingLoaded;
    const stored = takePendingFilename(item.url) || (item.finalUrl ? takePendingFilename(item.finalUrl) : "");
    await persistPending();
    if (stored) {
      suggest({ filename: stored, conflictAction: "uniquify" });
    } else {
      suggest();
    }
  })();
  return true;
});

function baseName(path) {
  return String(path || "").replace(/\\/g, "/").split("/").pop();
}

function dirName(path) {
  const parts = String(path || "").replace(/\\/g, "/").split("/");
  parts.pop();
  return parts.join("/");
}

// If an engine restart made Chrome fetch the same URL twice into one folder,
// keep the file with the plain name and remove the "name (1).jpg" copy.
async function removeDuplicateDownload(id) {
  const [item] = await chrome.downloads.search({ id }).catch(() => []);
  if (!item || item.byExtensionId !== chrome.runtime.id || item.state !== "complete") {
    return;
  }
  const siblings = (await chrome.downloads.search({ url: item.url, state: "complete" }).catch(() => []))
    .filter((other) => other.byExtensionId === chrome.runtime.id && other.exists !== false && dirName(other.filename) === dirName(item.filename) && other.fileSize === item.fileSize);
  if (siblings.length < 2) {
    return;
  }
  siblings.sort((left, right) => baseName(left.filename).length - baseName(right.filename).length || String(left.startTime).localeCompare(String(right.startTime)));
  for (const duplicate of siblings.slice(1)) {
    await chrome.downloads.removeFile(duplicate.id).catch(() => undefined);
    await chrome.downloads.erase({ id: duplicate.id }).catch(() => undefined);
  }
}

chrome.downloads.onChanged.addListener((delta) => {
  if (!delta || !delta.state || !["complete", "interrupted"].includes(delta.state.current)) {
    return;
  }
  if (delta.state.current === "complete") {
    void removeDuplicateDownload(delta.id);
  }
  void sendToEngine("dl-changed", {
    id: delta.id,
    state: delta.state.current,
    error: delta.error && delta.error.current ? delta.error.current : ""
  }).catch(() => undefined);
});

async function startDownload(url, filename) {
  await pendingLoaded;
  rememberPendingFilename(url, filename);
  await persistPending();
  try {
    const id = await chrome.downloads.download({ url, conflictAction: "uniquify", saveAs: false });
    return { id };
  } catch (error) {
    takePendingFilename(url);
    void persistPending();
    return { error: String(error && error.message || error) };
  }
}

async function queryDownloads(ids) {
  const results = [];
  for (const id of ids || []) {
    const [item] = await chrome.downloads.search({ id }).catch(() => []);
    results.push(item
      ? { id, url: item.url, state: item.state, paused: item.paused, exists: item.exists, bytesReceived: item.bytesReceived, totalBytes: item.totalBytes, error: item.error || "" }
      : null);
  }
  return results;
}

// ------------------------------------------------------------------- tab fetch

function sameOrigin(left, right) {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

// Reads a site page from inside the user's own album tab, so the request looks
// exactly like browsing (cookies, referer, same-origin). Cross-origin URLs and
// missing tabs tell the engine to fetch directly instead.
async function tabFetch(tabId, url) {
  let tab = null;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return { transportError: "no-tab" };
  }
  if (!tab || !tab.url || !siteFromUrl(tab.url)) {
    return { transportError: "no-tab" };
  }
  if (siteFromUrl(tab.url) !== siteFromUrl(url)) {
    return { transportError: "cross-origin" };
  }
  if (!sameOrigin(tab.url, url)) {
    return { transportError: "cross-origin" };
  }
  const timeout = new Promise((resolve) => setTimeout(() => resolve({ transportError: "timeout" }), TAB_FETCH_TIMEOUT_MS));
  const request = chrome.tabs.sendMessage(tabId, { scope: SCOPE, target: "content", type: "tab-fetch", url })
    .then((response) => response || { transportError: "no-tab" })
    .catch(() => ({ transportError: "no-tab" }));
  return Promise.race([request, timeout]);
}

// ------------------------------------------------------------- notifications

function notify({ id, title, message }) {
  if (!chrome.notifications) {
    return;
  }
  chrome.notifications.create(String(id || "maxdl-" + Date.now()), {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon128.png"),
    title: String(title || "Max Downloader"),
    message: String(message || "").slice(0, 300),
    priority: 0
  }, () => void chrome.runtime.lastError);
}

if (chrome.notifications && chrome.notifications.onClicked) {
  chrome.notifications.onClicked.addListener((id) => {
    chrome.notifications.clear(id);
    void openControlWindow();
  });
}

// -------------------------------------------------------------- control panel

async function openControlWindow() {
  const url = chrome.runtime.getURL("popup.html");
  const windows = await chrome.windows.getAll({ populate: true }).catch(() => []);
  const existing = windows.find((window) => (window.tabs || []).some((tab) => tab.url && tab.url.startsWith(url)));
  if (existing) {
    await chrome.windows.update(existing.id, { focused: true }).catch(() => undefined);
    return;
  }
  await chrome.windows.create({ url: url + "?window=1", type: "popup", width: 440, height: 820, focused: true }).catch(() => undefined);
}

if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
} else {
  chrome.action.onClicked.addListener(() => void openControlWindow());
}

function installMenus() {
  if (!chrome.contextMenus) {
    return;
  }
  chrome.contextMenus.removeAll(() => {
    void chrome.runtime.lastError;
    chrome.contextMenus.create({
      id: MENU_PAGE,
      title: "Tải album/thread này (Max Downloader)",
      contexts: ["page"],
      documentUrlPatterns: SITE_PATTERNS
    }, () => void chrome.runtime.lastError);
    chrome.contextMenus.create({
      id: MENU_LINK,
      title: "Thêm link này vào hàng đợi tải",
      contexts: ["link"],
      targetUrlPatterns: SITE_PATTERNS
    }, () => void chrome.runtime.lastError);
  });
}

if (chrome.contextMenus && chrome.contextMenus.onClicked) {
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    // sidePanel.open must run inside the user gesture, before any await.
    if (chrome.sidePanel && chrome.sidePanel.open && tab && tab.windowId !== undefined) {
      chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => undefined);
    }
    const url = info.menuItemId === MENU_LINK ? info.linkUrl : info.pageUrl;
    if (!supportedTargetUrl(url)) {
      notify({ title: "Link không được hỗ trợ", message: String(url || "") });
      return;
    }
    void ensureEngine()
      .then(() => sendToEngine("enqueue", {
        url,
        tabId: info.menuItemId === MENU_PAGE && tab ? tab.id : null
      }))
      .then((result) => {
        if (result && result.error) {
          notify({ title: "Không thêm được", message: result.message });
        }
      })
      .catch(() => undefined);
  });
}

// ---------------------------------------------------------------- lifecycle

chrome.runtime.onInstalled.addListener(() => {
  installMenus();
  chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 1 });
  void resumeEngineIfActive();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 1 });
  void resumeEngineIfActive();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm && alarm.name === WATCHDOG_ALARM) {
    void resumeEngineIfActive();
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void engineExists().then((exists) => {
    if (exists) {
      return sendToEngine("tab-closed", { tabId });
    }
    return undefined;
  }).catch(() => undefined);
});

// --------------------------------------------------------------- messages

async function handleBg(message) {
  switch (message.type) {
    case "ensure-engine":
      return { ok: await ensureEngine() };
    case "engine-ready":
      await migrateLegacyData();
      return { ok: true };
    case "engine-active":
      await chrome.storage.local.set({ maxdlActive: Boolean(message.active) });
      if (message.active) {
        chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 1 });
      }
      return { ok: true };
    case "dl-start":
      return startDownload(message.url, message.filename);
    case "dl-cancel":
      await chrome.downloads.cancel(message.id).catch(() => undefined);
      return { ok: true };
    case "dl-erase":
      await chrome.downloads.erase({ id: message.id }).catch(() => undefined);
      return { ok: true };
    case "dl-query":
      return queryDownloads(message.ids);
    case "dl-find": {
      const items = await chrome.downloads.search({ url: message.url, orderBy: ["-startTime"], limit: 10 }).catch(() => []);
      return items.map((item) => ({
        id: item.id,
        state: item.state,
        exists: item.exists,
        filename: item.filename,
        byUs: item.byExtensionId === chrome.runtime.id
      }));
    }
    case "tab-fetch":
      return tabFetch(message.tabId, message.url);
    case "notify":
      notify(message);
      return { ok: true };
    case "open-window":
      await openControlWindow();
      return { ok: true };
    default:
      return { ok: false, message: "Unknown bg message " + message.type };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Commands only come from extension pages (panel, offscreen), never a site tab.
  const fromExtension = !sender || !sender.url || sender.url.startsWith(chrome.runtime.getURL(""));
  if (!message || message.scope !== SCOPE || message.target !== "bg" || !fromExtension) {
    return false;
  }
  handleBg(message)
    .then((result) => sendResponse(result))
    .catch((error) => sendResponse({ ok: false, error: String(error && error.message || error) }));
  return true;
});

// A fresh worker (update, crash, wake-up) re-arms the engine if work was pending.
void resumeEngineIfActive();
