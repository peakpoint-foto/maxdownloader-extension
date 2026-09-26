(function installViperAdapter(globalObject) {
  "use strict";

  const sites = globalObject.MaxDownloaderSites;
  const paths = globalObject.MaxDownloaderPaths;
  const cleanText = sites.cleanText;

  const IMAGE_PATH = /\.(?:jpe?g|png|webp|gif)$/i;

  function threadIdFromUrl(value) {
    try {
      const match = new URL(value).pathname.match(/^\/threads\/(\d+)(?:-|\/|$)/i);
      return match ? match[1] : "";
    } catch {
      return "";
    }
  }

  function canonicalThreadPageUrl(value) {
    const url = new URL(value);
    url.protocol = "https:";
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    url.hash = "";
    for (const key of ["s", "p", "viewfull", "styleid", "goto"]) {
      url.searchParams.delete(key);
    }
    url.searchParams.sort();
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url.href;
  }

  function canonicalThreadUrl(value) {
    const id = threadIdFromUrl(value);
    return id ? `https://viper.to/threads/${id}` : "";
  }

  function stableUrlHash(value) {
    let hash = 0x811c9dc5;
    for (const character of String(value || "")) {
      hash ^= character.codePointAt(0);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36);
  }

  function threadTitleFromDocument(doc, pageUrl) {
    const candidates = [
      doc.querySelector("#pagetitle h1 .threadtitle a"),
      doc.querySelector("#pagetitle .threadtitle a"),
      doc.querySelector("#pagetitle .threadtitle"),
      doc.querySelector("h1 .threadtitle a"),
      doc.querySelector("h1.threadtitle"),
      doc.querySelector('meta[property="og:title"]')
    ];
    for (const node of candidates) {
      const raw = node && (node.getAttribute("content") || node.textContent);
      const title = cleanText(raw)
        .replace(/^Thread:\s*/i, "")
        .replace(/\s*(?:\||-)\s*Viper(?:Girls)?\s*$/i, "");
      if (title && !/^Viper(?:Girls)?$/i.test(title)) {
        return title;
      }
    }

    try {
      const match = new URL(pageUrl).pathname.match(/\/threads\/\d+-([^/]+)/i);
      return match
        ? cleanText(decodeURIComponent(match[1]).replace(/[-_]+/g, " "))
        : "";
    } catch {
      return "";
    }
  }

  function forumTitlesFromDocument(doc) {
    const seen = new Set();
    const titles = [];
    for (const link of doc.querySelectorAll('#breadcrumb a[href*="forums/"], .breadcrumb a[href*="forums/"]')) {
      const title = cleanText(link.textContent);
      if (title && !seen.has(title)) {
        seen.add(title);
        titles.push(title);
      }
    }
    return titles;
  }

  function folderTitleFromDocument(doc, title, pageUrl) {
    const threadTitle = cleanText(title) || threadTitleFromDocument(doc, pageUrl);
    const forumPrefix = forumTitlesFromDocument(doc)
      .map((forumTitle) => `[${forumTitle}]`)
      .join("");
    return forumPrefix && threadTitle ? `${forumPrefix}-${threadTitle}` : threadTitle;
  }

  function sourceNameFromUrl(value) {
    try {
      const pathname = new URL(value).pathname.replace(/\/+$/, "");
      return decodeURIComponent(pathname.split("/").pop() || "image.jpg");
    } catch {
      return "image.jpg";
    }
  }

  function isThumbnailUrl(value) {
    try {
      const url = new URL(value);
      return /\/thumbs\/|\/u\/t\/|\/th_[^/]+$|\/imager\/w_\d+\/h_\d+\//i.test(url.pathname);
    } catch {
      return true;
    }
  }

  function postIdFromElement(post) {
    const match = String(post.id || "").match(/^post_(\d+)$/);
    return match ? match[1] : "";
  }

  function titleForPost(post, postId, fallbackTitle) {
    const heading = [...post.querySelectorAll("h2.title.icon, h2.title, h2[class*='title']")]
      .find((node) => node.closest("li.postcontainer") === post);
    return cleanText(heading && heading.textContent) || fallbackTitle || `Post ${postId}`;
  }

  function attributeUrl(node, attribute, baseUrl) {
    const value = node.getAttribute(attribute);
    if (!value || /^(?:data|javascript|about):/i.test(value)) {
      return "";
    }
    try {
      return new URL(value, baseUrl).href;
    } catch {
      return "";
    }
  }

  function isInternalViperAsset(url) {
    try {
      const parsed = new URL(url);
      const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
      return host === "viper.to" && (
        parsed.pathname.startsWith("/images/") ||
        /avatar|smil|favicon|logo|banner/i.test(parsed.pathname)
      );
    } catch {
      return true;
    }
  }

  function candidatesForPost(post, pageUrl) {
    const content = post.querySelector('div[id^="post_message_"] blockquote.postcontent.restore');
    if (!content) {
      return [];
    }
    const seenNodes = new Set();
    const candidates = [];
    for (const image of content.querySelectorAll("a[href] > img[src], img[src], img[data-src], img[data-original]")) {
      if (seenNodes.has(image)) {
        continue;
      }
      seenNodes.add(image);
      if (image.closest(".bbcode_quote") || image.classList.contains("inlineimg")) {
        continue;
      }
      const thumbUrl = attributeUrl(image, "data-original", pageUrl) ||
        attributeUrl(image, "data-src", pageUrl) ||
        attributeUrl(image, "src", pageUrl);
      if (!thumbUrl || isInternalViperAsset(thumbUrl)) {
        continue;
      }
      const anchor = image.closest("a[href]");
      const viewerUrl = anchor ? attributeUrl(anchor, "href", pageUrl) : "";
      if (!viewerUrl && !IMAGE_PATH.test(new URL(thumbUrl).pathname)) {
        continue;
      }
      candidates.push({
        viewerUrl,
        thumbUrl,
        index: candidates.length
      });
    }
    return candidates;
  }

  function extractThreadPage(doc, pageUrl) {
    const threadId = threadIdFromUrl(pageUrl);
    const threadTitle = threadTitleFromDocument(doc, pageUrl);
    const threadFolderTitle = folderTitleFromDocument(doc, threadTitle, pageUrl);
    const pageMatch = new URL(pageUrl).pathname.match(/\/page(\d+)\/?$/i);
    const pageUrls = [...doc.querySelectorAll(".pagination a[href]")]
      .map((link) => attributeUrl(link, "href", pageUrl))
      .filter((url) => url && threadIdFromUrl(url) === threadId)
      .map(canonicalThreadPageUrl)
      .filter((url, index, all) => all.indexOf(url) === index);
    const posts = [...doc.querySelectorAll('li.postcontainer[id^="post_"]')]
      .map((post) => {
        const postId = postIdFromElement(post);
        const postTitle = titleForPost(post, postId, threadTitle);
        return {
          postId,
          title: postTitle,
          folderTitle: folderTitleFromDocument(doc, postTitle, pageUrl) || threadFolderTitle,
          pageUrl: canonicalThreadPageUrl(pageUrl),
          candidates: candidatesForPost(post, pageUrl)
        };
      });
    return {
      threadId,
      threadTitle,
      folderTitle: threadFolderTitle,
      pageNumber: pageMatch ? Number(pageMatch[1]) : 1,
      pageUrls,
      posts
    };
  }

  // Host rules turn a known thumbnail/viewer URL into a full-size URL without an
  // extra round trip. Add new image hosts here instead of extending if-chains.
  const HOST_RULES = [
    {
      name: "imx",
      resolve(viewer, thumb) {
        if (thumb.hostname !== "image.imx.to" || !thumb.pathname.includes("/u/t/")) {
          return "";
        }
        return thumb.href.replace("/u/t/", "/u/i/");
      }
    },
    {
      name: "pixhost",
      resolve(viewer, thumb) {
        if (!/^t\d+\.pixhost\.cc$/.test(thumb.hostname) || !thumb.pathname.includes("/thumbs/")) {
          return "";
        }
        const url = new URL(thumb.href);
        const hostNumber = thumb.hostname.slice(1).split(".")[0];
        url.hostname = `img${hostNumber}.pixhost.cc`;
        url.pathname = url.pathname.replace("/thumbs/", "/images/");
        return url.href;
      }
    },
    {
      name: "imagevenue",
      resolve(viewer, thumb) {
        if (!/\.imagevenue\.com$/.test(thumb.hostname) || !/\/th_[^/]+$/i.test(thumb.pathname)) {
          return "";
        }
        const url = new URL(thumb.href.replace(/^http:/, "https:"));
        url.pathname = url.pathname.replace(/\/th_([^/]+)$/i, "/$1");
        return url.href;
      }
    },
    {
      name: "photosex",
      resolve(viewer) {
        if (viewer.hostname !== "photosex.biz" || viewer.pathname !== "/v.php") {
          return "";
        }
        const id = viewer.searchParams.get("id");
        return id ? `https://photosex.biz/pic_b/${encodeURIComponent(id)}.jpg` : "";
      }
    }
  ];

  async function verified(value, helpers) {
    const url = new URL(value).href;
    if (isThumbnailUrl(url) || !(await helpers.validateImage(url))) {
      throw new Error(`full-size image validation failed: ${url}`);
    }
    return { imageUrl: url, sourceName: sourceNameFromUrl(url) };
  }

  async function resolveFromViewerDocument(viewerUrl, helpers) {
    const { doc, finalUrl } = await helpers.fetchDocument(viewerUrl);
    const values = [];
    for (const image of doc.querySelectorAll("img[src], img[data-src], img[data-original]")) {
      const raw = image.getAttribute("data-original") || image.getAttribute("data-src") || image.getAttribute("src");
      if (raw) {
        values.push(new URL(raw, finalUrl).href);
      }
    }
    const ogImage = doc.querySelector('meta[property="og:image"], meta[name="twitter:image"]')?.content;
    if (ogImage) {
      values.push(new URL(ogImage, finalUrl).href);
    }
    const candidates = [...new Set(values)]
      .filter((url) => !isThumbnailUrl(url))
      .filter((url) => !/logo|icon|banner|avatar|smil/i.test(new URL(url).pathname))
      .sort((left, right) => {
        const rank = (url) => /\/images\/|\/full\/|\/original\/|\/u\/i\/|\/pic_b\//i.test(new URL(url).pathname) ? 1 : 0;
        return rank(right) - rank(left);
      });
    for (const candidate of candidates) {
      if (await helpers.validateImage(candidate)) {
        return { imageUrl: candidate, sourceName: sourceNameFromUrl(candidate) };
      }
    }
    throw new Error(`no full-size image found at ${viewerUrl}`);
  }

  async function resolveCandidate(candidate, helpers) {
    const viewer = new URL(candidate.viewerUrl || candidate.thumbUrl);
    const thumb = new URL(candidate.thumbUrl || candidate.viewerUrl);

    if (viewer.hostname === "viper.click" && viewer.pathname.includes("/expired/")) {
      throw new Error("expired image host");
    }
    for (const rule of HOST_RULES) {
      const resolved = rule.resolve(viewer, thumb);
      if (resolved) {
        return verified(resolved, helpers);
      }
    }
    if (!candidate.viewerUrl && IMAGE_PATH.test(thumb.pathname) && !isThumbnailUrl(thumb.href)) {
      return verified(thumb.href, helpers);
    }
    if (IMAGE_PATH.test(viewer.pathname) && !isThumbnailUrl(viewer.href)) {
      return verified(viewer.href, helpers);
    }
    return resolveFromViewerDocument(viewer.href, helpers);
  }

  // Resolves every candidate of a page with bounded concurrency; the caller's
  // onItem receives items in completion order and applies cross-page dedupe.
  async function buildItemsFromPage(page, resolver, options = {}) {
    const concurrency = Math.min(8, Math.max(1, Math.round(Number(options.concurrency) || 1)));
    const onItem = typeof options.onItem === "function" ? options.onItem : async () => undefined;
    const onError = typeof options.onError === "function" ? options.onError : () => undefined;
    const tasks = [];
    for (const post of page.posts) {
      for (const candidate of post.candidates) {
        tasks.push({ post, candidate });
      }
    }
    const items = [];
    const errors = [];
    const seen = new Set();
    let cursor = 0;

    async function worker() {
      while (cursor < tasks.length) {
        const index = cursor++;
        if (index >= tasks.length) {
          return;
        }
        const { post, candidate } = tasks[index];
        let item;
        try {
          const resolved = await resolver(candidate);
          const canonicalImageUrl = new URL(resolved.imageUrl).href;
          const duplicateKey = `${post.postId}:${canonicalImageUrl}`;
          if (seen.has(duplicateKey)) {
            continue;
          }
          seen.add(duplicateKey);
          const sourceName = paths.safePathPart(
            resolved.sourceName || sourceNameFromUrl(canonicalImageUrl),
            "image.jpg",
            60
          );
          item = {
            photoId: `viper:${post.postId}:${stableUrlHash(canonicalImageUrl)}`,
            postId: post.postId,
            pageUrl: post.pageUrl,
            imageUrl: canonicalImageUrl,
            fileName: `${String(candidate.index + 1).padStart(3, "0")}_${post.postId}_${sourceName}`,
            folderTitle: post.folderTitle || page.folderTitle || post.title
          };
          items[index] = item;
        } catch (error) {
          const entry = {
            photoId: `viper:${post.postId}:${candidate.index}`,
            pageUrl: post.pageUrl,
            message: error instanceof Error ? error.message : String(error)
          };
          errors.push(entry);
          onError(entry);
          continue;
        }
        await onItem(item);
      }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(tasks.length, 1)) }, () => worker()));
    return { items: items.filter(Boolean), errors };
  }

  globalObject.MaxDownloaderViper = Object.freeze({
    isThreadUrl: (value) => Boolean(threadIdFromUrl(value)),
    threadIdFromUrl,
    canonicalThreadUrl,
    canonicalThreadPageUrl,
    extractThreadPage,
    resolveCandidate,
    buildItemsFromPage,
    stableUrlHash
  });
})(globalThis);
