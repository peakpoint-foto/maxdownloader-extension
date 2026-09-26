"use strict";

// Runs on every supported host (including /human-verification or /captcha pages
// without an adapter) and tells the engine whether this tab shows a challenge.
// When a tab that showed one stops showing it, the engine resumes the run.
// Nothing here solves or bypasses anything: the user completes the challenge.
(() => {
  const SCOPE = "maxdl";
  const sites = globalThis.MaxDownloaderSites;
  const CHECK_THROTTLE_MS = 500;
  const WATCH_LIMIT_MS = 30 * 60 * 1000;

  function isVerificationPage() {
    return sites.verificationDocument(document, location.href, location.href);
  }

  function report(isVerification) {
    void chrome.runtime.sendMessage({
      scope: SCOPE,
      type: "captcha-tab-state",
      site: sites.siteFromUrl(location.href),
      pageUrl: location.href,
      isVerification,
      title: document.title || ""
    }).catch(() => undefined);
  }

  function watchForVerification() {
    let last = null;
    let scheduled = null;
    let observer = null;
    let poll = null;

    const check = () => {
      const isVerification = isVerificationPage();
      if (isVerification !== last) {
        last = isVerification;
        report(isVerification);
      }
      return isVerification;
    };

    const stop = () => {
      clearInterval(poll);
      clearTimeout(scheduled);
      if (observer) {
        observer.disconnect();
      }
    };

    // Throttled: challenge pages mutate constantly and each check reads the body text.
    const scheduleCheck = () => {
      if (scheduled) {
        return;
      }
      scheduled = setTimeout(() => {
        scheduled = null;
        if (!check()) {
          stop();
        }
      }, CHECK_THROTTLE_MS);
    };

    // A normal page is reported once (so a solved challenge that redirected
    // here is noticed) and never watched.
    if (!check()) {
      return;
    }
    if (typeof MutationObserver !== "undefined" && document.documentElement) {
      observer = new MutationObserver(scheduleCheck);
      observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
    }
    // reCAPTCHA/Turnstile redraw inside their own iframe, invisible to the observer.
    poll = setInterval(scheduleCheck, 2000);
    setTimeout(stop, WATCH_LIMIT_MS);
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message && message.scope === SCOPE && message.type === "captcha-state-request") {
      sendResponse({ ok: true, isVerification: isVerificationPage(), pageUrl: location.href });
    }
    return false;
  });

  watchForVerification();
})();
