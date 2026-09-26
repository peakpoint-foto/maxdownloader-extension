"use strict";

// Shared between the service worker (importScripts), content scripts and the control page.
(function installSiteLib(globalObject) {
  "use strict";

  const SITE_CONFIG = Object.freeze({
    imagefap: { key: "imagefap", label: "ImageFap", folder: "ImageFap", fallbackTitle: "ImageFap" },
    xasiat: { key: "xasiat", label: "Xasiat", folder: "Xasiat", fallbackTitle: "Xasiat" },
    viper: { key: "viper", label: "Viper", folder: "Viper", fallbackTitle: "Viper" }
  });

  const HOST_TO_SITE = Object.freeze({
    "imagefap.com": "imagefap",
    "www.imagefap.com": "imagefap",
    "xasiat.com": "xasiat",
    "www.xasiat.com": "xasiat",
    "viper.to": "viper",
    "www.viper.to": "viper"
  });

  function parseUrl(value, baseUrl) {
    try {
      const base = baseUrl || (typeof location !== "undefined" ? location.href : undefined);
      return new URL(value, base);
    } catch {
      return null;
    }
  }

  // Host-only lookup: used for image URL checks, where viper hosts serve CDN assets too.
  function siteFromUrl(value, baseUrl) {
    const url = parseUrl(value, baseUrl);
    return url ? HOST_TO_SITE[url.hostname.toLowerCase()] || "" : "";
  }

  function isViperThreadUrl(value, baseUrl) {
    const url = parseUrl(value, baseUrl);
    if (!url || siteFromUrl(url.href) !== "viper") {
      return false;
    }
    return /^\/threads\/\d+(?:-|\/|$)/i.test(url.pathname);
  }

  // Host + path rules: a bare viper.to page is not a download target.
  function supportedTargetUrl(value, baseUrl) {
    const site = siteFromUrl(value, baseUrl);
    if (!site) {
      return false;
    }
    return site === "viper" ? isViperThreadUrl(value, baseUrl) : true;
  }

  // Parses a possibly-relative link and keeps it only when it points at a supported page.
  function supportedUrl(value, baseUrl) {
    const url = parseUrl(value, baseUrl);
    return url && supportedTargetUrl(url.href) ? url : null;
  }

  function normalizeSite(value) {
    return Object.prototype.hasOwnProperty.call(SITE_CONFIG, value) ? value : "imagefap";
  }

  function cleanText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  // innerText forces a layout and is empty on a DOMParser document. Count strings
  // live in the visible body text, so a capped textContent is enough.
  function bodyText(doc, limit = 30000) {
    const body = doc && doc.body;
    return cleanText(body && (body.textContent || body.innerText)).slice(0, limit);
  }

  function pageKey(value, baseUrl) {
    const url = parseUrl(value, baseUrl);
    if (!url) {
      return String(value || "");
    }
    url.hash = "";
    if (url.searchParams.get("page") === "0") {
      url.searchParams.delete("page");
    }
    if (url.searchParams.get("view") === "0") {
      url.searchParams.delete("view");
    }
    return url.href;
  }

  function titleFromPageUrl(value, baseUrl) {
    const url = parseUrl(value, baseUrl);
    if (!url) {
      return "";
    }
    const match = url.pathname.match(/\/(?:pictures|albums)\/\d+\/([^/]+)/i);
    if (!match) {
      return "";
    }
    try {
      return cleanText(decodeURIComponent(match[1]).replace(/[-_]+/g, " "));
    } catch {
      return cleanText(match[1].replace(/[-_]+/g, " "));
    }
  }

  function normalizeGalleryTitle(value) {
    const title = cleanText(value)
      .replace(/^Gallery:\s*/i, "")
      .replace(/^Thread:\s*/i, "")
      .replace(/\s+Sex Image Gallery.*$/i, "")
      .replace(/\s*(?:\||-)\s*(?:ImageFap|Xasiat)\s*$/i, "");
    if (!title || /^(?:ImageFap|Xasiat|Users who added this gallery)$/i.test(title)) {
      return "";
    }
    if (/^Free Porn Pics, Adult Photos, XXX Images/i.test(title)) {
      return "";
    }
    return title;
  }

  function imageFapGalleryLinkTitle(doc) {
    for (const row of doc.querySelectorAll("tr")) {
      if (!/\bGallery\s*:/i.test(cleanText(row.textContent))) {
        continue;
      }
      const link = row.querySelector('a[href*="gid="]');
      const title = normalizeGalleryTitle(link && link.textContent);
      if (title) {
        return title;
      }
    }
    return "";
  }

  function documentTitleGalleryName(doc) {
    const rawTitle = cleanText(doc.title);
    const inGallery = rawTitle.match(/\bin gallery\s+(.+?)\s+\(Picture\s+\d+\)\s+uploaded\s+by\b/i);
    if (inGallery) {
      return normalizeGalleryTitle(inGallery[1]);
    }
    const pageGallery = rawTitle.match(/\bPorn pics of\s+(.+?)\s+\(Page\s+\d+\)/i);
    return pageGallery ? normalizeGalleryTitle(pageGallery[1]) : "";
  }

  function galleryTitle(doc, pageUrl, fallback = "ImageFap") {
    const candidates = siteFromUrl(pageUrl) === "imagefap"
      ? [
        doc.querySelector('font[itemprop="name"]')?.textContent,
        imageFapGalleryLinkTitle(doc),
        titleFromPageUrl(pageUrl),
        documentTitleGalleryName(doc),
        doc.querySelector('meta[property="og:title"]')?.getAttribute("content"),
        doc.querySelector('meta[name="twitter:title"]')?.getAttribute("content"),
        doc.querySelector("h1")?.textContent,
        doc.title
      ]
      : [
        doc.querySelector("h1")?.textContent,
        doc.querySelector('meta[property="og:title"]')?.getAttribute("content"),
        doc.title,
        titleFromPageUrl(pageUrl)
      ];
    for (const candidate of candidates) {
      const title = normalizeGalleryTitle(candidate);
      if (title) {
        return title;
      }
    }
    return titleFromPageUrl(pageUrl) || fallback;
  }

  // Challenge widgets are the strongest signal: they only exist on an actual
  // challenge page, unlike the word "captcha" in an album's footer text.
  const VERIFICATION_WIDGETS = [
    'iframe[src*="recaptcha"]',
    'iframe[src*="hcaptcha"]',
    'iframe[src*="challenges.cloudflare.com"]',
    ".g-recaptcha",
    ".h-captcha",
    ".cf-turnstile",
    "#challenge-form",
    "#cf-challenge-running",
    "[data-sitekey]",
    "input[name='captcha']",
    'form[action*="captcha"]',
    'form[action*="verification"]'
  ];

  const VERIFICATION_PATH = /\/human[-_ ]?verification|\/captcha(?:\/|\.|$)|[?&]captcha=|\/verif(?:y|ication)(?:\/|\.|$)/i;
  const VERIFICATION_TEXT = /human\s+verification|verify\s+(?:that\s+)?you\s+are\s+(?:a\s+)?human|\bi\s+am\s+human\b|checking\s+your\s+browser|checking\s+if\s+the\s+site\s+connection\s+is\s+secure|please\s+complete\s+(?:the\s+)?captcha|complete\s+(?:the\s+)?(?:captcha|security\s+check)|security\s+check|are\s+you\s+a\s+robot|unusual\s+traffic|access\s+has\s+been\s+(?:restricted|denied)|enable\s+javascript\s+and\s+cookies\s+to\s+continue/i;

  // Returns why a page looks like a challenge: "path", "widget", "text" or "".
  function verificationKind(doc, finalUrl, baseUrl) {
    if (!doc) {
      return "";
    }
    const url = parseUrl(finalUrl || "", baseUrl);
    if (url && VERIFICATION_PATH.test(url.pathname + url.search)) {
      return "path";
    }
    for (const selector of VERIFICATION_WIDGETS) {
      if (doc.querySelector(selector)) {
        return "widget";
      }
    }
    // innerText forces layout and is empty on an inert DOMParser document, so
    // fall back to textContent.
    const body = doc.body || null;
    const text = cleanText(body && (body.innerText || body.textContent)).slice(0, 30000);
    return VERIFICATION_TEXT.test(`${cleanText(doc.title)} ${text}`) ? "text" : "";
  }

  function verificationDocument(doc, finalUrl, baseUrl) {
    return Boolean(verificationKind(doc, finalUrl, baseUrl));
  }

  function siteLabel(siteKey) {
    return SITE_CONFIG[normalizeSite(siteKey)].label;
  }

  globalObject.MaxDownloaderSites = Object.freeze({
    SITE_CONFIG,
    parseUrl,
    siteFromUrl,
    isViperThreadUrl,
    supportedTargetUrl,
    supportedUrl,
    normalizeSite,
    cleanText,
    bodyText,
    pageKey,
    titleFromPageUrl,
    normalizeGalleryTitle,
    galleryTitle,
    verificationKind,
    verificationDocument,
    siteLabel
  });
})(globalThis);
