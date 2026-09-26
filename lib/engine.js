"use strict";

// Download engine. Runs in the offscreen document (long-lived, not killed like
// the MV3 service worker) and owns every job from first page to last file.
//
// Pipeline per job, all stages overlapping:
//   list    — walk gallery/thread pages, persist the page frontier after each page
//   resolve — turn items without a full-size URL into one (photo/viewer pages)
//   download— global pool, fair round-robin across jobs
//
// Item states: unresolved → resolving → ready → downloading → done
//              (+ skipped | failed | expired). Everything is persisted, so a
// browser restart resumes from the exact item/page where it stopped.
//
// The engine is environment-agnostic: `env` supplies storage, network, parsing
// and downloads, which keeps it unit-testable in Node.
(function installEngine(globalObject) {
  "use strict";

  const { HostLimiter } = globalObject.MaxDownloaderLimiter;
  const { itemKey } = globalObject.MaxDownloaderStore;
  const sites = globalObject.MaxDownloaderSites;
  const paths = globalObject.MaxDownloaderPaths;
  const handlerLib = globalObject.MaxDownloaderHandlers;

  const DEFAULT_SETTINGS = Object.freeze({
    delayMs: 750,
    scanConcurrency: 2,
    downloadConcurrency: 2,
    downloadDelayMs: 500,
    retryCount: 2,
    adaptive: true,
    maxActiveJobs: 2,
    skipDownloaded: true,
    includeAlbum: true,
    fetchVia: "auto",
    downloadMode: "downloads",
    downloadSubdir: "",
    eraseDownloadHistory: false,
    notify: true
  });

  const SETTING_LIMITS = Object.freeze({
    delayMs: [0, 10000],
    scanConcurrency: [1, 8],
    downloadConcurrency: [1, 8],
    downloadDelayMs: [0, 10000],
    retryCount: [0, 5],
    maxActiveJobs: [1, 6]
  });

  const LIVE_STATUSES = new Set(["queued", "running", "captcha"]);
  const MAX_PAGES = 500;
  const MAX_JOB_ERRORS = 50;
  const MAX_REFRESH = 2;
  const MAX_RATE_RETRIES = 8;
  const POST_CAPTCHA_COOLDOWN_MS = 4000;
  const FLUSH_MS = 700;
  const EMIT_MS = 400;
  const RATE_WINDOW_MS = 60000;

  class CaptchaError extends Error {
    constructor(url, host, phase, kind = "verification") {
      super("Trang yêu cầu xác minh CAPTCHA");
      this.code = "HUMAN_VERIFICATION";
      this.url = url;
      this.host = host;
      this.phase = phase;
      this.kind = kind;
    }
  }

  function isAbort(error) {
    return Boolean(error && (error.name === "AbortError" || error.code === "ABORTED"));
  }

  function hostKey(url) {
    try {
      return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    } catch {
      return "";
    }
  }

  function errorMessage(error) {
    return error instanceof Error ? error.message : String(error || "Lỗi không xác định");
  }

  function clampSettings(input) {
    const merged = { ...DEFAULT_SETTINGS, ...(input || {}) };
    for (const [key, [min, max]] of Object.entries(SETTING_LIMITS)) {
      const value = Number(merged[key]);
      merged[key] = Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : DEFAULT_SETTINGS[key];
    }
    for (const key of ["adaptive", "skipDownloaded", "includeAlbum", "eraseDownloadHistory", "notify"]) {
      merged[key] = Boolean(merged[key]);
    }
    merged.fetchVia = merged.fetchVia === "background" ? "background" : "auto";
    merged.downloadMode = merged.downloadMode === "directory" ? "directory" : "downloads";
    merged.downloadSubdir = paths.safeDownloadRoot(merged.downloadSubdir || "");
    return merged;
  }

  class Engine {
    constructor(env) {
      this.env = env;
      this.store = env.store;
      this.now = env.now || (() => Date.now());
      this.handlers = env.handlers || handlerLib.HANDLERS;
      this.settings = clampSettings({});
      this.jobs = new Map();
      this.rt = new Map();
      this.history = new Set();
      this.captchas = new Map();
      this.limiter = new HostLimiter({
        now: this.now,
        random: env.random || Math.random,
        config: (key) => this.limiterConfig(key)
      });
      this.dlActive = 0;
      this.rr = 0;
      this.dirtyItems = new Map();
      this.dirtyJobs = new Set();
      this.pendingHistory = [];
      this.pendingLogs = [];
      this.flushTimer = null;
      this.emitTimer = null;
      this.pumpQueued = false;
      this.ready = false;
      this.lastActive = null;
    }

    // ------------------------------------------------------------------ setup

    limiterConfig(key) {
      if (key.startsWith("dl:")) {
        return {
          delayMs: this.settings.downloadDelayMs,
          maxConcurrency: this.settings.downloadConcurrency,
          adaptive: this.settings.adaptive
        };
      }
      return {
        delayMs: this.settings.delayMs,
        maxConcurrency: this.settings.scanConcurrency,
        adaptive: this.settings.adaptive
      };
    }

    async init() {
      this.settings = clampSettings(await this.store.kvGet("settings"));
      this.history = new Set(await this.store.loadHistoryKeys());
      const jobs = await this.store.listJobs();
      for (const job of jobs) {
        this.normalizeJob(job);
        if (LIVE_STATUSES.has(job.status)) {
          // Picked up where the browser/extension stopped; a CAPTCHA that was
          // pending shows up again on the next request if it still applies.
          job.status = "queued";
          job.captcha = null;
          job.note = "Tự tiếp tục sau khi extension/trình duyệt khởi động lại.";
          this.markJob(job);
        }
        this.jobs.set(job.id, job);
      }
      this.ready = true;
      this.log("info", "Engine sẵn sàng", { jobs: jobs.length, history: this.history.size });
      this.pump();
      this.emitSoon(true);
    }

    normalizeJob(job) {
      job.keys = Array.isArray(job.keys) ? job.keys : [handlerLib.catalogKey(job.sourceUrl)].filter(Boolean);
      job.scan = {
        queue: [],
        visited: [],
        pagesRead: 0,
        done: false,
        totalHint: 0,
        ...(job.scan || {})
      };
      job.errors = Array.isArray(job.errors) ? job.errors : [];
      job.warnings = Array.isArray(job.warnings) ? job.warnings : [];
      job.counts = job.counts || { total: 0, done: 0, skipped: 0, failed: 0, expired: 0, pending: 0 };
      job.refreshCount = Number(job.refreshCount) || 0;
      return job;
    }

    // --------------------------------------------------------------- logging

    log(level, message, data) {
      const entry = { at: this.now(), level, message, data: data === undefined ? null : data };
      this.pendingLogs.push(entry);
      if (this.env.log) {
        this.env.log(level, message, data);
      }
      this.scheduleFlush();
    }

    // ------------------------------------------------------------ persistence

    markJob(job) {
      job.updatedAt = this.now();
      this.dirtyJobs.add(job.id);
      this.scheduleFlush();
    }

    markItem(item) {
      this.dirtyItems.set(item.key, item);
      this.scheduleFlush();
    }

    scheduleFlush() {
      if (this.flushTimer) {
        return;
      }
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        void this.flush();
      }, FLUSH_MS);
    }

    async flush() {
      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }
      const items = [...this.dirtyItems.values()].map(stripItem);
      this.dirtyItems.clear();
      const jobIds = [...this.dirtyJobs];
      this.dirtyJobs.clear();
      const history = this.pendingHistory.splice(0);
      const logs = this.pendingLogs.splice(0);
      try {
        if (items.length) {
          await this.store.putItems(items);
        }
        for (const id of jobIds) {
          const job = this.jobs.get(id);
          if (job) {
            job.counts = this.countsFor(job);
            await this.store.putJob(stripJob(job));
          }
        }
        if (history.length) {
          await this.store.addHistory(history);
        }
        if (logs.length) {
          await this.store.addLogs(logs);
        }
      } catch (error) {
        if (this.env.log) {
          this.env.log("error", "Không ghi được dữ liệu vào IndexedDB", errorMessage(error));
        }
      }
    }

    // --------------------------------------------------------------- runtime

    async ensureRuntime(job) {
      const existing = this.rt.get(job.id);
      if (existing) {
        return existing.loading ? existing.loading.then(() => existing) : existing;
      }
      const rt = {
        items: new Map(),
        unresolved: [],
        ready: [],
        listing: false,
        resolving: 0,
        downloading: 0,
        retryTimers: new Set(),
        usedNames: new Map(),
        historyInJob: new Map(),
        queuedKeys: new Set(),
        visitedKeys: new Set(),
        doneTimes: [],
        seqNext: 0,
        controller: new AbortController(),
        loaded: false,
        loading: null
      };
      this.rt.set(job.id, rt);
      rt.loading = (async () => {
        const items = await this.store.getItems(job.id);
        items.sort((left, right) => (left.seq || 0) - (right.seq || 0));
        const handler = this.handlers[job.site];
        for (const item of items) {
          rt.items.set(item.photoId, item);
          rt.seqNext = Math.max(rt.seqNext, (Number(item.seq) || 0) + 1);
          if (item.filename) {
            this.claimName(rt, item.filename);
          }
          if (item.status === "resolving") {
            item.status = "unresolved";
          }
          if (item.status === "downloading") {
            // Chrome may still be finishing (or have finished) this file.
            item.status = "ready";
            item.interrupted = true;
          }
          if (item.status === "unresolved") {
            rt.unresolved.push(item.photoId);
          } else if (item.status === "ready") {
            rt.ready.push(item.photoId);
          }
          if (["ready", "done"].includes(item.status) && handler) {
            rt.historyInJob.set(handler.historyKey(item), item.photoId);
          }
        }
        const pageKey = handler ? handler.pageKey : (url) => url;
        for (const url of job.scan.visited) {
          rt.visitedKeys.add(url);
        }
        for (const url of job.scan.queue) {
          rt.queuedKeys.add(pageKey(url));
        }
        rt.loaded = true;
        rt.loading = null;
      })();
      await rt.loading;
      return rt;
    }

    unloadRuntime(job) {
      const rt = this.rt.get(job.id);
      if (!rt) {
        return;
      }
      if (rt.listing || rt.resolving || rt.downloading) {
        rt.unloadWhenIdle = true;
        return;
      }
      for (const timer of rt.retryTimers) {
        clearTimeout(timer);
      }
      job.counts = this.countsFor(job);
      this.rt.delete(job.id);
    }

    claimName(rt, fullPath) {
      const parts = String(fullPath).split("/");
      const name = parts.pop();
      const folder = parts.join("/").toLocaleLowerCase();
      let set = rt.usedNames.get(folder);
      if (!set) {
        set = new Set();
        rt.usedNames.set(folder, set);
      }
      set.add(String(name).toLocaleLowerCase());
    }

    // ------------------------------------------------------------ public API

    findJobByUrl(url) {
      const key = handlerLib.catalogKey(url);
      if (!key) {
        return null;
      }
      for (const job of this.jobs.values()) {
        if (job.keys.includes(key)) {
          return job;
        }
      }
      return null;
    }

    nextOrder() {
      let max = 0;
      for (const job of this.jobs.values()) {
        max = Math.max(max, Number(job.order) || 0);
      }
      return max + 1;
    }

    async enqueue({ url, tabId = null, includeAlbum, mode = "auto" } = {}) {
      const site = handlerLib.siteForUrl(url);
      if (!site || !this.handlers[site]) {
        throw new Error("URL không được hỗ trợ: hãy mở album/ảnh ImageFap, album Xasiat hoặc thread Viper.");
      }
      const existing = this.findJobByUrl(url);
      if (existing) {
        if (tabId !== null && tabId !== undefined) {
          existing.tabId = tabId;
        }
        if (LIVE_STATUSES.has(existing.status)) {
          return { job: this.summary(existing), existed: true, message: "Album này đang có trong hàng đợi." };
        }
        const rt = await this.ensureRuntime(existing);
        const incomplete = !existing.scan.done || [...rt.items.values()].some((item) => !["done", "skipped"].includes(item.status));
        const action = mode === "auto" ? (incomplete ? "resume" : "rescan") : mode;
        if (action === "rescan") {
          this.resetScan(existing);
        }
        this.resetFailed(existing, rt);
        existing.status = "queued";
        existing.finishedAt = 0;
        existing.note = action === "rescan"
          ? "Quét lại để lấy ảnh mới; ảnh đã tải vẫn được bỏ qua."
          : "Tải tiếp từ vị trí đang dở, không quét lại.";
        this.markJob(existing);
        this.log("info", action === "rescan" ? "Quét lại job" : "Tải tiếp job", { id: existing.id, url });
        this.pump();
        return { job: this.summary(existing), existed: true, action };
      }
      const job = this.normalizeJob({
        id: "job-" + this.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7),
        site,
        sourceUrl: url,
        keys: [handlerLib.catalogKey(url)],
        title: sites.siteLabel(site),
        titleFromPage: false,
        status: "queued",
        includeAlbum: includeAlbum === undefined ? this.settings.includeAlbum : Boolean(includeAlbum),
        tabId: tabId === undefined ? null : tabId,
        createdAt: this.now(),
        startedAt: 0,
        finishedAt: 0,
        order: this.nextOrder(),
        scan: { queue: [url], visited: [], pagesRead: 0, done: false, totalHint: 0 }
      });
      this.jobs.set(job.id, job);
      this.markJob(job);
      this.log("info", "Thêm job", { id: job.id, url, site });
      this.pump();
      return { job: this.summary(job), existed: false, action: "new" };
    }

    resetScan(job) {
      job.scan = { queue: [job.sourceUrl], visited: [], pagesRead: 0, done: false, totalHint: job.scan.totalHint || 0 };
      job.refreshing = false;
      job.refreshCount = 0;
      const rt = this.rt.get(job.id);
      if (rt) {
        rt.visitedKeys.clear();
        rt.queuedKeys = new Set([this.handlers[job.site].pageKey(job.sourceUrl)]);
      }
    }

    resetFailed(job, rt) {
      const handler = this.handlers[job.site];
      let count = 0;
      for (const item of rt.items.values()) {
        if (item.status === "failed" || item.status === "expired") {
          item.attempts = 0;
          item.error = "";
          if (item.status === "expired" || (handler.needsResolve(item) && !item.imageUrl)) {
            item.imageUrl = item.status === "expired" ? item.imageUrl : "";
          }
          item.status = item.imageUrl ? "ready" : "unresolved";
          if (item.status === "ready") {
            rt.ready.push(item.photoId);
          } else {
            rt.unresolved.push(item.photoId);
          }
          this.markItem(item);
          count += 1;
        }
      }
      job.errors = [];
      return count;
    }

    async retryFailed(jobId) {
      const job = this.jobs.get(jobId);
      if (!job) {
        throw new Error("Không tìm thấy job.");
      }
      const rt = await this.ensureRuntime(job);
      const count = this.resetFailed(job, rt);
      job.refreshCount = 0;
      if (!LIVE_STATUSES.has(job.status)) {
        job.status = "queued";
        job.finishedAt = 0;
      }
      job.note = count ? `Thử lại ${count} ảnh lỗi.` : "Không có ảnh lỗi cần thử lại.";
      this.markJob(job);
      this.pump();
      return { count };
    }

    pauseJob(jobId) {
      const job = this.jobs.get(jobId);
      if (!job || !LIVE_STATUSES.has(job.status)) {
        return false;
      }
      job.status = "paused";
      job.note = "Đã tạm dừng. Ảnh đang tải dở sẽ hoàn tất, không bắt đầu ảnh mới.";
      this.markJob(job);
      this.pump();
      return true;
    }

    resumeJob(jobId) {
      const job = this.jobs.get(jobId);
      if (!job || LIVE_STATUSES.has(job.status)) {
        return false;
      }
      if (job.status === "cancelled" || job.status === "error" || job.status.startsWith("done")) {
        job.finishedAt = 0;
      }
      job.status = "queued";
      job.needsPermission = false;
      job.note = "Đang tiếp tục...";
      this.markJob(job);
      this.pump();
      return true;
    }

    async cancelJob(jobId, note = "Đã dừng. Phần đã quét được giữ lại; bấm Tiếp tục để chạy tiếp.") {
      const job = this.jobs.get(jobId);
      if (!job) {
        return false;
      }
      const wasLive = LIVE_STATUSES.has(job.status) || job.status === "paused";
      job.status = "cancelled";
      job.captcha = null;
      job.note = note;
      job.finishedAt = this.now();
      const rt = this.rt.get(job.id);
      if (rt) {
        rt.controller.abort();
        rt.controller = new AbortController();
      }
      if (wasLive && this.env.cancelDownloads) {
        await this.env.cancelDownloads(job.id);
      }
      this.markJob(job);
      this.releaseCaptchaIfUnused();
      this.pump();
      return true;
    }

    async removeJob(jobId) {
      const job = this.jobs.get(jobId);
      if (!job) {
        return false;
      }
      await this.cancelJob(jobId, "Đã xóa.");
      this.jobs.delete(jobId);
      this.dirtyJobs.delete(jobId);
      for (const [key, item] of this.dirtyItems) {
        if (item.jobId === jobId) {
          this.dirtyItems.delete(key);
        }
      }
      this.rt.delete(jobId);
      await this.store.deleteJob(jobId);
      this.emitSoon(true);
      return true;
    }

    async clearFinished() {
      const ids = [...this.jobs.values()]
        .filter((job) => job.status === "done")
        .map((job) => job.id);
      for (const id of ids) {
        await this.removeJob(id);
      }
      return ids.length;
    }

    moveJob(jobId, direction) {
      const ordered = [...this.jobs.values()].sort((a, b) => a.order - b.order);
      const index = ordered.findIndex((job) => job.id === jobId);
      const swapWith = ordered[index + (direction < 0 ? -1 : 1)];
      if (index < 0 || !swapWith) {
        return false;
      }
      const job = ordered[index];
      [job.order, swapWith.order] = [swapWith.order, job.order];
      this.markJob(job);
      this.markJob(swapWith);
      this.pump();
      return true;
    }

    async updateSettings(patch) {
      this.settings = clampSettings({ ...this.settings, ...(patch || {}) });
      await this.store.kvSet("settings", this.settings);
      this.log("info", "Cập nhật cài đặt", this.settings);
      for (const job of this.jobs.values()) {
        if (job.needsPermission && this.settings.downloadMode !== "directory") {
          job.needsPermission = false;
        }
      }
      this.pump();
      return this.settings;
    }

    async clearHistory() {
      this.history.clear();
      this.pendingHistory = [];
      await this.store.clearHistory();
      this.log("info", "Đã xóa lịch sử ảnh đã tải");
      this.emitSoon(true);
    }

    tabClosed(tabId) {
      for (const job of this.jobs.values()) {
        if (job.tabId === tabId) {
          job.tabId = null;
          this.markJob(job);
        }
      }
    }

    // ---------------------------------------------------------------- captcha

    enterCaptcha(job, error) {
      const host = error.host || hostKey(error.url);
      this.limiter.hold(host, "captcha");
      let entry = this.captchas.get(host);
      if (!entry) {
        entry = {
          host,
          url: error.url,
          kind: error.kind || "verification",
          phase: error.phase || "",
          since: this.now(),
          seenTabs: new Set(),
          tabId: null
        };
        this.captchas.set(host, entry);
        this.log("warn", "Gặp CAPTCHA", { host, url: error.url, phase: error.phase });
        if (this.settings.notify && this.env.notify) {
          this.env.notify({
            id: "captcha-" + host,
            title: "Cần xác minh CAPTCHA",
            message: `${host}: mở cửa sổ điều khiển và xác minh thủ công; extension tự tiếp tục sau đó.`
          });
        }
      }
      for (const other of this.jobs.values()) {
        if (other === job || (other.status === "running" && hostKey(other.sourceUrl) === host)) {
          if (other.status === "running" || other === job) {
            other.status = "captcha";
            other.captcha = { host, url: entry.url, kind: entry.kind, phase: entry.phase };
            this.markJob(other);
          }
        }
      }
      this.emitSoon(true);
    }

    resolveCaptcha(host, how = "manual") {
      const entry = this.captchas.get(host);
      this.captchas.delete(host);
      this.limiter.unhold(host, POST_CAPTCHA_COOLDOWN_MS);
      let resumed = 0;
      for (const job of this.jobs.values()) {
        if (job.status === "captcha" && job.captcha && job.captcha.host === host) {
          job.status = "running";
          job.captcha = null;
          job.note = "Đã xác minh; tiếp tục đúng vị trí bị gián đoạn.";
          this.markJob(job);
          resumed += 1;
        }
      }
      if (entry || resumed) {
        this.log("info", "CAPTCHA đã xử lý, tiếp tục", { host, how, resumed });
      }
      this.pump();
      return resumed > 0 || Boolean(entry);
    }

    resolveCaptchaForJob(jobId) {
      const job = this.jobs.get(jobId);
      if (job && job.captcha) {
        return this.resolveCaptcha(job.captcha.host, "manual");
      }
      return false;
    }

    captchaTabOpened(host, tabId) {
      const entry = this.captchas.get(host);
      if (entry) {
        entry.tabId = tabId;
      }
    }

    // Report from captcha-watch.js in any tab of a supported site.
    captchaTabState({ tabId, url, isVerification }) {
      const host = hostKey(url);
      const entry = this.captchas.get(host);
      if (!entry) {
        return false;
      }
      if (isVerification) {
        entry.seenTabs.add(tabId);
        return false;
      }
      // Only trust an "all clear" from a tab that showed the challenge, or from
      // the tab the user opened for it; a normal page load proves nothing.
      if (entry.seenTabs.has(tabId) || entry.tabId === tabId) {
        return this.resolveCaptcha(host, "auto");
      }
      return false;
    }

    releaseCaptchaIfUnused() {
      for (const host of [...this.captchas.keys()]) {
        const used = [...this.jobs.values()].some((job) => job.status === "captcha" && job.captcha && job.captcha.host === host);
        if (!used) {
          this.captchas.delete(host);
          this.limiter.unhold(host, 0);
        }
      }
    }

    // ---------------------------------------------------------------- network

    async fetchDocument(job, url, phase) {
      const rt = this.rt.get(job.id);
      const signal = rt ? rt.controller.signal : undefined;
      const host = hostKey(url);
      let failures = 0;
      let rateHits = 0;
      for (;;) {
        await this.limiter.acquire(host, signal);
        let response;
        try {
          response = await this.env.fetchPage(url, {
            tabId: job.tabId,
            site: job.site,
            fetchVia: this.settings.fetchVia,
            signal
          });
        } catch (error) {
          this.limiter.release(host, "error");
          if (isAbort(error) || (signal && signal.aborted)) {
            throw Object.assign(new Error("Cancelled"), { name: "AbortError" });
          }
          failures += 1;
          if (failures > this.settings.retryCount) {
            throw error;
          }
          await sleep(500 * failures);
          continue;
        }
        if (response.tabLost && job.tabId !== null) {
          job.tabId = null;
          this.markJob(job);
        }
        const finalUrl = response.url || url;
        const doc = response.text ? this.env.parseHtml(response.text, finalUrl) : null;
        if (sites.verificationKind(doc || { body: null, title: "", querySelector: () => null }, finalUrl, url)) {
          // Hold before releasing so no parked request slips out in between.
          this.limiter.hold(host, "captcha");
          this.limiter.release(host, "captcha");
          throw new CaptchaError(finalUrl, host, phase);
        }
        const status = Number(response.status) || 0;
        if (status >= 400 || !response.ok) {
          const rateLike = status === 429 || status === 503 || (status === 403 && rateHits < 2);
          if (rateLike && rateHits < MAX_RATE_RETRIES) {
            rateHits += 1;
            this.limiter.release(host, "rate", { retryAfterMs: response.retryAfterMs });
            this.log("warn", "Trang nguồn giới hạn tốc độ", { host, status, url });
            continue;
          }
          this.limiter.release(host, "error");
          failures += 1;
          if (status >= 500 && failures <= this.settings.retryCount) {
            continue;
          }
          throw Object.assign(new Error(`HTTP ${status || "lỗi"} khi đọc ${phase === "gallery" ? "trang album" : "trang ảnh"}`), { code: "HTTP_" + status, status });
        }
        this.limiter.release(host, "ok");
        return { doc, html: response.text || "", finalUrl };
      }
    }

    async probe(job, url) {
      const rt = this.rt.get(job.id);
      const host = hostKey(url);
      await this.limiter.acquire(host, rt ? rt.controller.signal : undefined);
      try {
        const ok = await this.env.probeImage(url, rt ? rt.controller.signal : undefined);
        this.limiter.release(host, "ok");
        return ok;
      } catch (error) {
        this.limiter.release(host, "error");
        if (isAbort(error)) {
          throw error;
        }
        return false;
      }
    }

    // ----------------------------------------------------------------- items

    addListedItems(job, rt, list) {
      const handler = this.handlers[job.site];
      let added = 0;
      for (const raw of list) {
        if (!raw || !raw.photoId) {
          continue;
        }
        const existing = rt.items.get(raw.photoId);
        if (existing) {
          // A refresh read brings new tokens for links that expired.
          if (raw.imageUrl && raw.imageUrl !== existing.imageUrl && ["expired", "failed", "ready", "unresolved"].includes(existing.status)) {
            const wasQueued = existing.status === "ready" || existing.status === "unresolved";
            existing.imageUrl = raw.imageUrl;
            existing.attempts = 0;
            existing.error = "";
            if (!wasQueued) {
              existing.status = "ready";
              rt.ready.push(existing.photoId);
            } else if (existing.status === "unresolved") {
              this.markReady(job, rt, existing);
            }
            this.markItem(existing);
          }
          continue;
        }
        const item = {
          key: itemKey(job.id, raw.photoId),
          jobId: job.id,
          photoId: String(raw.photoId),
          seq: rt.seqNext++,
          status: "unresolved",
          pageUrl: raw.pageUrl || "",
          imageUrl: raw.imageUrl || "",
          label: raw.label || "",
          postId: raw.postId || "",
          postTitle: raw.postTitle || "",
          folderTitle: raw.folderTitle || "",
          resolve: raw.resolve || null,
          fileName: raw.fileName || "",
          historyId: raw.historyId || "",
          filename: "",
          attempts: 0,
          error: ""
        };
        rt.items.set(item.photoId, item);
        added += 1;
        if (!handler.needsResolve(item)) {
          this.markReady(job, rt, item);
        } else if (this.canSkipBeforeResolve(job, item)) {
          item.status = "skipped";
          item.error = "Đã tải ở lần trước";
        } else {
          rt.unresolved.push(item.photoId);
        }
        this.markItem(item);
      }
      return added;
    }

    // ImageFap/Xasiat identify a photo by id before its URL is known, so a photo
    // downloaded earlier never costs a photo-page request.
    canSkipBeforeResolve(job, item) {
      if (!this.settings.skipDownloaded || job.site === "viper") {
        return false;
      }
      return this.history.has(this.handlers[job.site].historyKey(item));
    }

    markReady(job, rt, item) {
      const handler = this.handlers[job.site];
      const key = handler.historyKey(item);
      if (this.settings.skipDownloaded && this.history.has(key)) {
        item.status = "skipped";
        item.error = "Đã tải ở lần trước";
      } else if (rt.historyInJob.has(key) && rt.historyInJob.get(key) !== item.photoId) {
        item.status = "skipped";
        item.error = "Trùng ảnh trong cùng album";
      } else {
        rt.historyInJob.set(key, item.photoId);
        item.status = "ready";
        rt.ready.push(item.photoId);
      }
      this.markItem(item);
    }

    failItem(job, rt, item, message) {
      item.status = "failed";
      item.error = message;
      this.markItem(item);
      this.pushJobError(job, { photoId: item.photoId, pageUrl: item.pageUrl, message });
    }

    pushJobError(job, error) {
      job.errors.push({ ...error, at: this.now() });
      if (job.errors.length > MAX_JOB_ERRORS) {
        job.errors.splice(0, job.errors.length - MAX_JOB_ERRORS);
      }
      this.markJob(job);
    }

    scheduleRetry(job, rt, photoId, queue, delayMs) {
      const timer = setTimeout(() => {
        rt.retryTimers.delete(timer);
        rt[queue].push(photoId);
        this.pump();
      }, delayMs);
      rt.retryTimers.add(timer);
    }

    // --------------------------------------------------------------- stages

    async listNext(job, rt) {
      const handler = this.handlers[job.site];
      const url = job.scan.queue.shift();
      const key = handler.pageKey(url);
      rt.queuedKeys.delete(key);
      if (rt.visitedKeys.has(key)) {
        return;
      }
      if (job.scan.pagesRead >= MAX_PAGES) {
        this.pushJobError(job, { pageUrl: url, message: `Album có quá ${MAX_PAGES} trang, đã dừng quét để tránh quét nhầm.` });
        job.scan.queue = [];
        rt.queuedKeys.clear();
        return;
      }
      rt.visitedKeys.add(key);
      job.scan.visited.push(key);
      let page;
      try {
        page = await this.fetchDocument(job, url, "gallery");
      } catch (error) {
        rt.visitedKeys.delete(key);
        job.scan.visited = job.scan.visited.filter((value) => value !== key);
        if (error instanceof CaptchaError) {
          job.scan.queue.unshift(url);
          rt.queuedKeys.add(key);
          this.enterCaptcha(job, error);
          return;
        }
        if (isAbort(error)) {
          job.scan.queue.unshift(url);
          rt.queuedKeys.add(key);
          return;
        }
        this.pushJobError(job, { pageUrl: url, message: errorMessage(error) });
        this.log("error", "Lỗi đọc trang album", { url, error: errorMessage(error) });
        if (job.scan.pagesRead === 0 && !rt.items.size) {
          job.fatal = errorMessage(error);
        }
        this.markJob(job);
        return;
      }
      let result;
      try {
        result = handler.listPage({ doc: page.doc, html: page.html, finalUrl: page.finalUrl, pageUrl: url, job });
      } catch (error) {
        this.pushJobError(job, { pageUrl: url, message: "Không phân tích được trang: " + errorMessage(error) });
        return;
      }
      job.scan.pagesRead += 1;
      if (result.title && (!job.titleFromPage || job.scan.pagesRead === 1)) {
        job.title = result.title;
        job.titleFromPage = true;
      }
      if (result.canonicalUrl) {
        const canonicalKey = handlerLib.catalogKey(result.canonicalUrl);
        if (canonicalKey && !job.keys.includes(canonicalKey)) {
          job.keys.push(canonicalKey);
        }
      }
      const added = this.addListedItems(job, rt, result.items || []);
      for (const next of result.pageUrls || []) {
        const nextKey = handler.pageKey(next);
        if (!nextKey || rt.visitedKeys.has(nextKey) || rt.queuedKeys.has(nextKey)) {
          continue;
        }
        rt.queuedKeys.add(nextKey);
        job.scan.queue.push(next);
      }
      job.scan.totalHint = Math.max(Number(job.scan.totalHint) || 0, Number(result.totalHint) || 0);
      this.log("debug", "Đã đọc trang", { job: job.id, url, added, queue: job.scan.queue.length });
      this.markJob(job);
    }

    async resolveNext(job, rt, item) {
      const handler = this.handlers[job.site];
      try {
        const resolved = await handler.resolve(item, {
          fetchPage: (url) => this.fetchDocument(job, url, "photo"),
          probeImage: (url) => this.probe(job, url)
        });
        item.imageUrl = resolved.imageUrl;
        if (resolved.fileName) {
          item.fileName = resolved.fileName;
        }
        if (resolved.historyId) {
          item.historyId = resolved.historyId;
        }
        item.attempts = 0;
        item.error = "";
        this.markReady(job, rt, item);
        for (const extra of resolved.harvested || []) {
          const other = rt.items.get(String(extra.photoId));
          if (other && other.status === "unresolved" && !other.imageUrl) {
            other.imageUrl = extra.imageUrl;
            this.markReady(job, rt, other);
            rt.harvested = (rt.harvested || 0) + 1;
          }
        }
      } catch (error) {
        if (error instanceof CaptchaError) {
          item.status = "unresolved";
          rt.unresolved.unshift(item.photoId);
          this.markItem(item);
          this.enterCaptcha(job, error);
          return;
        }
        if (isAbort(error)) {
          item.status = "unresolved";
          rt.unresolved.unshift(item.photoId);
          this.markItem(item);
          return;
        }
        if (error && error.code === "EXPIRED") {
          item.status = "expired";
          item.error = errorMessage(error);
          this.markItem(item);
          return;
        }
        this.failItem(job, rt, item, errorMessage(error));
      }
    }

    downloadTarget(job, rt, item) {
      const handler = this.handlers[job.site];
      const config = sites.SITE_CONFIG[job.site];
      const extension = paths.fileExtension(item.imageUrl);
      const requested = paths.safePathPart(item.fileName || handler.fileName(item), String(item.seq + 1).padStart(3, "0") + extension);
      const name = /\.[a-z0-9]{2,5}$/i.test(requested) ? requested : requested + extension;
      const folder = job.site === "viper"
        ? paths.safePathPart(item.folderTitle || job.title, config.fallbackTitle, 180)
        : config.folder + "/" + paths.safePathPart(job.title, config.fallbackTitle);
      const root = this.settings.downloadMode === "downloads" ? paths.safeDownloadRoot(this.settings.downloadSubdir) : "";
      const folderPath = [root, folder].filter(Boolean).join("/");
      let used = rt.usedNames.get(folderPath.toLocaleLowerCase());
      if (!used) {
        used = new Set();
        rt.usedNames.set(folderPath.toLocaleLowerCase(), used);
      }
      const unique = paths.uniqueFileName(name, used);
      return paths.fitPath([root, folder, unique]);
    }

    async downloadNext(job, rt, item) {
      const handler = this.handlers[job.site];
      if (!item.filename) {
        item.filename = this.downloadTarget(job, rt, item);
      }
      const dlKey = "dl:" + hostKey(item.imageUrl);
      const signal = rt.controller.signal;
      let result;
      try {
        await this.limiter.acquire(dlKey, signal);
      } catch (error) {
        item.status = "ready";
        rt.ready.unshift(item.photoId);
        this.markItem(item);
        return;
      }
      try {
        result = await this.env.download({
          jobId: job.id,
          photoId: item.photoId,
          url: item.imageUrl,
          filename: item.filename,
          referrer: item.pageUrl,
          mode: this.settings.downloadMode,
          erase: this.settings.eraseDownloadHistory,
          // A download started before the engine restarted is adopted, not duplicated.
          resumeId: Number.isInteger(item.downloadId) ? item.downloadId : null,
          adoptByUrl: Boolean(item.interrupted),
          onStarted: (id) => {
            item.downloadId = id;
            this.markItem(item);
          }
        }, signal);
      } catch (error) {
        result = { ok: false, reason: isAbort(error) ? "cancelled" : "exception", message: errorMessage(error) };
      }
      item.downloadId = null;
      item.interrupted = false;
      if (result.ok) {
        this.limiter.release(dlKey, "ok");
        item.status = "done";
        item.error = result.existed ? "Đã có sẵn trong thư mục" : "";
        item.attempts = 0;
        this.markItem(item);
        const historyKey = handler.historyKey(item);
        this.history.add(historyKey);
        this.pendingHistory.push({ key: historyKey, at: this.now(), jobId: job.id, filename: item.filename });
        rt.doneTimes.push(this.now());
        return;
      }
      if (result.reason === "cancelled" || signal.aborted) {
        this.limiter.release(dlKey, "error");
        item.status = "ready";
        rt.ready.unshift(item.photoId);
        this.markItem(item);
        return;
      }
      if (result.reason === "NEEDS_PERMISSION" || result.reason === "NO_DIRECTORY") {
        this.limiter.release(dlKey, "error");
        item.status = "ready";
        rt.ready.unshift(item.photoId);
        this.markItem(item);
        if (job.status === "running") {
          job.status = "paused";
          job.needsPermission = true;
          job.note = result.message || "Cần cấp lại quyền ghi vào thư mục đã chọn.";
          this.markJob(job);
        }
        return;
      }
      if (handler.isExpiredDownload(result)) {
        this.limiter.release(dlKey, "ok");
        item.status = "expired";
        item.error = "Link ảnh hết hạn";
        this.markItem(item);
        return;
      }
      const status = Number(result.status) || 0;
      const rate = status === 429 || status === 503 || result.reason === "rate";
      item.attempts = (Number(item.attempts) || 0) + 1;
      if (rate) {
        this.limiter.release(dlKey, "rate", { retryAfterMs: result.retryAfterMs });
        if (item.attempts <= MAX_RATE_RETRIES) {
          item.status = "ready";
          rt.ready.unshift(item.photoId);
          this.markItem(item);
          return;
        }
      } else {
        this.limiter.release(dlKey, "error");
      }
      const message = result.message || result.reason || "Không tải được ảnh";
      if (!rate && item.attempts <= this.settings.retryCount && result.retryable !== false) {
        item.status = "ready";
        item.error = message;
        this.markItem(item);
        this.scheduleRetry(job, rt, item.photoId, "ready", 1000 * item.attempts);
        return;
      }
      this.failItem(job, rt, item, message);
    }

    // ------------------------------------------------------------- scheduler

    pump() {
      if (this.pumpQueued) {
        return;
      }
      this.pumpQueued = true;
      Promise.resolve().then(() => {
        this.pumpQueued = false;
        this.pumpNow();
      });
    }

    orderedJobs() {
      return [...this.jobs.values()].sort((left, right) => (left.order || 0) - (right.order || 0));
    }

    pumpNow() {
      if (!this.ready) {
        return;
      }
      const ordered = this.orderedJobs();
      let active = ordered.filter((job) => job.status === "running" || job.status === "captcha").length;
      for (const job of ordered) {
        if (active >= this.settings.maxActiveJobs) {
          break;
        }
        if (job.status === "queued") {
          job.status = "running";
          job.startedAt = job.startedAt || this.now();
          job.fatal = "";
          this.markJob(job);
          active += 1;
        }
      }

      for (const job of ordered) {
        if (job.status !== "running") {
          continue;
        }
        const rt = this.rt.get(job.id);
        if (!rt) {
          void this.ensureRuntime(job).then(() => this.pump());
          continue;
        }
        if (!rt.loaded) {
          continue;
        }
        this.launchListing(job, rt);
        this.launchResolvers(job, rt);
      }
      this.launchDownloads(ordered);

      for (const job of ordered) {
        const rt = this.rt.get(job.id);
        if (job.status === "running" && rt && rt.loaded) {
          this.checkFinished(job, rt);
        } else if (rt && rt.unloadWhenIdle && !rt.listing && !rt.resolving && !rt.downloading) {
          this.unloadRuntime(job);
        }
      }
      this.updateActive();
      this.emitSoon();
    }

    launchListing(job, rt) {
      if (rt.listing || job.scan.done) {
        return;
      }
      if (!job.scan.queue.length) {
        job.scan.done = true;
        this.onListingDone(job, rt);
        return;
      }
      rt.listing = true;
      void this.listNext(job, rt)
        .catch((error) => this.log("error", "Lỗi quét", errorMessage(error)))
        .finally(() => {
          rt.listing = false;
          this.pump();
        });
    }

    launchResolvers(job, rt) {
      while (rt.resolving < this.settings.scanConcurrency && rt.unresolved.length) {
        const photoId = rt.unresolved.shift();
        const item = rt.items.get(photoId);
        if (!item || item.status !== "unresolved") {
          continue;
        }
        if (this.canSkipBeforeResolve(job, item)) {
          item.status = "skipped";
          item.error = "Đã tải ở lần trước";
          this.markItem(item);
          continue;
        }
        item.status = "resolving";
        rt.resolving += 1;
        void this.resolveNext(job, rt, item)
          .catch((error) => this.log("error", "Lỗi resolve", errorMessage(error)))
          .finally(() => {
            rt.resolving -= 1;
            this.pump();
          });
      }
    }

    launchDownloads(ordered) {
      const candidates = ordered.filter((job) => job.status === "running" && this.rt.get(job.id) && this.rt.get(job.id).loaded);
      if (!candidates.length) {
        return;
      }
      let idle = 0;
      while (this.dlActive < this.settings.downloadConcurrency && idle < candidates.length) {
        const job = candidates[this.rr % candidates.length];
        this.rr += 1;
        const rt = this.rt.get(job.id);
        const item = this.takeReady(rt);
        if (!item) {
          idle += 1;
          continue;
        }
        idle = 0;
        item.status = "downloading";
        this.markItem(item);
        rt.downloading += 1;
        this.dlActive += 1;
        void this.downloadNext(job, rt, item)
          .catch((error) => this.log("error", "Lỗi tải", errorMessage(error)))
          .finally(() => {
            rt.downloading -= 1;
            this.dlActive -= 1;
            this.pump();
          });
      }
    }

    takeReady(rt) {
      while (rt.ready.length) {
        const item = rt.items.get(rt.ready.shift());
        if (item && item.status === "ready") {
          return item;
        }
      }
      return null;
    }

    onListingDone(job, rt) {
      const expired = [...rt.items.values()].filter((item) => item.status === "expired");
      if (job.refreshing) {
        job.refreshing = false;
        for (const item of expired) {
          this.failItem(job, rt, item, "Link ảnh hết hạn và không lấy lại được khi đọc lại album");
        }
      }
      job.warnings = this.nameWarnings(job, rt);
      this.log("info", "Quét xong", { job: job.id, items: rt.items.size, pages: job.scan.pagesRead });
      this.markJob(job);
    }

    startRefresh(job, rt) {
      job.refreshing = true;
      job.refreshCount += 1;
      job.scan.queue = [job.sourceUrl];
      job.scan.visited = [];
      job.scan.done = false;
      job.scan.pagesRead = 0;
      rt.visitedKeys.clear();
      rt.queuedKeys = new Set([this.handlers[job.site].pageKey(job.sourceUrl)]);
      job.note = "Một số link ảnh đã hết hạn; đang đọc lại album để lấy link mới...";
      this.log("info", "Đọc lại album để làm mới link hết hạn", { job: job.id, attempt: job.refreshCount });
      this.markJob(job);
    }

    checkFinished(job, rt) {
      if (rt.listing || rt.resolving || rt.downloading || rt.retryTimers.size) {
        return;
      }
      if (!job.scan.done || job.scan.queue.length) {
        return;
      }
      const pending = [...rt.items.values()].some((item) => ["unresolved", "resolving", "ready", "downloading"].includes(item.status));
      if (pending) {
        // Queues can only be empty with pending items after a reload glitch; re-seed them.
        for (const item of rt.items.values()) {
          if (item.status === "unresolved") {
            rt.unresolved.push(item.photoId);
          } else if (item.status === "ready") {
            rt.ready.push(item.photoId);
          }
        }
        if (rt.unresolved.length || rt.ready.length) {
          this.pump();
          return;
        }
      }
      const expired = [...rt.items.values()].filter((item) => item.status === "expired");
      if (expired.length && job.refreshCount < MAX_REFRESH) {
        this.startRefresh(job, rt);
        this.pump();
        return;
      }
      for (const item of expired) {
        this.failItem(job, rt, item, "Link ảnh hết hạn");
      }
      const counts = this.countsFor(job);
      if (!rt.items.size) {
        job.status = "error";
        job.note = job.fatal || (job.errors.length ? job.errors[job.errors.length - 1].message : "Không tìm thấy URL ảnh full-size nào.");
      } else {
        job.status = counts.failed ? "done-with-errors" : "done";
        job.note = counts.failed
          ? `Xong: ${counts.done} ảnh${counts.skipped ? `, ${counts.skipped} bỏ qua` : ""}, ${counts.failed} lỗi.`
          : `Xong: ${counts.done} ảnh${counts.skipped ? ` (${counts.skipped} bỏ qua vì đã tải trước đó)` : ""}.`;
      }
      job.finishedAt = this.now();
      this.markJob(job);
      this.log("info", "Job kết thúc", { job: job.id, status: job.status, counts });
      if (this.settings.notify && this.env.notify) {
        this.env.notify({
          id: "job-" + job.id,
          title: job.status === "done" ? "Tải xong" : job.status === "error" ? "Không tải được" : "Tải xong (có lỗi)",
          message: `${job.title}: ${job.note}`
        });
      }
      void this.flush();
      this.unloadRuntime(job);
    }

    nameWarnings(job, rt) {
      const warnings = [];
      if (job.site === "viper") {
        const groups = new Map();
        for (const item of rt.items.values()) {
          const folder = paths.safePathPart(item.folderTitle || job.title, "Viper", 180);
          const key = folder.toLocaleLowerCase();
          const group = groups.get(key) || { folder, posts: new Set() };
          if (item.postId) {
            group.posts.add(item.postId);
          }
          groups.set(key, group);
        }
        for (const group of groups.values()) {
          if (group.posts.size > 1) {
            warnings.push(`Tên bài post "${group.folder}" trùng ở ${group.posts.size} post khác nhau; ảnh dùng chung một thư mục.`);
          }
        }
        return warnings.slice(0, 10);
      }
      const title = paths.safePathPart(job.title, job.site).toLocaleLowerCase();
      for (const other of this.jobs.values()) {
        if (other.id !== job.id && other.site === job.site && paths.safePathPart(other.title, other.site).toLocaleLowerCase() === title) {
          warnings.push(`Tiêu đề "${job.title}" trùng với một album khác trong danh sách; hai album sẽ dùng chung thư mục.`);
          break;
        }
      }
      return warnings;
    }

    updateActive() {
      const active = [...this.jobs.values()].some((job) => LIVE_STATUSES.has(job.status));
      if (active !== this.lastActive) {
        this.lastActive = active;
        if (this.env.setActive) {
          this.env.setActive(active);
        }
      }
    }

    // ------------------------------------------------------------- reporting

    countsFor(job) {
      const rt = this.rt.get(job.id);
      if (!rt || !rt.loaded) {
        return { ...job.counts };
      }
      const counts = { total: rt.items.size, done: 0, skipped: 0, failed: 0, expired: 0, pending: 0, resolved: 0 };
      for (const item of rt.items.values()) {
        if (item.status === "done") {
          counts.done += 1;
        } else if (item.status === "skipped") {
          counts.skipped += 1;
        } else if (item.status === "failed") {
          counts.failed += 1;
        } else if (item.status === "expired") {
          counts.expired += 1;
        } else {
          counts.pending += 1;
        }
        if (item.imageUrl) {
          counts.resolved += 1;
        }
      }
      return counts;
    }

    statusLine(job, counts) {
      if (job.status === "captcha") {
        const where = job.captcha && job.captcha.phase === "photo" ? " khi mở trang ảnh"
          : job.captcha && job.captcha.phase === "gallery" ? " khi đọc trang album" : "";
        return `Cần xác minh CAPTCHA${where}. Mở trang xác minh và làm thủ công; extension tự tiếp tục, không quét lại từ đầu.`;
      }
      if (job.status === "running") {
        const host = hostKey(job.sourceUrl);
        const blockedFor = this.limiter.blockedUntil(host) - this.now();
        const parts = [];
        if (!job.scan.done) {
          parts.push(`${job.refreshing ? "Đọc lại" : "Quét"} trang ${job.scan.pagesRead + 1}${job.scan.queue.length > 1 ? ` (còn ${job.scan.queue.length})` : ""}`);
        }
        parts.push(`${counts.done + counts.skipped}/${Math.max(counts.total, job.scan.totalHint || 0)} ảnh`);
        if (blockedFor > 1500) {
          parts.push(`trang nguồn giới hạn tốc độ, tự thử lại sau ${Math.ceil(blockedFor / 1000)}s`);
        }
        return parts.join(" · ");
      }
      if (job.status === "queued") {
        return job.note || "Đang chờ tới lượt trong hàng đợi.";
      }
      return job.note || "";
    }

    summary(job) {
      const counts = this.countsFor(job);
      const rt = this.rt.get(job.id);
      const total = Math.max(counts.total, job.scan.done ? 0 : Number(job.scan.totalHint) || 0);
      const processed = counts.done + counts.skipped + counts.failed;
      let ratePerMin = 0;
      let etaSec = 0;
      if (rt) {
        const cutoff = this.now() - RATE_WINDOW_MS;
        rt.doneTimes = rt.doneTimes.filter((at) => at >= cutoff);
        const window = Math.min(RATE_WINDOW_MS, Math.max(1000, this.now() - (job.startedAt || this.now())));
        ratePerMin = Math.round((rt.doneTimes.length / window) * 60000);
        const remaining = Math.max(0, total - processed);
        etaSec = ratePerMin > 0 && remaining ? Math.round((remaining / ratePerMin) * 60) : 0;
      }
      return {
        id: job.id,
        site: job.site,
        title: job.title,
        sourceUrl: job.sourceUrl,
        keys: job.keys.slice(),
        status: job.status,
        message: this.statusLine(job, counts),
        note: job.note || "",
        captcha: job.captcha || null,
        needsPermission: Boolean(job.needsPermission),
        counts: { ...counts, total },
        percent: total ? Math.min(100, Math.round((processed / total) * 100)) : 0,
        ratePerMin,
        etaSec,
        scan: { pagesRead: job.scan.pagesRead, done: job.scan.done, queued: job.scan.queue.length, refreshing: Boolean(job.refreshing) },
        includeAlbum: Boolean(job.includeAlbum),
        viaTab: job.tabId !== null && job.tabId !== undefined && this.settings.fetchVia === "auto",
        createdAt: job.createdAt,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        order: job.order,
        warnings: job.warnings.slice(0, 10),
        errors: job.errors.slice(-5)
      };
    }

    state() {
      return {
        ready: this.ready,
        settings: { ...this.settings },
        jobs: this.orderedJobs().map((job) => this.summary(job)),
        hosts: this.limiter.snapshot().filter((host) => host.inFlight || host.held || host.blockedUntil > this.now() || host.limit),
        captchas: [...this.captchas.values()].map((entry) => ({ host: entry.host, url: entry.url, kind: entry.kind, since: entry.since })),
        activeDownloads: this.dlActive,
        historyCount: this.history.size
      };
    }

    emitSoon(immediate = false) {
      if (!this.env.emit) {
        return;
      }
      if (immediate) {
        clearTimeout(this.emitTimer);
        this.emitTimer = null;
        this.env.emit(this.state());
        return;
      }
      if (this.emitTimer) {
        return;
      }
      this.emitTimer = setTimeout(() => {
        this.emitTimer = null;
        this.env.emit(this.state());
      }, EMIT_MS);
    }

    async jobItems(jobId, status) {
      const job = this.jobs.get(jobId);
      if (!job) {
        return [];
      }
      const rt = this.rt.get(jobId);
      const items = rt && rt.loaded ? [...rt.items.values()] : await this.store.getItems(jobId);
      return items
        .filter((item) => !status || item.status === status)
        .sort((left, right) => left.seq - right.seq)
        .slice(0, 500)
        .map((item) => ({ photoId: item.photoId, status: item.status, error: item.error, pageUrl: item.pageUrl, imageUrl: item.imageUrl, filename: item.filename }));
    }

    // -------------------------------------------------------- import / export

    async exportData() {
      await this.flush();
      const jobs = [];
      for (const job of this.orderedJobs()) {
        const rt = this.rt.get(job.id);
        const items = rt && rt.loaded ? [...rt.items.values()].map(stripItem) : await this.store.getItems(job.id);
        jobs.push({ job: stripJob(job), items });
      }
      return { version: 2, exportedAt: this.now(), jobs };
    }

    // Accepts the 0.5.x catalog format ({version:1, catalogs}) and 0.6+ ({version:2, jobs}).
    async importData(data) {
      const entries = [];
      if (data && Array.isArray(data.jobs)) {
        for (const entry of data.jobs) {
          if (entry && entry.job && entry.job.sourceUrl && Array.isArray(entry.items)) {
            entries.push({ sourceUrl: entry.job.sourceUrl, title: entry.job.title, includeAlbum: entry.job.includeAlbum, items: entry.items });
          }
        }
      }
      const catalogs = Array.isArray(data) ? data : data && Array.isArray(data.catalogs) ? data.catalogs : [];
      for (const catalog of catalogs) {
        if (catalog && catalog.sourceUrl && Array.isArray(catalog.items)) {
          entries.push({ sourceUrl: catalog.sourceUrl, title: catalog.albumTitle, includeAlbum: true, items: catalog.items, legacy: true });
        }
      }
      let jobsTouched = 0;
      let itemsAdded = 0;
      for (const entry of entries) {
        const site = handlerLib.siteForUrl(entry.sourceUrl);
        if (!site) {
          continue;
        }
        let job = this.findJobByUrl(entry.sourceUrl);
        if (!job) {
          job = this.normalizeJob({
            id: "job-" + this.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7),
            site,
            sourceUrl: entry.sourceUrl,
            keys: [handlerLib.catalogKey(entry.sourceUrl)],
            title: entry.title || sites.siteLabel(site),
            titleFromPage: Boolean(entry.title),
            status: "paused",
            note: "Nhập từ catalog. Bấm Tiếp tục để tải phần còn lại, hoặc Quét lại để cập nhật.",
            includeAlbum: entry.includeAlbum !== false,
            tabId: null,
            createdAt: this.now(),
            startedAt: 0,
            finishedAt: 0,
            order: this.nextOrder(),
            scan: { queue: [], visited: [], pagesRead: 0, done: true, totalHint: 0 }
          });
          this.jobs.set(job.id, job);
        }
        const rt = await this.ensureRuntime(job);
        for (const raw of entry.items) {
          if (!raw || raw.photoId === undefined || raw.photoId === null) {
            continue;
          }
          const photoId = String(raw.photoId);
          if (rt.items.has(photoId)) {
            continue;
          }
          // Only keep image URLs that belong to a host this extension may touch.
          const imageUrl = safeImportUrl(raw.imageUrl);
          const item = {
            key: itemKey(job.id, photoId),
            jobId: job.id,
            photoId,
            seq: Number.isFinite(Number(raw.seq)) ? Number(raw.seq) : rt.seqNext,
            status: "unresolved",
            pageUrl: String(raw.pageUrl || ""),
            imageUrl,
            label: String(raw.label || ""),
            postId: String(raw.postId || ""),
            postTitle: String(raw.postTitle || ""),
            folderTitle: String(raw.folderTitle || ""),
            resolve: raw.resolve || null,
            fileName: String(raw.fileName || ""),
            historyId: String(raw.historyId || (entry.legacy && site === "viper" ? photoId : "")),
            filename: "",
            attempts: 0,
            error: ""
          };
          rt.seqNext = Math.max(rt.seqNext, item.seq + 1);
          rt.items.set(photoId, item);
          const handler = this.handlers[site];
          if (item.imageUrl || !handler.needsResolve(item)) {
            const key = handler.historyKey(item);
            if (this.history.has(key)) {
              item.status = "done";
            } else {
              item.status = "ready";
              rt.ready.push(photoId);
            }
          } else if (item.pageUrl || item.resolve) {
            rt.unresolved.push(photoId);
          } else {
            item.status = "failed";
            item.error = "Catalog thiếu URL ảnh";
          }
          this.markItem(item);
          itemsAdded += 1;
        }
        this.markJob(job);
        jobsTouched += 1;
      }
      await this.flush();
      for (const job of this.jobs.values()) {
        if (!LIVE_STATUSES.has(job.status)) {
          this.unloadRuntime(job);
        }
      }
      this.emitSoon(true);
      return { jobs: jobsTouched, items: itemsAdded };
    }

    async importHistory(keys) {
      const entries = [];
      for (const raw of keys || []) {
        if (typeof raw !== "string" || !raw) {
          continue;
        }
        // 0.3.x stored bare ImageFap ids.
        const key = /^\d+$/.test(raw) ? "imagefap:" + raw : raw;
        if (!this.history.has(key)) {
          this.history.add(key);
          entries.push({ key, at: this.now(), jobId: "", filename: "" });
        }
      }
      if (entries.length) {
        await this.store.addHistory(entries);
      }
      return entries.length;
    }
  }

  function safeImportUrl(value) {
    try {
      const url = new URL(String(value || ""));
      return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
    } catch {
      return "";
    }
  }

  function stripItem(item) {
    return { ...item };
  }

  function stripJob(job) {
    const copy = { ...job };
    delete copy.fatal;
    return copy;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  globalObject.MaxDownloaderEngine = Object.freeze({
    Engine,
    CaptchaError,
    DEFAULT_SETTINGS,
    clampSettings,
    hostKey
  });
})(globalThis);
