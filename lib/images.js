"use strict";

// Full-size image URL resolution, shared by the ImageFap and Xasiat adapters.
(function installImageLib(globalObject) {
  "use strict";

  const sites = globalObject.MaxDownloaderSites;

  function imageCandidateUrl(value, baseUrl) {
    if (!value) {
      return null;
    }
    try {
      const url = new URL(value, baseUrl || (typeof location !== "undefined" ? location.href : undefined));
      const host = url.hostname.toLowerCase();
      if ((sites.siteFromUrl(url.href) === "imagefap" || host.endsWith(".imagefap.com")) && /\/images\//i.test(url.pathname)) {
        return url.href;
      }
      if (sites.siteFromUrl(url.href) === "xasiat" && /\/get_image\/[^/]+\/[^/]+\/sources\/\d+\/\d+\/\d+\.[a-z0-9]{2,5}\/?$/i.test(url.pathname)) {
        return url.href;
      }
      return null;
    } catch {
      return null;
    }
  }

  function imageRank(url) {
    try {
      const pathname = new URL(url).pathname;
      if (/\/get_image\//i.test(pathname)) {
        return 500;
      }
      const match = pathname.match(/\/images\/([^/]+)\//i);
      const bucket = (match ? match[1] : "").toLowerCase();
      return ({ original: 500, full: 450, large: 400, hd: 350, medium: 200, mini: 100, thumb: 50 }[bucket] || 10);
    } catch {
      return 0;
    }
  }

  function normalizeHtml(value) {
    return String(value || "")
      .replace(/&amp;/gi, "&")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/\\\//g, "/")
      .replace(/\\u0026/gi, "&");
  }

  function imageBelongsToPhoto(url, photoId) {
    if (!photoId) {
      return false;
    }
    try {
      const fileName = new URL(url).pathname.split("/").filter(Boolean).pop() || "";
      return new RegExp(`^${photoId}\\.[a-z0-9]+$`, "i").test(fileName);
    } catch {
      return false;
    }
  }

  function extractRawImageCandidates(rawHtml, pageUrl) {
    const html = normalizeHtml(rawHtml);
    const matches = html.match(/(?:https?:)?\/\/[^"'<>\s]+/gi) || [];
    const allowed = matches.filter((value) => (
      /\/images\/(?:original|full|large|hd|medium)\/[^"'<>\s]+/i.test(value) ||
      /\/get_image\/[^"'<>\s]*\/sources\/\d+\/\d+\/\d+\.[a-z0-9]{2,5}\/?(?:\?[^"'<>\s]*)?/i.test(value)
    ));
    return allowed.map((value) => value.replace(/[\\'"),;<>]+$/g, ""));
  }

  function extractFullImageUrl(doc, pageUrl, rawHtml, photoId) {
    const candidates = [];
    const seen = new Set();
    const add = (value, areaBonus, preferred = false) => {
      const url = imageCandidateUrl(value, pageUrl);
      if (!url || seen.has(url)) {
        return;
      }
      if (imageRank(url) < 200) {
        return;
      }
      seen.add(url);
      const belongsToPhoto = preferred || imageBelongsToPhoto(url, photoId);
      candidates.push({
        url,
        preferred: belongsToPhoto,
        score: imageRank(url) * 1000000000 + (belongsToPhoto ? 100000000 : 0) + (areaBonus || 0)
      });
    };

    for (const img of doc.querySelectorAll("img")) {
      const width = Number(img.naturalWidth || img.width || img.getAttribute("width") || 0);
      const height = Number(img.naturalHeight || img.height || img.getAttribute("height") || 0);
      const area = Number.isFinite(width * height) ? width * height : 0;
      add(img.currentSrc || img.src, area);
      add(img.getAttribute("data-src"), area);
      add(img.getAttribute("data-original"), area);
      add(img.getAttribute("data-lazy-src"), area);
    }
    for (const meta of doc.querySelectorAll('meta[property="og:image"], meta[name="twitter:image"]')) {
      add(meta.getAttribute("content"), 0);
    }
    for (const anchor of doc.querySelectorAll("a[href]")) {
      add(anchor.getAttribute("href"), 0);
    }
    for (const rawCandidate of extractRawImageCandidates(rawHtml, pageUrl)) {
      add(rawCandidate, 0, imageBelongsToPhoto(rawCandidate, photoId));
    }

    candidates.sort((left, right) => right.score - left.score);
    const preferred = candidates.filter((candidate) => candidate.preferred);
    if (photoId && preferred.length) {
      return preferred[0].url;
    }
    return candidates.length ? candidates[0].url : "";
  }

  function fileNameFor(index, photoId, imageUrl) {
    return `${String(index + 1).padStart(3, "0")}_${photoId || "image"}${globalObject.MaxDownloaderPaths.fileExtension(imageUrl)}`;
  }

  globalObject.MaxDownloaderImages = Object.freeze({
    imageCandidateUrl,
    imageRank,
    normalizeHtml,
    imageBelongsToPhoto,
    extractRawImageCandidates,
    extractFullImageUrl,
    fileNameFor
  });
})(globalThis);
