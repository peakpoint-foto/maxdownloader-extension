"use strict";

// Xasiat album extraction: source image anchors plus raw-HTML fallback.
(function installXasiatAdapter(globalObject) {
  "use strict";

  const sites = globalObject.MaxDownloaderSites;
  const images = globalObject.MaxDownloaderImages;
  const { cleanText, bodyText, pageKey, siteFromUrl, supportedUrl, galleryTitle } = sites;

  function xasiatAlbumIdFromUrl(value, baseUrl) {
    const url = sites.parseUrl(value, baseUrl);
    const match = url && url.pathname.match(/\/albums\/(\d+)(?:\/|$)/i);
    return match ? match[1] : "";
  }

  function xasiatImageParts(value, baseUrl) {
    const url = sites.parseUrl(value, baseUrl);
    const match = url && url.pathname.match(/\/sources\/\d+\/(\d+)\/(\d+)\.([a-z0-9]{2,5})\/?$/i);
    if (!match) {
      return null;
    }
    return {
      albumId: match[1],
      photoId: match[2],
      extension: match[3].toLowerCase()
    };
  }

  function isXasiatAlbumUrl(value, baseUrl) {
    return Boolean(siteFromUrl(value, baseUrl) === "xasiat" && xasiatAlbumIdFromUrl(value, baseUrl));
  }

  function extractXasiatAlbumPage(doc, pageUrl, rawHtml) {
    const albumId = xasiatAlbumIdFromUrl(pageUrl, pageUrl);
    const photos = [];
    const seenPhotoIds = new Set();
    const addPhoto = (value, label) => {
      const url = images.imageCandidateUrl(value, pageUrl);
      if (!url || siteFromUrl(url) !== "xasiat") {
        return;
      }
      const parts = xasiatImageParts(url, pageUrl);
      if (!parts || (albumId && parts.albumId !== albumId) || seenPhotoIds.has(parts.photoId)) {
        return;
      }
      seenPhotoIds.add(parts.photoId);
      photos.push({
        pageUrl,
        photoId: parts.photoId,
        imageUrl: url,
        label: cleanText(label)
      });
    };

    for (const anchor of doc.querySelectorAll("a[href]")) {
      const image = anchor.querySelector("img");
      addPhoto(
        anchor.getAttribute("href"),
        anchor.getAttribute("data-filename") ||
          (image && (image.getAttribute("alt") || image.getAttribute("title"))) ||
          anchor.textContent
      );
    }
    for (const rawCandidate of images.extractRawImageCandidates(rawHtml, pageUrl)) {
      addPhoto(rawCandidate, "");
    }

    const pageUrls = new Set([pageKey(pageUrl, pageUrl)]);
    for (const anchor of doc.querySelectorAll("a[href]")) {
      const href = supportedUrl(anchor.getAttribute("href"), pageUrl);
      if (!href || xasiatAlbumIdFromUrl(href.href, pageUrl) !== albumId || !href.searchParams.has("page")) {
        continue;
      }
      pageUrls.add(pageKey(href.href, pageUrl));
    }

    const countMatch = bodyText(doc).match(/(?:images?|photos?):\s*(\d+)/i);
    return {
      albumId,
      title: galleryTitle(doc, pageUrl, "Xasiat"),
      photos,
      pageUrls: [...pageUrls],
      totalHint: countMatch ? Number(countMatch[1]) : photos.length
    };
  }

  globalObject.MaxDownloaderXasiat = Object.freeze({
    xasiatAlbumIdFromUrl,
    xasiatImageParts,
    isXasiatAlbumUrl,
    extractXasiatAlbumPage
  });
})(globalThis);
