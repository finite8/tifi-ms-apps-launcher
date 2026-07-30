// options.js — Settings & transparency page for My Apps Launcher

const DEFAULTS = {
  apps: [],
  history: [],
  loginState: "unknown",
  lastSync: 0,
  tenantId: null,
  favourites: [],
  recentMax: 6,
  rankMode: "frequency",
  autoSync: true,
};

const $ = (id) => document.getElementById(id);

function getAll() {
  return chrome.storage.local.get(null); // everything actually stored
}
function set(patch) {
  return chrome.storage.local.set(patch);
}

function keyForApp(a) {
  return a.appId || a.url || (a.name || "").toLowerCase();
}

function timeAgo(ts) {
  if (!ts) return "never";
  const secs = Math.round((Date.now() - ts) / 1000);
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return mins + " min ago";
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return hrs + " hr ago";
  const days = Math.round(hrs / 24);
  return days + (days === 1 ? " day ago" : " days ago");
}

function fmtDate(ts) {
  if (!ts) return "–";
  try { return new Date(ts).toLocaleString(); } catch (e) { return String(ts); }
}

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), 2200);
}

function initials(name) {
  const parts = String(name || "?").trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]).join("").toUpperCase() || "?";
}

function el(tag, props = {}, children = []) {
  const n = document.createElement(tag);
  Object.assign(n, props);
  for (const c of [].concat(children)) {
    if (c == null) continue;
    n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return n;
}

async function render() {
  const s = Object.assign({}, DEFAULTS, await getAll());

  // Version
  $("version").textContent = chrome.runtime.getManifest().version;

  // Status
  $("st-login").textContent =
    s.loginState === "loggedIn" ? "Yes" :
    s.loginState === "loggedOut" ? "No (session expired / signed out)" :
    "Unknown";
  $("st-tenant").textContent = s.tenantId || "–";
  $("st-sync").textContent = s.lastSync
    ? timeAgo(s.lastSync) + "  (" + fmtDate(s.lastSync) + ")"
    : "never";
  $("st-count").textContent = (s.apps || []).length;

  // Preferences
  $("setRecentMax").value = s.recentMax;
  $("setRankMode").value = s.rankMode;
  $("setAutoSync").checked = s.autoSync !== false;

  // Apps table
  const appsBody = $("appsTable");
  appsBody.innerHTML = "";
  const apps = (s.apps || []).slice().sort((a, b) =>
    (a.name || "").localeCompare(b.name || "")
  );
  $("appsCount").textContent = apps.length;
  const keyToName = {};
  for (const a of s.apps || []) keyToName[keyForApp(a)] = a.name || keyForApp(a);
  const favSet = new Set(s.favourites || []);

  if (!apps.length) {
    appsBody.appendChild(el("tr", {}, el("td", { colSpan: 2, className: "muted" }, "No apps cached yet.")));
  }
  for (const a of apps) {
    const iconWrap = el("span", { className: "app-cell" });
    if (a.icon) {
      const img = el("img", { src: a.icon, alt: "" });
      img.onerror = () => img.replaceWith(document.createTextNode(""));
      iconWrap.appendChild(img);
    }
    const fav = favSet.has(keyForApp(a));
    if (fav) {
      iconWrap.appendChild(el("span", { title: "Favourite", style: "color:#f2c811" }, "★ "));
    }
    iconWrap.appendChild(document.createTextNode(a.name || "(unnamed)"));
    const urlCell = a.url
      ? el("a", { href: a.url, target: "_blank", rel: "noopener", textContent: a.url })
      : el("span", { className: "muted", textContent: "—" });
    appsBody.appendChild(el("tr", {}, [el("td", {}, iconWrap), el("td", {}, urlCell)]));
  }

  // History (aggregated)
  const history = s.history || [];
  $("historyCount").textContent = history.length;
  const count = {}, lastTs = {};
  for (const e of history) {
    if (!e || !e.key) continue;
    count[e.key] = (count[e.key] || 0) + 1;
    lastTs[e.key] = Math.max(lastTs[e.key] || 0, e.ts || 0);
  }
  const rows = Object.keys(count)
    .map((k) => ({ key: k, count: count[k], lastTs: lastTs[k] }))
    .sort((a, b) => b.count - a.count || b.lastTs - a.lastTs);
  const hBody = $("historyTable");
  hBody.innerHTML = "";
  if (!rows.length) {
    hBody.appendChild(el("tr", {}, el("td", { colSpan: 3, className: "muted" }, "No opens recorded yet.")));
  }
  for (const r of rows) {
    hBody.appendChild(el("tr", {}, [
      el("td", {}, keyToName[r.key] || r.key),
      el("td", {}, String(r.count)),
      el("td", {}, timeAgo(r.lastTs) + " (" + fmtDate(r.lastTs) + ")"),
    ]));
  }

  // Raw dump
  $("rawJson").textContent = JSON.stringify(s, null, 2);
}

// ---- preference handlers ----
$("setRecentMax").addEventListener("change", async (e) => {
  let v = parseInt(e.target.value, 10);
  if (!Number.isFinite(v)) v = 6;
  v = Math.min(20, Math.max(1, v));
  e.target.value = v;
  await set({ recentMax: v });
  toast("Saved");
});
$("setRankMode").addEventListener("change", async (e) => {
  await set({ rankMode: e.target.value });
  toast("Saved");
});
$("setAutoSync").addEventListener("change", async (e) => {
  await set({ autoSync: e.target.checked });
  toast("Saved");
});

// ---- actions ----
$("syncNowBtn").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "SYNC", force: true }).catch(() => {});
  toast("Syncing…");
});
$("clearHistoryBtn").addEventListener("click", async () => {
  if (!confirm("Clear your usage history? The Recent section will reset.")) return;
  await set({ history: [] });
  toast("Usage history cleared");
});
$("clearFavBtn").addEventListener("click", async () => {
  if (!confirm("Clear all favourites?")) return;
  await set({ favourites: [] });
  toast("Favourites cleared");
});
$("clearAppsBtn").addEventListener("click", async () => {
  if (!confirm("Clear the cached app list? It will re-sync next time you open the popup.")) return;
  await set({ apps: [], lastSync: 0 });
  toast("Cached apps cleared");
});
$("resetAllBtn").addEventListener("click", async () => {
  if (!confirm("Reset everything? This erases all stored data (apps, history, tenant, settings) and signs the extension out.")) return;
  await chrome.storage.local.clear();
  toast("All data reset");
});
$("copyRawBtn").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("rawJson").textContent);
    toast("Copied to clipboard");
  } catch (e) {
    toast("Copy failed");
  }
});

// Live-refresh when anything in storage changes.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local") render();
});

render();
