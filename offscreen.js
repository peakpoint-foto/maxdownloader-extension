"use strict";

// Offscreen document: hosts the engine and gives it a real browser environment
// (fetch with host permissions, DOMParser, IndexedDB, File System Access).
// Offscreen documents only get chrome.runtime, so downloads, tabs and
// notifications go through the service worker ("bg" messages).
(() => {
  const SCOPE = "maxdl";
  const PAGE_TIMEOUT_MS = 20000;
  const DOWNLOAD_STALL_MS = 90000;
  const DOWNLOAD_POLL_MS = 15000;

  const { Engine } = globalThis.MaxDownloaderEngine;
  const { IdbStore } = globalThis.MaxDownloaderStore;

  const store = new IdbStore();
  const downloadWaiters = new Map();
  const downloadsByJob = new Map();

  function bg(type, payload = {}) {
    return chrome.runtime.sendMessage({ scope: SCOPE, target: "bg", type, ...payload });
  }

  function retryAfterMs(headers) {
    const raw = headers && headers.get("retry-after");
    if (!raw) {
      return 0;
    }
    const seconds = Number(raw);
    if (Number.isFinite(seconds)) {
      return Math.max(0, seconds * 1000);
    }
    const date = Date.parse(raw);
    return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
  }

  // Aborts when the caller's signal fires or when `ms` passes without progress.
  function timeoutSignal(signal, ms) {
    const controller = new AbortController();
    let timer = setTimeout(() => controller.abort(new DOMException("Timeout", "TimeoutError")), ms);
    const onAbort = () => controller.abort(signal.reason);
    if (signal) {
      if (signal.aborted) {
        controller.abort(signal.reason);
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }
    return {
      signal: controller.signal,
      bump() {
        clearTimeout(timer);
        timer = setTimeout(() => controller.abort(new DOMException("Timeout", "TimeoutError")), ms);
      },
      done() {
        clearTimeout(timer);
        if (signal) {
          signal.removeEventListener("abort", onAbort);
        }
      }
    };
  }

  function abortError() {
    return Object.assign(new Error("Cancelled"), { name: "AbortError" });
  }

  async function directFetch(url, signal) {
    const timed = timeoutSignal(signal, PAGE_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        credentials: "include",
        headers: { Accept: "text/html,application/xhtml+xml" },
        signal: timed.signal
      });
      const text = await response.text();
      return {
        ok: response.ok,
        status: response.status,
        url: response.url || url,
        text,
        retryAfterMs: retryAfterMs(response.headers)
      };
    } catch (error) {
      if (signal && signal.aborted) {
        throw abortError();
      }
      if (timed.signal.aborted) {
        throw Object.assign(new Error(`Timeout sau ${PAGE_TIMEOUT_MS / 1000}s`), { code: "FETCH_TIMEOUT" });
      }
      throw error;
    } finally {
      timed.done();
    }
  }

  // "auto": read site pages through the open album tab (same cookies, referer
  // and request profile as browsing), falling back to a direct fetch.
  async function fetchPage(url, { tabId, site, fetchVia, signal } = {}) {
    let tabLost = false;
    // Only the album site itself goes through the tab; image hosts are fetched directly.
    const sameSite = globalThis.MaxDownloaderSites.siteFromUrl(url) === site;
    if (fetchVia === "auto" && sameSite && tabId !== null && tabId !== undefined) {
      const response = await bg("tab-fetch", { tabId, url }).catch(() => ({ transportError: "no-tab" }));
      if (signal && signal.aborted) {
        throw abortError();
      }
      if (response && !response.transportError) {
        return response;
      }
      tabLost = !response || response.transportError === "no-tab";
    }
    const response = await directFetch(url, signal);
    return { ...response, tabLost };
  }

  async function probeImage(url, signal) {
    for (const request of [{ method: "HEAD" }, { method: "GET", headers: { Range: "bytes=0-0" } }]) {
      const timed = timeoutSignal(signal, PAGE_TIMEOUT_MS);
      try {
        const response = await fetch(url, { ...request, credentials: "include", redirect: "follow", signal: timed.signal });
        if (response.body && request.method === "GET") {
          response.body.cancel().catch(() => undefined);
        }
        if (response.ok && /^image\//i.test(response.headers.get("content-type") || "")) {
          return true;
        }
      } catch (error) {
        if (signal && signal.aborted) {
          throw abortError();
        }
      } finally {
        timed.done();
      }
    }
    return false;
  }

  // ---------------------------------------------------------------- downloads

  const INTERRUPT_STATUS = {
    SERVER_FORBIDDEN: 403,
    SERVER_UNAUTHORIZED: 401,
    SERVER_BAD_CONTENT: 404,
    SERVER_CERT_PROBLEM: 495
  };

  function trackDownload(jobId, id) {
    let set = downloadsByJob.get(jobId);
    if (!set) {
      set = new Set();
      downloadsByJob.set(jobId, set);
    }
    set.add(id);
  }

  function untrackDownload(jobId, id) {
    const set = downloadsByJob.get(jobId);
    if (set) {
      set.delete(id);
    }
  }

  function interruptedResult(error) {
    const reason = String(error || "INTERRUPTED");
    const status = INTERRUPT_STATUS[reason] || 0;
    if (reason === "USER_CANCELED") {
      return { ok: false, reason: "cancelled", message: "Download bị hủy" };
    }
    return {
      ok: false,
      reason,
      status,
      retryable: !/^FILE_(NAME_TOO_LONG|ACCESS_DENIED|TOO_LARGE|VIRUS_INFECTED|BLOCKED|SECURITY_CHECK_FAILED)$/.test(reason),
      message: "Chrome không tải được ảnh (" + reason + ")"
    };
  }

  async function downloadViaChrome(request, signal) {
    let id = null;
    if (Number.isInteger(request.resumeId)) {
      // Started by a previous engine instance: adopt it instead of starting a duplicate.
      const [previous] = (await bg("dl-query", { ids: [request.resumeId] }).catch(() => [])) || [];
      if (previous && previous.url === request.url) {
        if (previous.state === "complete" && previous.exists !== false) {
          return { ok: true };
        }
        if (previous.state === "in_progress") {
          id = request.resumeId;
        }
      }
    }
    if (id === null && request.adoptByUrl) {
      // The engine died before Chrome even returned an id (slow server): find
      // the download by URL and target name.
      const name = String(request.filename).split("/").pop().replace(/\.[^.]+$/, "");
      const matches = (await bg("dl-find", { url: request.url }).catch(() => [])) || [];
      const match = matches.find((entry) => entry.byUs && String(entry.filename).replace(/\\/g, "/").split("/").pop().startsWith(name));
      if (match && match.state === "complete" && match.exists !== false) {
        return { ok: true };
      }
      if (match && match.state === "in_progress") {
        id = match.id;
      }
    }
    if (id === null) {
      const started = await bg("dl-start", { url: request.url, filename: request.filename, jobId: request.jobId }).catch((error) => ({ error: String(error && error.message || error) }));
      if (!started || started.error || typeof started.id !== "number") {
        return { ok: false, reason: "exception", message: (started && started.error) || "Không bắt đầu được download" };
      }
      id = started.id;
    }
    if (typeof request.onStarted === "function") {
      request.onStarted(id);
    }
    trackDownload(request.jobId, id);
    try {
      const result = await new Promise((resolve) => {
        let lastBytes = -1;
        let lastProgressAt = Date.now();
        const finish = (value) => {
          clearInterval(poll);
          downloadWaiters.delete(id);
          if (signal) {
            signal.removeEventListener("abort", onAbort);
          }
          resolve(value);
        };
        const onAbort = () => {
          void bg("dl-cancel", { id }).catch(() => undefined);
          finish({ ok: false, reason: "cancelled" });
        };
        downloadWaiters.set(id, (delta) => {
          if (delta.state === "complete") {
            finish({ ok: true });
          } else if (delta.state === "interrupted") {
            finish(interruptedResult(delta.error));
          }
        });
        // The worker may have slept through an onChanged event, and a download
        // can hang with no event at all: poll, and cancel on a real stall.
        const poll = setInterval(async () => {
          const [item] = await bg("dl-query", { ids: [id] }).catch(() => []) || [];
          if (!item) {
            return;
          }
          if (item.state === "complete") {
            finish({ ok: true });
          } else if (item.state === "interrupted") {
            finish(interruptedResult(item.error));
          } else if (!item.paused) {
            if (item.bytesReceived !== lastBytes) {
              lastBytes = item.bytesReceived;
              lastProgressAt = Date.now();
            } else if (Date.now() - lastProgressAt > DOWNLOAD_STALL_MS) {
              void bg("dl-cancel", { id }).catch(() => undefined);
              finish({ ok: false, reason: "stalled", retryable: true, message: `Download đứng yên quá ${DOWNLOAD_STALL_MS / 1000}s` });
            }
          }
        }, DOWNLOAD_POLL_MS);
        if (signal) {
          if (signal.aborted) {
            onAbort();
          } else {
            signal.addEventListener("abort", onAbort, { once: true });
          }
        }
      });
      if (result.ok && request.erase) {
        void bg("dl-erase", { id }).catch(() => undefined);
      }
      return result;
    } finally {
      untrackDownload(request.jobId, id);
    }
  }

  async function directoryHandle() {
    const handle = await store.kvGet("dirHandle");
    if (!handle) {
      return { error: { ok: false, reason: "NO_DIRECTORY", message: "Chưa chọn thư mục lưu. Mở Cài đặt → Browse, hoặc chuyển về Downloads." } };
    }
    let permission = "granted";
    try {
      permission = typeof handle.queryPermission === "function" ? await handle.queryPermission({ mode: "readwrite" }) : "granted";
    } catch {
      permission = "denied";
    }
    if (permission !== "granted") {
      return { error: { ok: false, reason: "NEEDS_PERMISSION", message: "Trình duyệt cần bạn cấp lại quyền ghi vào thư mục \"" + handle.name + "\". Bấm \"Cấp quyền\" trong cửa sổ điều khiển." } };
    }
    return { handle };
  }

  // Direct write into the folder picked with Browse. createWritable() writes to
  // a swap file and only replaces the target on close(), so a crash never
  // leaves a half image under the final name.
  async function downloadToDirectory(request, signal) {
    const { handle, error } = await directoryHandle();
    if (error) {
      return error;
    }
    const parts = String(request.filename).split("/").filter((part) => part && part !== "." && part !== "..");
    const name = parts.pop();
    let directory = handle;
    try {
      for (const part of parts) {
        directory = await directory.getDirectoryHandle(part, { create: true });
      }
      try {
        const existing = await directory.getFileHandle(name, { create: false });
        const file = await existing.getFile();
        if (file.size > 0) {
          return { ok: true, existed: true };
        }
      } catch (lookupError) {
        if (!lookupError || lookupError.name !== "NotFoundError") {
          throw lookupError;
        }
      }
    } catch (fsError) {
      return { ok: false, reason: "FILE_ERROR", retryable: false, message: "Không tạo được thư mục/file: " + (fsError && fsError.message) };
    }
    const timed = timeoutSignal(signal, DOWNLOAD_STALL_MS);
    let writable = null;
    try {
      const response = await fetch(request.url, { credentials: "include", cache: "no-store", signal: timed.signal });
      if (!response.ok) {
        const status = response.status;
        response.body && response.body.cancel().catch(() => undefined);
        return {
          ok: false,
          status,
          reason: status === 429 || status === 503 ? "rate" : "http",
          retryAfterMs: retryAfterMs(response.headers),
          retryable: status >= 500 || status === 408,
          message: `HTTP ${status}`
        };
      }
      const fileHandle = await directory.getFileHandle(name, { create: true });
      writable = await fileHandle.createWritable();
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        timed.bump();
        await writable.write(value);
      }
      await writable.close();
      writable = null;
      return { ok: true };
    } catch (fetchError) {
      if (writable) {
        await writable.abort().catch(() => undefined);
      }
      if (signal && signal.aborted) {
        return { ok: false, reason: "cancelled" };
      }
      if (timed.signal.aborted) {
        return { ok: false, reason: "stalled", retryable: true, message: `Tải đứng yên quá ${DOWNLOAD_STALL_MS / 1000}s` };
      }
      return { ok: false, reason: "network", retryable: true, message: String(fetchError && fetchError.message || fetchError) };
    } finally {
      timed.done();
    }
  }

  function download(request, signal) {
    return request.mode === "directory" ? downloadToDirectory(request, signal) : downloadViaChrome(request, signal);
  }

  async function cancelDownloads(jobId) {
    const ids = [...(downloadsByJob.get(jobId) || [])];
    await Promise.all(ids.map((id) => bg("dl-cancel", { id }).catch(() => undefined)));
  }

  // ------------------------------------------------------------------- engine

  const engine = new Engine({
    store,
    parseHtml: (html, url) => {
      const doc = new DOMParser().parseFromString(html, "text/html");
      // Relative URLs in adapters resolve against the page, never this document.
      if (url && doc.head) {
        const base = doc.createElement("base");
        base.href = url;
        doc.head.prepend(base);
      }
      return doc;
    },
    fetchPage,
    probeImage,
    download,
    cancelDownloads,
    notify: (note) => void bg("notify", note).catch(() => undefined),
    emit: (state) => void chrome.runtime.sendMessage({ scope: SCOPE, target: "ui", type: "state", state }).catch(() => undefined),
    setActive: (active) => void bg("engine-active", { active }).catch(() => undefined),
    log: (level, message, data) => {
      const method = level === "error" ? "error" : level === "warn" ? "warn" : level === "debug" ? "debug" : "log";
      console[method]("[maxdl]", message, data === undefined ? "" : data);
    }
  });
  const readyPromise = engine.init().then(() => {
    void bg("engine-ready").catch(() => undefined);
  });

  async function handle(message, sender) {
    await readyPromise;
    switch (message.type) {
      case "ping":
        return { ok: true, ready: engine.ready };
      case "get-state":
        return engine.state();
      case "enqueue":
        return engine.enqueue({ url: message.url, tabId: message.tabId, includeAlbum: message.includeAlbum, mode: message.mode });
      case "enqueue-many": {
        const results = [];
        for (const url of message.urls || []) {
          try {
            const result = await engine.enqueue({ url, includeAlbum: message.includeAlbum, mode: "auto" });
            results.push({ url, ok: true, existed: result.existed });
          } catch (error) {
            results.push({ url, ok: false, message: error.message });
          }
        }
        return { results };
      }
      case "pause":
        return { ok: engine.pauseJob(message.jobId) };
      case "resume":
        return { ok: engine.resumeJob(message.jobId) };
      case "cancel":
        return { ok: await engine.cancelJob(message.jobId) };
      case "remove":
        return { ok: await engine.removeJob(message.jobId) };
      case "retry-failed":
        return engine.retryFailed(message.jobId);
      case "move":
        return { ok: engine.moveJob(message.jobId, message.direction) };
      case "resolve-captcha":
        return { ok: engine.resolveCaptchaForJob(message.jobId) };
      case "captcha-tab-opened":
        engine.captchaTabOpened(message.host, message.tabId);
        return { ok: true };
      case "update-settings":
        return { settings: await engine.updateSettings(message.patch) };
      case "permission-granted":
        for (const job of engine.jobs.values()) {
          if (job.needsPermission) {
            engine.resumeJob(job.id);
          }
        }
        return { ok: true };
      case "clear-history":
        await engine.clearHistory();
        return { ok: true };
      case "clear-finished":
        return { removed: await engine.clearFinished() };
      case "job-items":
        return { items: await engine.jobItems(message.jobId, message.status) };
      case "export":
        return engine.exportData();
      case "import":
        return engine.importData(message.data);
      case "migrate": {
        const history = await engine.importHistory(message.historyKeys || []);
        const imported = await engine.importData({ catalogs: message.catalogs || [] });
        if (message.settings) {
          await engine.updateSettings(message.settings);
        }
        engine.log("info", "Đã chuyển dữ liệu từ bản 0.5.x", { history, ...imported });
        return { ok: true, history, ...imported };
      }
      case "dl-changed": {
        const waiter = downloadWaiters.get(message.id);
        if (waiter) {
          waiter(message);
        }
        return { ok: Boolean(waiter) };
      }
      case "tab-closed":
        engine.tabClosed(message.tabId);
        return { ok: true };
      case "get-logs":
        await engine.flush();
        return { logs: await store.getLogs(message.limit || 3000) };
      default:
        return { ok: false, message: "Lệnh không hỗ trợ: " + message.type };
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.scope !== SCOPE) {
      return false;
    }
    // captcha-watch.js broadcasts from site tabs.
    if (message.type === "captcha-tab-state" && sender && sender.tab) {
      void readyPromise.then(() => {
        sendResponse({ resumed: engine.captchaTabState({ tabId: sender.tab.id, url: message.pageUrl, isVerification: message.isVerification }) });
      });
      return true;
    }
    // Commands only come from extension pages/worker, never from a site tab.
    const fromExtension = !sender || !sender.url || sender.url.startsWith(chrome.runtime.getURL(""));
    if (message.target !== "engine" || !fromExtension) {
      return false;
    }
    handle(message, sender)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: true, message: error instanceof Error ? error.message : String(error) }));
    return true;
  });
})();
