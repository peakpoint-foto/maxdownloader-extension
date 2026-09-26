"use strict";

// Windows-safe path helpers shared by the service worker and the control page.
(function installPathLib(globalObject) {
  "use strict";

  // Windows refuses these names even with an extension (CON.jpg is still reserved).
  const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
  const DEFAULT_PATH_BUDGET = 180;

  function trimTrailing(value) {
    return value.replace(/[. ]+$/g, "");
  }

  function safePathPart(value, fallback = "", maxLength = 90) {
    const cleaned = trimTrailing(
      String(value || "")
        .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, maxLength)
    );
    if (!cleaned) {
      return fallback;
    }
    return WINDOWS_RESERVED.test(cleaned) ? "_" + cleaned : cleaned;
  }

  function safeDownloadRoot(value) {
    return String(value || "")
      .replace(/\\/g, "/")
      .split("/")
      .map((segment) => safePathPart(segment, "", 80))
      .filter((segment) => segment && segment !== "." && segment !== "..")
      .join("/");
  }

  function fileExtension(url) {
    try {
      const pathname = new URL(url).pathname.replace(/\/+$/, "");
      const match = pathname.match(/\.([a-z0-9]{2,5})$/i);
      return match ? "." + match[1].toLowerCase() : ".jpg";
    } catch {
      return ".jpg";
    }
  }

  // Keeps the joined path inside the Windows 260-char budget by shortening folder
  // names first (deepest first) and the file name last, never the extension.
  // Two images that sanitize to the same name would otherwise start together and
  // one of them loses. Claim each name before the download starts.
  function uniqueFileName(name, usedNames) {
    const key = String(name || "").toLocaleLowerCase();
    if (!usedNames.has(key)) {
      usedNames.add(key);
      return name;
    }
    const extension = (String(name).match(/\.[a-z0-9]{2,5}$/i) || [""])[0];
    const base = String(name).slice(0, String(name).length - extension.length);
    let suffix = 2;
    let candidate = base + "-" + suffix + extension;
    while (usedNames.has(candidate.toLocaleLowerCase())) {
      suffix += 1;
      candidate = base + "-" + suffix + extension;
    }
    usedNames.add(candidate.toLocaleLowerCase());
    return candidate;
  }

  function fitPath(parts, budget = DEFAULT_PATH_BUDGET) {
    const segments = parts.filter(Boolean).map(String);
    if (!segments.length) {
      return "";
    }
    let total = segments.join("/").length;
    for (let index = segments.length - 2; index >= 0 && total > budget; index -= 1) {
      const overflow = total - budget;
      const length = Math.max(12, segments[index].length - overflow);
      if (length >= segments[index].length) {
        continue;
      }
      total -= segments[index].length - length;
      segments[index] = trimTrailing(segments[index].slice(0, length));
    }
    if (total > budget) {
      const last = segments.length - 1;
      const extension = (segments[last].match(/\.[a-z0-9]{2,5}$/i) || [""])[0];
      const base = segments[last].slice(0, segments[last].length - extension.length);
      const room = Math.max(8, budget - (total - segments[last].length) - extension.length);
      if (base.length > room) {
        total -= base.length - room;
        segments[last] = base.slice(0, room) + extension;
      }
    }
    return segments.filter(Boolean).join("/");
  }

  globalObject.MaxDownloaderPaths = Object.freeze({
    DEFAULT_PATH_BUDGET,
    safePathPart,
    safeDownloadRoot,
    fileExtension,
    uniqueFileName,
    fitPath
  });
})(globalThis);
