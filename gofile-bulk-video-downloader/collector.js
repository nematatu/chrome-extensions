(function (root) {
  "use strict";

  async function collectGofilePageVideos(expectedPageUrl) {
    "use strict";

    const PAGE_SIZE = 1000;
    const MAX_PAGES = 100;
    const MAX_VIDEOS = 10000;
    const READY_TIMEOUT_MS = 5000;
    const READY_POLL_MS = 100;
    const VIDEO_EXTENSIONS = new Set([
      "3g2", "3gp", "avi", "flv", "m2ts", "m4v", "mkv", "mov", "mp4",
      "mpe", "mpeg", "mpg", "mts", "ogv", "ts", "webm", "wmv",
    ]);
    const GENERIC_MIME_TYPES = new Set(["", "application/octet-stream", "binary/octet-stream"]);

    function failure(code) {
      return { ok: false, error: code };
    }

    function sharePath(pathname) {
      if (typeof pathname !== "string") return null;
      const match = pathname.match(/^\/d\/([^/]+)\/?$/);
      if (!match) return null;

      let token;
      try {
        token = decodeURIComponent(match[1]);
      } catch {
        return null;
      }
      if (!token || /[\u0000-\u001f\u007f/\\]/.test(token)) return null;

      return {
        pathname: `/d/${match[1]}`,
        token,
      };
    }

    function mainContent() {
      if (typeof appdata === "undefined") return null;
      return appdata?.fileManager?.mainContent || null;
    }

    function folderIdentity(content) {
      if (content?.data?.type !== "folder" || typeof content.data.id !== "string") return "";
      return content.data.id;
    }

    function wait(milliseconds) {
      return new Promise((resolve) => setTimeout(resolve, milliseconds));
    }

    function fileManagerDomReady() {
      if (typeof document === "undefined") return true;
      const main = document.getElementById("filemanager_maincontent");
      if (!main) return false;
      const loading = document.getElementById("filemanager_loading");
      if (!loading || loading.hidden) return true;
      if (typeof getComputedStyle !== "function") return false;
      const style = getComputedStyle(loading);
      return style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0;
    }

    function isVideo(item) {
      if (!item || item.type !== "file") return false;
      const mime = typeof item.mimetype === "string" ? item.mimetype.trim().toLowerCase() : "";
      if (mime.startsWith("video/")) return true;
      if (!GENERIC_MIME_TYPES.has(mime)) return false;
      const match = String(item.name || "").toLowerCase().match(/\.([a-z0-9]{2,5})$/);
      return Boolean(match && VIDEO_EXTENSIONS.has(match[1]));
    }

    function safeItem(item) {
      return {
        id: typeof item.id === "string" ? item.id.slice(0, 160) : "",
        type: item.type,
        name: typeof item.name === "string" ? item.name.slice(0, 512) : "",
        size: Number.isSafeInteger(Number(item.size)) && Number(item.size) >= 0 ? Number(item.size) : 0,
        mimetype: typeof item.mimetype === "string" ? item.mimetype.slice(0, 200) : "",
        link: typeof item.link === "string" ? item.link.slice(0, 4096) : "",
        thumbnail: typeof item.thumbnail === "string" ? item.thumbnail.slice(0, 4096) : null,
      };
    }

    try {
      let expected;
      try {
        expected = new URL(expectedPageUrl);
      } catch {
        return failure("PAGE_CHANGED");
      }
      const expectedShare = sharePath(expected.pathname);
      if (
        expected.origin !== "https://gofile.io" ||
        expected.username ||
        expected.password ||
        !expectedShare ||
        location.origin !== expected.origin
      ) {
        return failure("PAGE_CHANGED");
      }

      const initialShare = sharePath(location.pathname);
      if (!initialShare) return failure("PAGE_CHANGED");

      let lastShare = initialShare;
      let observedFolderId = "";
      let canonicalTransition = expectedShare.pathname === initialShare.pathname
        ? null
        : { from: expectedShare, folderIdBefore: "" };
      let remainingReadyWait = READY_TIMEOUT_MS;
      let stableReadyIdentity = "";
      let stableReadyChecks = 0;
      let current;

      while (true) {
        if (location.origin !== expected.origin) return failure("PAGE_CHANGED");

        const visibleShare = sharePath(location.pathname);
        if (!visibleShare) return failure("PAGE_CHANGED");
        if (visibleShare.pathname !== lastShare.pathname) {
          if (canonicalTransition) return failure("PAGE_CHANGED");
          canonicalTransition = {
            from: lastShare,
            folderIdBefore: observedFolderId,
          };
          lastShare = visibleShare;
        }

        current = mainContent();
        const visibleFolderId = folderIdentity(current);
        if (visibleFolderId) observedFolderId = visibleFolderId;
        const domReady = fileManagerDomReady();

        if (domReady && current?.status === "error-notFound") return failure("NOT_FOUND");
        if (domReady && current?.status === "ok" && current?.data?.canAccess === false) {
          return failure("ACCESS_REQUIRED");
        }

        if (domReady && current?.status === "ok" && current?.data) {
          if (current.data.type !== "folder" || !visibleFolderId) return failure("SITE_CHANGED");

          if (canonicalTransition) {
            const sameObservedFolder = Boolean(
              canonicalTransition.folderIdBefore &&
              canonicalTransition.folderIdBefore === visibleFolderId,
            );
            const oldPathWasFolderId = canonicalTransition.from.token === visibleFolderId;
            if (!sameObservedFolder && !oldPathWasFolderId) return failure("PAGE_CHANGED");
          }
          const readyIdentity = `${visibleShare.pathname}\n${visibleFolderId}`;
          if (readyIdentity === stableReadyIdentity) stableReadyChecks += 1;
          else {
            stableReadyIdentity = readyIdentity;
            stableReadyChecks = 1;
          }
          if (stableReadyChecks >= 2) break;
        } else {
          stableReadyIdentity = "";
          stableReadyChecks = 0;
        }

        if (remainingReadyWait <= 0) return failure("PAGE_NOT_READY");
        const waitTime = Math.min(READY_POLL_MS, remainingReadyWait);
        await wait(waitTime);
        remainingReadyWait -= waitTime;
      }

      if (current.data.canAccess !== true) return failure("ACCESS_REQUIRED");

      const folderId = typeof current.data.id === "string" ? current.data.id : "";
      if (!folderId || current.data.type !== "folder") return failure("SITE_CHANGED");

      let totalPages = Math.max(1, Number(current.metadata?.totalPages) || 1);
      if (totalPages > MAX_PAGES) return failure("TOO_MANY_PAGES");

      const currentPage = Math.max(1, Number(current.metadata?.page) || 1);
      const currentIsUnfiltered = String(appdata.fileManager.contentFilter || "") === "";
      const settledPathname = location.pathname;
      const videos = [];
      const skipped = [];
      const seenIds = new Set();
      let scannedItems = 0;

      for (let page = 1; page <= totalPages; page += 1) {
        if (location.origin !== expected.origin || location.pathname !== settledPathname) {
          return failure("PAGE_CHANGED");
        }

        let response;
        if (page === currentPage && currentIsUnfiltered) {
          response = current;
        } else {
          if (typeof getContent !== "function") return failure("SITE_CHANGED");
          response = await getContent(folderId, "", page, PAGE_SIZE, "createTime", -1);
        }

        if (location.origin !== expected.origin || location.pathname !== settledPathname) {
          return failure("PAGE_CHANGED");
        }

        if (response?.status !== "ok" || !response.data || response.data.canAccess !== true) {
          return failure(response?.data?.canAccess === false ? "ACCESS_REQUIRED" : "SCAN_FAILED");
        }
        if (response.data.type !== "folder" || response.data.id !== folderId) {
          return failure("SCAN_FAILED");
        }

        const responsePages = Math.max(1, Number(response.metadata?.totalPages) || totalPages);
        if (responsePages > MAX_PAGES) return failure("TOO_MANY_PAGES");
        totalPages = Math.max(totalPages, responsePages);

        const children = response.data.children && typeof response.data.children === "object"
          ? Object.values(response.data.children)
          : [];
        scannedItems += children.length;

        for (const item of children) {
          if (!isVideo(item)) continue;
          const safe = safeItem(item);
          if (!safe.id || seenIds.has(safe.id)) continue;
          seenIds.add(safe.id);

          let unavailableReason = "";
          if (item.isFrozen === true) unavailableReason = "frozen";
          else if (item.overloaded === true) unavailableReason = "overloaded";
          else if (!safe.link) unavailableReason = "missing-link";

          if (unavailableReason) skipped.push({ ...safe, reason: unavailableReason });
          else videos.push(safe);

          if (videos.length + skipped.length > MAX_VIDEOS) return failure("TOO_MANY_VIDEOS");
        }
      }

      if (location.origin !== expected.origin || location.pathname !== settledPathname) {
        return failure("PAGE_CHANGED");
      }

      return {
        ok: true,
        folderId,
        folderName: typeof current.data.name === "string" ? current.data.name.slice(0, 512) : "Gofile",
        pageUrl: `${location.origin}${settledPathname}`,
        scannedItems,
        skipped,
        totalPages,
        videos,
      };
    } catch {
      return failure("SCAN_FAILED");
    }
  }

  root.collectGofilePageVideos = collectGofilePageVideos;
  if (typeof module === "object" && module.exports) module.exports = collectGofilePageVideos;
})(typeof globalThis !== "undefined" ? globalThis : this);
