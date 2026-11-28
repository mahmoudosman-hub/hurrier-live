// ==UserScript==
// @name         Hurrier Live Sync
// @namespace    https://mahmoudosman-hub.github.io/hurrier-live/
// @version      10.16
// @description  [v10.16] Fix Syntax & Restore Full On-Demand Handlers (Order Details + Transitions Retry + Courier Profile + Rider Search + Direct Completed Lookup)
// @author       Mahmoud Mohammed
// @match        https://eg.me.logisticsbackoffice.com/*
// @match        https://mahmoudosman-hub.github.io/hurrier-live/*
// @match        https://hurrier-live.web.app/*
// @match        https://hurrier-live.firebaseapp.com/*
// @updateURL    https://raw.githubusercontent.com/mahmoudosman-hub/hurrier-live/main/hurrier-tampermonkey.user.js
// @downloadURL  https://raw.githubusercontent.com/mahmoudosman-hub/hurrier-live/main/hurrier-tampermonkey.user.js
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_openInTab
// @connect      raw.githubusercontent.com
// @connect      hurrier-live-default-rtdb.europe-west1.firebasedatabase.app
// @connect      securetoken.googleapis.com
// @connect      eg.me.logisticsbackoffice.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const SCRIPT_VERSION = "10.16";
  const GITHUB_SCRIPT_RAW_URL =
    "https://raw.githubusercontent.com/mahmoudosman-hub/hurrier-live/main/hurrier-tampermonkey.user.js";
  const FIREBASE_DB_URL =
    "https://hurrier-live-default-rtdb.europe-west1.firebasedatabase.app";
  const BASE_API = "https://eg.me.logisticsbackoffice.com/api";

  const AUTH_BRIDGE_STORAGE_KEY = "hurrier_fb_bridge_auth";
  const GM_AUTH_BRIDGE_KEY = "hurrier_fb_bridge_auth_v1";
  const DEVICE_ID_STORAGE_KEY = "hurrier_live_device_id_v1";
  const DEVICE_ACTIVE_TAB_KEY = "hurrier_live_device_active_tab_v2";
  const DEVICE_TABS_REGISTRY_KEY = "hurrier_live_device_tabs_registry_v2";

  const IS_DASHBOARD_HOST =
    location.hostname.includes("mahmoudosman-hub.github.io") ||
    location.hostname.includes("hurrier-live");
  const IS_HURRIER_HOST = location.hostname.includes("logisticsbackoffice.com");

  // ============================================================================
  // 1) DASHBOARD HOST AUTH BRIDGE (Mirrors Google Sign-In Token to Tampermonkey)
  // ============================================================================
  function syncAuthBridgeFromDashboardPage() {
    try {
      const raw = window.localStorage.getItem(AUTH_BRIDGE_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && parsed.idToken && parsed.apiKey) {
        if (typeof GM_setValue === "function") {
          GM_setValue(GM_AUTH_BRIDGE_KEY, parsed);
        }
      }
    } catch {}
  }

  if (IS_DASHBOARD_HOST) {
    syncAuthBridgeFromDashboardPage();
    setInterval(syncAuthBridgeFromDashboardPage, 2500);
    window.addEventListener("storage", (e) => {
      if (e.key === AUTH_BRIDGE_STORAGE_KEY) syncAuthBridgeFromDashboardPage();
    });
    return;
  }

  if (!IS_HURRIER_HOST) return;

  // ============================================================================
  // 2) FLOATING STATUS & AUTO-UPDATE BADGE UI
  // ============================================================================
  let badgeEl = null;
  let updateAvailableVersion = "";

  function ensureBadge() {
    if (badgeEl && document.body && document.body.contains(badgeEl)) return badgeEl;
    if (!document.body) return null;
    badgeEl = document.createElement("div");
    badgeEl.id = "hurrier-live-sync-badge";
    Object.assign(badgeEl.style, {
      position: "fixed",
      bottom: "14px",
      right: "16px",
      zIndex: "2147483647",
      padding: "7px 14px",
      borderRadius: "9999px",
      backgroundColor: "#15803d",
      color: "#ffffff",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      fontSize: "12px",
      fontWeight: "700",
      boxShadow: "0 6px 18px rgba(0,0,0,0.22)",
      cursor: "pointer",
      userSelect: "none",
      transition: "all 0.2s ease",
      letterSpacing: "0.01em"
    });
    badgeEl.textContent = `v${SCRIPT_VERSION} • Initializing...`;
    badgeEl.addEventListener("click", () => {
      if (updateAvailableVersion) {
        if (typeof GM_openInTab === "function") {
          GM_openInTab(GITHUB_SCRIPT_RAW_URL, { active: true });
        } else {
          window.open(GITHUB_SCRIPT_RAW_URL, "_blank");
        }
      } else {
        window.open("https://mahmoudosman-hub.github.io/hurrier-live/", "_blank");
      }
    });
    document.body.appendChild(badgeEl);
    return badgeEl;
  }

  function setBadge(bgColor, text) {
    const el = ensureBadge();
    if (!el) return;
    if (updateAvailableVersion) {
      el.style.backgroundColor = "#1d4ed8";
      el.textContent = `⬆ Update v${updateAvailableVersion} Ready (Click to Update)`;
      return;
    }
    el.style.backgroundColor = bgColor;
    el.textContent = text;
  }

  function compareVersions(a, b) {
    const pa = String(a || "0")
      .split(".")
      .map((n) => parseInt(n, 10) || 0);
    const pb = String(b || "0")
      .split(".")
      .map((n) => parseInt(n, 10) || 0);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
      const na = pa[i] || 0;
      const nb = pb[i] || 0;
      if (na > nb) return 1;
      if (na < nb) return -1;
    }
    return 0;
  }

  function checkGitHubForScriptUpdates() {
    if (typeof GM_xmlhttpRequest !== "function") return;
    GM_xmlhttpRequest({
      method: "GET",
      url: `${GITHUB_SCRIPT_RAW_URL}?t=${Date.now()}`,
      onload: (res) => {
        if (res.status >= 200 && res.status < 300 && res.responseText) {
          const m = /@version\s+([0-9]+(?:\.[0-9]+)*)/.exec(res.responseText);
          if (m && m[1] && compareVersions(m[1], SCRIPT_VERSION) > 0) {
            updateAvailableVersion = m[1];
            setBadge("#1d4ed8", `⬆ Update v${m[1]} Ready (Click to Update)`);
          }
        }
      }
    });
  }

  setTimeout(checkGitHubForScriptUpdates, 4000);
  setInterval(checkGitHubForScriptUpdates, 90000);

  // ============================================================================
  // 3) FIREBASE AUTH TOKEN BRIDGE & AUTO-REFRESH
  // ============================================================================
  function readStoredAuthBridge() {
    try {
      if (typeof GM_getValue === "function") {
        const gmVal = GM_getValue(GM_AUTH_BRIDGE_KEY, null);
        if (gmVal && gmVal.idToken) return gmVal;
      }
    } catch {}
    try {
      const lsRaw = window.localStorage.getItem(AUTH_BRIDGE_STORAGE_KEY);
      if (lsRaw) {
        const parsed = JSON.parse(lsRaw);
        if (parsed && parsed.idToken) return parsed;
      }
    } catch {}
    return null;
  }

  function writeStoredAuthBridge(obj) {
    try {
      if (typeof GM_setValue === "function") {
        GM_setValue(GM_AUTH_BRIDGE_KEY, obj);
      }
    } catch {}
    try {
      window.localStorage.setItem(AUTH_BRIDGE_STORAGE_KEY, JSON.stringify(obj));
    } catch {}
  }

  function getBridgedLeaderEmail() {
    const b = readStoredAuthBridge();
    return b?.email || "";
  }

  async function refreshFirebaseIdToken(bridge) {
    if (!bridge?.refreshToken || !bridge?.apiKey) return bridge?.idToken || "";
    try {
      const res = await fetch(
        `https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(bridge.apiKey)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(bridge.refreshToken)}`
        }
      );
      if (!res.ok) return bridge?.idToken || "";
      const data = await res.json();
      if (data && data.id_token) {
        const updated = {
          ...bridge,
          idToken: data.id_token,
          refreshToken: data.refresh_token || bridge.refreshToken,
          updatedAt: Date.now()
        };
        writeStoredAuthBridge(updated);
        return data.id_token;
      }
    } catch {}
    return bridge?.idToken || "";
  }

  async function getValidFirebaseIdToken(forceRefresh = false) {
    const bridge = readStoredAuthBridge();
    if (!bridge || !bridge.idToken) return "";
    const ageMs = Date.now() - Number(bridge.updatedAt || 0);
    if (forceRefresh || ageMs > 45 * 60 * 1000) {
      return await refreshFirebaseIdToken(bridge);
    }
    return bridge.idToken;
  }

  async function firebaseReq(method, path, bodyObj = undefined) {
    let token = await getValidFirebaseIdToken(false);
    if (!token) throw new Error("NO_FIREBASE_TOKEN");
    const sep = path.includes("?") ? "&" : "?";
    const buildUrl = (tok) =>
      `${FIREBASE_DB_URL}${path}.json${tok ? `${sep}auth=${encodeURIComponent(tok)}` : ""}`;

    const opts = {
      method,
      headers: { "Content-Type": "application/json" }
    };
    if (bodyObj !== undefined) {
      opts.body = JSON.stringify(bodyObj);
    }

    let res = await fetch(buildUrl(token), opts);
    if (res.status === 401 || res.status === 403) {
      token = await getValidFirebaseIdToken(true);
      if (token) {
        res = await fetch(buildUrl(token), opts);
      }
    }
    if (!res.ok) throw new Error(`FB_${res.status}`);
    if (method === "DELETE") return null;
    return res.json();
  }

  // ============================================================================
  // 4) HURRIER BACKOFFICE API CLIENT (Auto-extracts JWT Token + Session Cookies)
  // ============================================================================
  function getHurrierBearerToken() {
    const candidateKeys = [
      "dhhToken",
      "token",
      "access_token",
      "jwt",
      "authToken",
      "id_token"
    ];

    const extractJwt = (val) => {
      if (!val || typeof val !== "string") return "";
      const clean = val.replace(/^Bearer\s+/i, "").replace(/^"|"$/g, "").trim();
      if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(clean)) {
        return clean;
      }
      const m = clean.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
      return m ? m[0] : "";
    };

    for (const store of [window.localStorage, window.sessionStorage]) {
      try {
        for (const k of candidateKeys) {
          const tok = extractJwt(store.getItem(k));
          if (tok) return tok;
        }
        for (let i = 0; i < store.length; i++) {
          const k = store.key(i);
          if (!k || k === AUTH_BRIDGE_STORAGE_KEY) continue;
          const tok = extractJwt(store.getItem(k));
          if (tok) return tok;
        }
      } catch {}
    }

    try {
      const cookieJwt = extractJwt(document.cookie);
      if (cookieJwt) return cookieJwt;
    } catch {}

    return "";
  }

  async function hurrierGet(path) {
    const url = path.startsWith("http") ? path : `${BASE_API}${path}`;
    const jwt = getHurrierBearerToken();
    const headers = {
      Accept: "application/json"
    };
    if (jwt) {
      headers.Authorization = `Bearer ${jwt}`;
    }
    const res = await fetch(url, {
      method: "GET",
      headers,
      credentials: "include"
    });
    if (!res.ok) throw new Error(`HURRIER_${res.status}`);
    return res.json();
  }

  // ============================================================================
  // 5) UNIFIED DEVICE MULTI-TAB INSTANT HANDOFF & MULTI-PC PRIMARY LEADER ELECTION
  // ============================================================================
  function getOrCreatePersistentDeviceId() {
    const fallbackKey = "hurrier_live_gm_device_id_v1";
    try {
      const existing = String(window.localStorage.getItem(DEVICE_ID_STORAGE_KEY) || "").trim();
      if (existing) return existing;
    } catch {}
    try {
      const gmExisting =
        typeof GM_getValue === "function" ? String(GM_getValue(fallbackKey, "") || "").trim() : "";
      if (gmExisting) {
        try {
          window.localStorage.setItem(DEVICE_ID_STORAGE_KEY, gmExisting);
        } catch {}
        return gmExisting;
      }
    } catch {}
    const generated = `dev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    try {
      window.localStorage.setItem(DEVICE_ID_STORAGE_KEY, generated);
    } catch {}
    try {
      if (typeof GM_setValue === "function") GM_setValue(fallbackKey, generated);
    } catch {}
    return generated;
  }

  const DEVICE_ID = getOrCreatePersistentDeviceId();
  const TAB_ID = `tab_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const DEVICE_LEADER_ID = `devldr_${DEVICE_ID}`;
  let ownsLocalTabLock = false;
  let isCurrentLeader = false;

  function isTabCurrentlyFocusedOrVisible() {
    try {
      if (document.hidden) return false;
      if (typeof document.hasFocus === "function" && document.hasFocus()) return true;
      return document.visibilityState === "visible";
    } catch {
      return true;
    }
  }

  function readDeviceTabsRegistry(nowMs) {
    try {
      const raw = window.localStorage.getItem(DEVICE_TABS_REGISTRY_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      if (!parsed || typeof parsed !== "object") return {};
      const cleaned = {};
      for (const [tid, info] of Object.entries(parsed)) {
        if (info && typeof info === "object" && nowMs - Number(info.ts || 0) < 7000) {
          cleaned[tid] = info;
        }
      }
      return cleaned;
    } catch {
      return {};
    }
  }

  function writeDeviceTabsRegistry(regObj) {
    try {
      window.localStorage.setItem(DEVICE_TABS_REGISTRY_KEY, JSON.stringify(regObj));
    } catch {}
  }

  function touchCurrentTabHeartbeat(markPreferredIfFocused = false) {
    const now = Date.now();
    const focused = isTabCurrentlyFocusedOrVisible();
    const reg = readDeviceTabsRegistry(now);
    const prev = reg[TAB_ID] || {};
    reg[TAB_ID] = {
      tabId: TAB_ID,
      version: SCRIPT_VERSION,
      ts: now,
      focused,
      lastActiveAt: focused || markPreferredIfFocused ? now : Number(prev.lastActiveAt || now)
    };
    writeDeviceTabsRegistry(reg);

    if (focused || markPreferredIfFocused) {
      try {
        window.localStorage.setItem(
          DEVICE_ACTIVE_TAB_KEY,
          JSON.stringify({ tabId: TAB_ID, version: SCRIPT_VERSION, ts: now })
        );
      } catch {}
    }
    return { now, reg };
  }

  function electBestSameDeviceTab(now, reg) {
    let preferredTabId = "";
    let preferredTs = 0;
    try {
      const rawPref = window.localStorage.getItem(DEVICE_ACTIVE_TAB_KEY);
      if (rawPref) {
        const parsedPref = JSON.parse(rawPref);
        if (parsedPref?.tabId && reg[parsedPref.tabId]) {
          preferredTabId = String(parsedPref.tabId);
          preferredTs = Number(parsedPref.ts || 0);
        }
      }
    } catch {}

    if (preferredTabId && now - preferredTs < 15000 && reg[preferredTabId]) {
      return preferredTabId;
    }

    const candidates = Object.values(reg);
    if (candidates.length === 0) return TAB_ID;

    candidates.sort((a, b) => {
      const vCmp = compareVersions(b.version || "0", a.version || "0");
      if (vCmp !== 0) return vCmp;
      const aFoc = a.focused ? 1 : 0;
      const bFoc = b.focused ? 1 : 0;
      if (aFoc !== bFoc) return bFoc - aFoc;
      const actDiff = Number(b.lastActiveAt || 0) - Number(a.lastActiveAt || 0);
      if (actDiff !== 0) return actDiff;
      return Number(b.ts || 0) - Number(a.ts || 0);
    });

    return candidates[0].tabId;
  }

  function acquireSamePcTabLock() {
    const { now, reg } = touchCurrentTabHeartbeat(false);
    const chosenTabId = electBestSameDeviceTab(now, reg);
    ownsLocalTabLock = chosenTabId === TAB_ID;
    return ownsLocalTabLock;
  }

  window.addEventListener("focus", () => {
    touchCurrentTabHeartbeat(true);
    ownsLocalTabLock = true;
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      touchCurrentTabHeartbeat(true);
      ownsLocalTabLock = true;
    } else {
      touchCurrentTabHeartbeat(false);
    }
  });

  setInterval(() => {
    touchCurrentTabHeartbeat(false);
  }, 1500);

  window.addEventListener("beforeunload", () => {
    const now = Date.now();
    const reg = readDeviceTabsRegistry(now);
    delete reg[TAB_ID];
    writeDeviceTabsRegistry(reg);
    const nextTabId = electBestSameDeviceTab(now, reg);
    if (nextTabId) {
      try {
        window.localStorage.setItem(
          DEVICE_ACTIVE_TAB_KEY,
          JSON.stringify({ tabId: nextTabId, version: SCRIPT_VERSION, ts: now })
        );
      } catch {}
    }
  });

  async function ensureMultiPcLeadership() {
    const now = Date.now();
    try {
      const lock = await firebaseReq("GET", "/feeder_lock");
      const lockAge = now - Number(lock?.updatedAt || 0);
      const isSameDevice =
        lock?.deviceId === DEVICE_ID || lock?.leaderId === DEVICE_LEADER_ID;
      const isExpired = !lock || !lock.leaderId || lockAge > 14000;
      const isOlderVersion =
        lock?.version && compareVersions(SCRIPT_VERSION, lock.version) > 0;

      if (isSameDevice || isExpired || isOlderVersion) {
        await firebaseReq("PUT", "/feeder_lock", {
          leaderId: DEVICE_LEADER_ID,
          deviceId: DEVICE_ID,
          activeTabId: TAB_ID,
          email: getBridgedLeaderEmail(),
          version: SCRIPT_VERSION,
          updatedAt: now
        });
        isCurrentLeader = true;
        return true;
      }
      isCurrentLeader = false;
      return false;
    } catch {
      return isCurrentLeader;
    }
  }

  setInterval(() => {
    if (isCurrentLeader && ownsLocalTabLock) {
      firebaseReq("PUT", "/feeder_lock", {
        leaderId: DEVICE_LEADER_ID,
        deviceId: DEVICE_ID,
        activeTabId: TAB_ID,
        email: getBridgedLeaderEmail(),
        version: SCRIPT_VERSION,
        updatedAt: Date.now()
      }).catch(() => {});
    }
  }, 3000);

  // ============================================================================
  // 6) PAGINATION & DATA FETCHING HELPERS
  // ============================================================================
  const DELIVERY_ENDPOINTS = [
    { tab: "Queued", path: "/dispatcher-dashboard/deliveries/queued" },
    { tab: "Dispatched", path: "/dispatcher-dashboard/deliveries/dispatched" },
    { tab: "Active", path: "/dispatcher-dashboard/deliveries/active" }
  ];

  const cachedTabRecordsMap = new Map();
  const lastServerTotalsMap = new Map();
  let lastFullActiveSweepAt = 0;
  let lastKnownActivePageCount = 1;
  const knownZonesCatalogMap = new Map();
  let lastCatalogSyncAt = 0;
  // Shared Rolling 2-Hour Completed Orders Archive State
  // v10.9: full sweep every 15m + near-real-time delta sync every 60s + instant delta on new viewer sessions
  const sharedCompletedMap = new Map();
  let completedArchiveLoadedFromFb = false;
  let completedSyncing = false;
  let completedLastSweepAt = 0;
  let completedNewestCachedMs = 0;
  let lastKnownCompletedLastPage = 1;
  let lastCompletedDeltaSyncAt = 0;
  let lastHandledForceSweepTs = 0;
  let latestUnionZoneIds = [];
  let latestLiveZoneNameToId = new Map();
  let latestActiveSessionsSnapshot = [];
  const prevLiveOrdersMap = new Map();
  // v10.9: code -> first-checked ts. Failed/unknown-status checks are retried after 10 minutes
  const checkedTransitionCodes = new Map();
  const knownSessionIds = new Set();

  // Courier Cache & Throttling
  const couriersBySpCache = new Map();
  const allKnownCouriersMap = new Map();

  // Processed Request Trackers
  const processedOrderDetailReqs = new Map();
  const orderDetailAttemptCounts = new Map();
  let lastHandledCourierDetailTs = 0;
  let lastHandledRiderSearchId = "";
  const processedCompletedIdReqs = new Map();
  const processedCompletedRangeReqs = new Map();

  function buildStartingPointQueryParams(zoneIds) {
    const ids = Array.from(new Set((zoneIds || []).map(Number).filter((n) => n > 0)));
    if (ids.length === 0) return "";
    return ids.map((id) => `starting_point_id%5B%5D=${encodeURIComponent(id)}`).join("&");
  }

  async function hurrierGetWithRetry(path, maxRetries = 2, baseDelayMs = 250) {
    let lastErr = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await hurrierGet(path);
      } catch (err) {
        lastErr = err;
        const msg = String(err?.message || "");
        if (msg.includes("HURRIER_404")) throw err;
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, baseDelayMs * (attempt + 1)));
        }
      }
    }
    throw lastErr || new Error("HURRIER_RETRY_FAILED");
  }

  async function fetchSingleDeliveryPage(basePathWithQuery, page) {
    const sep = basePathWithQuery.includes("?") ? "&" : "?";
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const data = await hurrierGet(`${basePathWithQuery}${sep}page=${page}&per_page=50`);
        const recs = Array.isArray(data?.records) ? data.records : [];
        const totalHint = Number(
          data?.metadata?.total_count ??
            data?.total_count ??
            data?.total ??
            data?.meta?.total ??
            data?.pagination?.total ??
            0
        );
        return { ok: true, records: recs, totalHint };
      } catch {
        // Progressive backoff (300ms/600ms/900ms) so a busy Hurrier server is not hammered
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
      }
    }
    return { ok: false, records: [], totalHint: 0 };
  }

  async function fetchAllDeliveryPages(basePathWithQuery, maxPagesCap = 180) {
    const all = [];
    const seenIds = new Set();
    let serverTotalHint = 0;
    const failedPages = new Set();

    const addRecs = (recs) => {
      for (const r of recs) {
        // v10.12: dedup on delivery id + courier_id so every rider on multi-rider / split orders survives
        const rid = String(r?.id ?? "").trim();
        const cid = String(r?.courier_id ?? "").trim();
        const dedupKey = rid
          ? `${rid}_${cid}`
          : `uniq_${all.length}_${Math.random().toString(36).slice(2, 9)}`;
        if (!seenIds.has(dedupKey)) {
          seenIds.add(dedupKey);
          all.push(r);
        }
      }
    };

    const p1 = await fetchSingleDeliveryPage(basePathWithQuery, 1);
    if (!p1.ok) return null;
    serverTotalHint = Number(p1.totalHint || 0);
    addRecs(p1.records);

    const expectedTotalPages =
      p1.totalHint > 0 ? Math.min(maxPagesCap, Math.ceil(p1.totalHint / 50)) : 0;

    if (p1.records.length < 50 && (!expectedTotalPages || expectedTotalPages <= 1)) {
      return { records: all, totalPages: 1, serverTotal: serverTotalHint };
    }

    let nextPage = 2;
    let totalPages = 1;
    let consecutiveEmptyBatches = 0;

    while (nextPage <= maxPagesCap) {
      if (expectedTotalPages > 0 && nextPage > expectedTotalPages) break;

      const batchPages = [];
      for (let i = 0; i < 6 && nextPage <= maxPagesCap; i++, nextPage++) {
        if (expectedTotalPages > 0 && nextPage > expectedTotalPages) break;
        batchPages.push(nextPage);
      }
      if (batchPages.length === 0) break;

      const results = await Promise.all(
        batchPages.map((pg) => fetchSingleDeliveryPage(basePathWithQuery, pg))
      );
      let batchHadRecords = false;
      let explicitEndReached = false;
      let batchAllFailed = true;

      for (let i = 0; i < results.length; i++) {
        const res = results[i];
        if (!res.ok) {
          // Mark the page for a post-loop retry instead of silently losing its records
          failedPages.add(batchPages[i]);
          continue;
        }
        batchAllFailed = false;
        if (res.records.length > 0) {
          batchHadRecords = true;
          totalPages = Math.max(totalPages, batchPages[i]);
          addRecs(res.records);
          if (res.totalHint > 0 && serverTotalHint === 0) serverTotalHint = res.totalHint;
          if (
            res.records.length < 50 &&
            (!expectedTotalPages || batchPages[i] >= expectedTotalPages)
          ) {
            explicitEndReached = true;
          }
        } else if (res.records.length === 0) {
          explicitEndReached = true;
        }
      }

      if (batchAllFailed || !batchHadRecords) {
        consecutiveEmptyBatches++;
        if (consecutiveEmptyBatches >= 2) break;
      } else {
        consecutiveEmptyBatches = 0;
        if (explicitEndReached && (!expectedTotalPages || totalPages >= expectedTotalPages)) {
          break;
        }
      }
    }

    // CRITICAL ANTI-LOSS RETRY: any page that failed during the sweep is retried up to
    // 3 extra rounds before giving up, so a transient 4xx/5xx can never drop ~50 orders
    let retryRound = 0;
    while (failedPages.size > 0 && retryRound < 3) {
      retryRound++;
      const pages = Array.from(failedPages).sort((a, b) => a - b);
      failedPages.clear();
      const retryResults = await Promise.all(
        pages.map((pg) => fetchSingleDeliveryPage(basePathWithQuery, pg))
      );
      retryResults.forEach((res, i) => {
        const pg = pages[i];
        if (!res.ok) {
          failedPages.add(pg);
          return;
        }
        if (res.totalHint > 0 && serverTotalHint === 0) serverTotalHint = res.totalHint;
        if (res.records.length > 0) {
          totalPages = Math.max(totalPages, pg);
          addRecs(res.records);
        }
      });
      if (failedPages.size > 0) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    return { records: all, totalPages, serverTotal: serverTotalHint };
  }

  function formatCairo24Hour(isoStr) {
    if (!isoStr || String(isoStr).startsWith("0001-01-01")) return "";
    const d = new Date(isoStr);
    if (Number.isNaN(d.getTime())) return "";
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: "Africa/Cairo",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).format(d);
  }

  function normalizeCourierEntryForSp(entry, spId) {
    const c = entry?.courier || entry || {};
    const veh = entry?.vehicle || {};
    const meta = entry?.current_state_metadata || c?.status_meta_data || {};
    const cid = String(c.id || entry?.courier_id || "");
    const statusLower = String(c.status || "working").toLowerCase();

    let stateTime24h = "";
    if (statusLower === "break" || statusLower.includes("temp")) {
      stateTime24h = formatCairo24Hour(meta.ended_at);
    } else if (statusLower === "ending") {
      stateTime24h = formatCairo24Hour(entry?.active_shift_ended_at || meta.shift_ended_at);
    } else if (statusLower === "starting" || statusLower === "ready" || statusLower === "late") {
      stateTime24h = formatCairo24Hour(entry?.active_shift_started_at || meta.shift_started_at);
    }

    const vType = veh.vehicle_type_name || "Bike";
    const vBag = veh.vehicle_bag_type_name || "";
    const norm = {
      starting_point_id: Number(spId),
      id: c.id,
      courier_id: c.id,
      name: c.name || "",
      user_id: c.user_id || "",
      phone_number: c.phone_number || "",
      status: c.status || "working",
      status_until: meta.ended_at || "",
      performed_by: meta.performed_by || "",
      status_reason: meta.reason || "",
      contract_type: c.contract_type || "",
      vehicle_type: vType,
      vehicle_full: [vType, vBag].filter(Boolean).join("-"),
      active_orders_count: Number(entry?.active_delivery_count ?? 0),
      state_time_24h: stateTime24h
    };

    if (cid) {
      allKnownCouriersMap.set(cid, norm);
    }
    return norm;
  }

  async function fetchCouriersForStartingPoints(spIds) {
    const now = Date.now();
    const toFetch = [];
    for (const id of spIds) {
      const cached = couriersBySpCache.get(Number(id));
      if (!cached || now - cached.ts > 6500) {
        toFetch.push(Number(id));
      }
    }

    for (let i = 0; i < toFetch.length; i += 6) {
      const chunk = toFetch.slice(i, i + 6);
      await Promise.all(
        chunk.map(async (spId) => {
          try {
            const data = await hurrierGet(
              `/dispatcher-dashboard/couriers?starting_point_id=${encodeURIComponent(spId)}`
            );
            const rawList = Array.isArray(data?.couriers) ? data.couriers : [];
            const normalized = rawList.map((entry) => normalizeCourierEntryForSp(entry, spId));
            couriersBySpCache.set(spId, { ts: Date.now(), list: normalized });
          } catch {}
        })
      );
    }

    const out = [];
    for (const id of spIds) {
      const cached = couriersBySpCache.get(Number(id));
      if (cached && Array.isArray(cached.list)) {
        out.push(...cached.list);
      }
    }
    return out;
  }

  // ============================================================================
  // 7) ROLLING 2H COMPLETED ARCHIVE (15-MIN CYCLE AUTO-PRUNE OLD & ADD NEW)
  // ============================================================================
  function getCairoDateStringForMs(ms) {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Africa/Cairo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(new Date(ms));
  }

  function extractCompletedMsFromRecord(rec) {
    if (rec?.__completed_at_ms && Number(rec.__completed_at_ms) > 0) {
      return Number(rec.__completed_at_ms);
    }
    const order = rec?.order || {};
    const primaryDel = rec?.primary_delivery || {};
    const timings = rec?.primary_delivery_timings || {};
    const candidates = [
      primaryDel.completed_at,
      primaryDel.delivered_at,
      primaryDel.dropped_off_at,
      primaryDel.finished_at,
      timings.completed_at,
      timings.delivered_at,
      timings.dropped_off_at,
      order.current_state_transition,
      order.completed_at,
      order.delivered_at,
      order.dropped_off_at,
      order.finished_at,
      rec?.completed_at,
      rec?.delivered_at,
      rec?.dropped_off_at
    ];
    for (const v of candidates) {
      if (v) {
        const ms = typeof v === "number" ? (v > 1e12 ? v : v * 1000) : new Date(v).getTime();
        if (!Number.isNaN(ms) && ms > 946684800000) return ms;
      }
    }
    const placedMs = order.placed_at ? new Date(order.placed_at).getTime() : 0;
    const rawTotalTimeSec = Number(timings.total_time);
    if (placedMs > 0 && !Number.isNaN(rawTotalTimeSec) && rawTotalTimeSec > 0) {
      return placedMs + rawTotalTimeSec * 1000;
    }
    if (order.updated_at) {
      const updMs = new Date(order.updated_at).getTime();
      if (!Number.isNaN(updMs) && updMs > 946684800000) return updMs;
    }
    return 0;
  }

  function doesCompletedRecordMatchUnionZones(rec) {
    if (!Array.isArray(latestUnionZoneIds) || latestUnionZoneIds.length === 0) return true;
    const idSet = new Set(latestUnionZoneIds.map(Number));
    const nameSet = new Set();
    knownZonesCatalogMap.forEach((z, zid) => {
      if (idSet.has(zid)) nameSet.add(String(z.name).trim().toLowerCase());
    });

    const rawSps = Array.isArray(rec?.starting_points)
      ? rec.starting_points
      : Array.isArray(rec?.order?.drop_off_address?.starting_points)
      ? rec.order.drop_off_address.starting_points
      : Array.isArray(rec?.order?.dropoff_address?.starting_points)
      ? rec.order.dropoff_address.starting_points
      : [];

    if (rawSps.length === 0) return true;

    return rawSps.some((sp) => {
      if (sp && typeof sp === "object" && sp.id && idSet.has(Number(sp.id))) return true;
      const spName = String(typeof sp === "string" ? sp : sp?.name || "")
        .trim()
        .toLowerCase();
      if (!spName) return false;
      if (nameSet.has(spName)) return true;
      const mappedId = latestLiveZoneNameToId.get(spName);
      if (mappedId && idSet.has(mappedId)) return true;
      const stripped = spName.replace(/\s+sp$/i, "").trim();
      const mappedStripped = latestLiveZoneNameToId.get(`${stripped} sp`);
      return Boolean(mappedStripped && idSet.has(mappedStripped));
    });
  }

  // Strict 2-hour rolling window rule: drop anything older than 2 hours, keep only latest 2h
  function pruneOldCompletedRecords() {
    const rolling2hCutoff = Date.now() - 2 * 3600 * 1000;
    for (const [code, rec] of sharedCompletedMap.entries()) {
      const ms = extractCompletedMsFromRecord(rec);
      if (ms > 0 && ms < rolling2hCutoff) {
        sharedCompletedMap.delete(code);
      }
    }
  }

  async function loadInitialSharedCompletedArchive() {
    if (completedArchiveLoadedFromFb) return;
    try {
      const data = await firebaseReq("GET", "/config/shared_completed_archive");
      completedArchiveLoadedFromFb = true;
      if (data && typeof data === "object") {
        Object.entries(data).forEach(([code, rec]) => {
          if (rec && typeof rec === "object") {
            const ms = extractCompletedMsFromRecord(rec);
            sharedCompletedMap.set(String(code), ms > 0 ? { ...rec, __completed_at_ms: ms } : rec);
          }
        });
        pruneOldCompletedRecords();
        let maxMs = 0;
        for (const rec of sharedCompletedMap.values()) {
          const ms = extractCompletedMsFromRecord(rec);
          if (ms > maxMs) maxMs = ms;
        }
        completedNewestCachedMs = maxMs;
        const now = Date.now();
        // If Firebase 2h archive is already fresh (< 15m old), hydrate immediately and delta-sync only the gap
        if (sharedCompletedMap.size > 0 && maxMs > 0 && now - maxMs < 15 * 60 * 1000) {
          completedLastSweepAt = maxMs;
          runCompletedSmartDeltaSync(maxMs - 2 * 60 * 1000).catch(() => {});
        }
      }
    } catch {}
  }

  // Pulls ONLY the missing gap from newestCachedMs up to now (fast startup after logout/login without full re-scan)
  async function runCompletedSmartDeltaSync(fromCutoffMs) {
    if (completedSyncing) return;
    completedSyncing = true;
    const now = Date.now();
    const effectiveFromMs = Math.max(now - 2 * 3600 * 1000, Number(fromCutoffMs || 0));
    const todayStr = getCairoDateStringForMs(now);

    try {
      const deltaMap = new Map();
      const detectedLastPage = await ingestCompletedWindowBackwardsForDate(
        todayStr,
        effectiveFromMs,
        now + 10 * 60 * 1000,
        deltaMap,
        lastKnownCompletedLastPage
      );
      if (detectedLastPage > 0) {
        lastKnownCompletedLastPage = detectedLastPage;
      }

      let addedAny = false;
      for (const [code, rec] of deltaMap.entries()) {
        if (doesCompletedRecordMatchUnionZones(rec)) {
          sharedCompletedMap.set(code, rec);
          addedAny = true;
        }
      }
      // v10.9: keep the newest cached completed timestamp fresh for the next delta window
      for (const rec of deltaMap.values()) {
        const ms = extractCompletedMsFromRecord(rec);
        if (ms > completedNewestCachedMs) completedNewestCachedMs = ms;
      }
      pruneOldCompletedRecords();
      if (addedAny) {
        await saveSharedCompletedArchiveToFb();
        await pushImmediateCompletedPatchToSessions();
      }
    } finally {
      completedSyncing = false;
    }
  }

  async function saveSharedCompletedArchiveToFb() {
    pruneOldCompletedRecords();
    const obj = {};
    for (const [code, rec] of sharedCompletedMap.entries()) {
      if (doesCompletedRecordMatchUnionZones(rec)) {
        obj[code] = rec;
      }
    }
    try {
      await firebaseReq("PUT", "/config/shared_completed_archive", obj);
    } catch {}
  }

  async function pushImmediateCompletedPatchToSessions() {
    if (!Array.isArray(latestActiveSessionsSnapshot) || latestActiveSessionsSnapshot.length === 0) {
      return;
    }
    pruneOldCompletedRecords();
    const allComp = Array.from(sharedCompletedMap.values());
    await Promise.all(
      latestActiveSessionsSnapshot.map(async (sess) => {
        const sessZoneIdSet = new Set(sess.zoneIds.map(Number));
        const sessZoneNameSet = new Set();
        knownZonesCatalogMap.forEach((z, zid) => {
          if (sessZoneIdSet.has(zid)) {
            sessZoneNameSet.add(String(z.name).trim().toLowerCase());
          }
        });
        const filtered = allComp.filter((rec) => {
          const rawSps = Array.isArray(rec?.starting_points)
            ? rec.starting_points
            : Array.isArray(rec?.order?.drop_off_address?.starting_points)
            ? rec.order.drop_off_address.starting_points
            : Array.isArray(rec?.order?.dropoff_address?.starting_points)
            ? rec.order.dropoff_address.starting_points
            : [];
          if (rawSps.length === 0) return true;
          return rawSps.some((sp) => {
            if (sp && typeof sp === "object" && sp.id && sessZoneIdSet.has(Number(sp.id))) return true;
            const spName = String(typeof sp === "string" ? sp : sp?.name || "").trim().toLowerCase();
            if (!spName) return false;
            if (sessZoneNameSet.has(spName)) return true;
            const mappedId = latestLiveZoneNameToId.get(spName);
            return Boolean(mappedId && sessZoneIdSet.has(mappedId));
          });
        });
        try {
          await firebaseReq("PATCH", `/session_bundles/${encodeURIComponent(sess.sessionId)}`, {
            completedRecords: filtered,
            completedSyncing,
            completedLastSweepAt
          });
        } catch {}
      })
    );
  }

  function buildCompletedRecordFromOrderDetail(detailRes, fallbackDeliveryRec = null) {
    const dOrder = detailRes?.order || detailRes || {};
    const code = String(
      dOrder.code ||
        dOrder.confirmation_number ||
        String(dOrder.order_code || "").replace(/^(HF_[A-Z]{2}|ODR_[A-Z]{2})/i, "") ||
        ""
    ).trim();
    const sps =
      dOrder?.drop_off_address?.starting_points ||
      fallbackDeliveryRec?.starting_points ||
      [];
    const completedAtIso =
      dOrder.current_state_transition || dOrder.updated_at || new Date().toISOString();
    const completedMs = new Date(completedAtIso).getTime() || Date.now();

    return {
      __completed_at_ms: completedMs,
      starting_points: sps,
      distance: fallbackDeliveryRec?.distance || dOrder.distance || 0,
      courier_id: fallbackDeliveryRec?.courier_id || dOrder.courier_id || "",
      courier_name: fallbackDeliveryRec?.courier_name || dOrder.courier_name || "",
      order: {
        ...dOrder,
        code,
        confirmation_number: code,
        status: dOrder.status || "completed",
        current_state_transition: completedAtIso
      },
      primary_delivery: {
        completed_at: completedAtIso,
        courier_id: fallbackDeliveryRec?.courier_id || dOrder.courier_id || "",
        courier_name: fallbackDeliveryRec?.courier_name || dOrder.courier_name || "",
        delivery_distance: fallbackDeliveryRec?.distance || dOrder.distance || 0
      },
      primary_delivery_timings: dOrder.timings || {}
    };
  }

  // Catch orders that disappear from Active/Dispatched and turn into Completed in real time
  async function catchCompletedTransitionsFromLiveOrders(globalTabRecords) {
    const currentLiveCodes = new Set();
    for (const tabKey of ["Queued", "Dispatched", "Active"]) {
      const list = Array.isArray(globalTabRecords[tabKey]) ? globalTabRecords[tabKey] : [];
      for (const r of list) {
        const ord = r?.order || {};
        const code = String(
          ord.code ||
            ord.confirmation_number ||
            String(ord.order_code || "").replace(/^(HF_[A-Z]{2}|ODR_[A-Z]{2})/i, "") ||
            ""
        ).trim();
        if (code) currentLiveCodes.add(code);
      }
    }

    if (prevLiveOrdersMap.size > 0) {
      const nowTs = Date.now();
      // v10.9: purge stale check-marks so lost/failed transitions get re-checked instead of waiting for the 15m sweep
      if (checkedTransitionCodes.size > 400) {
        for (const [cCode, cTs] of checkedTransitionCodes.entries()) {
          if (nowTs - cTs > 10 * 60 * 1000) checkedTransitionCodes.delete(cCode);
        }
      }
      const candidates = [];
      for (const [code, prevRec] of prevLiveOrdersMap.entries()) {
        if (
          !currentLiveCodes.has(code) &&
          !sharedCompletedMap.has(code) &&
          nowTs - (checkedTransitionCodes.get(code) || 0) > 10 * 60 * 1000
        ) {
          candidates.push({ code, prevRec });
        }
      }

      if (candidates.length > 0) {
        const batch = candidates.slice(0, 15);
        let caughtAny = false;
        await Promise.all(
          batch.map(async ({ code, prevRec }) => {
            if (!checkedTransitionCodes.has(code)) checkedTransitionCodes.set(code, Date.now());
            try {
              const det = await hurrierGet(`/orders/${encodeURIComponent(code)}`);
              const dOrder = det?.order || det || {};
              const st = String(dOrder.status || "").toLowerCase();
              if (st === "completed" || st === "delivered") {
                const compRec = buildCompletedRecordFromOrderDetail(det, prevRec);
                sharedCompletedMap.set(code, compRec);
                caughtAny = true;
              }
            } catch {}
          })
        );
        if (caughtAny) {
          saveSharedCompletedArchiveToFb().catch(() => {});
          pushImmediateCompletedPatchToSessions().catch(() => {});
        }
      }
    }

    prevLiveOrdersMap.clear();
    for (const tabKey of ["Dispatched", "Active"]) {
      const list = Array.isArray(globalTabRecords[tabKey]) ? globalTabRecords[tabKey] : [];
      for (const r of list) {
        const ord = r?.order || {};
        const code = String(
          ord.code ||
            ord.confirmation_number ||
            String(ord.order_code || "").replace(/^(HF_[A-Z]{2}|ODR_[A-Z]{2})/i, "") ||
            ""
        ).trim();
        if (code) prevLiveOrdersMap.set(code, r);
      }
    }
  }

  // Hurrier's /dispatcher-dashboard/orders/completed?date=YYYY-MM-DD returns records sorted ASCENDING (00:00 AM first)
  async function fetchCompletedOrdersPageWithMeta(dateStr, page) {
    try {
      const data = await hurrierGet(
        `/dispatcher-dashboard/orders/completed?date=${encodeURIComponent(dateStr)}&page=${page}&per_page=50`
      );
      const recs = Array.isArray(data?.records)
        ? data.records
        : Array.isArray(data?.orders)
        ? data.orders
        : Array.isArray(data)
        ? data
        : [];
      const totalCount = Number(
        data?.metadata?.total_count ??
          data?.total_count ??
          data?.total ??
          data?.meta?.total ??
          0
      );
      return { ok: true, records: recs, totalCount };
    } catch {
      return { ok: false, records: [], totalCount: 0 };
    }
  }

  async function findLastCompletedPageForDate(dateStr, hintLastPage = 1) {
    const p1 = await fetchCompletedOrdersPageWithMeta(dateStr, 1);
    if (!p1.ok || p1.records.length === 0) return { lastPage: 0, prefetched: new Map() };

    const prefetched = new Map([[1, p1.records]]);
    if (p1.totalCount > 0) {
      return { lastPage: Math.max(1, Math.ceil(p1.totalCount / 50)), prefetched };
    }
    if (p1.records.length < 50) {
      return { lastPage: 1, prefetched };
    }

    let low = 1;
    let high = Math.max(2, hintLastPage);

    // Exponential probe up to 4000 pages (200,000 daily orders) so afternoon/evening peaks are always reached
    while (high <= 4000) {
      const pr = await fetchCompletedOrdersPageWithMeta(dateStr, high);
      if (!pr.ok || pr.records.length === 0) {
        break;
      }
      prefetched.set(high, pr.records);
      if (pr.records.length < 50) {
        return { lastPage: high, prefetched };
      }
      low = high;
      high = high < 32 ? high * 2 : high + 60;
    }

    // Binary search between low (non-empty) and high (empty)
    while (low + 1 < high) {
      const mid = Math.floor((low + high) / 2);
      const pr = await fetchCompletedOrdersPageWithMeta(dateStr, mid);
      if (pr.ok && pr.records.length > 0) {
        prefetched.set(mid, pr.records);
        if (pr.records.length < 50) {
          return { lastPage: mid, prefetched };
        }
        low = mid;
      } else {
        high = mid;
      }
    }

    return { lastPage: low, prefetched };
  }

  async function ingestCompletedWindowBackwardsForDate(
    dateStr,
    fromMs,
    toMs,
    targetMap,
    hintPage = 1,
    options = {}
  ) {
    const { lastPage, prefetched } = await findLastCompletedPageForDate(dateStr, hintPage);
    if (lastPage <= 0) return 0;

    let pg = lastPage;
    let batchIdx = 0;
    while (pg >= 1) {
      const batchPages = [];
      for (let i = 0; i < 4 && pg >= 1; i++, pg--) {
        batchPages.push(pg);
      }

      const batchResults = await Promise.all(
        batchPages.map(async (pNum) => {
          if (prefetched.has(pNum)) return { page: pNum, records: prefetched.get(pNum) };
          const res = await fetchCompletedOrdersPageWithMeta(dateStr, pNum);
          return { page: pNum, records: res.records };
        })
      );

      let reachedOlderThanWindow = false;
      for (const { records } of batchResults) {
        if (!records || records.length === 0) continue;
        let newestInPage = 0;
        for (const r of records) {
          const ord = r?.order || r || {};
          const code = String(
            ord.confirmation_number ||
              ord.code ||
              String(ord.order_code || "").replace(/^(HF_[A-Z]{2}|ODR_[A-Z]{2})/i, "") ||
              ""
          ).trim();
          const compMs = extractCompletedMsFromRecord(r);
          if (compMs > newestInPage) newestInPage = compMs;
          if (code && compMs >= fromMs && compMs <= toMs) {
            targetMap.set(code, { ...r, __completed_at_ms: compMs });
          }
        }
        if (newestInPage > 0 && newestInPage < fromMs) {
          reachedOlderThanWindow = true;
        }
      }

      // Progressive Instant Push: immediately publish the newest tail batch so UI populates in <2s
      if (batchIdx === 0 && typeof options.onFirstBatch === "function") {
        await options.onFirstBatch(targetMap);
      }
      batchIdx++;

      if (reachedOlderThanWindow) break;
    }

    return lastPage;
  }

  // Every 15 minutes: drop old orders (> 2h) and add newly completed orders in the rolling 2-hour window
  async function runCompletedArchive15MinSweep() {
    if (completedSyncing) return;
    completedSyncing = true;
    const now = Date.now();
    const cutoffMs = now - 2 * 3600 * 1000;
    const todayStr = getCairoDateStringForMs(now);
    const cutoffDateStr = getCairoDateStringForMs(cutoffMs);

    try {
      const freshMap = new Map();
      const detectedLastPage = await ingestCompletedWindowBackwardsForDate(
        todayStr,
        cutoffMs,
        now + 10 * 60 * 1000,
        freshMap,
        lastKnownCompletedLastPage,
        {
          onFirstBatch: async (partialMap) => {
            pruneOldCompletedRecords();
            for (const [code, rec] of partialMap.entries()) {
              if (doesCompletedRecordMatchUnionZones(rec)) {
                sharedCompletedMap.set(code, rec);
              }
            }
            await saveSharedCompletedArchiveToFb();
            await pushImmediateCompletedPatchToSessions();
          }
        }
      );
      if (detectedLastPage > 0) {
        lastKnownCompletedLastPage = detectedLastPage;
      }

      if (cutoffDateStr !== todayStr) {
        await ingestCompletedWindowBackwardsForDate(
          cutoffDateStr,
          cutoffMs,
          now + 10 * 60 * 1000,
          freshMap,
          1
        );
      }

      // Replace with clean 2-hour window (removes anything > 2h and keeps all newly completed orders)
      sharedCompletedMap.clear();
      for (const [code, rec] of freshMap.entries()) {
        if (doesCompletedRecordMatchUnionZones(rec)) {
          sharedCompletedMap.set(code, rec);
        }
      }
      pruneOldCompletedRecords();
      completedLastSweepAt = Date.now();
      await saveSharedCompletedArchiveToFb();
      await pushImmediateCompletedPatchToSessions();
    } finally {
      completedSyncing = false;
    }
  }

  // ============================================================================
  // 8) ON-DEMAND REQUEST HANDLERS (Order Details + Notes, Courier Details, Rider Search, Completed Lookup)
  // ============================================================================
  async function processOnDemandRequests() {
    // A) Per-Order Detail + Deliveries + Dispatcher Notes Requests (Parallel + Retry + Zero Null Overwrite)
    try {
      const reqs = await firebaseReq("GET", "/config/order_detail_reqs");
      if (reqs && typeof reqs === "object") {
        const entries = Object.entries(reqs).filter(([, v]) => v && v.code);
        await Promise.all(
          entries.slice(0, 6).map(async ([key, req]) => {
            const code = String(req.code).trim();
            const reqTs = Number(req.requestedAt || 0);
            const reqSig = `${reqTs}`;
            if (processedOrderDetailReqs.get(code) === reqSig) return;
            processedOrderDetailReqs.set(code, reqSig);

            const orderCode = String(req.orderCode || `HF_EG${code}`).trim();
            const internalId = String(req.internalOrderId || "").trim();

            const fetchOrderDetailAnyId = async () => {
              try {
                const r1 = await hurrierGetWithRetry(`/orders/${encodeURIComponent(code)}`, 2, 250);
                if (r1 && (r1.order || r1.id || r1.code)) return r1;
              } catch (err) {
                if (!internalId || internalId === code) throw err;
              }
              if (internalId && internalId !== code) {
                return await hurrierGetWithRetry(`/orders/${encodeURIComponent(internalId)}`, 2, 250);
              }
              return null;
            };

            const fetchOrderDeliveriesAnyId = async () => {
              try {
                const d1 = await hurrierGetWithRetry(
                  `/orders/${encodeURIComponent(code)}/deliveries`,
                  2,
                  250
                );
                const list1 = Array.isArray(d1?.deliveries)
                  ? d1.deliveries
                  : Array.isArray(d1)
                  ? d1
                  : [];
                if (list1.length > 0 || !internalId || internalId === code) return d1;
              } catch (err) {
                if (!internalId || internalId === code) throw err;
              }
              if (internalId && internalId !== code) {
                return await hurrierGetWithRetry(
                  `/orders/${encodeURIComponent(internalId)}/deliveries`,
                  2,
                  250
                );
              }
              return null;
            };

            const [detRes, delRes, notesRes] = await Promise.allSettled([
              fetchOrderDetailAnyId(),
              fetchOrderDeliveriesAnyId(),
              hurrierGetWithRetry(
                `/orders/dispatcher_notes?code=${encodeURIComponent(orderCode)}`,
                1,
                250
              ).catch(() =>
                hurrierGetWithRetry(
                  `/hurrier/v1/orders/dispatcher_notes?code=${encodeURIComponent(orderCode)}`,
                  1,
                  250
                )
              )
            ]);

            const hasDetail = detRes.status === "fulfilled" && detRes.value;
            const delVal = delRes.status === "fulfilled" ? delRes.value : null;
            const extractedDelList = Array.isArray(delVal?.deliveries)
              ? delVal.deliveries
              : Array.isArray(delVal)
              ? delVal
              : Array.isArray(detRes.value?.order?.deliveries)
              ? detRes.value.order.deliveries
              : [];
            const hasDeliveries = extractedDelList.length > 0;
            const isGenuine404 =
              detRes.status === "rejected" &&
              String(detRes.reason?.message || "").includes("HURRIER_404") &&
              delRes.status === "rejected" &&
              String(delRes.reason?.message || "").includes("HURRIER_404");

            if ((!hasDetail || !hasDeliveries) && !isGenuine404) {
              // Retry if either detail or deliveries failed transiently so logs never stay empty
              const attemptKey = `${code}_${reqTs}`;
              const tries = (orderDetailAttemptCounts.get(attemptKey) || 0) + 1;
              orderDetailAttemptCounts.set(attemptKey, tries);
              if (tries < 3) {
                processedOrderDetailReqs.delete(code);
                if (!hasDetail) return;
              } else {
                firebaseReq("DELETE", `/config/order_detail_reqs/${encodeURIComponent(key)}`).catch(
                  () => {}
                );
              }
            } else {
              firebaseReq("DELETE", `/config/order_detail_reqs/${encodeURIComponent(key)}`).catch(
                () => {}
              );
            }

            let prevSaved = null;
            if (!hasDetail || !hasDeliveries) {
              try {
                prevSaved = await firebaseReq("GET", `/order_details/${encodeURIComponent(code)}`);
              } catch {}
            }

            const finalDetail = hasDetail ? detRes.value : prevSaved?.detail || null;
            const finalDeliveries = hasDeliveries
              ? { deliveries: extractedDelList }
              : prevSaved?.deliveries || { deliveries: [] };
            const finalNotes =
              notesRes.status === "fulfilled" && notesRes.value
                ? notesRes.value
                : prevSaved?.notes || { dispatcher_notes: [] };

            const payload = {
              code,
              detail: finalDetail,
              deliveries: finalDeliveries,
              deliveriesFetched: Boolean(hasDeliveries || delRes.status === "fulfilled" || isGenuine404),
              notFound: isGenuine404,
              notes: finalNotes,
              updatedAt: Date.now()
            };
            await firebaseReq("PUT", `/order_details/${encodeURIComponent(code)}`, payload);
          })
        );
      }
    } catch {}

    // B) On-Demand Courier Detail + Balance
    try {
      const cReq = await firebaseReq("GET", "/config/courier_detail_req");
      if (cReq && cReq.courierId && Number(cReq.requestedAt || 0) > lastHandledCourierDetailTs) {
        lastHandledCourierDetailTs = Number(cReq.requestedAt);
        const cid = String(cReq.courierId).trim();
        const [detRes, balRes] = await Promise.allSettled([
          hurrierGetWithRetry(`/courier/detail?courier_id=${encodeURIComponent(cid)}`, 1, 250).catch(
            () => hurrierGetWithRetry(`/couriers/${encodeURIComponent(cid)}`, 1, 250)
          ),
          hurrierGetWithRetry(`/courier/balance?courier_id=${encodeURIComponent(cid)}`, 1, 250).catch(
            () => hurrierGetWithRetry(`/couriers/${encodeURIComponent(cid)}/balance`, 1, 250)
          )
        ]);
        const rawDet = detRes.status === "fulfilled" ? detRes.value : {};
        const rawBal = balRes.status === "fulfilled" ? balRes.value : {};
        const cObj = rawDet?.courier || rawDet || {};
        const meta = cObj?.status_meta_data || cObj?.current_state_metadata || {};
        const veh = cObj?.vehicle;
        const vehStr =
          veh && typeof veh === "object"
            ? [veh.vehicle_type_name, veh.vehicle_bag_type_name].filter(Boolean).join("-")
            : typeof veh === "string"
            ? veh
            : "";

        const balanceVal =
          rawBal?.balance ?? rawBal?.amount ?? cObj?.balance ?? rawDet?.balance ?? null;

        await firebaseReq("PUT", `/courier_details/${encodeURIComponent(cid)}`, {
          ...rawDet,
          balance: balanceVal,
          requestedAt: lastHandledCourierDetailTs,
          updatedAt: Date.now(),
          normalized: {
            courierId: String(cObj.id || cid),
            userId: String(cObj.user_id || ""),
            name: cObj.name || cReq.courierName || "",
            phone: cObj.phone_number || cObj.mobile || cObj.phone || "",
            rawStatus: cObj.status || "",
            status: cObj.status || "",
            statusUntil: cObj.status_until || meta.ended_at || "",
            performedBy: meta.performed_by || "",
            statusReason: meta.reason || "",
            contract: cObj.contract_info?.type || cObj.contract_type || "",
            vehicle: vehStr,
            balance: balanceVal
          }
        });
      }
    } catch {}

    // C) Live Rider Search
    try {
      const rReq = await firebaseReq("GET", "/config/rider_search_req");
      if (rReq && rReq.reqId && rReq.reqId !== lastHandledRiderSearchId && rReq.query) {
        lastHandledRiderSearchId = String(rReq.reqId);
        const q = String(rReq.query).trim();
        const qLower = q.toLowerCase();
        const qDigits = q.replace(/\D/g, "");
        const resultsMap = new Map();

        const addMatch = (item) => {
          const cid = String(item.courierId || item.id || "");
          if (!cid) return;
          if (!resultsMap.has(cid)) {
            resultsMap.set(cid, {
              courierId: cid,
              userId: String(item.userId || item.user_id || ""),
              name: item.name || "",
              phone: item.phone || item.phone_number || "",
              status: item.status || "Working",
              statusUntil: item.statusUntil || item.status_until || "",
              statusReason: item.statusReason || item.status_reason || ""
            });
          }
        };

        for (const c of allKnownCouriersMap.values()) {
          const uid = String(c.user_id || "");
          const cid = String(c.id || "");
          const ph = String(c.phone_number || "").replace(/\D/g, "");
          const nm = String(c.name || "").toLowerCase();
          if (
            (qDigits && (uid.includes(qDigits) || cid === qDigits || ph.includes(qDigits))) ||
            (nm && nm.includes(qLower))
          ) {
            addMatch(c);
          }
        }

        try {
          const apiData = await hurrierGet(`/couriers?query=${encodeURIComponent(q)}`).catch(() =>
            hurrierGet(`/courier/search?query=${encodeURIComponent(q)}`)
          );
          const list = Array.isArray(apiData?.couriers)
            ? apiData.couriers
            : Array.isArray(apiData)
            ? apiData
            : [];
          list.forEach((entry) => {
            const c = entry?.courier || entry || {};
            const meta = entry?.current_state_metadata || c?.status_meta_data || {};
            addMatch({
              courierId: c.id,
              userId: c.user_id,
              name: c.name,
              phone: c.phone_number,
              status: c.status,
              statusUntil: meta.ended_at || "",
              statusReason: meta.reason || ""
            });
          });
        } catch {}

        await firebaseReq("PUT", "/config/rider_search_res", {
          reqId: lastHandledRiderSearchId,
          results: Array.from(resultsMap.values()).slice(0, 20),
          updatedAt: Date.now()
        });
      }
    } catch {}

    // D) Direct Order ID Lookup in Completed Orders
    try {
      const idReqs = await firebaseReq("GET", "/config/completed_id_reqs");
      if (idReqs && typeof idReqs === "object") {
        for (const [key, req] of Object.entries(idReqs)) {
          if (!req || !req.code) continue;
          const code = String(req.code).trim();
          const reqTs = Number(req.requestedAt || 0);
          if (processedCompletedIdReqs.get(code) === reqTs) continue;
          processedCompletedIdReqs.set(code, reqTs);

          let found = false;
          let status = "not_found";
          let record = null;

          if (sharedCompletedMap.has(code)) {
            found = true;
            status = "completed";
            record = sharedCompletedMap.get(code);
          } else {
            try {
              const det = await hurrierGetWithRetry(`/orders/${encodeURIComponent(code)}`, 1, 250);
              const dOrder = det?.order || det || {};
              if (dOrder && (dOrder.id || dOrder.code)) {
                found = true;
                status = String(dOrder.status || "completed").toLowerCase();
                record = buildCompletedRecordFromOrderDetail(det, null);
                if (status === "completed" || status === "delivered") {
                  status = "completed";
                  const ms = extractCompletedMsFromRecord(record);
                  if (ms >= Date.now() - 2 * 3600 * 1000) {
                    sharedCompletedMap.set(code, record);
                    saveSharedCompletedArchiveToFb().catch(() => {});
                  }
                }
              }
            } catch (e) {
              const errMsg = String(e?.message || "");
              if (errMsg.includes("HURRIER_404")) {
                found = false;
                status = "not_found";
              } else {
                found = false;
                status = "lookup_error";
              }
            }
          }

          await firebaseReq("PUT", `/session_bundles/comp_id_${encodeURIComponent(code)}`, {
            code,
            found,
            status,
            record,
            updatedAt: Date.now()
          });
          firebaseReq("DELETE", `/config/completed_id_reqs/${encodeURIComponent(key)}`).catch(() => {});
        }
      }
    } catch {}

    // E) Custom Time Range Completed Orders Request
    try {
      const rangeReqs = await firebaseReq("GET", "/config/completed_range_reqs");
      if (rangeReqs && typeof rangeReqs === "object") {
        for (const [sessKey, req] of Object.entries(rangeReqs)) {
          if (!req || !req.reqId) continue;
          if (processedCompletedRangeReqs.get(sessKey) === req.reqId) continue;
          processedCompletedRangeReqs.set(sessKey, req.reqId);

          const fromMs = Number(req.fromMs || 0);
          const toMs = Number(req.toMs || 0);
          const dateStr = req.dateStr || getCairoDateStringForMs(fromMs || Date.now());
          const rangeMap = new Map();

          for (const [code, rec] of sharedCompletedMap.entries()) {
            const ms = extractCompletedMsFromRecord(rec);
            if (ms >= fromMs && ms <= toMs) {
              rangeMap.set(code, rec);
            }
          }

          await ingestCompletedWindowBackwardsForDate(
            dateStr,
            fromMs,
            toMs,
            rangeMap,
            dateStr === getCairoDateStringForMs(Date.now()) ? lastKnownCompletedLastPage : 1
          );

          await firebaseReq(
            "PUT",
            `/session_bundles/comp_range_${encodeURIComponent(req.sessionId || sessKey)}`,
            {
              reqId: req.reqId,
              records: Array.from(rangeMap.values()),
              updatedAt: Date.now()
            }
          );
          firebaseReq("DELETE", `/config/completed_range_reqs/${encodeURIComponent(sessKey)}`).catch(
            () => {}
          );
        }
      }
    } catch {}

    // F) Force Completed Archive Refresh Request
    try {
      const fReq = await firebaseReq("GET", "/config/completed_force_sync_req");
      if (fReq && Number(fReq.requestedAt || 0) > lastHandledForceSweepTs) {
        lastHandledForceSweepTs = Number(fReq.requestedAt);
        runCompletedArchive15MinSweep().catch(() => {});
      }
    } catch {}
  }

  // ============================================================================
  // 9) MAIN 2-SECOND REAL-TIME SYNC LOOP
  // ============================================================================
  let isSyncTickRunning = false;

  async function runSyncTick() {
    if (isSyncTickRunning) return;
    isSyncTickRunning = true;

    try {
      if (!acquireSamePcTabLock()) {
        isCurrentLeader = false;
        setBadge("#0f766e", `v${SCRIPT_VERSION} [Device Tab Standby • Active Tab Feeding]`);
        return;
      }

      const authToken = await getValidFirebaseIdToken(false);
      if (!authToken) {
        setBadge("#b45309", `v${SCRIPT_VERSION} • Open Dashboard Tab Once`);
        return;
      }

      const leaderOk = await ensureMultiPcLeadership();
      const now = Date.now();

      // Read active sessions
      const rawSessions = (await firebaseReq("GET", "/active_sessions")) || {};
      const activeSessions = [];
      const activeViewers = [];
      const unionZoneIdsSet = new Set();

      Object.entries(rawSessions).forEach(([sid, sess]) => {
        if (!sess || typeof sess !== "object") return;
        if (now - Number(sess.lastSeen || 0) > 35000) return;
        const zIds = Array.isArray(sess.zoneIds)
          ? sess.zoneIds.map(Number).filter((n) => n > 0)
          : [];
        if (zIds.length === 0) return;
        zIds.forEach((id) => unionZoneIdsSet.add(id));
        activeSessions.push({ ...sess, sessionId: sid, zoneIds: zIds });
        activeViewers.push({
          sessionId: sid,
          email: sess.email || "",
          employeeName: sess.employeeName || sess.email || "Captain",
          zoneCount: zIds.length,
          activeTab: sess.activeTab || "Active"
        });
      });

      if (!leaderOk) {
        setBadge(
          "#0f766e",
          `v${SCRIPT_VERSION} [Backup Standby] (${activeViewers.length} Viewers)`
        );
        return;
      }

      const unionZoneIds = Array.from(unionZoneIdsSet);
      latestUnionZoneIds = unionZoneIds;
      latestActiveSessionsSnapshot = activeSessions;

      if (activeSessions.length === 0) {
        setBadge(
          "#15803d",
          `v${SCRIPT_VERSION} [Primary Leader] Live (2s) • 0 Viewers`
        );
        return;
      }

      // Rolling 2-hour Completed Archive
      await loadInitialSharedCompletedArchive();

      // v10.9: track viewer sessions — a brand-new session triggers an instant completed delta
      // so its very first bundle is already complete instead of trickling in
      let hasNewViewerSession = false;
      for (const sess of activeSessions) {
        if (!knownSessionIds.has(sess.sessionId)) {
          knownSessionIds.add(sess.sessionId);
          hasNewViewerSession = true;
        }
      }
      if (knownSessionIds.size > activeSessions.length) {
        for (const sid of Array.from(knownSessionIds)) {
          if (!activeSessions.some((s) => s.sessionId === sid)) knownSessionIds.delete(sid);
        }
      }

      // v10.9: keep the newest cached completed timestamp fresh (drives the delta window)
      let newestCompletedMs = 0;
      for (const rec of sharedCompletedMap.values()) {
        const ms = extractCompletedMsFromRecord(rec);
        if (ms > newestCompletedMs) newestCompletedMs = ms;
      }
      if (newestCompletedMs > completedNewestCachedMs) completedNewestCachedMs = newestCompletedMs;

      if (completedLastSweepAt === 0 || now - completedLastSweepAt >= 15 * 60 * 1000) {
        runCompletedArchive15MinSweep().catch(() => {});
      } else if (
        (hasNewViewerSession || now - lastCompletedDeltaSyncAt >= 60 * 1000) &&
        !completedSyncing
      ) {
        // v10.9: near-real-time delta — pull only the tiny gap since the newest cached completed order
        lastCompletedDeltaSyncAt = now;
        const deltaFromMs =
          completedNewestCachedMs > 0 ? completedNewestCachedMs - 90 * 1000 : now - 15 * 60 * 1000;
        runCompletedSmartDeltaSync(deltaFromMs).catch(() => {});
      }

      const spQuery = buildStartingPointQueryParams(unionZoneIds);
      const doFullActiveSweep =
        !cachedTabRecordsMap.has("Active") || now - lastFullActiveSweepAt >= 5000;

      const [statsRes, ...tabFetchResults] = await Promise.allSettled([
        hurrierGet("/dispatcher-dashboard/stats"),
        ...DELIVERY_ENDPOINTS.map(async (ep) => {
          const fullUrl = spQuery ? `${ep.path}?${spQuery}` : ep.path;

          if (ep.tab === "Active" && !doFullActiveSweep) {
            const prevAll = cachedTabRecordsMap.get("Active") || [];
            const pagesToRefresh = new Set([1, 2, 3]);
            for (
              let p = Math.max(1, lastKnownActivePageCount - 6);
              p <= lastKnownActivePageCount + 2;
              p++
            ) {
              pagesToRefresh.add(p);
            }
            const refreshedPages = await Promise.all(
              Array.from(pagesToRefresh).map((pg) => fetchSingleDeliveryPage(fullUrl, pg))
            );
            const mergedById = new Map();
            const mergeKey = (r, prefix, idx) => {
              const ownId = String(r?.id ?? "").trim();
              const cid = String(r?.courier_id ?? "").trim();
              // v10.12: key by delivery id + courier_id so multi-rider / split-order siblings survive
              return ownId
                ? `${ownId}_${cid}`
                : `${prefix}_${idx}_${Math.random().toString(36).slice(2, 8)}`;
            };
            prevAll.forEach((r, idx) => {
              mergedById.set(mergeKey(r, "prev", idx), r);
            });
            refreshedPages.forEach((pr) => {
              if (pr.ok && pr.records.length > 0) {
                pr.records.forEach((r, idx) => {
                  mergedById.set(mergeKey(r, `ref${pr.records.length}`, idx), r);
                });
              }
            });
            return {
              tab: ep.tab,
              records: Array.from(mergedById.values()),
              serverTotal: Number(lastServerTotalsMap.get(ep.tab) || 0)
            };
          }

          const full = await fetchAllDeliveryPages(fullUrl, ep.tab === "Active" ? 180 : 50);
          if (full && Array.isArray(full.records)) {
            if (ep.tab === "Active") {
              lastFullActiveSweepAt = Date.now();
              lastKnownActivePageCount = full.totalPages || 1;
            }
            cachedTabRecordsMap.set(ep.tab, full.records);
            if (Number(full.serverTotal || 0) > 0) {
              lastServerTotalsMap.set(ep.tab, Number(full.serverTotal));
            }
            return {
              tab: ep.tab,
              records: full.records,
              serverTotal: Number(full.serverTotal || 0)
            };
          }
          return {
            tab: ep.tab,
            records: cachedTabRecordsMap.get(ep.tab) || [],
            serverTotal: Number(lastServerTotalsMap.get(ep.tab) || 0)
          };
        })
      ]);

      const globalTabRecords = { Queued: [], Dispatched: [], Active: [] };
      const serverTabTotals = {};
      tabFetchResults.forEach((res) => {
        if (res.status === "fulfilled" && res.value?.tab) {
          globalTabRecords[res.value.tab] = res.value.records || [];
          if (Number(res.value.serverTotal || 0) > 0) {
            serverTabTotals[res.value.tab] = Number(res.value.serverTotal);
          }
        }
      });

      // Catch orders transitioning from Active/Dispatched to Completed in real time
      catchCompletedTransitionsFromLiveOrders(globalTabRecords).catch(() => {});

      // Fetch active couriers for all union starting points
      const allUnionCouriers = await fetchCouriersForStartingPoints(unionZoneIds);

      // Parse zone stats & update dynamic zones catalog
      const allZoneStatsList = [];
      const liveZoneNameToId = new Map();
      latestLiveZoneNameToId = liveZoneNameToId;

      if (statsRes.status === "fulfilled" && Array.isArray(statsRes.value?.cities)) {
        statsRes.value.cities.forEach((cityObj) => {
          const cityName = cityObj?.city_name || "Cairo";
          (cityObj?.zones || []).forEach((zGrp) => {
            const parentZoneDelay = Number(zGrp?.stat?.delay ?? zGrp?.delay ?? 0);
            (zGrp?.starting_points || []).forEach((sp) => {
              if (sp?.id && sp?.name) {
                const spIdNum = Number(sp.id);
                const spNameClean = String(sp.name).trim();
                liveZoneNameToId.set(spNameClean.toLowerCase(), spIdNum);
                knownZonesCatalogMap.set(spIdNum, {
                  id: spIdNum,
                  name: spNameClean,
                  city: cityName
                });
                const spOwnDelay = Number(sp?.delay ?? sp?.stat?.delay ?? sp?.stat?.avg_delay ?? 0);
                const rawDelayVal = spOwnDelay > 0 ? spOwnDelay : parentZoneDelay;
                allZoneStatsList.push({
                  id: spIdNum,
                  name: spNameClean,
                  city: cityName,
                  delay: Math.round(rawDelayVal * 10) / 10,
                  stat: sp?.stat || {}
                });
              }
            });
          });
        });
      }

      if (knownZonesCatalogMap.size > 0 && now - lastCatalogSyncAt > 10 * 60 * 1000) {
        lastCatalogSyncAt = now;
        firebaseReq(
          "PUT",
          "/config/dynamic_zones_catalog",
          Array.from(knownZonesCatalogMap.values())
        ).catch(() => {});
      }

      // Helper to match a record against a specific session's selected zones.
      // v10.8: a record is dropped ONLY on a confident non-match (a known zone id or a
      // known zone name that is not in this session's zones). Unknown zone names are
      // trusted to the server-side starting_point filter instead of losing the order.
      const recordMatchesSessionZones = (rec, sessZoneIdSet, sessZoneNameSet) => {
        const rawSps = Array.isArray(rec?.starting_points)
          ? rec.starting_points
          : Array.isArray(rec?.order?.drop_off_address?.starting_points)
          ? rec.order.drop_off_address.starting_points
          : Array.isArray(rec?.order?.dropoff_address?.starting_points)
          ? rec.order.dropoff_address.starting_points
          : [];

        if (rawSps.length === 0) return true;

        let hasConfidentNonMatch = false;
        let hasUnknownSp = false;

        for (const sp of rawSps) {
          if (sp && typeof sp === "object" && sp.id) {
            if (sessZoneIdSet.has(Number(sp.id))) return true;
            hasConfidentNonMatch = true;
            continue;
          }
          const spName = String(typeof sp === "string" ? sp : sp?.name || "")
            .trim()
            .toLowerCase();
          if (!spName) {
            hasUnknownSp = true;
            continue;
          }
          if (sessZoneNameSet.has(spName)) return true;
          const mappedId = liveZoneNameToId.get(spName);
          if (mappedId && sessZoneIdSet.has(mappedId)) return true;
          const stripped = spName.replace(/\s+sp$/i, "").trim();
          if (stripped && sessZoneNameSet.has(stripped)) return true;
          const mappedStrippedId = liveZoneNameToId.get(`${stripped} sp`);
          if (mappedStrippedId && sessZoneIdSet.has(mappedStrippedId)) return true;
          if (liveZoneNameToId.has(spName) || liveZoneNameToId.has(`${stripped} sp`)) {
            hasConfidentNonMatch = true;
          } else {
            hasUnknownSp = true;
          }
        }

        return hasUnknownSp && !hasConfidentNonMatch;
      };

      pruneOldCompletedRecords();
      const allCompletedRecords = Array.from(sharedCompletedMap.values());

      // Build & push tailored session bundles for each active viewer
      let maxActiveDisplayed = 0;
      await Promise.all(
        activeSessions.map(async (sess) => {
          const sessZoneIdSet = new Set(sess.zoneIds.map(Number));
          const sessZoneNameSet = new Set();
          knownZonesCatalogMap.forEach((z, zid) => {
            if (sessZoneIdSet.has(zid)) {
              sessZoneNameSet.add(String(z.name).trim().toLowerCase());
            }
          });

          // v10.12: collect parent order keys of every matched delivery across Queued/Dispatched/Active
          // so split/multi-rider sibling deliveries (is_primary: false) are NEVER dropped when their
          // starting_points differ from the primary delivery's starting_points.
          const matchedParentOrderKeys = new Set();
          const collectOrderKeys = (rec) => {
            const ord = rec?.order || {};
            const keys = [];
            if (ord.id) keys.push(`oid:${String(ord.id).trim()}`);
            if (ord.code) keys.push(`code:${String(ord.code).trim()}`);
            if (ord.order_code) keys.push(`ocode:${String(ord.order_code).trim()}`);
            return keys;
          };

          for (const tKey of ["Queued", "Dispatched", "Active"]) {
            for (const r of globalTabRecords[tKey]) {
              if (recordMatchesSessionZones(r, sessZoneIdSet, sessZoneNameSet)) {
                collectOrderKeys(r).forEach((k) => matchedParentOrderKeys.add(k));
              }
            }
          }

          const recordBelongsToSessionWithSiblings = (r) => {
            if (recordMatchesSessionZones(r, sessZoneIdSet, sessZoneNameSet)) return true;
            return collectOrderKeys(r).some((k) => matchedParentOrderKeys.has(k));
          };

          const sessTabRecords = {
            Queued: globalTabRecords.Queued.filter(recordBelongsToSessionWithSiblings),
            Dispatched: globalTabRecords.Dispatched.filter(recordBelongsToSessionWithSiblings),
            Active: globalTabRecords.Active.filter(recordBelongsToSessionWithSiblings)
          };

          maxActiveDisplayed = Math.max(maxActiveDisplayed, sessTabRecords.Active.length);

          const sessCompletedRecords = allCompletedRecords.filter((r) =>
            recordMatchesSessionZones(r, sessZoneIdSet, sessZoneNameSet)
          );

          const sessCouriers = allUnionCouriers.filter((c) =>
            sessZoneIdSet.has(Number(c.starting_point_id))
          );

          const sessZoneStats = allZoneStatsList.filter((zs) =>
            sessZoneIdSet.has(Number(zs.id))
          );

          await firebaseReq("PUT", `/session_bundles/${encodeURIComponent(sess.sessionId)}`, {
            updatedAt: Date.now(),
            tabRecords: sessTabRecords,
            completedRecords: sessCompletedRecords,
            completedSyncing,
            completedLastSweepAt,
            couriers: sessCouriers,
            zoneStats: sessZoneStats,
            counts: {
              Queued: sessTabRecords.Queued.length,
              Dispatched: sessTabRecords.Dispatched.length,
              Active: sessTabRecords.Active.length
            },
            serverTotals: serverTabTotals,
            fetchedTotals: {
              Queued: globalTabRecords.Queued.length,
              Dispatched: globalTabRecords.Dispatched.length,
              Active: globalTabRecords.Active.length
            },
            activeViewers
          });
        })
      );

      setBadge(
        "#15803d",
        `v${SCRIPT_VERSION} [Primary Leader] Live (2s) • ${activeViewers.length} Viewer • ${maxActiveDisplayed} Act • Comp (${allCompletedRecords.length})`
      );
    } catch (err) {
      setBadge("#b91c1c", `v${SCRIPT_VERSION} • Sync Retry (${err?.message || "err"})`);
    } finally {
      isSyncTickRunning = false;
    }
  }

  setTimeout(() => {
    ensureBadge();
    runSyncTick();
    setInterval(runSyncTick, 2000);
  }, 1200);

  // Dedicated 400ms Fast-Lane for On-Demand Order Details, Notes, Courier Profiles & Searches
  let isFastOnDemandRunning = false;
  setInterval(async () => {
    if (isFastOnDemandRunning || !ownsLocalTabLock || !isCurrentLeader) return;
    isFastOnDemandRunning = true;
    try {
      await processOnDemandRequests();
    } catch {} finally {
      isFastOnDemandRunning = false;
    }
  }, 400);
})();
