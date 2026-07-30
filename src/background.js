// background.js — service worker for My Apps Launcher
// Manages the cached app list, drives "auto tab sync" against the
// Microsoft My Apps portal, and tracks login state.

const MYAPPS_URL = "https://myapplications.microsoft.com/";
const MYAPPS_MATCH = "https://myapplications.microsoft.com/*";
const LAUNCHER_BASE = "https://launcher.myapps.microsoft.com/api/signin/";
const LOGOUT_URL =
  "https://login.microsoftonline.com/common/oauth2/logout" +
  "?post_logout_redirect_uri=" +
  encodeURIComponent("https://myapplications.microsoft.com/");

const SYNC_TIMEOUT_MS = 30000;

// ---- storage helpers -------------------------------------------------------

async function getState() {
  return chrome.storage.local.get({
    apps: [],
    lastSync: 0,
    loginState: "unknown", // unknown | loggedIn | loggedOut
    syncing: false,
    syncTabId: null,
    syncTabOpenedByUs: false,
    tenantId: null,
    history: [], // rolling log of opens: [{ key, ts }], newest last, max 100
    favourites: [], // app keys the user has starred
    // user settings
    recentMax: 6, // apps shown in the "Recent" section
    rankMode: "frequency", // 'frequency' | 'recency'
    autoSync: true, // open a background My Apps tab to sync automatically
  });
}

const HISTORY_MAX = 100;

async function recordOpen(key) {
  if (!key) return;
  const s = await getState();
  const h = Array.isArray(s.history) ? s.history.slice() : [];
  h.push({ key: String(key), ts: Date.now() });
  while (h.length > HISTORY_MAX) h.shift();
  await setState({ history: h });
}

async function setState(patch) {
  await chrome.storage.local.set(patch);
}

function notifyPopup(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

// ---- sync orchestration ----------------------------------------------------

async function findExistingMyAppsTab() {
  const tabs = await chrome.tabs.query({ url: MYAPPS_MATCH });
  return tabs && tabs.length ? tabs[0] : null;
}

async function startSync({ force = false } = {}) {
  const s = await getState();
  if (s.syncing && !force) return;

  await setState({ syncing: true });
  notifyPopup({ type: "SYNC_STARTED" });

  const existing = await findExistingMyAppsTab();
  if (existing) {
    await setState({ syncTabId: existing.id, syncTabOpenedByUs: false });
    try {
      await chrome.tabs.sendMessage(existing.id, { type: "RECAPTURE" });
    } catch (e) {
      chrome.tabs.reload(existing.id);
    }
  } else if (s.autoSync !== false) {
    const tab = await chrome.tabs.create({ url: MYAPPS_URL, active: false });
    await setState({ syncTabId: tab.id, syncTabOpenedByUs: true });
  } else {
    // Manual mode + no open My Apps tab: can't sync silently.
    await setState({ syncing: false });
    const st = await getState();
    if (!st.apps || !st.apps.length) notifyPopup({ type: "LOGIN_REQUIRED" });
    return;
  }

  chrome.alarms.clear("syncTimeout");
  chrome.alarms.create("syncTimeout", { when: Date.now() + SYNC_TIMEOUT_MS });
}

async function finishSync({ loginState } = {}) {
  chrome.alarms.clear("syncTimeout");
  const s = await getState();
  if (s.syncTabOpenedByUs && s.syncTabId != null) {
    try {
      await chrome.tabs.remove(s.syncTabId);
    } catch (e) {}
  }
  const patch = { syncing: false, syncTabId: null, syncTabOpenedByUs: false };
  if (loginState) patch.loginState = loginState;
  await setState(patch);
}

// ---- app-list normalization ------------------------------------------------

function pick(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] != null && obj[k] !== "") return obj[k];
  }
  return null;
}

function isSigninUrl(u) {
  return !!u && /launcher\.myapps\.microsoft\.com\/api\/signin\//i.test(u);
}

function isUsableUrl(u) {
  // Absolute, and not just the portal dashboard / an in-app SPA route.
  if (!u || !/^https?:\/\//i.test(u)) return false;
  if (/^https:\/\/myapplications\.microsoft\.com\/?($|[?#])/i.test(u)) return false;
  return true;
}

function buildLauncher(appId, tenantId) {
  if (!appId) return null;
  let u = LAUNCHER_BASE + encodeURIComponent(appId);
  if (tenantId) u += "?tenantId=" + encodeURIComponent(tenantId);
  return u;
}

// Tile ids can be composite, e.g. "AzureADThirdParty|<guid>". The launcher
// signin endpoint only accepts the trailing id, so strip any prefix.
function extractAppId(v) {
  if (v == null) return null;
  let s = String(v);
  if (s.indexOf("|") !== -1) s = s.split("|").pop();
  return s || null;
}

function signinIdOf(u) {
  if (!isSigninUrl(u)) return null;
  const m = u.match(/\/api\/signin\/([^/?#]+)/i);
  return m ? decodeURIComponent(m[1]) : null;
}

function isCleanSignin(u) {
  const id = signinIdOf(u);
  return !!id && id.indexOf("|") === -1;
}

// Raw tile (undocumented schema) -> our shape. The tile provides a ready-made
// launcher URL (fastLaunchUrl / persistentLaunchUrl); use it verbatim. Only
// construct one as a last resort, and never from the tile id (that GUID is the
// service-principal/provider id, NOT the launch id).
function normalizeTile(t, tenantId) {
  if (!t || typeof t !== "object") return null;
  const name = pick(t, ["displayName", "appName", "name", "title", "label"]);
  const direct = pick(t, [
    "fastLaunchUrl", "persistentLaunchUrl",
    "appLaunchUrl", "launchUrl", "loginUrl", "ssoUrl",
    "appUrl", "externalUrl", "url", "link", "href",
  ]);
  const tid = pick(t, ["tenantId", "tid", "realm"]) || tenantId;
  const icon = pick(t, ["logoUrl", "iconUrl", "icon", "imageUrl", "smallLogoUrl"]);

  let url = null;
  if (isSigninUrl(direct)) url = direct;          // ready-made, correct URL
  else if (isUsableUrl(direct)) url = direct;     // some other absolute URL
  // No usable direct URL: fall back to constructing from an explicit appId
  // field only (not the tile id/providerId).
  if (!url) {
    const appId = extractAppId(
      pick(t, ["appId", "applicationId", "servicePrincipalAppId"])
    );
    url = buildLauncher(appId, tid);
  }

  const appId = signinIdOf(url) || null;
  if (!name && !url) return null;
  return { name: name || url, url: url || null, icon: icon || null, appId };
}

function keyOf(a) {
  return (a.name || a.url || "").toLowerCase().trim();
}

function betterOf(a, b) {
  // Prefer a clean-GUID signin URL, then any signin URL, then any usable
  // URL, then presence of an icon.
  const acs = isCleanSignin(a.url), bcs = isCleanSignin(b.url);
  if (acs !== bcs) return acs ? a : b;
  const ag = isSigninUrl(a.url), bg = isSigninUrl(b.url);
  if (ag !== bg) return ag ? a : b;
  const au = isUsableUrl(a.url), bu = isUsableUrl(b.url);
  if (au !== bu) return au ? a : b;
  if (!!a.icon !== !!b.icon) return a.icon ? a : b;
  return b; // default to the newer capture
}

function normalizeIncoming(apps, source, tenantId) {
  let list = [];
  if (Array.isArray(apps)) {
    list = apps
      .map((a) => (source === "api" ? normalizeTile(a, tenantId) : completeDomApp(a, tenantId)))
      .filter(Boolean);
  }
  // dedupe within this capture
  const map = new Map();
  for (const a of list) {
    const k = keyOf(a);
    if (!k) continue;
    map.set(k, map.has(k) ? betterOf(map.get(k), a) : a);
  }
  return [...map.values()];
}

// DOM apps carry a ready-made launcher href; keep it as-is.
function completeDomApp(a, tenantId) {
  if (!a || (!a.name && !a.url)) return null;
  let url = a.url || null;
  let appId = extractAppId(a.appId) || signinIdOf(url);
  if (!url && appId) url = buildLauncher(appId, tenantId);
  return { name: a.name || url, url: url || null, icon: a.icon || null, appId };
}

// ---- message handling ------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg && msg.type) {
      case "GET_STATE":
        sendResponse(await getState());
        break;

      case "SYNC":
        await startSync({ force: !!msg.force });
        sendResponse({ ok: true });
        break;

      case "CONTEXT":
        if (msg.tenantId) await setState({ tenantId: msg.tenantId });
        sendResponse({ ok: true });
        break;

      case "RECORD_OPEN":
        await recordOpen(msg.key);
        sendResponse({ ok: true });
        break;

      case "SET_FAVOURITES":
        if (Array.isArray(msg.favourites)) {
          await setState({ favourites: msg.favourites.map(String) });
        }
        sendResponse({ ok: true });
        break;

      case "LOGIN": {
        const existing = await findExistingMyAppsTab();
        if (existing) {
          await chrome.tabs.update(existing.id, { active: true });
          if (existing.windowId != null) {
            chrome.windows.update(existing.windowId, { focused: true });
          }
        } else {
          await chrome.tabs.create({ url: MYAPPS_URL, active: true });
        }
        sendResponse({ ok: true });
        break;
      }

      case "LOGOUT":
        await setState({ apps: [], loginState: "loggedOut", lastSync: 0 });
        await chrome.tabs.create({ url: LOGOUT_URL, active: true });
        sendResponse({ ok: true });
        break;

      case "APPS_CAPTURED": {
        const s = await getState();
        const incoming = normalizeIncoming(msg.apps, msg.source, s.tenantId);
        if (!incoming.length) {
          await setState({ loginState: "loggedIn" });
          sendResponse({ ok: true, count: 0 });
          break;
        }

        let merged;
        const domAuthoritative =
          msg.source === "dom" && incoming.some((a) => isSigninUrl(a.url));
        if (domAuthoritative) {
          // The rendered page is the source of truth for the full list.
          merged = incoming;
        } else {
          // API (or urlless DOM): merge into what we have, keeping best URLs.
          const map = new Map();
          for (const a of s.apps || []) map.set(keyOf(a), a);
          for (const a of incoming) {
            const k = keyOf(a);
            map.set(k, map.has(k) ? betterOf(map.get(k), a) : a);
          }
          merged = [...map.values()];
        }

        await setState({
          apps: merged,
          lastSync: Date.now(),
          loginState: "loggedIn",
        });
        await finishSync({ loginState: "loggedIn" });
        notifyPopup({ type: "APPS_UPDATED", count: merged.length });
        sendResponse({ ok: true, count: merged.length });
        break;
      }

      case "LOGIN_REQUIRED":
        await finishSync({ loginState: "loggedOut" });
        notifyPopup({ type: "LOGIN_REQUIRED" });
        sendResponse({ ok: true });
        break;

      default:
        sendResponse({ ok: false, error: "unknown message" });
    }
  })();
  return true;
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  const s = await getState();
  if (s.syncTabId !== tabId) return;
  const url = changeInfo.url || (tab && tab.url) || "";
  if (s.syncTabOpenedByUs && /^https:\/\/login\.microsoftonline\.com\//.test(url)) {
    await finishSync({ loginState: "loggedOut" });
    notifyPopup({ type: "LOGIN_REQUIRED" });
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const s = await getState();
  if (s.syncTabId === tabId) {
    await setState({ syncing: false, syncTabId: null, syncTabOpenedByUs: false });
    chrome.alarms.clear("syncTimeout");
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "syncTimeout") {
    const s = await getState();
    if (s.syncing) {
      const loginState = s.loginState === "loggedIn" ? "loggedIn" : "loggedOut";
      await finishSync({ loginState });
      notifyPopup({ type: "SYNC_TIMEOUT" });
    }
  }
});

// Clear stale cached apps whenever the extension is installed or reloaded,
// so old (bad) launch URLs can't linger. Next sync repopulates the list.
chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.local.set({ apps: [], lastSync: 0, syncing: false });
  await chrome.storage.local.remove(["debugSample", "debugTiles"]);
});
