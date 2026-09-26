"use strict";

// Site handlers: the only place that knows how a site lists pages and turns an
// item into a full-size URL. The engine drives every site through this shape:
//
//   { site, pageKey(url), listPage(ctx) -> { title, items, pageUrls, totalHint, canonicalUrl? },
//     resolve(item, helpers) -> { imageUrl, fileName?, historyId?, harvested? },
//     historyKey(item), isExpiredDownload(result) }
//
// Adding a site = one adapter file + one handler object here.
(function installHandlers(globalObject) {
  "use strict";

  const sites = globalObject.MaxDownloaderSites;
  const paths = globalObject.MaxDownloaderPaths;
  const images = globalObject.MaxDownloaderImages;
  const imagefap = globalObject.MaxDownloaderImageFap;
  const xasiat = globalObject.MaxDownloaderXasiat;
  const viper = globalObject.MaxDownloaderViper;

  const FULL_RANK = 400;

  function pad(index) {
    return String(index + 1).padStart(3, "0");
  }

  function baseHistoryKey(site, item) {
    return site + ":" + String(item.historyId || item.photoId || "");
  }

  // Full-size URLs of *other* photos that a photo page happens to embed
  // (neighbour strips, preloads). Only exact "<photoId>.<ext>" matches count.
  function harvestImageFap(html, finalUrl, selfPhotoId) {
    const found = new Map();
    for (const raw of images.extractRawImageCandidates(html, finalUrl)) {
      const url = images.imageCandidateUrl(raw, finalUrl);
      if (!url || images.imageRank(url) < FULL_RANK) {
        continue;
      }
      let fileName = "";
      try {
        fileName = new URL(url).pathname.split("/").filter(Boolean).pop() || "";
      } catch {
        continue;
      }
      const match = fileName.match(/^(\d+)\.[a-z0-9]{2,5}$/i);
      if (!match || match[1] === String(selfPhotoId) || found.has(match[1])) {
        continue;
      }
      found.set(match[1], url);
    }
    return [...found].map(([photoId, imageUrl]) => ({ photoId, imageUrl }));
  }

  const imagefapHandler = {
    site: "imagefap",
    pageKey: (url) => sites.pageKey(url, url),
    listPage({ doc, html, finalUrl, job }) {
      if (imagefap.isPhotoUrl(finalUrl, finalUrl) && !imagefap.isGalleryUrl(finalUrl, finalUrl)) {
        const title = sites.galleryTitle(doc, finalUrl, "ImageFap");
        const galleryUrl = job.includeAlbum ? imagefap.galleryUrlFromDocument(doc, finalUrl) : "";
        if (galleryUrl) {
          return { title, items: [], pageUrls: [galleryUrl], totalHint: 0, canonicalUrl: galleryUrl };
        }
        const photoId = imagefap.photoIdFromUrl(finalUrl, finalUrl);
        const imageUrl = images.extractFullImageUrl(doc, finalUrl, html, photoId);
        return {
          title,
          items: photoId ? [{ photoId, pageUrl: finalUrl, imageUrl }] : [],
          pageUrls: [],
          totalHint: 1
        };
      }
      const page = imagefap.extractGalleryPage(doc, finalUrl);
      return {
        title: page.title,
        items: page.photos.map((photo) => ({
          photoId: photo.photoId,
          pageUrl: photo.pageUrl,
          imageUrl: photo.imageUrl || "",
          label: photo.label || ""
        })),
        pageUrls: page.pageUrls,
        totalHint: page.totalHint
      };
    },
    needsResolve: (item) => !item.imageUrl,
    async resolve(item, helpers) {
      const page = await helpers.fetchPage(item.pageUrl);
      const imageUrl = images.extractFullImageUrl(page.doc, page.finalUrl || item.pageUrl, page.html || "", item.photoId);
      if (!imageUrl) {
        throw Object.assign(new Error("Không tìm thấy ảnh full-size trên trang ảnh"), { code: "NO_IMAGE" });
      }
      return { imageUrl, harvested: harvestImageFap(page.html || "", page.finalUrl || item.pageUrl, item.photoId) };
    },
    fileName: (item) => images.fileNameFor(item.seq, item.photoId, item.imageUrl),
    historyKey: (item) => baseHistoryKey("imagefap", item),
    isExpiredDownload: () => false
  };

  const xasiatHandler = {
    site: "xasiat",
    pageKey: (url) => sites.pageKey(url, url),
    listPage({ doc, html, finalUrl }) {
      const page = xasiat.extractXasiatAlbumPage(doc, finalUrl, html);
      return {
        title: page.title,
        items: page.photos.map((photo) => ({
          photoId: photo.photoId,
          pageUrl: photo.pageUrl,
          imageUrl: photo.imageUrl,
          label: photo.label || ""
        })),
        pageUrls: page.pageUrls,
        totalHint: page.totalHint
      };
    },
    needsResolve: (item) => !item.imageUrl,
    async resolve(item) {
      // Xasiat source links come with the album page; a missing one means the
      // token expired and only a fresh album read can bring it back.
      throw Object.assign(new Error("Thiếu URL nguồn; cần đọc lại album"), { code: "EXPIRED" });
    },
    fileName: (item) => images.fileNameFor(item.seq, item.photoId, item.imageUrl),
    historyKey: (item) => baseHistoryKey("xasiat", item),
    // get_image links carry a time-limited token: 403/410 means "re-read the album".
    isExpiredDownload: (result) => Boolean(result && (result.status === 403 || result.status === 410 || result.reason === "SERVER_FORBIDDEN"))
  };

  const viperHandler = {
    site: "viper",
    pageKey: (url) => {
      try {
        return viper.canonicalThreadPageUrl(url);
      } catch {
        return String(url || "");
      }
    },
    listPage({ doc, finalUrl, job }) {
      const extracted = viper.extractThreadPage(doc, finalUrl);
      const expectedThread = viper.threadIdFromUrl(job.sourceUrl);
      if (!extracted.threadId || extracted.threadId !== expectedThread) {
        return { title: "", items: [], pageUrls: [], totalHint: 0 };
      }
      const items = [];
      for (const post of extracted.posts) {
        for (const candidate of post.candidates) {
          items.push({
            photoId: `vc:${post.postId}:${candidate.index}`,
            postId: post.postId,
            pageUrl: post.pageUrl,
            folderTitle: post.folderTitle || extracted.folderTitle || post.title,
            postTitle: post.title,
            imageUrl: "",
            resolve: { viewerUrl: candidate.viewerUrl, thumbUrl: candidate.thumbUrl, index: candidate.index }
          });
        }
      }
      return {
        title: extracted.folderTitle || extracted.threadTitle || "",
        items,
        pageUrls: job.includeAlbum ? extracted.pageUrls : [],
        totalHint: 0
      };
    },
    needsResolve: (item) => !item.imageUrl,
    async resolve(item, helpers) {
      const resolved = await viper.resolveCandidate(item.resolve || {}, {
        fetchDocument: async (url) => {
          const page = await helpers.fetchPage(url);
          return { doc: page.doc, finalUrl: page.finalUrl };
        },
        validateImage: (url) => (isKnownViperFullImage(url) ? true : helpers.probeImage(url))
      });
      const imageUrl = new URL(resolved.imageUrl).href;
      const sourceName = paths.safePathPart(resolved.sourceName || "image.jpg", "image.jpg", 60);
      const index = item.resolve && Number.isFinite(Number(item.resolve.index)) ? Number(item.resolve.index) : item.seq;
      return {
        imageUrl,
        fileName: `${pad(index)}_${item.postId}_${sourceName}`,
        // Same identity the 0.5.x history used, so old downloads still count.
        historyId: `viper:${item.postId}:${viper.stableUrlHash(imageUrl)}`
      };
    },
    fileName: (item) => item.fileName || `${pad(item.seq)}_${item.postId || "image"}.jpg`,
    historyKey: (item) => baseHistoryKey("viper", item),
    isExpiredDownload: () => false
  };

  // Hosts whose full-size URL shape is known: no HEAD request needed to trust them.
  function isKnownViperFullImage(value) {
    try {
      const url = new URL(value);
      const host = url.hostname.toLowerCase();
      return (
        (host === "image.imx.to" && /\/u\/i\//i.test(url.pathname)) ||
        (/^img\d+\.pixhost\.(?:cc|to)$/.test(host) && /\/images\//i.test(url.pathname)) ||
        (/\.imagevenue\.com$/.test(host) && !/\/th_[^/]+$/i.test(url.pathname) && /\.(?:jpe?g|png|gif|webp)$/i.test(url.pathname)) ||
        (host === "photosex.biz" && /\/pic_b\//i.test(url.pathname))
      );
    } catch {
      return false;
    }
  }

  const HANDLERS = Object.freeze({ imagefap: imagefapHandler, xasiat: xasiatHandler, viper: viperHandler });

  function siteForUrl(url) {
    return sites.supportedTargetUrl(url) ? sites.siteFromUrl(url) : "";
  }

  function catalogKey(url) {
    const site = siteForUrl(url);
    if (!site) {
      return "";
    }
    try {
      const parsed = new URL(url);
      if (site === "viper") {
        const id = viper.threadIdFromUrl(parsed.href);
        return id ? `viper:thread:${id}` : "";
      }
      if (site === "xasiat") {
        const id = xasiat.xasiatAlbumIdFromUrl(parsed.href, parsed.href);
        if (id) {
          return `xasiat:album:${id}`;
        }
      }
      if (site === "imagefap" && imagefap.isGalleryUrl(parsed.href, parsed.href)) {
        const gid = imagefap.galleryIdFromUrl(parsed.href, parsed.href);
        if (gid) {
          return `imagefap:gallery:${gid}`;
        }
      }
      if (site === "imagefap") {
        const photoId = imagefap.photoIdFromUrl(parsed.href, parsed.href);
        if (photoId) {
          return `imagefap:photo:${photoId}`;
        }
      }
      parsed.hash = "";
      parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
      for (const key of ["page", "view", "link"]) {
        parsed.searchParams.delete(key);
      }
      parsed.searchParams.sort();
      return site + ":" + parsed.href;
    } catch {
      return "";
    }
  }

  // Keys used by 0.5.x catalogs, so imported/migrated catalogs match new jobs.
  function legacyCatalogKey(site, sourceUrl) {
    return catalogKey(sourceUrl) || String(site || "") + ":" + String(sourceUrl || "");
  }

  globalObject.MaxDownloaderHandlers = Object.freeze({
    HANDLERS,
    siteForUrl,
    catalogKey,
    legacyCatalogKey,
    harvestImageFap,
    isKnownViperFullImage,
    get: (site) => HANDLERS[site] || null
  });
})(globalThis);
