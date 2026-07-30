// injected.js — runs in the PAGE world on the My Apps portal.
// Monkeypatches fetch + XHR to capture the (undocumented) tiles API
// response the portal loads for itself, and forwards it to the content
// script via window.postMessage.
(function () {
  const TILE_URL_RE =
    /(\/api\/v2\/me\/tiles)|(\/api\/.*tiles)|(GetAllUserApplications)|(UserApplications)/i;

  function looksLikeTiles(url) {
    try {
      return TILE_URL_RE.test(String(url));
    } catch (e) {
      return false;
    }
  }

  function forward(payload) {
    try {
      window.postMessage(
        { __myAppsLauncher: true, kind: "api", payload: payload },
        "*"
      );
    } catch (e) {}
  }

  function tryParse(text) {
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch (e) {
      return null;
    }
  }

  // ---- patch fetch ----
  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (...args) {
      const req = args[0];
      const url = typeof req === "string" ? req : req && req.url;
      const p = origFetch.apply(this, args);
      if (looksLikeTiles(url)) {
        p.then((res) => {
          try {
            res
              .clone()
              .text()
              .then((t) => {
                const j = tryParse(t);
                if (j) forward(j);
              })
              .catch(() => {});
          } catch (e) {}
        }).catch(() => {});
      }
      return p;
    };
  }

  // ---- patch XMLHttpRequest ----
  const OrigXHR = window.XMLHttpRequest;
  if (OrigXHR) {
    const origOpen = OrigXHR.prototype.open;
    const origSend = OrigXHR.prototype.send;
    OrigXHR.prototype.open = function (method, url) {
      this.__mal_url = url;
      return origOpen.apply(this, arguments);
    };
    OrigXHR.prototype.send = function () {
      if (looksLikeTiles(this.__mal_url)) {
        this.addEventListener("load", () => {
          try {
            const j = tryParse(this.responseText);
            if (j) forward(j);
          } catch (e) {}
        });
      }
      return origSend.apply(this, arguments);
    };
  }
})();
