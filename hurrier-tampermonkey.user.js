// ==UserScript==
// @name         Hurrier Live Sync
// @namespace    https://mahmoudosman-hub.github.io/hurrier-live/
// @version      10.27
// @description  [v10.27] Distributed Multi-Admin Active Feeders + Visibility-Aware Relay for View-Only Employees
// @author       Mahmoud Mohammed
// @match        https://eg.me.logisticsbackoffice.com/*
// @match        https://*.logisticsbackoffice.com/*
// @match        https://mahmoudosman-hub.github.io/hurrier-live/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_openInTab
// @connect      hurrier-live-default-rtdb.europe-west1.firebasedatabase.app
// @connect      securetoken.googleapis.com
// @connect      raw.githubusercontent.com
// @connect      eg.me.logisticsbackoffice.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const SCRIPT_VERSION = "10.27";
  const GITHUB_SCRIPT_RAW_URL =
    "https://raw.githubusercontent.com/mahmoudosman-hub/hurrier-live/main/hurrier-tampermonkey.user.js";
  const FIREBASE_DB_URL =
    "https://hurrier-live-default-rtdb.europe-west1.firebasedatabase.app";
  const AUTH_BRIDGE_STORAGE_KEY = "hurrier_fb_bridge_auth";
  const GM_AUTH_BRIDGE_KEY = "hurrier_gm_fb_auth_v1";

  const IS_DASHBOARD_HOST =
    location.hostname.includes("mahmoudosman-hub.github.io") ||
    location.pathname.includes("/hurrier-live");
  const IS_HURRIER_HOST = location.hostname.includes("logisticsbackoffice.com");

  // ============================================================================
  // 1) DASHBOARD -> HURRIER AUTH BRIDGE SYNC
  // ============================================================================
  function syncAuthBridgeFromDashboardPage() {
    if (!IS_DASHBOARD_HOST) return;
    try {
      const raw = window.localStorage.getItem(AUTH_BRIDGE_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && parsed.idToken && typeof GM_setValue === "function") {
        GM_setValue(GM_AUTH_BRIDGE_KEY, parsed);
      }
    } catch {}
  }

  if (IS_DASHBOARD_HOST) {
    syncAuthBridgeFromDashboardPage();
    setInterval(syncAuthBridgeFromDashboardPage, 4000);
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
  // 4) HURRIER BACKOFFICE API CLIENT (Exact 64-bit ID Preservation + JWT Auth)
  // ============================================================================
  const HURRIER_API_BASE = "https://eg.me.logisticsbackoffice.com/api";

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
      if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(clean)) return clean;
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
      const m = document.cookie.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
      if (m) return m[0];
    } catch {}
    return "";
  }

  function preserveLargeJsonIntegers(rawText) {
    // Wrap 15+ digit numeric values in quotes so 64-bit order IDs never lose precision in JS
    return String(rawText || "").replace(
      /(:\s*)(\d{15,22})(?=\s*[,}\]])/g,
      '$1"$2"'
    );
  }

  async function hurrierGet(path) {
    const url = path.startsWith("http")
      ? path
      : `${HURRIER_API_BASE}${path.startsWith("/") ? path : `/${path}`}`;
    const jwt = getHurrierBearerToken();
    const headers = { Accept: "application/json" };
    if (jwt) {
      headers.Authorization = `Bearer ${jwt}`;
    }
    const res = await fetch(url, {
      method: "GET",
      credentials: "include",
      headers
    });
    if (!res.ok) {
      throw new Error(`HURRIER_${res.status}`);
    }
    const rawText = await res.text();
    if (!rawText) return {};
    return JSON.parse(preserveLargeJsonIntegers(rawText));
  }

  async function hurrierGetWithRetry(path, retries = 2, delayMs = 150) {
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await hurrierGet(path);
      } catch (err) {
        lastErr = err;
        const msg = String(err?.message || "");
        if (msg === "HURRIER_404" || msg === "HURRIER_401" || msg === "HURRIER_403") {
          throw err;
        }
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, delayMs * (attempt + 1)));
        }
      }
    }
    throw lastErr;
  }

  let discoveredOrderEndpointPrefix = "";
  async function fetchFirstValidOrderEndpoint(buildSuffixFn, validatorFn) {
    const prefixes = Array.from(
      new Set(
        [
          discoveredOrderEndpointPrefix,
          "/dispatcher-dashboard/orders",
          "/hurrier/orders",
          "/hurrier/v1/orders",
          "/orders"
        ].filter(Boolean)
      )
    );
    for (const prefix of prefixes) {
      try {
        const data = await hurrierGet(`${prefix}${buildSuffixFn()}`);
        if (validatorFn(data)) {
          discoveredOrderEndpointPrefix = prefix;
          return { prefix, data };
        }
      } catch {}
    }
    return null;
  }

  // ============================================================================
  // 5) SHARED HELPERS, PRIORITY YIELDING & CAIRO DATE/TIME UTILITIES
  // ============================================================================
  let priorityUrgentUntil = 0;
  let isCompletedSweepRunning = false;

  function isPriorityUrgentActive() {
    return Date.now() < priorityUrgentUntil;
  }

  async function waitWhilePriorityUrgent(maxWaitMs = 2200) {
    const start = Date.now();
    while (isPriorityUrgentActive() && Date.now() - start < maxWaitMs) {
      await new Promise((r) => setTimeout(r, 120));
    }
  }

  function normalizeText(v) {
    return String(v || "")
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, " ")
      .trim();
  }

  function buildStartingPointQueryParams(zoneIds) {
    const clean = Array.from(
      new Set((Array.isArray(zoneIds) ? zoneIds : []).map(Number).filter((n) => n > 0))
    );
    if (clean.length === 0) return "";
    return clean.map((id) => `starting_point_id%5B%5D=${encodeURIComponent(id)}`).join("&");
  }

  function getCairoTodayDateStr() {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Africa/Cairo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(new Date());
  }

  function extractRecordCompletedMs(rec) {
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

    for (const val of candidates) {
      if (val) {
        const ms =
          typeof val === "number" ? (val > 1e12 ? val : val * 1000) : new Date(val).getTime();
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
    return placedMs || 0;
  }

  // ============================================================================
  // 6) LIVE DELIVERIES FETCHER (Queued / Dispatched / Active - All Pages)
  // ============================================================================
  const lastKnownGoodStatusSnapshots = new Map();

  async function fetchAllPagesForDeliveryStatus(statusSlug, zoneIds) {
    const spQuery = buildStartingPointQueryParams(zoneIds);
    if (!spQuery) return { records: [], serverTotal: 0 };

    if (isPriorityUrgentActive()) {
      await waitWhilePriorityUrgent(2200);
    }

    const p1 = await hurrierGetWithRetry(
      `/dispatcher-dashboard/deliveries/${statusSlug}?${spQuery}&page=1&per_page=50`,
      2,
      150
    );
    const firstRecords = Array.isArray(p1?.records) ? p1.records : [];
    const explicitTotalCount = Number(
      p1?.total_count ?? p1?.meta?.total_count ?? p1?.pagination?.total_count ?? 0
    );
    const explicitTotalPages = Number(
      p1?.total_pages ??
        p1?.meta?.total_pages ??
        p1?.pagination?.total_pages ??
        (explicitTotalCount > 0 ? Math.ceil(explicitTotalCount / 50) : 0)
    );

    const allRecords = [...firstRecords];
    const seenIds = new Set(
      firstRecords.map((r) => String(r?.id || r?.order?.id || "")).filter(Boolean)
    );
    let hadFetchError = false;

    const appendUniqueRecords = (recs) => {
      for (const r of recs) {
        const rid = String(r?.id || r?.order?.id || "");
        if (rid) {
          if (seenIds.has(rid)) continue;
          seenIds.add(rid);
        }
        allRecords.push(r);
      }
    };

    if (explicitTotalPages > 1) {
      const cappedPages = Math.min(45, explicitTotalPages);
      let nextPage = 2;
      while (nextPage <= cappedPages) {
        if (isPriorityUrgentActive()) {
          await waitWhilePriorityUrgent(2200);
        }
        const batchPages = [];
        for (let p = nextPage; p < nextPage + 6 && p <= cappedPages; p++) {
          batchPages.push(p);
        }
        const results = await Promise.all(
          batchPages.map((pageNum) =>
            hurrierGetWithRetry(
              `/dispatcher-dashboard/deliveries/${statusSlug}?${spQuery}&page=${pageNum}&per_page=50`,
              2,
              150
            ).catch(() => {
              hadFetchError = true;
              return null;
            })
          )
        );
        for (const r of results) {
          if (r && Array.isArray(r.records)) {
            appendUniqueRecords(r.records);
          }
        }
        nextPage += batchPages.length;
      }
    } else if (firstRecords.length >= 50) {
      // Hurrier API omits total_pages; probe in parallel batches of 6 until a short/empty page is reached
      let nextPage = 2;
      const maxPagesCap = 45;
      let reachedEnd = false;
      while (nextPage <= maxPagesCap && !reachedEnd) {
        if (isPriorityUrgentActive()) {
          await waitWhilePriorityUrgent(2200);
        }
        const batchPages = [];
        for (let p = nextPage; p < nextPage + 6 && p <= maxPagesCap; p++) {
          batchPages.push(p);
        }
        const results = await Promise.all(
          batchPages.map((pageNum) =>
            hurrierGetWithRetry(
              `/dispatcher-dashboard/deliveries/${statusSlug}?${spQuery}&page=${pageNum}&per_page=50`,
              2,
              150
            )
              .then((data) => ({
                pageNum,
                ok: true,
                records: Array.isArray(data?.records) ? data.records : []
              }))
              .catch(() => {
                hadFetchError = true;
                return { pageNum, ok: false, records: [] };
              })
          )
        );
        for (const res of results) {
          if (!res.ok) continue;
          if (res.records.length > 0) {
            appendUniqueRecords(res.records);
          }
          if (res.records.length < 50) {
            reachedEnd = true;
          }
        }
        nextPage += batchPages.length;
      }
    }

    const snapKey = `${statusSlug}:${spQuery}`;
    const prevSnap = lastKnownGoodStatusSnapshots.get(snapKey);
    if (
      hadFetchError &&
      prevSnap &&
      prevSnap.records.length > allRecords.length &&
      Date.now() - prevSnap.ts < 30000
    ) {
      return {
        records: prevSnap.records,
        serverTotal: prevSnap.serverTotal
      };
    }

    const finalTotal =
      explicitTotalCount > 0 ? Math.max(explicitTotalCount, allRecords.length) : allRecords.length;
    if (!hadFetchError || allRecords.length >= (prevSnap?.records?.length || 0)) {
      lastKnownGoodStatusSnapshots.set(snapKey, {
        records: allRecords,
        serverTotal: finalTotal,
        ts: Date.now()
      });
    }

    return {
      records: allRecords,
      serverTotal: finalTotal
    };
  }

  // ============================================================================
  // 7) COURIERS & ZONE STATS FETCHER
  // ============================================================================
  let latestCachedCouriersById = new Map();

  function normalizeCourierObject(rawRec, fallbackSpId = null) {
    const c = rawRec?.courier || rawRec || {};
    const cid = String(c.id || c.courier_id || "").trim();
    if (!cid) return null;
    const meta = rawRec?.current_state_metadata || c.current_state_metadata || {};
    const veh = rawRec?.vehicle || c.vehicle || {};
    const vehTypeName =
      typeof veh === "string" ? veh : veh.vehicle_type_name || veh.icon || "Bike";
    const vehBagName =
      typeof veh === "object" && veh.vehicle_bag_type_name ? veh.vehicle_bag_type_name : "";
    const vehFull = [vehTypeName, vehBagName].filter(Boolean).join("-");

    let stateTime24h = "";
    const stateTs =
      meta.ended_at ||
      meta.scheduled_break_requested_at ||
      rawRec?.active_shift_started_at ||
      "";
    if (stateTs && !String(stateTs).startsWith("0001-01-01")) {
      const d = new Date(stateTs);
      if (!Number.isNaN(d.getTime())) {
        stateTime24h = d.toLocaleTimeString("en-GB", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false
        });
      }
    }

    return {
      id: cid,
      courier_id: cid,
      user_id: String(c.user_id || c.userId || ""),
      name: normalizeText(c.name || c.courier_name || `Courier #${cid}`),
      phone_number: normalizeText(c.phone_number || c.phone || c.mobile || ""),
      status: String(c.status || rawRec?.status || "working").toLowerCase(),
      status_until: meta.ended_at || "",
      performed_by: meta.performed_by || "",
      status_reason: meta.reason || "",
      contract_type: c.contract_type || "",
      contract_name: c.contract_name || "",
      vehicle_type: vehTypeName,
      vehicle_full: vehFull || vehTypeName,
      active_orders_count: Number(
        rawRec?.active_delivery_count ?? c.active_delivery_count ?? 0
      ),
      starting_point_id: Number(meta.starting_point_id || fallbackSpId || 0),
      state_time_24h: stateTime24h
    };
  }

  async function fetchCouriersAndStatsForZones(zoneIds) {
    const cleanZoneIds = Array.from(
      new Set((Array.isArray(zoneIds) ? zoneIds : []).map(Number).filter((n) => n > 0))
    );
    const zoneStats = [];
    const dynamicZones = [];

    try {
      const statsRes = await hurrierGet("/dispatcher-dashboard/stats");
      const cities = Array.isArray(statsRes?.cities) ? statsRes.cities : [];
      for (const cityObj of cities) {
        const cName = cityObj.city_name || "Cairo";
        const zones = Array.isArray(cityObj?.zones) ? cityObj.zones : [];
        for (const zObj of zones) {
          const sps = Array.isArray(zObj?.starting_points) ? zObj.starting_points : [];
          for (const sp of sps) {
            const spId = Number(sp.id);
            if (!spId) continue;
            dynamicZones.push({ id: spId, name: sp.name, city: cName });
            const st = sp.stat || {};
            zoneStats.push({
              id: spId,
              name: sp.name,
              city: cName,
              delay: Math.round(Number(st.delay || 0) * 10) / 10,
              stat: st
            });
          }
        }
      }
    } catch {}

    const couriersOut = [];
    const seenKeys = new Set();

    for (let i = 0; i < cleanZoneIds.length; i += 6) {
      if (isPriorityUrgentActive()) {
        await waitWhilePriorityUrgent(2200);
      }
      const chunk = cleanZoneIds.slice(i, i + 6);
      const responses = await Promise.all(
        chunk.map((zid) =>
          hurrierGet(`/dispatcher-dashboard/couriers?starting_point_id=${encodeURIComponent(zid)}`)
            .then((data) => ({ zid, list: Array.isArray(data?.couriers) ? data.couriers : [] }))
            .catch(() => ({ zid, list: [] }))
        )
      );
      for (const { zid, list } of responses) {
        for (const rawC of list) {
          const norm = normalizeCourierObject(rawC, zid);
          if (!norm) continue;
          latestCachedCouriersById.set(norm.id, norm);
          const uniqKey = `${zid}:${norm.id}`;
          if (!seenKeys.has(uniqKey)) {
            seenKeys.add(uniqKey);
            couriersOut.push(norm);
          }
        }
      }
    }

    return { couriers: couriersOut, zoneStats, dynamicZones };
  }

  // ============================================================================
  // 8) SHARED 2H COMPLETED ARCHIVE + CUSTOM RANGE + DIRECT ID LOOKUP
  // ============================================================================
  const completedArchiveMap = new Map();
  let lastCompletedSweepAt = 0;

  async function findLastCompletedPageForDate(dateStr, p1Data = null) {
    const p1 =
      p1Data ||
      (await hurrierGet(
        `/dispatcher-dashboard/orders/completed?date=${encodeURIComponent(dateStr)}&page=1&per_page=50`
      ));
    const explicitTotalCount = Number(
      p1?.total_count ?? p1?.meta?.total_count ?? p1?.pagination?.total_count ?? 0
    );
    const explicitTotalPages = Number(
      p1?.total_pages ??
        p1?.meta?.total_pages ??
        p1?.pagination?.total_pages ??
        (explicitTotalCount > 0 ? Math.ceil(explicitTotalCount / 50) : 0)
    );
    if (explicitTotalPages > 1) return explicitTotalPages;

    const firstRecs = Array.isArray(p1?.records) ? p1.records : [];
    if (firstRecs.length < 50) return 1;

    // Exponential probe + binary search to find exact last page when total_pages is omitted
    let lo = 1;
    let hi = 64;
    while (hi <= 32768) {
      if (isPriorityUrgentActive()) {
        await waitWhilePriorityUrgent(2200);
      }
      const probeRes = await hurrierGet(
        `/dispatcher-dashboard/orders/completed?date=${encodeURIComponent(
          dateStr
        )}&page=${hi}&per_page=50`
      ).catch(() => ({ records: [] }));
      const recs = Array.isArray(probeRes?.records) ? probeRes.records : [];
      if (recs.length === 0) break;
      lo = hi;
      if (recs.length < 50) return hi;
      hi *= 2;
    }

    while (lo < hi) {
      const mid = Math.floor((lo + hi + 1) / 2);
      if (isPriorityUrgentActive()) {
        await waitWhilePriorityUrgent(2200);
      }
      const midRes = await hurrierGet(
        `/dispatcher-dashboard/orders/completed?date=${encodeURIComponent(
          dateStr
        )}&page=${mid}&per_page=50`
      ).catch(() => ({ records: [] }));
      const recs = Array.isArray(midRes?.records) ? midRes.records : [];
      if (recs.length > 0) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return lo;
  }

  async function sweepCompletedOrdersLast2Hours(force = false) {
    if (isCompletedSweepRunning) return;
    const now = Date.now();
    if (!force && lastCompletedSweepAt > 0 && now - lastCompletedSweepAt < 15 * 60 * 1000) {
      return;
    }
    isCompletedSweepRunning = true;
    try {
      const todayStr = getCairoTodayDateStr();
      const cutoff2h = Date.now() - 2 * 3600 * 1000;

      if (isPriorityUrgentActive()) {
        await waitWhilePriorityUrgent(2200);
      }

      const p1 = await hurrierGet(
        `/dispatcher-dashboard/orders/completed?date=${encodeURIComponent(todayStr)}&page=1&per_page=50`
      );
      const totalPages = await findLastCompletedPageForDate(todayStr, p1);

      const processPageRecords = (recs) => {
        let anyInWindow = false;
        for (const rec of recs) {
          const compMs = extractRecordCompletedMs(rec);
          const oid = String(rec?.order?.id || rec?.order?.confirmation_number || "");
          if (oid && compMs >= cutoff2h) {
            completedArchiveMap.set(oid, rec);
            anyInWindow = true;
          }
        }
        return anyInWindow;
      };

      if (totalPages === 1) {
        processPageRecords(Array.isArray(p1?.records) ? p1.records : []);
      } else {
        let curPage = totalPages;
        let pagesScanned = 0;
        while (curPage >= 1 && pagesScanned < 80) {
          if (isPriorityUrgentActive()) {
            await waitWhilePriorityUrgent(2200);
          }
          const batch = [];
          for (let p = curPage; p > curPage - 5 && p >= 1; p--) {
            batch.push(p);
          }
          const results = await Promise.all(
            batch.map((pageNum) =>
              hurrierGet(
                `/dispatcher-dashboard/orders/completed?date=${encodeURIComponent(
                  todayStr
                )}&page=${pageNum}&per_page=50`
              ).catch(() => ({ records: [] }))
            )
          );
          let batchHasAnyRecent = false;
          for (const res of results) {
            const recs = Array.isArray(res?.records) ? res.records : [];
            if (processPageRecords(recs)) {
              batchHasAnyRecent = true;
            }
          }
          pagesScanned += batch.length;
          curPage -= batch.length;
          if (!batchHasAnyRecent && pagesScanned >= 10) {
            break;
          }
        }
      }

      // Prune entries older than 2 hours
      for (const [k, rec] of completedArchiveMap.entries()) {
        if (extractRecordCompletedMs(rec) < cutoff2h) {
          completedArchiveMap.delete(k);
        }
      }

      lastCompletedSweepAt = Date.now();

      // Persist shared 2h archive to Firebase
      const archivePayload = {};
      let count = 0;
      for (const [k, rec] of completedArchiveMap.entries()) {
        if (count >= 1500) break;
        archivePayload[k] = rec;
        count++;
      }
      if (count > 0) {
        await firebaseReq("PUT", "/config/shared_completed_archive", archivePayload).catch(() => {});
      }
    } catch {} finally {
      isCompletedSweepRunning = false;
    }
  }

  const processedRangeReqIds = new Set();
  async function processCustomCompletedRangeRequests() {
    try {
      const reqs = await firebaseReq("GET", "/config/completed_range_reqs");
      if (!reqs || typeof reqs !== "object") return;
      for (const [sessKey, req] of Object.entries(reqs)) {
        if (!req || !req.reqId || processedRangeReqIds.has(req.reqId)) continue;
        processedRangeReqIds.add(req.reqId);

        const { reqId, sessionId, dateStr, fromMs, toMs } = req;
        const totalPages = await findLastCompletedPageForDate(dateStr);

        // Binary search for page range around [fromMs, toMs]
        let lo = 1;
        let hi = totalPages;
        let pivotPage = totalPages;
        while (lo <= hi) {
          const mid = Math.floor((lo + hi) / 2);
          const midRes = await hurrierGet(
            `/dispatcher-dashboard/orders/completed?date=${encodeURIComponent(
              dateStr
            )}&page=${mid}&per_page=50`
          ).catch(() => ({ records: [] }));
          const recs = Array.isArray(midRes?.records) ? midRes.records : [];
          if (recs.length === 0) {
            hi = mid - 1;
            continue;
          }
          const firstMs = extractRecordCompletedMs(recs[0]);
          const lastMs = extractRecordCompletedMs(recs[recs.length - 1]);
          pivotPage = mid;
          if (lastMs < fromMs) {
            lo = mid + 1;
          } else if (firstMs > toMs) {
            hi = mid - 1;
          } else {
            break;
          }
        }

        const startP = Math.max(1, pivotPage - 6);
        const endP = Math.min(totalPages, pivotPage + 6);
        const pagesToFetch = [];
        for (let p = startP; p <= endP; p++) pagesToFetch.push(p);

        const matchedRecords = [];
        const seenIds = new Set();
        for (let i = 0; i < pagesToFetch.length; i += 4) {
          const chunk = pagesToFetch.slice(i, i + 4);
          const batchRes = await Promise.all(
            chunk.map((p) =>
              hurrierGet(
                `/dispatcher-dashboard/orders/completed?date=${encodeURIComponent(
                  dateStr
                )}&page=${p}&per_page=50`
              ).catch(() => ({ records: [] }))
            )
          );
          for (const res of batchRes) {
            const recs = Array.isArray(res?.records) ? res.records : [];
            for (const r of recs) {
              const ms = extractRecordCompletedMs(r);
              if (ms >= fromMs && ms <= toMs) {
                const oid = String(r?.order?.id || r?.order?.confirmation_number || "");
                if (oid && !seenIds.has(oid)) {
                  seenIds.add(oid);
                  matchedRecords.push(r);
                }
              }
            }
          }
        }

        await firebaseReq("PUT", `/session_bundles/comp_range_${encodeURIComponent(sessionId)}`, {
          reqId,
          records: matchedRecords,
          updatedAt: Date.now()
        });
        await firebaseReq(
          "DELETE",
          `/config/completed_range_reqs/${encodeURIComponent(sessKey)}`
        ).catch(() => {});
      }
    } catch {}
  }

  const processedCompletedIdReqs = new Map();
  async function processCompletedIdLookupRequests() {
    try {
      const reqs = await firebaseReq("GET", "/config/completed_id_reqs");
      if (!reqs || typeof reqs !== "object") return;
      for (const [key, req] of Object.entries(reqs)) {
        const cleanCode = String(req?.code || key || "").trim();
        const reqAt = Number(req?.requestedAt || 0);
        if (!cleanCode) continue;
        if (processedCompletedIdReqs.get(cleanCode) === reqAt) continue;
        processedCompletedIdReqs.set(cleanCode, reqAt);

        // 1) Check in-memory 2h archive first
        for (const rec of completedArchiveMap.values()) {
          const o = rec?.order || {};
          if (
            String(o.confirmation_number || "") === cleanCode ||
            String(o.id || "") === cleanCode ||
            String(o.order_code || "").endsWith(cleanCode)
          ) {
            await firebaseReq("PUT", `/session_bundles/comp_id_${encodeURIComponent(cleanCode)}`, {
              code: cleanCode,
              found: true,
              status: String(o.status || "completed").toLowerCase(),
              record: rec,
              updatedAt: Date.now()
            });
            await firebaseReq(
              "DELETE",
              `/config/completed_id_reqs/${encodeURIComponent(key)}`
            ).catch(() => {});
            return;
          }
        }

        // 2) Query Hurrier Detail endpoint directly
        let foundOrder = null;
        for (const cTry of [cleanCode, `HF_EG${cleanCode}`]) {
          try {
            const det = await hurrierGet(
              `/dispatcher-dashboard/orders/detail?code=${encodeURIComponent(cTry)}`
            );
            const oObj = det?.order || det;
            if (oObj && (oObj.id || oObj.code || oObj.order_code)) {
              foundOrder = oObj;
              break;
            }
          } catch {}
        }

        if (foundOrder) {
          const wrappedRec = {
            order: {
              ...foundOrder,
              confirmation_number: foundOrder.code || cleanCode,
              total: foundOrder.order_value ?? foundOrder.total,
              vendor_name: foundOrder.vendor?.vendor_name || foundOrder.restaurant_name,
              vendor_code: foundOrder.vendor?.vendor_code,
              vendor_order_number: foundOrder.vendor?.vendor_order_number,
              customer_name: foundOrder.customer?.customer_name
            },
            primary_delivery: {
              courier_name: foundOrder.assigned_couriers?.[0]?.name || "-",
              courier_id: foundOrder.assigned_couriers?.[0]?.id || ""
            }
          };
          await firebaseReq("PUT", `/session_bundles/comp_id_${encodeURIComponent(cleanCode)}`, {
            code: cleanCode,
            found: true,
            status: String(foundOrder.status || "completed").toLowerCase(),
            record: wrappedRec,
            updatedAt: Date.now()
          });
        } else {
          await firebaseReq("PUT", `/session_bundles/comp_id_${encodeURIComponent(cleanCode)}`, {
            code: cleanCode,
            found: false,
            status: "not_found",
            updatedAt: Date.now()
          });
        }
        await firebaseReq(
          "DELETE",
          `/config/completed_id_reqs/${encodeURIComponent(key)}`
        ).catch(() => {});
      }
    } catch {}
  }

  // ============================================================================
  // 9) ULTRA-FAST ON-DEMAND ORDER DETAILS, DELIVERIES (TRANSITIONS) & COURIER
  // ============================================================================
  function isValidOrderObj(d) {
    if (!d || typeof d !== "object") return false;
    const o = d.order || d;
    return Boolean(o.id || o.code || o.order_code || o.status);
  }

  function extractDeliveriesList(d) {
    if (!d) return [];
    if (Array.isArray(d)) return d;
    if (Array.isArray(d.deliveries)) return d.deliveries;
    if (Array.isArray(d.records)) return d.records;
    if (Array.isArray(d.order?.deliveries)) return d.order.deliveries;
    return [];
  }

  const processedOrderReqTimestamps = new Map();
  let lastCourierReqTimestamp = 0;
  let lastRiderSearchReqId = "";

  async function processOnDemandRequests() {
    // A) Order Details & Deliveries (Transitions) Requests
    try {
      const reqs = await firebaseReq("GET", "/config/order_detail_reqs");
      if (reqs && typeof reqs === "object") {
        const pendingEntries = Object.entries(reqs).filter(([key, req]) => {
          if (!req || typeof req !== "object") return false;
          const reqAt = Number(req.requestedAt || 0);
          return reqAt > (processedOrderReqTimestamps.get(key) || 0);
        });

        if (pendingEntries.length > 0) {
          priorityUrgentUntil = Date.now() + 2500;
        }

        await Promise.all(
          pendingEntries.map(async ([key, req]) => {
            const reqAt = Number(req.requestedAt || Date.now());
            processedOrderReqTimestamps.set(key, reqAt);

            const code = String(req.code || key || "").trim();
            const orderCode = String(req.orderCode || (code ? `HF_EG${code}` : "")).trim();
            const internalOrderId = String(req.internalOrderId || "").trim();
            const explicitDeliveryId = String(req.deliveryId || "").trim();
            const idsToProbe = Array.from(
              new Set([internalOrderId, code, orderCode].filter(Boolean))
            );

            const fetchOrderDetailAnyId = async () => {
              const codesToTry = [];
              if (code) codesToTry.push(code);
              if (orderCode && !codesToTry.includes(orderCode)) codesToTry.push(orderCode);
              for (const cVal of codesToTry) {
                try {
                  const res = await hurrierGetWithRetry(
                    `/dispatcher-dashboard/orders/detail?code=${encodeURIComponent(cVal)}`,
                    2,
                    120
                  );
                  if (isValidOrderObj(res)) return res;
                } catch {}
              }
              for (const probeId of idsToProbe) {
                const hit = await fetchFirstValidOrderEndpoint(
                  () => `/${encodeURIComponent(probeId)}`,
                  isValidOrderObj
                );
                if (hit?.data) return hit.data;
              }
              return null;
            };

            const fetchOrderDeliveriesAnyId = async () => {
              const codesToTry = [];
              if (orderCode) codesToTry.push(orderCode);
              if (code && !codesToTry.includes(code)) codesToTry.push(code);
              for (const cVal of codesToTry) {
                try {
                  const res = await hurrierGetWithRetry(
                    `/dispatcher-dashboard/orders/detail/deliveries?code=${encodeURIComponent(cVal)}`,
                    2,
                    120
                  );
                  if (extractDeliveriesList(res).length > 0) return res;
                } catch {}
              }
              for (const probeId of idsToProbe) {
                const hit = await fetchFirstValidOrderEndpoint(
                  () => `/${encodeURIComponent(probeId)}/deliveries`,
                  (d) => extractDeliveriesList(d).length > 0
                );
                if (hit?.data) return hit.data;
              }
              if (explicitDeliveryId) {
                const delPrefixes = [
                  "/hurrier/deliveries",
                  "/hurrier/v1/deliveries",
                  "/dispatcher-dashboard/deliveries",
                  "/deliveries"
                ];
                for (const dp of delPrefixes) {
                  try {
                    const singleDel = await hurrierGet(
                      `${dp}/${encodeURIComponent(explicitDeliveryId)}`
                    );
                    const dObj = singleDel?.delivery || singleDel;
                    if (dObj && (Array.isArray(dObj.transitions) || dObj.id)) {
                      return { deliveries: [dObj] };
                    }
                  } catch {}
                }
              }
              return null;
            };

            // Fetch Detail + Deliveries + Existing Cache immediately without waiting for slow Notes endpoints
            const [existingCached, detRes, delRes] = await Promise.allSettled([
              firebaseReq("GET", `/order_details/${encodeURIComponent(code)}`).catch(() => null),
              fetchOrderDetailAnyId(),
              fetchOrderDeliveriesAnyId()
            ]);

            const prevEntry =
              existingCached.status === "fulfilled" && existingCached.value
                ? existingCached.value
                : {};
            const freshDetail = detRes.status === "fulfilled" ? detRes.value : null;
            let freshDeliveries = delRes.status === "fulfilled" ? delRes.value : null;

            const embeddedDeliveries =
              freshDetail?.deliveries || freshDetail?.order?.deliveries || null;
            if (
              !freshDeliveries &&
              Array.isArray(embeddedDeliveries) &&
              embeddedDeliveries.length > 0
            ) {
              freshDeliveries = { deliveries: embeddedDeliveries };
            }

            const resolvedOidFromDetail = String(
              freshDetail?.order?.id || freshDetail?.id || ""
            ).trim();
            if (
              !freshDeliveries &&
              resolvedOidFromDetail &&
              !idsToProbe.includes(resolvedOidFromDetail)
            ) {
              const hit2 = await fetchFirstValidOrderEndpoint(
                () => `/${encodeURIComponent(resolvedOidFromDetail)}/deliveries`,
                (d) => extractDeliveriesList(d).length > 0
              );
              if (hit2?.data) freshDeliveries = hit2.data;
            }

            const finalDetail = freshDetail || prevEntry.detail || null;
            const finalDeliveries = freshDeliveries || prevEntry.deliveries || null;
            const embeddedNotes =
              freshDetail?.dispatcher_notes || freshDetail?.order?.dispatcher_notes || null;
            const finalNotes =
              (Array.isArray(embeddedNotes) ? { dispatcher_notes: embeddedNotes } : null) ||
              prevEntry.notes || { dispatcher_notes: [] };

            const delListCheck = extractDeliveriesList(finalDeliveries);
            const hasDeliveries = delListCheck.some(
              (d) => Array.isArray(d?.transitions) && d.transitions.length > 0
            );

            const payload = {
              code,
              detail: finalDetail,
              deliveries: finalDeliveries,
              deliveriesFetched: Boolean(hasDeliveries || finalDetail),
              notFound: false,
              notes: finalNotes,
              updatedAt: Date.now()
            };
            await firebaseReq("PUT", `/order_details/${encodeURIComponent(code)}`, payload);
            priorityUrgentUntil = 0;
            firebaseReq("DELETE", `/config/order_detail_reqs/${encodeURIComponent(key)}`).catch(
              () => {}
            );

            // Non-blocking background notes check (never delays transitions display)
            (async () => {
              try {
                const notePaths = [
                  `/dispatcher-dashboard/orders/detail/notes?code=${encodeURIComponent(orderCode)}`,
                  `/dispatcher-dashboard/orders/detail/notes?code=${encodeURIComponent(code)}`
                ];
                for (const np of notePaths) {
                  try {
                    const nData = await hurrierGet(np);
                    const nArr = Array.isArray(nData?.dispatcher_notes)
                      ? nData.dispatcher_notes
                      : Array.isArray(nData)
                      ? nData
                      : null;
                    if (nArr && nArr.length > 0) {
                      await firebaseReq("PATCH", `/order_details/${encodeURIComponent(code)}`, {
                        notes: { dispatcher_notes: nArr },
                        updatedAt: Date.now()
                      });
                      break;
                    }
                  } catch {}
                }
              } catch {}
            })();
          })
        );
      }
    } catch {}

    // B) On-Demand Courier Profile & Balance Request
    try {
      const cReq = await firebaseReq("GET", "/config/courier_detail_req");
      if (cReq && cReq.courierId && Number(cReq.requestedAt || 0) > lastCourierReqTimestamp) {
        lastCourierReqTimestamp = Number(cReq.requestedAt);
        const cid = String(cReq.courierId).trim();
        let detailData = null;
        let balanceVal = null;

        const detailCandidates = [
          `/dispatcher-dashboard/couriers/${encodeURIComponent(cid)}`,
          `/couriers/${encodeURIComponent(cid)}`,
          `/dispatcher-dashboard/couriers/detail?courier_id=${encodeURIComponent(cid)}`
        ];
        for (const p of detailCandidates) {
          try {
            const res = await hurrierGet(p);
            if (res && (res.id || res.courier?.id || res.user_id || res.courier?.user_id)) {
              detailData = res;
              break;
            }
          } catch {}
        }

        const balanceCandidates = [
          `/dispatcher-dashboard/couriers/${encodeURIComponent(cid)}/balance`,
          `/couriers/${encodeURIComponent(cid)}/balance`
        ];
        for (const bp of balanceCandidates) {
          try {
            const bRes = await hurrierGet(bp);
            if (bRes && (bRes.balance !== undefined || bRes.amount !== undefined)) {
              balanceVal = bRes.balance ?? bRes.amount;
              break;
            }
          } catch {}
        }

        const cachedC = latestCachedCouriersById.get(cid);
        const unwrapped = detailData?.courier || detailData || cachedC || {};
        const norm = normalizeCourierObject({ courier: unwrapped }, cachedC?.starting_point_id);

        await firebaseReq("PUT", `/courier_details/${encodeURIComponent(cid)}`, {
          courier: unwrapped,
          balance: balanceVal,
          normalized: norm
            ? {
                courierId: norm.id,
                userId: norm.user_id,
                name: norm.name,
                phone: norm.phone_number,
                rawStatus: norm.status,
                status: norm.status,
                statusUntil: norm.status_until,
                performedBy: norm.performed_by,
                statusReason: norm.status_reason,
                contract: norm.contract_type,
                vehicle: norm.vehicle_full,
                balance: balanceVal
              }
            : null,
          requestedAt: lastCourierReqTimestamp,
          updatedAt: Date.now()
        });
      }
    } catch {}

    // C) Live Rider Search Request
    try {
      const rsReq = await firebaseReq("GET", "/config/rider_search_req");
      if (rsReq && rsReq.reqId && rsReq.reqId !== lastRiderSearchReqId && rsReq.query) {
        lastRiderSearchReqId = rsReq.reqId;
        const rawQ = String(rsReq.query).trim();
        const qLower = rawQ.toLowerCase();
        const resultsMap = new Map();

        const addMatch = (norm) => {
          if (!norm || resultsMap.has(norm.id)) return;
          resultsMap.set(norm.id, {
            courierId: norm.id,
            userId: norm.user_id,
            name: norm.name,
            phone: norm.phone_number,
            status: norm.status,
            statusUntil: norm.status_until,
            statusReason: norm.status_reason
          });
        };

        for (const norm of latestCachedCouriersById.values()) {
          if (
            norm.id === rawQ ||
            norm.user_id === rawQ ||
            (norm.phone_number && norm.phone_number.includes(rawQ.replace(/^0+/, ""))) ||
            norm.name.toLowerCase().includes(qLower)
          ) {
            addMatch(norm);
          }
        }

        try {
          const apiSearch = await hurrierGet(
            `/dispatcher-dashboard/couriers?search=${encodeURIComponent(rawQ)}`
          );
          const arr = Array.isArray(apiSearch?.couriers)
            ? apiSearch.couriers
            : Array.isArray(apiSearch?.records)
            ? apiSearch.records
            : [];
          for (const item of arr) {
            const norm = normalizeCourierObject(item);
            if (norm) {
              latestCachedCouriersById.set(norm.id, norm);
              addMatch(norm);
            }
          }
        } catch {}

        await firebaseReq("PUT", "/config/rider_search_res", {
          reqId: rsReq.reqId,
          results: Array.from(resultsMap.values()),
          updatedAt: Date.now()
        });
      }
    } catch {}
  }

  // ============================================================================
  // 10) MULTI-TAB LOCK, LEADER ELECTION & MAIN 2-SECOND LIVE SYNC LOOP
  // ============================================================================
  const TAB_ID = `tab_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const FEEDER_ID = `feeder_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const LOCAL_LOCK_KEY = "hurrier_live_sync_local_tab_lock";
  let ownsLocalTabLock = true;
  let isCurrentLeader = true;
  let isRelayLeader = true;
  let latestUnionZoneIds = [];
  let latestActiveSessionsSnapshot = [];

  function acquireLocalTabLock() {
    try {
      const now = Date.now();
      const raw = window.localStorage.getItem(LOCAL_LOCK_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.tabId !== TAB_ID && now - Number(parsed.ts || 0) < 7000) {
          ownsLocalTabLock = false;
          return false;
        }
      }
      window.localStorage.setItem(LOCAL_LOCK_KEY, JSON.stringify({ tabId: TAB_ID, ts: now }));
      ownsLocalTabLock = true;
      return true;
    } catch {
      ownsLocalTabLock = true;
      return true;
    }
  }

  window.addEventListener("beforeunload", () => {
    try {
      const raw = window.localStorage.getItem(LOCAL_LOCK_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.tabId === TAB_ID) {
          window.localStorage.removeItem(LOCAL_LOCK_KEY);
        }
      }
    } catch {}
    try {
      firebaseReq("DELETE", `/config/feeders/${encodeURIComponent(FEEDER_ID)}`).catch(() => {});
    } catch {}
  });

  function filterRecordByZones(rec, targetZoneIds) {
    if (!Array.isArray(targetZoneIds) || targetZoneIds.length === 0) return true;
    const idSet = new Set(targetZoneIds.map(Number));
    const order = rec?.order || {};
    const sps = Array.isArray(rec?.starting_points)
      ? rec.starting_points
      : Array.isArray(order?.drop_off_address?.starting_points)
      ? order.drop_off_address.starting_points
      : [];
    if (sps.length === 0) return true;
    return sps.some((sp) => {
      if (sp && typeof sp === "object" && sp.id) {
        return idSet.has(Number(sp.id));
      }
      return true;
    });
  }

  let isMainLoopRunning = false;

  async function mainSyncLoop() {
    if (isMainLoopRunning) return;
    if (!acquireLocalTabLock()) {
      setBadge("#64748b", `v${SCRIPT_VERSION} [2nd Tab Standby]`);
      return;
    }

    const bridge = readStoredAuthBridge();
    if (!bridge || !bridge.idToken) {
      setBadge("#d97706", `v${SCRIPT_VERSION} • Open Dashboard Tab Once`);
      return;
    }

    isMainLoopRunning = true;
    try {
      const myEmail = String(getBridgedLeaderEmail() || "").trim().toLowerCase();
      const now = Date.now();

      // Register this active Hurrier Admin feeder with tab visibility status
      await firebaseReq("PUT", `/config/feeders/${encodeURIComponent(FEEDER_ID)}`, {
        feederId: FEEDER_ID,
        email: myEmail,
        isVisible: !document.hidden,
        updatedAt: now
      }).catch(() => {});

      const [sessionsRaw, feedersRaw] = await Promise.all([
        firebaseReq("GET", "/active_sessions").catch(() => ({})),
        firebaseReq("GET", "/config/feeders").catch(() => ({}))
      ]);

      const sessionsObj = sessionsRaw || {};
      const activeSessions = Object.values(sessionsObj).filter(
        (s) => s && s.sessionId && now - Number(s.lastSeen || 0) < 25000
      );

      const feedersObj = feedersRaw && typeof feedersRaw === "object" ? feedersRaw : {};
      const activeFeeders = [];
      for (const [fKey, fVal] of Object.entries(feedersObj)) {
        if (!fVal || !fVal.feederId) continue;
        const age = now - Number(fVal.updatedAt || 0);
        if (age < 9500) {
          activeFeeders.push(fVal);
        } else if (age > 18000) {
          firebaseReq("DELETE", `/config/feeders/${encodeURIComponent(fKey)}`).catch(() => {});
        }
      }
      if (!activeFeeders.some((f) => f.feederId === FEEDER_ID)) {
        activeFeeders.push({
          feederId: FEEDER_ID,
          email: myEmail,
          isVisible: !document.hidden,
          updatedAt: now
        });
      }

      // Prioritize visible (non-throttled) Hurrier tabs for shared employee relay
      activeFeeders.sort((a, b) => {
        const visDiff = (b.isVisible ? 1 : 0) - (a.isVisible ? 1 : 0);
        if (visDiff !== 0) return visDiff;
        return String(a.feederId).localeCompare(String(b.feederId));
      });

      const primaryRelayFeeder = activeFeeders[0];
      isRelayLeader = !primaryRelayFeeder || primaryRelayFeeder.feederId === FEEDER_ID;
      isCurrentLeader = true;

      // Determine primary feeder per Admin email (in case same Admin opened 2 different browsers)
      const activeFeederEmails = new Set(
        activeFeeders.map((f) => String(f.email || "").trim().toLowerCase()).filter(Boolean)
      );
      const sameEmailFeeders = activeFeeders.filter(
        (f) => String(f.email || "").trim().toLowerCase() === myEmail
      );
      const isPrimaryForMyEmail =
        !myEmail || sameEmailFeeders.length === 0 || sameEmailFeeders[0].feederId === FEEDER_ID;

      // Target sessions: (1) My own Admin dashboard sessions + (2) View-only employee sessions if I am Relay Leader
      const targetSessions = activeSessions.filter((s) => {
        const sEmail = String(s.email || "").trim().toLowerCase();
        if (myEmail && sEmail === myEmail) {
          return isPrimaryForMyEmail;
        }
        if (isRelayLeader && (!sEmail || !activeFeederEmails.has(sEmail))) {
          return true;
        }
        return false;
      });

      const unionZoneIdsSet = new Set();
      for (const s of targetSessions) {
        if (Array.isArray(s.zoneIds)) {
          s.zoneIds.forEach((zid) => {
            const n = Number(zid);
            if (n > 0) unionZoneIdsSet.add(n);
          });
        }
      }
      const unionZoneIds = Array.from(unionZoneIdsSet);
      latestUnionZoneIds = unionZoneIds;
      latestActiveSessionsSnapshot = activeSessions;

      if (activeSessions.length === 0 || unionZoneIds.length === 0) {
        setBadge(
          isRelayLeader ? "#15803d" : "#0d9488",
          `v${SCRIPT_VERSION} [${isRelayLeader ? "Primary Relay" : "Admin Feeder"}] Waiting for Dashboard...`
        );
        return;
      }

      // Shared completed archive & range queries run on the Relay Leader (or initially if local map is empty)
      if (isRelayLeader || completedArchiveMap.size === 0) {
        try {
          const forceReq = await firebaseReq("GET", "/config/completed_force_sync_req");
          if (forceReq && Number(forceReq.requestedAt || 0) > lastCompletedSweepAt) {
            sweepCompletedOrdersLast2Hours(true);
          } else {
            sweepCompletedOrdersLast2Hours(false);
          }
        } catch {
          sweepCompletedOrdersLast2Hours(false);
        }
      }

      if (isRelayLeader) {
        processCustomCompletedRangeRequests().catch(() => {});
        processCompletedIdLookupRequests().catch(() => {});
      }

      const [queuedRes, dispatchedRes, activeRes, couriersData] = await Promise.all([
        fetchAllPagesForDeliveryStatus("queued", unionZoneIds),
        fetchAllPagesForDeliveryStatus("dispatched", unionZoneIds),
        fetchAllPagesForDeliveryStatus("active", unionZoneIds),
        fetchCouriersAndStatsForZones(unionZoneIds)
      ]);

      if (isRelayLeader && couriersData.dynamicZones.length > 0) {
        firebaseReq("PUT", "/config/dynamic_zones_catalog", couriersData.dynamicZones).catch(
          () => {}
        );
      }

      const activeViewersSummary = activeSessions.map((s) => ({
        sessionId: s.sessionId,
        email: s.email || "",
        employeeName: s.employeeName || s.email || "User",
        zoneCount: Array.isArray(s.zoneIds) ? s.zoneIds.length : 0,
        activeTab: s.activeTab || "Active"
      }));

      const allCompletedList = Array.from(completedArchiveMap.values());

      await Promise.all(
        targetSessions.map(async (sess) => {
          const zIds = Array.isArray(sess.zoneIds) ? sess.zoneIds.map(Number) : [];
          const zSet = new Set(zIds);

          const sessQueued = queuedRes.records.filter((r) => filterRecordByZones(r, zIds));
          const sessDispatched = dispatchedRes.records.filter((r) =>
            filterRecordByZones(r, zIds)
          );
          const sessActive = activeRes.records.filter((r) => filterRecordByZones(r, zIds));
          const sessCompleted = allCompletedList.filter((r) => filterRecordByZones(r, zIds));
          const sessCouriers = couriersData.couriers.filter((c) =>
            zSet.has(Number(c.starting_point_id))
          );

          const bundle = {
            sessionId: sess.sessionId,
            updatedAt: Date.now(),
            tabRecords: {
              Queued: sessQueued,
              Dispatched: sessDispatched,
              Active: sessActive
            },
            completedRecords: sessCompleted,
            completedSyncing: isCompletedSweepRunning,
            completedLastSweepAt: lastCompletedSweepAt,
            couriers: sessCouriers,
            zoneStats: couriersData.zoneStats,
            counts: {
              Queued: sessQueued.length,
              Dispatched: sessDispatched.length,
              Active: sessActive.length
            },
            serverTotals: {
              Queued: queuedRes.serverTotal,
              Dispatched: dispatchedRes.serverTotal,
              Active: activeRes.serverTotal
            },
            fetchedTotals: {
              Queued: queuedRes.records.length,
              Dispatched: dispatchedRes.records.length,
              Active: activeRes.records.length
            },
            activeViewers: activeViewersSummary
          };

          await firebaseReq(
            "PUT",
            `/session_bundles/${encodeURIComponent(sess.sessionId)}`,
            bundle
          ).catch(() => {});
        })
      );

      if (isRelayLeader) {
        setBadge(
          "#15803d",
          `v${SCRIPT_VERSION} [Primary Relay] Live (2s) • ${activeFeeders.length} Admin${
            activeFeeders.length > 1 ? "s" : ""
          } • ${activeSessions.length} Viewers • ${activeRes.records.length} Act`
        );
      } else {
        setBadge(
          "#0d9488",
          `v${SCRIPT_VERSION} [Active Admin Feeder] Live (2s) • ${targetSessions.length} Tab${
            targetSessions.length > 1 ? "s" : ""
          } • ${activeRes.records.length} Act`
        );
      }
    } catch (err) {
      setBadge("#b91c1c", `v${SCRIPT_VERSION} • Retry (${err?.message || "Sync"})`);
    } finally {
      isMainLoopRunning = false;
    }
  }

  // Start main 2-second loop
  setTimeout(mainSyncLoop, 600);
  setInterval(mainSyncLoop, 2000);

  // Dedicated 120ms Fast-Lane for On-Demand Order Details, Notes, Courier Profiles & Searches
  let isFastOnDemandRunning = false;
  setInterval(async () => {
    if (isFastOnDemandRunning || !ownsLocalTabLock || !readStoredAuthBridge()?.idToken) return;
    isFastOnDemandRunning = true;
    try {
      await processOnDemandRequests();
    } catch {} finally {
      isFastOnDemandRunning = false;
    }
  }, 120);
})();
