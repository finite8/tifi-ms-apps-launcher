// popup.js — UI for My Apps Launcher
const RECENT_MAX = 6; // apps shown in the "Recent" section

const els = {
  search: document.getElementById("search"),
  searchWrap: document.getElementById("searchWrap"),
  list: document.getElementById("list"),
  loginView: document.getElementById("loginView"),
  loadingView: document.getElementById("loadingView"),
  loadingText: document.getElementById("loadingText"),
  status: document.getElementById("status"),
  footer: document.getElementById("footer"),
  count: document.getElementById("count"),
  loginBtn: document.getElementById("loginBtn"),
  refreshBtn: document.getElementById("refreshBtn"),
  settingsBtn: document.getElementById("settingsBtn"),
  logoutBtn: document.getElementById("logoutBtn"),
  openPortal: document.getElementById("openPortal"),
};

let apps = [];
let history = [];
let favourites = []; // array of app keys
let orderedApps = []; // flat list matching the rendered .app-item order
let activeIndex = 0;
let tenantId = null;
let recentMax = RECENT_MAX;
let rankMode = "frequency"; // 'frequency' | 'recency'

function send(msg) {
  return chrome.runtime.sendMessage(msg).catch(() => ({}));
}

function show(view) {
  els.loadingView.classList.toggle("hidden", view !== "loading");
  els.loginView.classList.toggle("hidden", view !== "login");
  const appsMode = view === "apps";
  els.searchWrap.classList.toggle("hidden", !appsMode);
  els.list.classList.toggle("hidden", !appsMode);
  els.footer.classList.toggle("hidden", !appsMode);
}

function setStatus(text) {
  if (!text) {
    els.status.classList.add("hidden");
    els.status.textContent = "";
  } else {
    els.status.classList.remove("hidden");
    els.status.textContent = text;
  }
}

function faviconFor(url) {
  try {
    return new URL(url).origin + "/favicon.ico";
  } catch (e) {
    return null;
  }
}

function initials(name) {
  const parts = String(name || "?").trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]).join("").toUpperCase() || "?";
}

function keyForApp(a) {
  return a.appId || a.url || (a.name || "").toLowerCase();
}

function launchUrlFor(app) {
  if (app && app.url) return app.url;
  if (app && app.appId) {
    let u = "https://launcher.myapps.microsoft.com/api/signin/" +
      encodeURIComponent(app.appId);
    if (tenantId) u += "?tenantId=" + encodeURIComponent(tenantId);
    return u;
  }
  return "https://myapplications.microsoft.com/";
}

// ---- ranking -------------------------------------------------------------
function usageStats() {
  const count = {};
  const lastTs = {};
  for (const e of history) {
    if (!e || !e.key) continue;
    count[e.key] = (count[e.key] || 0) + 1;
    lastTs[e.key] = Math.max(lastTs[e.key] || 0, e.ts || 0);
  }
  return { count, lastTs };
}

// Usage-based comparator (respects the ranking preference).
function byUsage(a, b) {
  return rankMode === "recency"
    ? b.lastTs - a.lastTs || b.count - a.count
    : b.count - a.count || b.lastTs - a.lastTs;
}

function isFav(key) {
  return favourites.indexOf(key) !== -1;
}

// Returns { mode, groups: [{ label, apps }] }.
// - Search: a single flat, ranked group (favourites weighted first).
// - Otherwise: Favourites, then top-N Recent, then everything else by name.
function computeView() {
  const q = els.search.value.trim().toLowerCase();
  const { count, lastTs } = usageStats();
  const meta = apps.map((a) => {
    const k = keyForApp(a);
    return { app: a, key: k, count: count[k] || 0, lastTs: lastTs[k] || 0 };
  });

  if (q) {
    const f = meta
      .filter((m) => (m.app.name || "").toLowerCase().includes(q))
      .sort(
        (a, b) =>
          (isFav(b.key) ? 1 : 0) - (isFav(a.key) ? 1 : 0) ||
          byUsage(a, b) ||
          (a.app.name || "").localeCompare(b.app.name || "")
      );
    return { mode: "flat", groups: [{ label: null, apps: f.map((m) => m.app) }] };
  }

  const favs = meta.filter((m) => isFav(m.key)).sort(byUsage).map((m) => m.app);

  const recent = meta
    .filter((m) => !isFav(m.key) && m.count > 0)
    .sort(byUsage)
    .slice(0, recentMax)
    .map((m) => m.app);

  const usedKeys = new Set([...favs, ...recent].map((a) => keyForApp(a)));
  const rest = meta
    .filter((m) => !usedKeys.has(m.key))
    .map((m) => m.app)
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""));

  const groups = [];
  if (favs.length) groups.push({ label: "Favourites", apps: favs });
  if (recent.length) groups.push({ label: "Recent", apps: recent });
  // Only label the remainder when there is at least one section above it.
  groups.push({ label: groups.length ? "All apps" : null, apps: rest });

  return { mode: "sections", groups };
}

// ---- rendering -----------------------------------------------------------
function makeAppRow(app) {
  const li = document.createElement("li");
  li.className = "app-item";
  li.setAttribute("role", "option");

  const icon = document.createElement("div");
  icon.className = "app-icon";
  const iconUrl = app.icon || faviconFor(app.url);
  if (iconUrl) {
    const img = document.createElement("img");
    img.src = iconUrl;
    img.alt = "";
    img.onerror = () => {
      icon.textContent = initials(app.name);
      img.remove();
    };
    icon.appendChild(img);
  } else {
    icon.textContent = initials(app.name);
  }

  const name = document.createElement("span");
  name.className = "app-name";
  name.textContent = app.name || app.url;
  name.title = app.name || app.url;

  const star = document.createElement("button");
  const fav = isFav(keyForApp(app));
  star.className = "fav-btn" + (fav ? " on" : "");
  star.textContent = fav ? "★" : "☆"; // ★ / ☆
  star.title = fav ? "Remove from favourites" : "Add to favourites";
  star.setAttribute("aria-label", star.title);
  star.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleFav(app);
  });

  li.appendChild(icon);
  li.appendChild(name);
  li.appendChild(star);
  li.addEventListener("click", () => openApp(app));
  return li;
}

async function toggleFav(app) {
  const k = keyForApp(app);
  const set = new Set(favourites);
  if (set.has(k)) set.delete(k);
  else set.add(k);
  favourites = [...set];
  render();
  await send({ type: "SET_FAVOURITES", favourites });
}

function addHeader(label) {
  const li = document.createElement("li");
  li.className = "section-header";
  li.textContent = label;
  els.list.appendChild(li);
}

function emptyRow(text) {
  const li = document.createElement("li");
  li.className = "muted";
  li.style.padding = "12px 10px";
  li.textContent = text;
  els.list.appendChild(li);
}

function render() {
  els.list.innerHTML = "";
  orderedApps = [];
  const view = computeView();

  view.groups.forEach((group) => {
    if (!group.apps.length) return;
    if (group.label) addHeader(group.label);
    group.apps.forEach((a) => {
      orderedApps.push(a);
      els.list.appendChild(makeAppRow(a));
    });
  });

  if (!orderedApps.length) {
    emptyRow(apps.length ? "No matches." : "No apps found.");
  }

  // Bind hover-to-select on the freshly rendered rows.
  els.list.querySelectorAll(".app-item").forEach((el, i) => {
    el.addEventListener("mousemove", () => setActive(i));
  });

  activeIndex = 0;
  setActive(0);

  els.count.textContent = apps.length
    ? apps.length + " app" + (apps.length === 1 ? "" : "s")
    : "";
}

function setActive(i) {
  const items = els.list.querySelectorAll(".app-item");
  items.forEach((el) => el.classList.remove("active"));
  if (!items.length) return;
  activeIndex = Math.max(0, Math.min(i, items.length - 1));
  items[activeIndex].classList.add("active");
  items[activeIndex].scrollIntoView({ block: "nearest" });
}

async function openApp(app) {
  await send({ type: "RECORD_OPEN", key: keyForApp(app) });
  chrome.tabs.create({ url: launchUrlFor(app) });
  window.close();
}

// ---- events ----
els.search.addEventListener("input", render);
els.search.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    if (orderedApps[activeIndex]) openApp(orderedApps[activeIndex]);
  } else if (e.key === "ArrowDown") {
    e.preventDefault();
    setActive(activeIndex + 1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    setActive(activeIndex - 1);
  }
});

els.loginBtn.addEventListener("click", async () => {
  await send({ type: "LOGIN" });
  window.close();
});
els.refreshBtn.addEventListener("click", async () => {
  setStatus("Refreshing…");
  await send({ type: "SYNC", force: true });
});
els.settingsBtn.addEventListener("click", () => {
  if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
  else chrome.tabs.create({ url: chrome.runtime.getURL("options.html") });
  window.close();
});
els.logoutBtn.addEventListener("click", async () => {
  await send({ type: "LOGOUT" });
  apps = [];
  show("login");
});
els.openPortal.addEventListener("click", (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: "https://myapplications.microsoft.com/" });
  window.close();
});

// ---- live updates from background ----
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg) return;
  if (msg.type === "APPS_UPDATED") {
    refreshState();
  } else if (msg.type === "LOGIN_REQUIRED") {
    if (!apps.length) show("login");
    setStatus("");
  } else if (msg.type === "SYNC_TIMEOUT") {
    if (!apps.length) show("login");
    else setStatus("Couldn't refresh — showing last known list.");
  }
});

async function loadState() {
  const s = await send({ type: "GET_STATE" });
  apps = (s && s.apps) || [];
  history = (s && s.history) || [];
  favourites = (s && s.favourites) || [];
  tenantId = (s && s.tenantId) || tenantId;
  if (s && typeof s.recentMax === "number" && s.recentMax > 0) recentMax = s.recentMax;
  if (s && (s.rankMode === "frequency" || s.rankMode === "recency")) rankMode = s.rankMode;
  return s || {};
}

async function refreshState() {
  const s = await loadState();
  if (apps.length) {
    show("apps");
    render();
    els.search.focus();
    setStatus(s.lastSync ? "Updated " + timeAgo(s.lastSync) : "");
  } else if (s.loginState === "loggedOut") {
    show("login");
  } else {
    show("loading");
    els.loadingText.textContent = "Syncing your apps…";
  }
}

function timeAgo(ts) {
  const secs = Math.round((Date.now() - ts) / 1000);
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return mins + " min ago";
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return hrs + " hr ago";
  return Math.round(hrs / 24) + " day(s) ago";
}

// ---- init ----
(async function init() {
  const s = await loadState();
  if (apps.length) {
    show("apps");
    render();
    els.search.focus();
    setStatus(s.lastSync ? "Updated " + timeAgo(s.lastSync) : "");
    send({ type: "SYNC" });
  } else if (s.loginState === "loggedOut") {
    show("login");
  } else {
    show("loading");
    els.loadingText.textContent = "Syncing your apps…";
    send({ type: "SYNC" });
  }
})();
