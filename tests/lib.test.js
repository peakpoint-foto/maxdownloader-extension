"use strict";

// Loads the browser IIFEs into Node's globalThis in manifest order, then checks
// the pure helpers that were extracted out of content.js/background.js.
// Run: node --test tests/lib.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const root = path.join(__dirname, "..");
for (const file of [
  "lib/sites.js",
  "lib/paths.js",
  "lib/images.js",
  "adapters/imagefap.js",
  "adapters/xasiat.js",
  "adapters/viper.js"
]) {
  require(path.join(root, file));
}

const sites = globalThis.MaxDownloaderSites;
const paths = globalThis.MaxDownloaderPaths;
const images = globalThis.MaxDownloaderImages;
const imagefap = globalThis.MaxDownloaderImageFap;
const xasiat = globalThis.MaxDownloaderXasiat;
const viper = globalThis.MaxDownloaderViper;

test("site routing", () => {
  assert.equal(sites.siteFromUrl("https://www.imagefap.com/gallery.php?gid=1"), "imagefap");
  assert.equal(sites.siteFromUrl("https://xascdn.li/whatever"), "");
  assert.equal(sites.siteLabel("xasiat"), "Xasiat");
  assert.equal(sites.normalizeSite("nonsense"), "imagefap");
});

test("only viper thread pages are download targets", () => {
  const thread = "https://viper.to/threads/10232122-ViperGirls-Photoshoot-051-Sunshine";
  assert.equal(sites.supportedTargetUrl(thread), true);
  assert.equal(sites.isViperThreadUrl(thread + "/page2"), true);
  assert.equal(sites.supportedTargetUrl("https://viper.to/whats-new/"), false);
  assert.equal(sites.supportedTargetUrl("https://viper.to/human-verification"), false);
});

test("windows reserved names and illegal characters", () => {
  assert.equal(paths.safePathPart("CON"), "_CON");
  assert.equal(paths.safePathPart("lpt1.jpg"), "_lpt1.jpg");
  const cleaned = paths.safePathPart('a<b>c:d"e/f\\g|h?i*j');
  assert.equal(/[<>:"/\\|?*]/.test(cleaned), false);
  assert.equal(paths.safePathPart("  trailing.  "), "trailing");
  assert.equal(paths.safePathPart("", "fallback"), "fallback");
});

test("path budget shortens folder names but keeps the extension", () => {
  const longFolder = "x".repeat(120);
  const fitted = paths.fitPath(["Viper", longFolder, longFolder, "001_12345.jpg"]);
  assert.ok(fitted.length <= paths.DEFAULT_PATH_BUDGET, fitted.length + " > budget");
  assert.ok(fitted.endsWith(".jpg"));
});

test("duplicate file names get a suffix before the download starts", () => {
  const used = new Set();
  assert.equal(paths.uniqueFileName("001_9.jpg", used), "001_9.jpg");
  assert.equal(paths.uniqueFileName("001_9.jpg", used), "001_9-2.jpg");
  assert.equal(paths.uniqueFileName("001_9.JPG", used), "001_9-3.JPG");
  assert.equal(used.size, 3);
});

test("image url rules", () => {
  assert.equal(
    images.imageCandidateUrl("https://www.imagefap.com/images/full/1/2/3.jpg"),
    "https://www.imagefap.com/images/full/1/2/3.jpg"
  );
  assert.equal(images.imageCandidateUrl("https://example.com/a.jpg"), null);
  assert.equal(images.fileNameFor(0, "12345", "https://x/a.webp"), "001_12345.webp");
  assert.equal(paths.fileExtension("https://x/a.JPEG?token=1"), ".jpeg");
});

test("imagefap and xasiat url parsing", () => {
  assert.equal(imagefap.photoIdFromUrl("https://www.imagefap.com/photo/1619639924/?link=thm"), "1619639924");
  assert.equal(imagefap.galleryIdFromUrl("https://www.imagefap.com/gallery.php?gid=12345"), "12345");
  assert.equal(imagefap.isGalleryUrl("https://www.imagefap.com/pictures/12345/some-album"), true);
  assert.equal(imagefap.isGalleryUrl("https://www.imagefap.com/photo/1619639924/"), false);
  assert.equal(xasiat.xasiatAlbumIdFromUrl("https://www.xasiat.com/albums/37678/cosplay-machi-147p-970mb/"), "37678");
  assert.deepEqual(
    xasiat.xasiatImageParts("https://xascdn.li/get_image/abc/sources/99/37678/998877.jpg/"),
    { albumId: "37678", photoId: "998877", extension: "jpg" }
  );
});

test("viper url canonicalization and hashing", () => {
  const url = "https://www.viper.to/threads/10232122-Slug/page3?viewfull=1&s=abc";
  assert.equal(viper.threadIdFromUrl(url), "10232122");
  assert.equal(viper.canonicalThreadPageUrl(url), "https://viper.to/threads/10232122-Slug/page3");
  assert.equal(viper.stableUrlHash("https://a"), viper.stableUrlHash("https://a"));
  assert.notEqual(viper.stableUrlHash("https://a"), viper.stableUrlHash("https://b"));
});

// Minimal fake document: only the members verificationKind touches.
function fakeDocument({ title = "", text = "", widget = "" } = {}) {
  return {
    title,
    body: { innerText: text, textContent: text },
    querySelector: (selector) => (widget && selector.includes(widget) ? {} : null)
  };
}

test("captcha detection: path, widget and text signals", () => {
  assert.equal(
    sites.verificationKind(fakeDocument(), "https://www.imagefap.com/human-verification?page=2"),
    "path"
  );
  assert.equal(
    sites.verificationKind(fakeDocument({ widget: "recaptcha" }), "https://www.imagefap.com/gallery.php?gid=1"),
    "widget"
  );
  assert.equal(
    sites.verificationKind(fakeDocument({ text: "Checking your browser before accessing imagefap.com" }), "https://www.imagefap.com/gallery.php?gid=1"),
    "text"
  );
});

test("captcha detection: a normal gallery page is not a challenge", () => {
  const gallery = fakeDocument({
    title: "Some Album - ImageFap",
    text: "Gallery: Some Album (120 pictures) 120 Porn Pics. Report this gallery. Users who added this gallery."
  });
  assert.equal(sites.verificationKind(gallery, "https://www.imagefap.com/pictures/12345/some-album"), "");
  assert.equal(sites.verificationDocument(gallery, "https://www.imagefap.com/pictures/12345/some-album"), false);
});

function element(attrs, children) {
  return {
    getAttribute: (name) => (Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null),
    querySelector: (selector) => (selector === "img" ? (children || null) : null),
    querySelectorAll: () => [],
    textContent: attrs.text || ""
  };
}

function galleryDocument(anchors, text) {
  return {
    title: "Some Album - ImageFap",
    body: { textContent: text, innerText: "" },
    querySelector: () => null,
    querySelectorAll: (selector) => (selector === "a[href]" ? anchors : [])
  };
}

test("gallery page keeps a full image url and ignores a thumb", () => {
  const pageUrl = "https://www.imagefap.com/gallery.php?gid=12345";
  const doc = galleryDocument([
    element({ href: "/photo/111/?gid=12345" }, element({ src: "https://www.imagefap.com/images/full/1/111.jpg" })),
    element({ href: "/photo/222/?gid=12345" }, element({ src: "https://www.imagefap.com/images/thumb/1/222.jpg" }))
  ], "Gallery: Some Album of 40 pics");
  const page = imagefap.extractGalleryPage(doc, pageUrl);
  assert.equal(page.totalHint, 40);
  assert.equal(page.photos[0].imageUrl, "https://www.imagefap.com/images/full/1/111.jpg");
  assert.equal(page.photos[1].imageUrl, "");
});

test("xasiat count comes from textContent, not innerText", () => {
  const pageUrl = "https://www.xasiat.com/albums/37678/cosplay/";
  const doc = galleryDocument(
    [element({ href: "https://www.xasiat.com/get_image/abc/def/sources/99/37678/998877.jpg/" })],
    "Album title. Images: 12"
  );
  const page = xasiat.extractXasiatAlbumPage(doc, pageUrl, "");
  assert.equal(page.totalHint, 12);
  assert.equal(page.photos.length, 1);
});

