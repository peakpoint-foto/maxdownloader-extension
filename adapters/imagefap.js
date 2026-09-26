"use strict";

// ImageFap gallery extraction: gallery pages, photo links, pagination.
(function installImageFapAdapter(globalObject) {
  "use strict";

  const sites = globalObject.MaxDownloaderSites;
  const images = globalObject.MaxDownloaderImages;
  const { cleanText, bodyText, pageKey, siteFromUrl, supportedUrl, galleryTitle } = sites;

  // large/full/original/hd only. medium and below stay empty so resolvePhoto fetches the photo page.
  const GALLERY_IMAGE_RANK = 400;

  function galleryImageUrl(anchor, pageUrl) {
    const image = anchor.querySelector && anchor.querySelector("img");
    const values = [
      anchor.getAttribute("href"),
      image && (image.getAttribute("data-src") || image.getAttribute("data-original") || image.getAttribute("data-lazy-src") || image.getAttribute("src"))
    ];
    let best = "";
    let bestRank = 0;
    for (const value of values) {
      const url = images.imageCandidateUrl(value, pageUrl);
      const rank = url ? images.imageRank(url) : 0;
      if (url && rank >= GALLERY_IMAGE_RANK && rank > bestRank) {
        best = url;
        bestRank = rank;
      }
    }
    return best;
  }

  function photoIdFromUrl(value, baseUrl) {
    const url = sites.parseUrl(value, baseUrl);
    const match = url && url.pathname.match(/\/photo\/(\d+)/i);
    return match ? match[1] : "";
  }

  function galleryIdFromUrl(value, baseUrl) {
    try {
      const url = new URL(value, baseUrl);
      const queryId = url.searchParams.get("gid");
      if (/^\d+$/.test(queryId || "")) {
        return queryId;
      }
      const pathMatch = url.pathname.match(/\/(?:gallery|pictures)\/(\d+)/i);
      return pathMatch ? pathMatch[1] : "";
    } catch {
      return "";
    }
  }

  function galleryIdFromDocument(doc, pageUrl) {
    const fromUrl = galleryIdFromUrl(pageUrl, pageUrl);
    if (fromUrl) {
      return fromUrl;
    }
    for (const anchor of doc.querySelectorAll("a[href]")) {
      const href = supportedUrl(anchor.getAttribute("href"), pageUrl);
      const id = href && galleryIdFromUrl(href.href, pageUrl);
      if (id) {
        return id;
      }
    }
    return "";
  }

  function isPhotoUrl(value, baseUrl) {
    return Boolean(photoIdFromUrl(value, baseUrl));
  }

  function isGalleryUrl(value, baseUrl) {
    const url = sites.parseUrl(value, baseUrl);
    if (!url || siteFromUrl(url.href) !== "imagefap" || isPhotoUrl(url.href, url.href)) {
      return false;
    }
    return /\/(?:gallery|pictures)(?:\.php)?\//i.test(url.pathname)
      || url.pathname.endsWith("/gallery.php")
      || url.searchParams.has("gid");
  }

  function extractGalleryPage(doc, pageUrl) {
    const galleryId = galleryIdFromDocument(doc, pageUrl);
    const photos = [];
    const seenPhotoIds = new Set();

    for (const anchor of doc.querySelectorAll("a[href]")) {
      const href = supportedUrl(anchor.getAttribute("href"), pageUrl);
      if (!href) {
        continue;
      }
      const photoId = photoIdFromUrl(href.href, pageUrl);
      if (!photoId || seenPhotoIds.has(photoId)) {
        continue;
      }
      const linkGalleryId = href.searchParams.get("gid") || galleryIdFromUrl(href.href, pageUrl);
      if (galleryId && linkGalleryId !== galleryId) {
        continue;
      }
      seenPhotoIds.add(photoId);
      photos.push({
        pageUrl: href.href,
        photoId,
        imageUrl: galleryImageUrl(anchor, pageUrl),
        label: cleanText(anchor.textContent)
      });
    }

    const pageUrls = new Set([pageKey(pageUrl, pageUrl)]);
    for (const anchor of doc.querySelectorAll("a[href]")) {
      const href = supportedUrl(anchor.getAttribute("href"), pageUrl);
      if (!href || isPhotoUrl(href.href, pageUrl) || !href.searchParams.has("page")) {
        continue;
      }
      const linkGalleryId = href.searchParams.get("gid") || galleryIdFromUrl(href.href, pageUrl);
      if (galleryId && linkGalleryId !== galleryId) {
        continue;
      }
      pageUrls.add(pageKey(href.href, pageUrl));
    }

    const countMatch = bodyText(doc).match(/of\s+(\d+)\s+pics?/i);
    return {
      galleryId,
      title: galleryTitle(doc, pageUrl, "ImageFap"),
      photos,
      pageUrls: [...pageUrls],
      totalHint: countMatch ? Number(countMatch[1]) : 0
    };
  }

  function galleryUrlFromDocument(doc, pageUrl) {
    for (const anchor of doc.querySelectorAll("a[href]")) {
      const href = supportedUrl(anchor.getAttribute("href"), pageUrl);
      if (!href) {
        continue;
      }
      if (/\/gallery\.php$/i.test(href.pathname) && href.searchParams.has("gid")) {
        return href.href;
      }
      if (/\/gallery\/\d+\/?$/i.test(href.pathname)) {
        return href.href;
      }
      if (/\/pictures\/\d+\//i.test(href.pathname)) {
        return href.href;
      }
    }
    return "";
  }

  globalObject.MaxDownloaderImageFap = Object.freeze({
    photoIdFromUrl,
    galleryIdFromUrl,
    galleryIdFromDocument,
    isPhotoUrl,
    isGalleryUrl,
    extractGalleryPage,
    galleryUrlFromDocument
  });
})(globalThis);
