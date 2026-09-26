"use strict";

// Fake ImageFap / Xasiat / Viper / image hosts for the end-to-end test.
// Chromium maps every hostname to this HTTPS server (--host-resolver-rules),
// so the extension runs unmodified against real-looking URLs.
// Scenarios covered: pagination, thumb→photo-page resolve, a deleted photo,
// a 429 with Retry-After, a CAPTCHA page mid-album, expiring Xasiat tokens,
// and Viper image hosts (rule-based + a viewer page that needs a fetch).
const https = require("node:https");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAIAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDl6KKK8c/Rz//Z",
  "base64"
);

const state = {
  requests: [],
  gallery429Served: false,
  captchaSolved: false,
  xasiatToken: "tokA",
  expiredTokens: new Set(),
  expireOnFirstHit: new Set(["9003"])
};

function html(res, body, status = 200, headers = {}) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers });
  res.end("<!doctype html><html>" + body + "</html>");
}

function image(req, res) {
  res.writeHead(200, { "content-type": "image/jpeg", "content-length": JPEG.length });
  res.end(req.method === "HEAD" ? undefined : JPEG);
}

// ---------------------------------------------------------------- ImageFap

const GID = "555";
const PHOTOS_P0 = ["1001", "1002", "1003"];
const PHOTOS_P1 = ["1004", "1005", "1006"];

function galleryPage(page) {
  const ids = page === 0 ? PHOTOS_P0 : PHOTOS_P1;
  const thumbs = ids.map((id) => `<td><a href="/photo/${id}/?pgid=&gid=${GID}&page=${page}"><img src="https://x.imagefap.com/images/thumb/1/2/${id}.jpg"></a></td>`).join("");
  return `<head><title>Porn pics of Test Gallery (Page ${page + 1})</title></head><body>
    <font itemprop="name">Test Gallery</font>
    <div>Showing 1-3 of 6 pics</div>
    <table><tr>${thumbs}</tr></table>
    <div class="pages"><a href="/pictures/${GID}/Test-Gallery?gid=${GID}&page=0">1</a> <a href="/pictures/${GID}/Test-Gallery?gid=${GID}&page=1">2</a></div>
    <table><tr><td>Users who added this gallery</td></tr></table>
  </body>`;
}

function photoPage(id) {
  if (id === "1004") {
    return `<head><title>Photo removed</title></head><body><p>This image has been removed.</p></body>`;
  }
  // 1001 also embeds its neighbours' full-size URLs (harvest path).
  const neighbours = id === "1001"
    ? `<div id="navi"><a href="https://cdn.imagefap.com/images/full/1/2/1002.jpg"></a></div>`
    : "";
  return `<head><title>Test Gallery in gallery Test Gallery (Picture 1) uploaded by x</title></head><body>
    <img id="mainPhoto" src="https://cdn.imagefap.com/images/full/1/2/${id}.jpg" width="1200" height="800">
    ${neighbours}
    <a href="/pictures/${GID}/Test-Gallery">Back to gallery</a>
  </body>`;
}

const SLOW_GID = "556";
const SLOW_PHOTOS = ["2001", "2002", "2003", "2004"];

function slowGallery() {
  const cells = SLOW_PHOTOS.map((id) => `<td><a href="/photo/${id}/?gid=${SLOW_GID}"><img src="https://x.imagefap.com/images/thumb/9/9/${id}.jpg"></a></td>`).join("");
  return `<head><title>Slow</title></head><body><font itemprop="name">Slow Gallery</font><div>of 4 pics</div><table><tr>${cells}</tr></table></body>`;
}

function imagefap(req, res, url) {
  if (url.pathname.startsWith(`/pictures/${SLOW_GID}/`)) {
    html(res, slowGallery());
    return;
  }
  if (url.pathname.startsWith("/images/full/9/9/")) {
    // Slow files: the test restarts the engine while these are in flight.
    setTimeout(() => image(req, res), 2500);
    return;
  }
  if (url.pathname.startsWith(`/pictures/${GID}/`)) {
    const page = Number(url.searchParams.get("page") || 0);
    if (page === 1 && !state.gallery429Served) {
      state.gallery429Served = true;
      res.writeHead(429, { "retry-after": "1", "content-type": "text/plain" });
      res.end("slow down");
      return;
    }
    html(res, galleryPage(page));
    return;
  }
  const photo = url.pathname.match(/^\/photo\/(\d+)\/?$/);
  if (photo && SLOW_PHOTOS.includes(photo[1])) {
    html(res, `<body><img src="https://cdn.imagefap.com/images/full/9/9/${photo[1]}.jpg"></body>`);
    return;
  }
  if (photo) {
    html(res, photoPage(photo[1]));
    return;
  }
  if (url.pathname.startsWith("/images/")) {
    image(req, res);
    return;
  }
  html(res, "<body>ImageFap home</body>");
}

// ------------------------------------------------------------------ Xasiat

const ALBUM = "777";
const XAS_P1 = ["9001", "9002"];
const XAS_P2 = ["9003", "9004"];

function xasiatAlbum(page) {
  const ids = page === 2 ? XAS_P2 : XAS_P1;
  const links = ids.map((id) => `<a href="https://www.xasiat.com/get_image/2/${state.xasiatToken}/sources/1000/${ALBUM}/${id}.jpg/" data-filename="${id}.jpg"><img src="https://www.xasiat.com/thumbs/${id}.jpg"></a>`).join("");
  return `<head><title>Cosplay Test Album - Xasiat</title></head><body>
    <h1>Cosplay Test Album</h1><div>Images: 4</div>
    ${links}
    <a href="/albums/${ALBUM}/cosplay-test-album/?page=2">2</a>
  </body>`;
}

const CAPTCHA_PAGE = `<head><title>Human verification</title></head><body>
  <h1>Please verify you are a human</h1>
  <form action="/captcha/verify" method="post"><div class="g-recaptcha" data-sitekey="test"></div></form>
</body>`;

function xasiat(req, res, url) {
  if (url.pathname.startsWith(`/albums/${ALBUM}/`)) {
    const page = Number(url.searchParams.get("page") || 1);
    if (page === 2 && !state.captchaSolved) {
      html(res, CAPTCHA_PAGE);
      return;
    }
    html(res, xasiatAlbum(page));
    return;
  }
  if (url.pathname.startsWith("/captcha")) {
    html(res, state.captchaSolved ? "<head><title>OK</title></head><body>Verified, thanks.</body>" : CAPTCHA_PAGE);
    return;
  }
  const source = url.pathname.match(/^\/get_image\/2\/([^/]+)\/sources\/1000\/777\/(\d+)\.jpg\/?$/);
  if (source) {
    const [, token, id] = source;
    if (state.expireOnFirstHit.has(id)) {
      // Simulate a token that expired between scan and download.
      state.expireOnFirstHit.delete(id);
      state.expiredTokens.add(token);
      state.xasiatToken = "tokB";
    }
    if (state.expiredTokens.has(token) && id === "9003") {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("expired");
      return;
    }
    image(req, res);
    return;
  }
  html(res, "<body>Xasiat</body>");
}

// ------------------------------------------------------------------- Viper

function viperThread() {
  return `<head><title>Test Thread - ViperGirls</title></head><body>
    <div id="breadcrumb"><a href="forums/1-Misc">Misc</a><a href="forums/2-Sets">Sets</a></div>
    <div id="pagetitle"><h1><span class="threadtitle"><a href="threads/12345-Test-Thread">Test Thread</a></span></h1></div>
    <ol>
      <li class="postcontainer" id="post_111">
        <h2 class="title icon">Post Alpha</h2>
        <div id="post_message_111"><blockquote class="postcontent restore">
          <a href="https://imx.to/i/abc"><img src="https://image.imx.to/u/t/2026/01/01/abc.jpg"></a>
          <a href="https://pixhost.cc/show/1/zzz.jpg"><img src="https://t1.pixhost.cc/thumbs/1/zzz.jpg"></a>
          <a href="https://viewer.pixhost.to/show/q"><img src="https://viewer.pixhost.to/small/q.jpg"></a>
        </blockquote></div>
      </li>
    </ol>
  </body>`;
}

function viper(req, res, url) {
  if (url.pathname.startsWith("/threads/12345")) {
    html(res, viperThread());
    return;
  }
  html(res, "<body>Viper</body>");
}

// ----------------------------------------------------------------- routing

function route(req, res) {
  const host = String(req.headers.host || "").split(":")[0].toLowerCase();
  const url = new URL(req.url, "https://" + host);
  state.requests.push({
    at: Date.now(),
    method: req.method,
    host,
    path: url.pathname + url.search,
    site: req.headers["sec-fetch-site"] || "",
    referer: req.headers.referer || ""
  });
  if (host.endsWith("imagefap.com")) {
    return imagefap(req, res, url);
  }
  if (host.endsWith("xasiat.com")) {
    return xasiat(req, res, url);
  }
  if (host === "viper.to" || host === "www.viper.to") {
    return viper(req, res, url);
  }
  if (host === "viewer.pixhost.to") {
    if (url.pathname.startsWith("/show/")) {
      return html(res, `<body><img src="/logo.png"><img id="image" src="https://files.pixhost.to/full/q.jpg"></body>`);
    }
    return image(req, res);
  }
  if (/(^|\.)imx\.to$|pixhost\.(cc|to)$/.test(host)) {
    return image(req, res);
  }
  res.writeHead(404);
  res.end();
}

function makeCert(dir) {
  const key = path.join(dir, "key.pem");
  const cert = path.join(dir, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "2", "-subj", "/CN=fixture"], { stdio: "ignore" });
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

function start({ port = 8443, controlPort = 8444 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maxdl-fixture-"));
  const server = https.createServer(makeCert(dir), route);
  const control = http.createServer((req, res) => {
    if (req.url === "/solve") {
      state.captchaSolved = true;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ...state, expiredTokens: [...state.expiredTokens], expireOnFirstHit: [...state.expireOnFirstHit] }));
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      control.listen(controlPort, "127.0.0.1", () => resolve({ server, control, state }));
    });
  });
}

module.exports = { start, state };

if (require.main === module) {
  start().then(() => console.log("fixture on https://127.0.0.1:8443 (control :8444)"));
}
