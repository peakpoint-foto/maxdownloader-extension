"use strict";

// Content script: tiny on purpose. The engine (offscreen document) does all the
// scanning; this script only lends the album tab to it, so pages are read with
// the tab's own cookies, referer and same-origin profile — exactly like browsing.
(() => {
  const SCOPE = "maxdl";
  const FETCH_TIMEOUT_MS = 20000;

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

  async function tabFetch(url) {
    let target;
    try {
      target = new URL(url, location.href);
    } catch {
      return { transportError: "bad-url" };
    }
    // Same-origin only: anything else would hit CORS from a content script.
    if (target.origin !== location.origin) {
      return { transportError: "cross-origin" };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(target.href, {
        credentials: "include",
        headers: { Accept: "text/html,application/xhtml+xml" },
        signal: controller.signal
      });
      const text = await response.text();
      return {
        ok: response.ok,
        status: response.status,
        url: response.url || target.href,
        text,
        retryAfterMs: retryAfterMs(response.headers)
      };
    } catch (error) {
      // Network failure inside the tab: let the engine retry on its own path.
      return { transportError: controller.signal.aborted ? "timeout" : "network" };
    } finally {
      clearTimeout(timer);
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.scope !== SCOPE || message.target !== "content") {
      return false;
    }
    if (message.type === "tab-fetch") {
      void tabFetch(message.url).then(sendResponse);
      return true;
    }
    if (message.type === "page-info") {
      sendResponse({ url: location.href, title: document.title });
      return false;
    }
    return false;
  });
})();
