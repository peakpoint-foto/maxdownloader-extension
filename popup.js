"use strict";

// Control panel (side panel, or a popup window where sidePanel is missing).
// Pure view: all state lives in the engine; this page renders its pushes and
// sends commands. Titles come from third-party pages, so the DOM is built with
// textContent only.
(() => {
  const SCOPE = "maxdl";
  const sites = globalThis.MaxDownloaderSites;
  const handlers = globalThis.MaxDownloaderHandlers;
  const { IdbStore } = globalThis.MaxDownloaderStore;
  const store = new IdbStore();
  const isWindowMode = new URLSearchParams(location.search).has("window");
  const $ = (id) => document.getElementById(id);

  const ICON = {
    tune: "M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z",
    back: "M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z",
    pause: "M6 19h4V5H6v14zm8-14v14h4V5h-4z",
    play: "M8 5v14l11-7z",
    stop: "M6 6h12v12H6z",
    refresh: "M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z",
    open: "M19 19H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z",
    folder: "M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z",
    del: "M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z",
    list: "M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z",
    up: "M7 14l5-5 5 5z",
    down: "M7 10l5 5 5-5z",
    key: "M12.65 10A5.99 5.99 0 0 0 7 6c-3.31 0-6 2.69-6 6s2.69 6 6 6a5.99 5.99 0 0 0 5.65-4H17v4h4v-4h2v-4H12.65zM7 14c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z"
  };

  // [label, tone, sort priority]
  const STATUS = {
    captcha: ["Cần xác minh", "warn", 0],
    error: ["Lỗi", "bad", 1],
    "done-with-errors": ["Có lỗi", "bad", 1],
    running: ["Đang tải", "accent", 2],
    queued: ["Chờ", "muted", 3],
    paused: ["Tạm dừng", "muted", 4],
    cancelled: ["Đã dừng", "muted", 5],
    done: ["Hoàn tất", "ok", 6]
  };
  const LIVE = new Set(["queued", "running", "captcha"]);
  const PRESETS = {
    safe: { label: "Mặc định · 2 luồng · giãn 750 ms · ít bị chặn", patch: { scanConcurrency: 2, downloadConcurrency: 2, delayMs: 750, downloadDelayMs: 500 } },
    bal: { label: "3 luồng quét, 4 luồng tải · giãn 300 ms · cân bằng", patch: { scanConcurrency: 3, downloadConcurrency: 4, delayMs: 300, downloadDelayMs: 250 } },
    fast: { label: "6 luồng · không giãn · dễ gặp CAPTCHA / 429", patch: { scanConcurrency: 6, downloadConcurrency: 6, delayMs: 0, downloadDelayMs: 0 } }
  };
  const UNDO_MS = 4500;

  let state = null;
  let currentTab = null;
  let filter = "all";
  let view = "main";
  let includeAlbum = true;
  let renderQueued = false;
  let openJob = null;
  const failedLists = new Map();
  const hidden = new Set(); // job ids pending a delayed remove (undo window)
  let toastTimer = null;
  let settingsDirtyAt = 0;

  // -------------------------------------------------------------- messaging

  function engine(type, payload = {}) {
    return chrome.runtime.sendMessage({ scope: SCOPE, target: "engine", type, ...payload });
  }

  function bg(type, payload = {}) {
    return chrome.runtime.sendMessage({ scope: SCOPE, target: "bg", type, ...payload });
  }

  async function command(type, payload, okText) {
    try {
      const result = await engine(type, payload);
      if (result && result.error) {
        throw new Error(result.message);
      }
      if (okText) {
        toast(typeof okText === "function" ? okText(result) : okText);
      }
      return result;
    } catch (error) {
      toast("Lỗi: " + (error instanceof Error ? error.message : String(error)));
      return null;
    }
  }

  function toast(text, undo) {
    $("toast-text").textContent = text;
    $("toast-undo").hidden = !undo;
    $("toast-undo").onclick = undo ? () => { undo(); $("toast").hidden = true; } : null;
    $("toast").hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { $("toast").hidden = true; }, undo ? UNDO_MS : 3500);
  }

  // Hide locally, commit after the undo window unless the user undoes.
  // Pending commits run right away if the panel closes inside the undo window.
  const pendingCommits = new Set();
  window.addEventListener("pagehide", () => {
    for (const run of [...pendingCommits]) {
      run();
    }
  });

  function deferred(ids, text, commit) {
    ids.forEach((id) => hidden.add(id));
    let settled = false;
    const run = () => {
      if (settled) {
        return;
      }
      settled = true;
      pendingCommits.delete(run);
      void Promise.resolve(commit()).finally(() => ids.forEach((id) => hidden.delete(id)));
    };
    pendingCommits.add(run);
    scheduleRender();
    toast(text, () => {
      settled = true;
      pendingCommits.delete(run);
      ids.forEach((id) => hidden.delete(id));
      scheduleRender();
    });
    setTimeout(run, UNDO_MS);
  }

  // ---------------------------------------------------------------- helpers

  function h(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) {
        continue;
      }
      if (key === "class") {
        node.className = value;
      } else if (key === "text") {
        node.textContent = value;
      } else if (key.startsWith("on")) {
        node.addEventListener(key.slice(2), value);
      } else if (key === "style") {
        node.setAttribute("style", value);
      } else {
        node.setAttribute(key, value === true ? "" : String(value));
      }
    }
    for (const child of [].concat(children)) {
      if (child !== null && child !== undefined && child !== false) {
        node.append(child instanceof Node ? child : document.createTextNode(String(child)));
      }
    }
    return node;
  }

  function icon(name) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", ICON[name]);
    svg.append(path);
    return svg;
  }

  function iconBtn(name, title, onclick) {
    return h("button", { class: "icon-btn", title, "aria-label": title, onclick }, [icon(name)]);
  }

  function chipBtn(name, text, onclick, danger) {
    return h("button", { class: "outline small-btn" + (danger ? " danger" : ""), onclick }, [icon(name), text]);
  }

  function confirmBtn(button, idleText, onConfirm) {
    button.addEventListener("click", () => {
      if (!button.classList.contains("confirm")) {
        button.classList.add("confirm");
        button.lastChild.textContent = "Bấm lần nữa để xác nhận";
        setTimeout(() => {
          button.classList.remove("confirm");
          button.lastChild.textContent = idleText;
        }, 4000);
        return;
      }
      button.classList.remove("confirm");
      button.lastChild.textContent = idleText;
      onConfirm();
    });
    return button;
  }

  function duration(seconds) {
    if (!seconds) {
      return "";
    }
    if (seconds < 60) {
      return seconds + " giây";
    }
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) {
      return minutes + " phút";
    }
    return Math.floor(minutes / 60) + " giờ " + (minutes % 60) + " phút";
  }

  function downloadJson(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 1)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = h("a", { href: url, download: filename });
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function stamp() {
    return new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  }

  function openFolder() {
    try {
      chrome.downloads.showDefaultFolder();
    } catch {
      toast("Không mở được thư mục tải.");
    }
  }

  function visibleJobs() {
    return state ? state.jobs.filter((job) => !hidden.has(job.id)) : [];
  }

  function isScanning(job) {
    return job.status === "running" && job.scan && !job.scan.done;
  }

  function isProblem(job) {
    return ["error", "done-with-errors", "captcha"].includes(job.status) || job.counts.failed > 0 || job.needsPermission;
  }

  function statusOf(job) {
    if (job.needsPermission) {
      return ["Cần cấp quyền", "warn", 0];
    }
    if (isScanning(job)) {
      return ["Đang quét", "accent", 2];
    }
    return STATUS[job.status] || [job.status, "muted", 5];
  }

  // ------------------------------------------------------------ current tab

  async function readCurrentTab() {
    try {
      if (isWindowMode) {
        const win = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
        const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
        return tab || null;
      }
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return tab || null;
    } catch {
      return null;
    }
  }

  async function refreshCurrentTab() {
    currentTab = await readCurrentTab();
    scheduleRender();
  }

  function jobForUrl(url) {
    if (!state || !url) {
      return null;
    }
    const key = handlers.catalogKey(url);
    return key ? state.jobs.find((job) => (job.keys || []).includes(key)) || null : null;
  }

  function renderCurrent() {
    const url = currentTab && currentTab.url ? currentTab.url : "";
    const site = handlers.siteForUrl(url);
    const job = site ? jobForUrl(url) : null;
    $("current-site-block").hidden = !site;
    $("current-unsupported").hidden = !!site;
    $("current-new").hidden = !site || !!job;
    $("current-queued").hidden = !job;
    if (!site) {
      $("current-unsupported").textContent = url && /viper\.to/i.test(url)
        ? "Viper: hãy mở một thread dạng viper.to/threads/…, hoặc dán link bên dưới."
        : "Trang này không hỗ trợ. Mở album ImageFap, Xasiat hoặc thread Viper, hoặc dán link bên dưới.";
      return;
    }
    $("current-site").textContent = sites.siteLabel(site);
    $("current-url").textContent = url.replace(/^https?:\/\/(www\.)?/, "");
    $("current-name").textContent = currentTab.title || "";
    if (!job) {
      $("start").disabled = !state;
      $("start-label").textContent = includeAlbum ? "Tải cả album" : "Chỉ tải trang này";
      for (const item of document.querySelectorAll("#scope-menu [data-album]")) {
        item.setAttribute("aria-checked", String((item.dataset.album === "1") === includeAlbum));
      }
      $("current-hint").textContent = site === "viper"
        ? "Lưu vào Downloads/[Forum]-<tên bài post>/"
        : `Lưu vào Downloads/${sites.SITE_CONFIG[site].folder}/<tên album>/`;
      return;
    }
    const [label, tone] = statusOf(job);
    const bar = $("current-progress");
    bar.style.width = job.percent + "%";
    bar.className = "tone-" + tone + "-bar";
    $("current-job-line").textContent = `Đã có trong hàng đợi · ${label} · ${job.counts.done + job.counts.skipped}/${job.counts.total} ảnh`;
    const live = LIVE.has(job.status);
    // A finished album has nothing to resume: offer "Quét lại" as the main action.
    const finished = job.status === "done";
    $("resume-current").hidden = live || finished;
    $("rescan-current").hidden = live;
    $("rescan-current").className = finished ? "primary grow" : "outline";
  }

  async function enqueueCurrent(mode) {
    if (!currentTab || !currentTab.url) {
      return;
    }
    const result = await command("enqueue", { url: currentTab.url, tabId: currentTab.id, includeAlbum, mode });
    if (result && result.job) {
      toast(result.message || (result.action === "rescan" ? "Đang quét lại album." : result.action === "resume" ? "Đang tải tiếp phần còn lại." : "Đã thêm vào hàng đợi."));
      filter = "all";
    }
  }

  // ------------------------------------------------------------- paste box

  function parseBatch() {
    const urls = [...new Set($("batch-urls").value.split(/\s+/).map((value) => value.trim()).filter(Boolean))];
    return { urls, supported: urls.filter((url) => handlers.siteForUrl(url)) };
  }

  function updateBatchInfo() {
    const box = $("batch-urls");
    const lines = box.value.split("\n").length;
    box.rows = Math.min(Math.max(lines, 1), 5);
    const { urls, supported } = parseBatch();
    const info = $("batch-result");
    info.hidden = !urls.length;
    info.className = "small " + (supported.length === urls.length ? "ok" : "warn");
    info.textContent = supported.length === urls.length
      ? `${supported.length} link hợp lệ`
      : `${supported.length}/${urls.length} link hợp lệ · link không hỗ trợ sẽ bị bỏ qua`;
  }

  async function addBatch() {
    const { urls, supported } = parseBatch();
    if (!supported.length) {
      toast(urls.length ? "Không có link nào được hỗ trợ." : "Dán link album trước.");
      return;
    }
    const result = await command("enqueue-many", { urls: supported, includeAlbum: state ? state.settings.includeAlbum : true });
    if (result) {
      const ok = result.results.filter((entry) => entry.ok).length;
      toast(`Đã thêm ${ok} album${urls.length > supported.length ? ` · bỏ qua ${urls.length - supported.length} link` : ""}.`);
      $("batch-urls").value = "";
      updateBatchInfo();
    }
  }

  // --------------------------------------------------------------- job list

  function matchesFilter(job) {
    if (filter === "active") {
      return LIVE.has(job.status) || job.status === "paused";
    }
    if (filter === "problem") {
      return isProblem(job);
    }
    if (filter === "done") {
      return job.status === "done" || job.status === "done-with-errors";
    }
    return true;
  }

  async function openCaptcha(job) {
    const tab = await chrome.tabs.create({ url: job.captcha.url, active: true }).catch(() => null);
    if (tab && tab.id !== undefined) {
      await engine("captcha-tab-opened", { host: job.captcha.host, tabId: tab.id }).catch(() => undefined);
      toast("Xác minh trong tab mới; extension sẽ tự tiếp tục.");
    }
  }

  // One primary action per job, chosen by what the job needs next.
  function primaryAction(job) {
    const live = LIVE.has(job.status);
    if (job.needsPermission) {
      return iconBtn("key", "Cấp quyền ghi", () => grantPermission());
    }
    if (job.status === "captcha" && job.captcha) {
      return iconBtn("open", "Mở trang xác minh", () => openCaptcha(job));
    }
    if (live) {
      return iconBtn("pause", "Tạm dừng", () => command("pause", { jobId: job.id }));
    }
    if (job.counts.failed > 0) {
      return iconBtn("refresh", `Thử lại ${job.counts.failed} ảnh lỗi`, () => command("retry-failed", { jobId: job.id }, (r) => `Thử lại ${r.count} ảnh lỗi.`));
    }
    if (["paused", "cancelled", "error"].includes(job.status)) {
      return iconBtn("play", "Tiếp tục", () => command("resume", { jobId: job.id }));
    }
    return iconBtn("folder", "Mở thư mục tải", openFolder);
  }

  function jobExtra(job) {
    const live = LIVE.has(job.status);
    const children = [];
    if (job.status === "captcha" && job.captcha) {
      children.push(h("div", { class: "callout" }, [
        h("div", { text: "Trang nguồn yêu cầu xác minh. Làm CAPTCHA thủ công trong tab mới; extension tự tiếp tục đúng vị trí." }),
        h("div", { class: "row" }, [
          h("button", { class: "primary small-btn", text: "Mở trang xác minh", onclick: () => openCaptcha(job) }),
          h("button", { class: "link-btn", text: "Tôi đã xác minh xong", onclick: () => command("resolve-captcha", { jobId: job.id }, "Đang tiếp tục…") })
        ])
      ]));
    }
    if (job.needsPermission) {
      children.push(h("div", { class: "callout" }, [
        h("div", { text: job.note || "Cần cấp lại quyền ghi vào thư mục đã chọn." }),
        h("div", { class: "row" }, [h("button", { class: "primary small-btn", text: "Cấp quyền", onclick: () => grantPermission() })])
      ]));
    }
    children.push(h("div", { class: "muted", text: job.sourceUrl }));
    children.push(h("div", {
      class: "muted",
      text: `Trang đã đọc: ${job.scan.pagesRead}${job.scan.done ? " (xong)" : ""} · URL: ${job.counts.resolved || 0} · bỏ qua: ${job.counts.skipped} · lỗi: ${job.counts.failed}${job.viaTab ? " · đọc qua tab" : ""}`
    }));
    if (job.note && job.note !== job.message && !job.needsPermission) {
      children.push(h("div", { class: "muted", text: job.note }));
    }
    if (job.warnings.length) {
      children.push(h("ul", {}, job.warnings.map((w) => h("li", { text: w }))));
    }
    if (job.errors.length) {
      children.push(h("ul", {}, job.errors.map((e) => h("li", { text: (e.photoId ? e.photoId + ": " : "") + e.message }))));
    }
    const failed = failedLists.get(job.id);
    if (failed) {
      children.push(h("ul", {}, failed.slice(0, 100).map((item) => h("li", {}, [
        /^https?:\/\//i.test(item.pageUrl || "") ? h("a", { href: item.pageUrl, target: "_blank", rel: "noreferrer", text: item.photoId }) : item.photoId,
        " — " + (item.error || "lỗi")
      ]))));
    }
    const actions = [];
    if (live || job.status === "paused") {
      actions.push(chipBtn("stop", "Dừng", () => command("cancel", { jobId: job.id })));
    }
    if (job.status === "paused" && job.counts.failed > 0) {
      actions.push(chipBtn("play", "Tiếp tục", () => command("resume", { jobId: job.id })));
    }
    if (job.counts.failed && !failed) {
      actions.push(chipBtn("list", `Xem ${job.counts.failed} ảnh lỗi`, async () => {
        const result = await command("job-items", { jobId: job.id, status: "failed" });
        failedLists.set(job.id, (result && result.items) || []);
        scheduleRender();
      }));
    }
    if (job.status === "done" || job.status === "done-with-errors") {
      actions.push(chipBtn("refresh", "Quét lại", () => command("enqueue", { url: job.sourceUrl, mode: "rescan" }, "Đang quét lại album.")));
      actions.push(chipBtn("folder", "Thư mục", openFolder));
    }
    actions.push(chipBtn("open", "Mở trang", () => chrome.tabs.create({ url: job.sourceUrl })));
    actions.push(chipBtn("up", "Lên", () => command("move", { jobId: job.id, direction: -1 })));
    actions.push(chipBtn("down", "Xuống", () => command("move", { jobId: job.id, direction: 1 })));
    actions.push(chipBtn("del", "Xoá", () => {
      openJob = null;
      deferred([job.id], "Đã xoá album (lịch sử ảnh đã tải vẫn giữ).", () => command("remove", { jobId: job.id }));
    }, true));
    children.push(h("div", { class: "chips" }, actions));
    return h("div", { class: "job-extra" }, children);
  }

  function jobRow(job) {
    const [label, tone] = statusOf(job);
    const processed = job.counts.done + job.counts.skipped + job.counts.failed;
    const meta = [job.counts.total ? `${processed}/${job.counts.total} ảnh` : "Chưa rõ số ảnh"];
    if (job.counts.failed) {
      meta.push(`${job.counts.failed} lỗi`);
    }
    if (job.status === "running" && job.ratePerMin) {
      meta.push(`${job.ratePerMin} ảnh/phút`);
    }
    if (job.status === "running" && job.etaSec) {
      meta.push("còn ~" + duration(job.etaSec));
    }
    if (job.message) {
      meta.push(job.message);
    }
    const open = openJob === job.id;
    return h("li", { class: "job" + (open ? " open" : "") }, [
      h("div", { class: "job-main" }, [
        h("button", {
          class: "job-body",
          "aria-expanded": String(open),
          onclick: () => { openJob = open ? null : job.id; scheduleRender(); }
        }, [
          h("div", { class: "job-head" }, [
            h("span", { class: "job-title", text: job.title || job.sourceUrl }),
            h("span", { class: "job-status tone-" + tone, text: label })
          ]),
          h("div", { class: "progress", role: "progressbar", "aria-valuenow": job.percent, "aria-valuemin": 0, "aria-valuemax": 100 }, [
            h("div", { class: "tone-" + tone + "-bar", style: `width:${job.percent}%` })
          ]),
          h("div", { class: "job-meta", text: meta.join(" · ") })
        ]),
        primaryAction(job)
      ]),
      open ? jobExtra(job) : null
    ]);
  }

  function renderJobs() {
    const all = visibleJobs();
    const jobs = all
      .map((job, index) => ({ job, index }))
      .filter(({ job }) => matchesFilter(job))
      .sort((a, b) => statusOf(a.job)[2] - statusOf(b.job)[2] || a.index - b.index)
      .map(({ job }) => job);
    $("jobs").replaceChildren(...jobs.map(jobRow));
    $("jobs-empty").hidden = jobs.length > 0;
    $("jobs-empty").textContent = !state
      ? "Đang kết nối engine…"
      : all.length ? "Không có album nào ở mục này." : "Chưa có album nào. Mở một album rồi bấm \"Tải cả album\".";

    const saved = filter;
    for (const chip of document.querySelectorAll(".chip[data-filter]")) {
      filter = chip.dataset.filter;
      chip.querySelector("span").textContent = all.filter(matchesFilter).length;
      chip.classList.toggle("active", filter === saved);
      chip.setAttribute("aria-selected", String(filter === saved));
    }
    filter = saved;

    const problems = all.filter((job) => job.status === "captcha" || job.needsPermission || ["error", "done-with-errors"].includes(job.status));
    $("alert").hidden = !problems.length;
    const captcha = problems.filter((j) => j.status === "captcha").length;
    const perm = problems.filter((j) => j.needsPermission).length;
    const err = problems.length - captcha - perm;
    $("alert-text").textContent = [
      captcha && `${captcha} album cần xác minh`,
      perm && `${perm} album cần cấp quyền`,
      err > 0 && `${err} album có lỗi`
    ].filter(Boolean).join(" · ");

    const now = Date.now();
    const holds = [];
    for (const host of (state && state.hosts) || []) {
      if (host.held) {
        holds.push(`${host.key.replace(/^dl:/, "")}: chờ xác minh`);
      } else if (host.blockedUntil > now + 1000) {
        holds.push(`${host.key.replace(/^dl:/, "")}: bị giới hạn, chờ ${Math.ceil((host.blockedUntil - now) / 1000)}s`);
      }
    }
    $("global-line").hidden = !holds.length;
    $("global-line").textContent = holds.join(" · ");

    const running = all.filter((job) => job.status === "running").length;
    const queued = all.filter((job) => job.status === "queued").length;
    $("summary").textContent = state ? `${running} đang chạy · ${queued} chờ · ${all.length} album` : "";
    $("clear-finished").disabled = !all.some((job) => job.status === "done");

    const rate = all.filter((job) => job.status === "running").reduce((sum, job) => sum + (job.ratePerMin || 0), 0);
    $("speed").textContent = !state ? "Đang kết nối…" : rate ? `${rate} ảnh/phút` : running ? `${state.activeDownloads} file đang tải` : "Rảnh";
  }

  // --------------------------------------------------------------- settings

  const SELECTS = ["delayMs", "scanConcurrency", "downloadConcurrency", "downloadDelayMs", "retryCount", "maxActiveJobs"];
  const CHECKS = ["adaptive", "skipDownloaded", "includeAlbum", "eraseDownloadHistory", "notify"];

  function ensureOption(select, value) {
    if (![...select.options].some((option) => option.value === String(value))) {
      select.append(h("option", { value: String(value), text: String(value) }));
    }
  }

  function activePreset(settings) {
    return Object.keys(PRESETS).find((key) => Object.entries(PRESETS[key].patch).every(([k, v]) => Number(settings[k]) === v)) || null;
  }

  function renderSettings() {
    if (!state || Date.now() - settingsDirtyAt < 1500) {
      return;
    }
    const settings = state.settings;
    for (const key of SELECTS) {
      const select = $(key);
      if (document.activeElement !== select) {
        ensureOption(select, settings[key]);
        select.value = String(settings[key]);
      }
    }
    for (const key of CHECKS) {
      $(key).checked = Boolean(settings[key]);
    }
    $("fetchViaTab").checked = settings.fetchVia === "auto";
    for (const button of document.querySelectorAll("[data-mode]")) {
      button.setAttribute("aria-checked", String(button.dataset.mode === settings.downloadMode));
    }
    $("mode-downloads").hidden = settings.downloadMode === "directory";
    $("mode-directory").hidden = settings.downloadMode !== "directory";
    if (document.activeElement !== $("download-subdir")) {
      $("download-subdir").value = settings.downloadSubdir || "";
    }
    const preset = activePreset(settings);
    for (const button of document.querySelectorAll("[data-preset]")) {
      button.setAttribute("aria-checked", String(button.dataset.preset === preset));
    }
    $("preset-hint").textContent = preset ? PRESETS[preset].label : "Tuỳ chỉnh — xem mục Nâng cao.";
    $("tools-line").textContent = `Lịch sử: ${state.historyCount} ảnh đã tải được ghi nhớ.`;
  }

  async function saveSetting(patch) {
    settingsDirtyAt = Date.now();
    if (state) {
      state.settings = { ...state.settings, ...patch };
    }
    const result = await command("update-settings", { patch });
    if (result && result.settings && state) {
      state.settings = result.settings;
    }
    settingsDirtyAt = 0;
    scheduleRender();
  }

  async function renderDirectory() {
    let handle = null;
    try {
      handle = await store.kvGet("dirHandle");
    } catch {
      handle = null;
    }
    $("directory-name").value = handle ? handle.name : "";
    $("clear-directory").hidden = !handle;
    $("browse").textContent = handle ? "Đổi" : "Chọn";
    let permission = "granted";
    if (handle && typeof handle.queryPermission === "function") {
      permission = await handle.queryPermission({ mode: "readwrite" }).catch(() => "prompt");
    }
    $("grant-permission").hidden = !handle || permission === "granted";
    return handle;
  }

  async function grantPermission() {
    const handle = await store.kvGet("dirHandle").catch(() => null);
    if (!handle) {
      toast("Chưa chọn thư mục.");
      return;
    }
    const permission = await handle.requestPermission({ mode: "readwrite" }).catch(() => "denied");
    if (permission === "granted") {
      await command("permission-granted", {}, "Đã cấp quyền; đang tiếp tục.");
    } else {
      toast("Chưa được cấp quyền ghi.");
    }
    await renderDirectory();
  }

  async function explainPickerUnavailable() {
    const brave = navigator.brave && typeof navigator.brave.isBrave === "function" && await navigator.brave.isBrave().catch(() => false);
    if (brave) {
      toast("Brave đang tắt File System Access API: bật brave://flags/#file-system-access-api rồi khởi động lại Brave.");
      chrome.tabs.create({ url: "brave://flags/#file-system-access-api" }).catch(() => undefined);
    } else {
      toast("Trình duyệt này không cho chọn thư mục; hãy dùng Downloads.");
    }
  }

  async function pickDirectory() {
    if (typeof window.showDirectoryPicker !== "function") {
      await explainPickerUnavailable();
      return false;
    }
    try {
      const handle = await window.showDirectoryPicker({ id: "maxdl", mode: "readwrite" });
      const permission = await handle.requestPermission({ mode: "readwrite" });
      if (permission !== "granted") {
        throw new Error("Chưa được cấp quyền ghi vào thư mục đã chọn.");
      }
      await store.kvSet("dirHandle", handle);
      await saveSetting({ downloadMode: "directory" });
      await command("permission-granted", {});
      toast(`Ảnh mới sẽ được ghi thẳng vào "${handle.name}".`);
      return true;
    } catch (error) {
      if (!error || error.name !== "AbortError") {
        toast("Không chọn được thư mục: " + (error && error.message ? error.message : error));
      }
      return false;
    } finally {
      await renderDirectory();
    }
  }

  // ----------------------------------------------------------------- render

  function setView(next) {
    view = next;
    $("view-main").hidden = view !== "main";
    $("view-settings").hidden = view !== "settings";
    $("gear-path").setAttribute("d", view === "main" ? ICON.tune : ICON.back);
    $("gear").title = view === "main" ? "Cài đặt" : "Quay lại";
    $("gear").setAttribute("aria-label", $("gear").title);
    window.scrollTo(0, 0);
  }

  function closeMenu() {
    $("scope-menu").hidden = true;
    $("scope-toggle").setAttribute("aria-expanded", "false");
  }

  function scheduleRender() {
    if (renderQueued) {
      return;
    }
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      renderCurrent();
      renderJobs();
      renderSettings();
    });
  }

  // ------------------------------------------------------------------ events

  function bindEvents() {
    $("gear").addEventListener("click", () => setView(view === "main" ? "settings" : "main"));
    $("alert").addEventListener("click", () => { filter = "problem"; scheduleRender(); });

    $("start").addEventListener("click", () => enqueueCurrent("auto"));
    $("scope-toggle").addEventListener("click", (event) => {
      event.stopPropagation();
      const open = $("scope-menu").hidden;
      $("scope-menu").hidden = !open;
      $("scope-toggle").setAttribute("aria-expanded", String(open));
    });
    for (const item of document.querySelectorAll("#scope-menu [data-album]")) {
      item.addEventListener("click", () => {
        includeAlbum = item.dataset.album === "1";
        closeMenu();
        scheduleRender();
      });
    }
    document.addEventListener("click", (event) => {
      if (!$("scope-menu").hidden && !event.target.closest(".split")) {
        closeMenu();
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeMenu();
      }
    });
    $("resume-current").addEventListener("click", () => enqueueCurrent("resume"));
    $("rescan-current").addEventListener("click", () => enqueueCurrent("rescan"));

    $("batch-urls").addEventListener("input", updateBatchInfo);
    $("batch-urls").addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        void addBatch();
      }
    });
    $("batch-add").addEventListener("click", () => void addBatch());

    for (const chip of document.querySelectorAll(".chip[data-filter]")) {
      chip.addEventListener("click", () => {
        filter = chip.dataset.filter;
        scheduleRender();
      });
    }

    $("clear-finished").addEventListener("click", () => {
      const ids = visibleJobs().filter((job) => job.status === "done").map((job) => job.id);
      if (!ids.length) {
        return;
      }
      // Remove exactly the albums shown now, not ones that finish during the undo window.
      deferred(ids, `Đã dọn ${ids.length} album đã xong.`, () => Promise.all(ids.map((jobId) => engine("remove", { jobId }).catch(() => undefined))));
    });

    for (const key of SELECTS) {
      $(key).addEventListener("change", () => saveSetting({ [key]: Number($(key).value) }));
    }
    for (const key of CHECKS) {
      $(key).addEventListener("change", () => saveSetting({ [key]: $(key).checked }));
    }
    $("fetchViaTab").addEventListener("change", () => saveSetting({ fetchVia: $("fetchViaTab").checked ? "auto" : "background" }));
    $("download-subdir").addEventListener("change", () => saveSetting({ downloadSubdir: $("download-subdir").value }));
    for (const button of document.querySelectorAll("[data-preset]")) {
      button.addEventListener("click", () => saveSetting(PRESETS[button.dataset.preset].patch));
    }
    for (const button of document.querySelectorAll("[data-mode]")) {
      button.addEventListener("click", async () => {
        if (button.dataset.mode === "directory") {
          const handle = await store.kvGet("dirHandle").catch(() => null);
          if (!handle) {
            await pickDirectory();
            return;
          }
        }
        await saveSetting({ downloadMode: button.dataset.mode });
      });
    }

    $("browse").addEventListener("click", () => void pickDirectory());
    $("grant-permission").addEventListener("click", () => grantPermission());
    $("clear-directory").addEventListener("click", async () => {
      await store.kvDelete("dirHandle").catch(() => undefined);
      await saveSetting({ downloadMode: "downloads" });
      await renderDirectory();
      toast("Đã chuyển về thư mục Downloads.");
    });

    $("open-folder").addEventListener("click", openFolder);
    $("open-download-settings").addEventListener("click", () => {
      chrome.tabs.create({ url: navigator.brave ? "brave://settings/downloads" : "chrome://settings/downloads" }).catch(() => undefined);
    });
    $("export-catalog").addEventListener("click", async () => {
      const data = await command("export", {});
      if (data && Array.isArray(data.jobs)) {
        downloadJson(data, `maxdl-catalog-${stamp()}.json`);
        toast(`Đã sao lưu ${data.jobs.length} album.`);
      }
    });
    $("import-catalog").addEventListener("click", () => $("import-file").click());
    $("import-file").addEventListener("change", async () => {
      const file = $("import-file").files && $("import-file").files[0];
      $("import-file").value = "";
      if (!file) {
        return;
      }
      let data;
      try {
        data = JSON.parse(await file.text());
      } catch {
        toast("File JSON không hợp lệ.");
        return;
      }
      await command("import", { data }, (result) => `Đã nhập ${result.jobs} album, ${result.items} ảnh.`);
    });
    $("export-logs").addEventListener("click", async () => {
      const result = await command("get-logs", { limit: 3000 });
      if (result && result.logs) {
        downloadJson({ exportedAt: new Date().toISOString(), version: chrome.runtime.getManifest().version, logs: result.logs }, `maxdl-log-${stamp()}.json`);
      }
    });
    const clearHistory = $("clear-history");
    clearHistory.replaceChildren(document.createTextNode("Xoá lịch sử đã tải"));
    confirmBtn(clearHistory, "Xoá lịch sử đã tải", () => command("clear-history", {}, "Đã xoá lịch sử: lần sau sẽ tải lại cả ảnh đã từng tải."));

    chrome.runtime.onMessage.addListener((message) => {
      if (message && message.scope === SCOPE && message.target === "ui" && message.type === "state") {
        state = message.state;
        scheduleRender();
      }
      return false;
    });

    chrome.tabs.onActivated.addListener(() => void refreshCurrentTab());
    chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
      if (currentTab && tabId === currentTab.id && (changeInfo.url || changeInfo.title || changeInfo.status === "complete")) {
        void refreshCurrentTab();
      }
    });
    if (isWindowMode && chrome.windows.onFocusChanged) {
      chrome.windows.onFocusChanged.addListener(() => void refreshCurrentTab());
    }
  }

  // --------------------------------------------------------------------- boot

  async function connect() {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await bg("ensure-engine");
        const snapshot = await engine("get-state");
        if (snapshot && snapshot.jobs) {
          state = snapshot;
          scheduleRender();
          return true;
        }
      } catch {
        // Engine still starting; retry below.
      }
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
    }
    toast("Không khởi động được engine. Hãy reload extension.");
    scheduleRender();
    return false;
  }

  $("version").textContent = "v" + chrome.runtime.getManifest().version;
  setView("main");
  bindEvents();
  void refreshCurrentTab();
  void renderDirectory();
  void connect().then((ok) => {
    if (ok) {
      includeAlbum = Boolean(state.settings.includeAlbum);
      scheduleRender();
    }
  });
  // Push updates are throttled by the engine; this keeps ETA/"chờ Ns" fresh.
  setInterval(() => {
    if (state && state.jobs.some((job) => LIVE.has(job.status))) {
      void engine("get-state").then((snapshot) => {
        if (snapshot && snapshot.jobs) {
          state = snapshot;
          scheduleRender();
        }
      }).catch(() => undefined);
    }
  }, 3000);
})();
