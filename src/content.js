// content.js — isolated world on the My Apps portal.
// 1. Injects injected.js (page world) to capture the tiles API response.
// 2. Scrapes the rendered tiles from the DOM (authoritative launch URLs).
// 3. Captures the tenant id from a launcher link on the page.
// 4. Forwards everything to the background service worker.
(function () {
  // ---- inject the page-world interceptor ASAP ----
  try {
    const s = document.createElement("script");
    s.src = chrome.runtime.getURL("injected.js");
    s.async = false;
    (document.head || document.documentElement).appendChild(s);
    s.remove();
  } catch (e) {}

  const SIGNIN_RE = /launcher\.myapps\.microsoft\.com\/api\/signin\//i;

  function send(apps, source) {
    try {
      chrome.runtime.sendMessage({ type: "APPS_CAPTURED", apps, source });
    } catch (e) {}
  }

  function sendContext(tenantId) {
    if (!tenantId) return;
    try {
      chrome.runtime.sendMessage({ type: "CONTEXT", tenantId });
    } catch (e) {}
  }

  // ---- tenant id from any launcher link on the page ----
  function findTenantId() {
    const a = document.querySelector(
      'a[href*="launcher.myapps.microsoft.com/api/signin/"]'
    );
    if (a) {
      try {
        const t = new URL(a.href).searchParams.get("tenantId");
        if (t) return t;
      } catch (e) {}
    }
    return null;
  }

  // ---- receive captured API payloads from injected.js ----
  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.__myAppsLauncher !== true || d.kind !== "api") return;
    const arr = extractArray(d.payload);
    if (arr && arr.length) send(arr, "api");
  });

  function extractArray(payload) {
    if (!payload) return null;
    if (Array.isArray(payload)) return payload;
    for (const k of ["value", "tiles", "items", "applications", "data", "result"]) {
      if (Array.isArray(payload[k])) return payload[k];
    }
    for (const k of Object.keys(payload)) {
      const v = payload[k];
      if (v && typeof v === "object" && !Array.isArray(v)) {
        for (const k2 of ["value", "tiles", "items", "applications"]) {
          if (Array.isArray(v[k2])) return v[k2];
        }
      }
    }
    return null;
  }

  // ---- DOM scrape: read the real launcher anchors ----
  function scrapeDom() {
    const out = [];
    const seen = new Set();
    document.querySelectorAll("a[href]").forEach((a) => {
      const href = a.href || "";
      if (!SIGNIN_RE.test(href)) return;
      if (seen.has(href)) return;
      seen.add(href);
      let name = (
        a.getAttribute("aria-label") ||
        a.getAttribute("title") ||
        a.textContent ||
        ""
      ).trim();
      let icon = null;
      const img = a.querySelector("img");
      if (img) {
        if (!name && img.getAttribute("alt")) name = img.getAttribute("alt").trim();
        if (img.src) icon = img.src;
      }
      out.push({ name: name || href, url: href, icon });
    });
    return out;
  }

  let stopped = false;
  let attempts = 0;
  const MAX_ATTEMPTS = 25; // ~25s at 1s intervals

  function pollDom() {
    if (stopped) return;
    attempts++;
    const tid = findTenantId();
    if (tid) sendContext(tid);
    const apps = scrapeDom();
    if (apps.length) {
      send(apps, "dom");
      stopped = true; // keep API interceptor alive, stop DOM polling
      return;
    }
    if (attempts < MAX_ATTEMPTS) setTimeout(pollDom, 1000);
  }

  // ---- respond to background's recapture request ----
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === "RECAPTURE") {
      const tid = findTenantId();
      if (tid) sendContext(tid);
      const apps = scrapeDom();
      if (apps.length) send(apps, "dom");
      sendResponse({ ok: true, count: apps.length });
    }
    return true;
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => pollDom());
  } else {
    pollDom();
  }
})();
