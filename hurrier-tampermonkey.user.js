// ==UserScript==
// @name         Hurrier Live Sync
// @namespace    https://hurrier-live.local/
// @version      8.2
// @description  [v8.2] Exclude Cancelled Orders + Graceful Rolling 2h Completed At + Auto-Update
// @updateURL    https://raw.githubusercontent.com/mahmoudosman-hub/hurrier-live/main/hurrier-tampermonkey.user.js
// @downloadURL  https://raw.githubusercontent.com/mahmoudosman-hub/hurrier-live/main/hurrier-tampermonkey.user.js
// @match        https://eg.me.logisticsbackoffice.com/*
// @match        https://*.github.io/*
// @match        http://localhost:*/*
// @match        http://127.0.0.1:*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      hurrier-live-default-rtdb.europe-west1.firebasedatabase.app
// @connect      securetoken.googleapis.com
// @connect      raw.githubusercontent.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const SCRIPT_VERSION = "8.2";
  const GITHUB_SCRIPT_RAW_URL =
    "https://raw.githubusercontent.com/mahmoudosman-hub/hurrier-live/main/hurrier-tampermonkey.user.js";
  const FIREBASE_DB_URL = "https://hurrier-live-default-rtdb.europe-west1.firebasedatabase.app";
  const BASE_API = "https://eg.me.logisticsbackoffice.com/api";
  const AUTH_BRIDGE_STORAGE_KEY = "hurrier_fb_bridge_auth";
  const ROLLING_COMPLETED_WINDOW_MS = 2 * 3600 * 1000;
  const ROLLING_COMPLETED_GRACE_MS = 15 * 60 * 1000;
  const ROLLING_COMPLETED_SYNC_MS = 10000;

  const isDashboardHost =
    window.location.hostname.endsWith("github.io") ||
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1";

  // 1) Dashboard Auth Bridge (captures Google Sign-In Firebase token for Tampermonkey on Hurrier tab)
  if (isDashboardHost) {
    const syncBridgeAuth = () => {
      try {
        const raw = window.localStorage.getItem(AUTH_BRIDGE_STORAGE_KEY);
        if (raw) {
          GM_setValue(AUTH_BRIDGE_STORAGE_KEY, raw);
        }
      } catch {}
    };
    syncBridgeAuth();
    setInterval(syncBridgeAuth, 3000);
    return;
  }

  // 2) Hurrier Tab Feeder Logic
  const TAB_INSTANCE_ID = `tab_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const LOCAL_TAB_LOCK_KEY = "hurrier_local_tab_lock";
  let remoteAvailableVersion = null;
  let lastOrderDetailReqAt = 0;
  let lastCourierDetailReqAt = 0;
  let lastRiderSearchReqId = "";

  const rollingCompletedPool = new Map();
  let lastRollingCompletedSyncAt = 0;
  let initialCompletedBackfillDone = false;

  // Floating Status Pill
  const badge = document.createElement("div");
  badge.style.cssText =
    "position:fixed;bottom:14px;right:14px;z-index:999999;padding:7px 14px;border-radius:999px;font-family:sans-serif;font-size:12px;font-weight:700;color:#fff;background:#78350f;box-shadow:0 4px 12px rgba(0,0,0,0.22);cursor:pointer;user-select:none;transition:all 0.2s;";
  badge.textContent = `v${SCRIPT_VERSION} Standby...`;
  badge.title = "Hurrier Live Sync Status";
  badge.addEventListener("click", () => {
    if (remoteAvailableVersion) {
      window.open(GITHUB_SCRIPT_RAW_URL, "_blank");
    }
  });
  document.body.appendChild(badge);

  function setBadge(bg, text) {
    if (remoteAvailableVersion) {
      badge.style.background = "#2563eb";
      badge.textContent = `⬆ Update v${remoteAvailableVersion} Ready (Click to Update)`;
      return;
    }
    badge.style.background = bg;
    badge.textContent = text;
  }

  function compareVersions(vA, vB) {
    const a = String(vA || "0").split(".").map(Number);
    const b = String(vB || "0").split(".").map(Number);
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) {
      const nA = a[i] || 0;
      const nB = b[i] || 0;
      if (nA > nB) return 1;
      if (nA < nB) return -1;
    }
    return 0;
  }

  // Auto-Check GitHub for Script Updates
  function checkGitHubForScriptUpdate() {
    try {
      GM_xmlhttpRequest({
        method: "GET",
        url: `${GITHUB_SCRIPT_RAW_URL}?t=${Date.now()}`,
        onload: (res) => {
          if (res.status === 200 && res.responseText) {
            const match = /@version\s+([0-9.]+)/.exec(res.responseText);
            if (match && match[1] && compareVersions(match[1], SCRIPT_VERSION) > 0) {
              remoteAvailableVersion = match[1];
              setBadge("#2563eb", `⬆ Update v${remoteAvailableVersion} Ready (Click to Update)`);
            }
          }
        }
      });
    } catch {}
  }
  setTimeout(checkGitHubForScriptUpdate, 4000);
  setInterval(checkGitHubForScriptUpdate, 60000);

  function gmRequest(method, url, bodyObj = null) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url,
        headers: bodyObj ? { "Content-Type": "application/json" } : {},
        data: bodyObj ? JSON.stringify(bodyObj) : undefined,
        onload: (res) => {
          let data = null;
          try {
            data = res.responseText ? JSON.parse(res.responseText) : null;
          } catch {}
          resolve({ ok: res.status >= 200 && res.status < 300, status: res.status, data });
        },
        onerror: (err) => reject(err)
      });
    });
  }

  async function getValidFirebaseToken(forceRefresh = false) {
    let bridge = null;
    try {
      const raw = GM_getValue(AUTH_BRIDGE_STORAGE_KEY, "");
      bridge = raw ? JSON.parse(raw) : null;
    } catch {}
    if (!bridge || !bridge.idToken) return "";

    const isStale = Date.now() - (bridge.updatedAt || 0) > 45 * 60 * 1000;
    if ((forceRefresh || isStale) && bridge.refreshToken && bridge.apiKey) {
      try {
        const res = await gmRequest(
          "POST",
          `https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(bridge.apiKey)}`,
          { grant_type: "refresh_token", refresh_token: bridge.refreshToken }
        );
        if (res.ok && res.data?.id_token) {
          bridge.idToken = res.data.id_token;
          bridge.refreshToken = res.data.refresh_token || bridge.refreshToken;
          bridge.updatedAt = Date.now();
          GM_setValue(AUTH_BRIDGE_STORAGE_KEY, JSON.stringify(bridge));
        }
      } catch {}
    }
    return bridge.idToken || "";
  }

  async function fbDb(method, path, bodyObj = null) {
    let tok = await getValidFirebaseToken(false);
    const buildUrl = (t) => {
      const sep = path.includes("?") ? "&" : "?";
      return `${FIREBASE_DB_URL}${path}.json${t ? `${sep}auth=${encodeURIComponent(t)}` : ""}`;
    };
    let res = await gmRequest(method, buildUrl(tok), bodyObj);
    if (res.status === 401) {
      tok = await getValidFirebaseToken(true);
      res = await gmRequest(method, buildUrl(tok), bodyObj);
    }
    return res;
  }

  function getHurrierAuthHeaders() {
    const headers = { Accept: "application/json" };
    try {
      const dhhToken =
        window.localStorage.getItem("dhhToken") ||
        window.sessionStorage.getItem("dhhToken") ||
        window.localStorage.getItem("token");
      if (dhhToken) {
        headers["Authorization"] = `Bearer ${dhhToken}`;
      }
    } catch {}
    return headers;
  }

  async function hurrierGet(endpointPath) {
    const res = await fetch(`${BASE_API}${endpointPath}`, {
      method: "GET",
      credentials: "include",
      headers: getHurrierAuthHeaders()
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return res.json();
  }

  function acquireSamePcTabLock() {
    const now = Date.now();
    try {
      const cur = JSON.parse(window.localStorage.getItem(LOCAL_TAB_LOCK_KEY) || "null");
      if (cur && cur.tabId !== TAB_INSTANCE_ID && now - cur.ts < 5500) {
        return false;
      }
      window.localStorage.setItem(LOCAL_TAB_LOCK_KEY, JSON.stringify({ tabId: TAB_INSTANCE_ID, ts: now }));
      return true;
    } catch {
      return true;
    }
  }

  function extractCompletedTimestamp(rec) {
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
      rec?.delivered_at
    ];

    for (const val of candidates) {
      if (val) {
        const ms = typeof val === "number" ? (val > 1e12 ? val : val * 1000) : new Date(val).getTime();
        if (!Number.isNaN(ms) && ms > 0) return ms;
      }
    }

    const placedMs = order.placed_at ? new Date(order.placed_at).getTime() : 0;
    const rawTotalTime = Number(timings.total_time);
    if (placedMs > 0 && !Number.isNaN(rawTotalTime) && rawTotalTime > 0) {
      const durationMs = rawTotalTime < 240 ? rawTotalTime * 60 * 1000 : rawTotalTime * 1000;
      return placedMs + durationMs;
    }

    return 0;
  }

  function getCairoDateStringsForCompleted() {
    const now = new Date();
    const cairoNow = new Date(now.toLocaleString("en-US", { timeZone: "Africa/Cairo" }));
    const fmt = (d) => {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      return `${y}-${m}-${day}`;
    };
    const todayStr = fmt(cairoNow);
    const yesterdayDate = new Date(cairoNow.getTime() - 24 * 3600 * 1000);
    const yesterdayStr = fmt(yesterdayDate);
    return { todayStr, yesterdayStr, cairoHour: cairoNow.getHours() };
  }

  function extractRecordStartingPointIds(rec) {
    const ids = new Set();
    const collect = (arr) => {
      if (!Array.isArray(arr)) return;
      arr.forEach((sp) => {
        if (sp && typeof sp === "object" && sp.id) ids.add(Number(sp.id));
      });
    };
    collect(rec?.starting_points);
    collect(rec?.order?.drop_off_address?.starting_points);
    collect(rec?.order?.dropoff_address?.starting_points);
    return ids;
  }

  // Rolling 2-Hour Completed Orders Pool (excludes Cancelled + retains 2h + 15m grace)
  function ingestCompletedRecordsBatch(records) {
    if (!Array.isArray(records) || records.length === 0) return 0;
    const cutoffMs = Date.now() - (ROLLING_COMPLETED_WINDOW_MS + ROLLING_COMPLETED_GRACE_MS);
    let freshCount = 0;

    for (const rec of records) {
      if (!rec || typeof rec !== "object") continue;
      const order = rec.order || {};
      const stLower = String(order.status || rec.status || "").toLowerCase();
      if (stLower.includes("cancel")) continue;

      const orderKey = String(
        order.id ||
          order.confirmation_number ||
          String(order.order_code || "").replace(/^(HF_[A-Z]{2}|ODR_[A-Z]{2})/i, "") ||
          ""
      ).trim();
      if (!orderKey) continue;

      const completedAtMs = extractCompletedTimestamp(rec);
      if (!completedAtMs || completedAtMs < cutoffMs) continue;

      const spIds = extractRecordStartingPointIds(rec);
      rollingCompletedPool.set(orderKey, {
        completedAtMs,
        spIds,
        rec: {
          ...rec,
          __completed_at_ms: completedAtMs
        }
      });
      freshCount++;
    }
    return freshCount;
  }

  async function pullCompletedWindowForDate(dateStr, minPlacedCutoffMs, isIncremental) {
    try {
      const p1 = await hurrierGet(`/dispatcher-dashboard/orders/completed?date=${dateStr}&page=1&per_page=50`);
      const p1Records = Array.isArray(p1?.records) ? p1.records : [];
      if (p1Records.length === 0) return;

      ingestCompletedRecordsBatch(p1Records);
      const totalRecords = Number(p1?.total_records || p1?.total || p1Records.length);
      const totalPages = Math.max(1, Math.ceil(totalRecords / 50));
      if (totalPages <= 1) return;

      // Binary search to locate first page where placed_at >= minPlacedCutoffMs
      let low = 1;
      let high = totalPages;
      let startPage = Math.max(1, totalPages - 8);

      if (!isIncremental && totalPages > 6) {
        for (let step = 0; step < 8 && low <= high; step++) {
          const mid = Math.floor((low + high) / 2);
          const midRes = await hurrierGet(`/dispatcher-dashboard/orders/completed?date=${dateStr}&page=${mid}&per_page=50`);
          const midRecs = Array.isArray(midRes?.records) ? midRes.records : [];
          if (midRecs.length === 0) {
            high = mid - 1;
            continue;
          }
          ingestCompletedRecordsBatch(midRecs);
          const lastRec = midRecs[midRecs.length - 1];
          const lastPlacedMs = lastRec?.order?.placed_at ? new Date(lastRec.order.placed_at).getTime() : 0;
          if (lastPlacedMs > 0 && lastPlacedMs < minPlacedCutoffMs) {
            low = mid + 1;
          } else {
            startPage = mid;
            high = mid - 1;
          }
        }
      } else if (isIncremental) {
        startPage = Math.max(1, totalPages - 5);
      }

      const maxPagesToScan = isIncremental ? 6 : 24;
      const endPage = Math.min(totalPages, startPage + maxPagesToScan - 1);
      for (let pg = startPage; pg <= endPage; pg++) {
        if (pg === 1) continue;
        const pageRes = await hurrierGet(`/dispatcher-dashboard/orders/completed?date=${dateStr}&page=${pg}&per_page=50`);
        const recs = Array.isArray(pageRes?.records) ? pageRes.records : [];
        ingestCompletedRecordsBatch(recs);
      }
    } catch {}
  }

  async function syncRollingCompletedOrdersPool(force = false) {
    const now = Date.now();
    const retentionCutoffMs = now - (ROLLING_COMPLETED_WINDOW_MS + ROLLING_COMPLETED_GRACE_MS);

    for (const [key, entry] of rollingCompletedPool.entries()) {
      if (!entry || entry.completedAtMs < retentionCutoffMs) {
        rollingCompletedPool.delete(key);
      }
    }

    if (!force && now - lastRollingCompletedSyncAt < ROLLING_COMPLETED_SYNC_MS) {
      return;
    }
    lastRollingCompletedSyncAt = now;

    const { todayStr, yesterdayStr, cairoHour } = getCairoDateStringsForCompleted();
    const minPlacedCutoffMs = now - 3.5 * 3600 * 1000;
    const isIncremental = initialCompletedBackfillDone && rollingCompletedPool.size > 0;

    await pullCompletedWindowForDate(todayStr, minPlacedCutoffMs, isIncremental);

    if (cairoHour < 4) {
      await pullCompletedWindowForDate(yesterdayStr, minPlacedCutoffMs, isIncremental);
    }

    initialCompletedBackfillDone = true;

    const afterCutoff = Date.now() - (ROLLING_COMPLETED_WINDOW_MS + ROLLING_COMPLETED_GRACE_MS);
    for (const [key, entry] of rollingCompletedPool.entries()) {
      if (!entry || entry.completedAtMs < afterCutoff) {
        rollingCompletedPool.delete(key);
      }
    }
  }

  function getSessionRollingCompletedPayload(sessionZoneIds) {
    const cutoffMs = Date.now() - (ROLLING_COMPLETED_WINDOW_MS + ROLLING_COMPLETED_GRACE_MS);
    const targetSet = new Set((Array.isArray(sessionZoneIds) ? sessionZoneIds : []).map(Number));
    const matched = [];

    for (const entry of rollingCompletedPool.values()) {
      if (!entry || entry.completedAtMs < cutoffMs) continue;
      if (targetSet.size === 0 || entry.spIds.size === 0) {
        matched.push(entry.rec);
      } else {
        for (const id of entry.spIds) {
          if (targetSet.has(id)) {
            matched.push(entry.rec);
            break;
          }
        }
      }
    }
    matched.sort((a, b) => (b.__completed_at_ms || 0) - (a.__completed_at_ms || 0));
    return matched;
  }

  // Handle On-Demand Requests from Dashboard
  async function processOnDemandDashboardRequests() {
    try {
      const cfgRes = await fbDb("GET", "/config");
      const cfg = cfgRes.data || {};

      // 1) Order Details
      if (cfg.order_detail_req && cfg.order_detail_req.requestedAt > lastOrderDetailReqAt && cfg.order_detail_req.code) {
        lastOrderDetailReqAt = cfg.order_detail_req.requestedAt;
        const code = String(cfg.order_detail_req.code).trim();
        const orderCode = String(cfg.order_detail_req.orderCode || `HF_EG${code}`).trim();
        const [detailRes, delivRes, notesRes] = await Promise.allSettled([
          hurrierGet(`/dispatcher-dashboard/orders/detail?code=${encodeURIComponent(code)}`),
          hurrierGet(`/dispatcher-dashboard/orders/detail/deliveries?code=${encodeURIComponent(orderCode)}`),
          hurrierGet(`/dispatcher-dashboard/orders/dispatcher_notes?code=${encodeURIComponent(orderCode)}`)
        ]);
        await fbDb("PUT", `/order_details/${encodeURIComponent(code)}`, {
          detail: detailRes.status === "fulfilled" ? detailRes.value : null,
          deliveries: delivRes.status === "fulfilled" ? delivRes.value : null,
          notes: notesRes.status === "fulfilled" ? notesRes.value : null,
          updatedAt: Date.now()
        });
      }

      // 2) Courier Details
      if (
        cfg.courier_detail_req &&
        cfg.courier_detail_req.requestedAt > lastCourierDetailReqAt &&
        cfg.courier_detail_req.courierId
      ) {
        lastCourierDetailReqAt = cfg.courier_detail_req.requestedAt;
        const cid = String(cfg.courier_detail_req.courierId).trim();
        let cData = null;
        try {
          cData = await hurrierGet(`/dispatcher-dashboard/couriers/${encodeURIComponent(cid)}`);
        } catch {
          try {
            const searchRes = await hurrierGet(`/dispatcher-dashboard/couriers?search=${encodeURIComponent(cid)}&per_page=10`);
            const recs = Array.isArray(searchRes?.records) ? searchRes.records : [];
            cData = recs.find((r) => String(r.id) === cid || String(r.user_id) === cid) || recs[0] || null;
          } catch {}
        }
        await fbDb("PUT", `/courier_details/${encodeURIComponent(cid)}`, {
          courier: cData,
          updatedAt: Date.now()
        });
      }

      // 3) Live Rider Search
      if (cfg.rider_search_req && cfg.rider_search_req.reqId && cfg.rider_search_req.reqId !== lastRiderSearchReqId) {
        lastRiderSearchReqId = cfg.rider_search_req.reqId;
        const q = String(cfg.rider_search_req.query || "").trim();
        let results = [];
        try {
          const sRes = await hurrierGet(`/dispatcher-dashboard/couriers?search=${encodeURIComponent(q)}&per_page=25`);
          const recs = Array.isArray(sRes?.records) ? sRes.records : Array.isArray(sRes) ? sRes : [];
          results = recs.map((r) => ({
            courierId: String(r.id || r.courier_id || ""),
            userId: String(r.user_id || r.id || ""),
            name: String(r.name || r.courier_name || ""),
            phone: String(r.phone_number || r.mobile || r.phone || ""),
            status: String(r.status || r.shift_status || "Working")
          }));
        } catch {}
        await fbDb("PUT", "/config/rider_search_res", {
          reqId: lastRiderSearchReqId,
          results,
          updatedAt: Date.now()
        });
      }
    } catch {}
  }

  // Main Sync Loop (Every 2 Seconds)
  async function runSyncCycle() {
    if (!acquireSamePcTabLock()) {
      setBadge("#475569", `v${SCRIPT_VERSION} [Local Tab Standby]`);
      return;
    }

    const fbToken = await getValidFirebaseToken(false);
    if (!fbToken) {
      setBadge("#92400e", `v${SCRIPT_VERSION} Standby (Sign in on Dashboard)`);
      return;
    }

    try {
      // Check Active Sessions
      const sessRes = await fbDb("GET", "/active_sessions");
      const allSessions = sessRes.data || {};
      const now = Date.now();
      const activeSessions = Object.values(allSessions).filter(
        (s) => s && Array.isArray(s.zoneIds) && s.zoneIds.length > 0 && now - (s.lastSeen || 0) < 45000
      );

      if (activeSessions.length === 0) {
        setBadge("#78350f", `v${SCRIPT_VERSION} Standby (0 Viewers)`);
        return;
      }

      // Cross-PC Leader Election (/feeder_lock)
      const lockRes = await fbDb("GET", "/feeder_lock");
      const lock = lockRes.data;
      if (lock && lock.leaderId !== TAB_INSTANCE_ID && now - (lock.ts || 0) < 6000) {
        setBadge("#0f766e", `v${SCRIPT_VERSION} [Backup Standby] (${activeSessions.length} Viewers)`);
        return;
      }
      await fbDb("PUT", "/feeder_lock", { leaderId: TAB_INSTANCE_ID, ts: now });

      // Process On-Demand Requests & Sync Rolling 2h Completed Pool
      await processOnDemandDashboardRequests();
      await syncRollingCompletedOrdersPool(false);

      // Fetch Live Deliveries & Stats from Hurrier
      const [statsRes, queuedRes, dispRes, activeRes, preorderRes, actionableRes, waitRes, issuesRes] =
        await Promise.allSettled([
          hurrierGet("/dispatcher-dashboard/stats"),
          hurrierGet("/dispatcher-dashboard/deliveries/queued?page=1&per_page=100"),
          hurrierGet("/dispatcher-dashboard/deliveries/dispatched?page=1&per_page=100"),
          hurrierGet("/dispatcher-dashboard/deliveries/active?page=1&per_page=100"),
          hurrierGet("/dispatcher-dashboard/deliveries/preorder?page=1&per_page=100"),
          hurrierGet("/dispatcher-dashboard/deliveries/actionable?page=1&per_page=100"),
          hurrierGet("/dispatcher-dashboard/deliveries/wait_for_assembled?page=1&per_page=100"),
          hurrierGet("/issue-service/dispatcher_dashboard")
        ]);

      const tabAllRecords = {
        Queued: queuedRes.status === "fulfilled" ? queuedRes.value?.records || [] : [],
        Dispatched: dispRes.status === "fulfilled" ? dispRes.value?.records || [] : [],
        Active: activeRes.status === "fulfilled" ? activeRes.value?.records || [] : [],
        "Pre-order": preorderRes.status === "fulfilled" ? preorderRes.value?.records || [] : [],
        Actionable: actionableRes.status === "fulfilled" ? actionableRes.value?.records || [] : [],
        "Waiting for Assembly": waitRes.status === "fulfilled" ? waitRes.value?.records || [] : []
      };

      const allIssues = issuesRes.status === "fulfilled" && Array.isArray(issuesRes.value) ? issuesRes.value : [];
      const allZoneStats = [];
      if (statsRes.status === "fulfilled" && Array.isArray(statsRes.value?.cities)) {
        statsRes.value.cities.forEach((c) => {
          (c.zones || []).forEach((z) => {
            (z.starting_points || []).forEach((sp) => {
              allZoneStats.push(sp);
            });
          });
        });
      }

      // Build and Push Session Bundles for each active viewer
      for (const sess of activeSessions) {
        const targetSet = new Set(sess.zoneIds.map(Number));
        const filterBySessionZones = (arr) =>
          arr.filter((rec) => {
            const spIds = extractRecordStartingPointIds(rec);
            if (spIds.size === 0) return false;
            for (const id of spIds) {
              if (targetSet.has(id)) return true;
            }
            return false;
          });

        const filteredTabRecords = {};
        const counts = {};
        Object.entries(tabAllRecords).forEach(([tName, recs]) => {
          const matched = filterBySessionZones(recs);
          filteredTabRecords[tName] = matched;
          counts[tName] = matched.length;
        });

        const completedRecords = getSessionRollingCompletedPayload(sess.zoneIds);
        const filteredZoneStats = allZoneStats.filter((sp) => targetSet.has(Number(sp.id)));

        // Extract unique couriers from active/dispatched orders in session zones
        const courierMap = new Map();
        [...filteredTabRecords.Active, ...filteredTabRecords.Dispatched].forEach((rec) => {
          if (rec.courier_id && rec.courier_name) {
            const cid = String(rec.courier_id);
            const cur = courierMap.get(cid) || {
              id: cid,
              courier_id: cid,
              name: rec.courier_name,
              status: "Working",
              active_orders_count: 0
            };
            cur.active_orders_count += 1;
            courierMap.set(cid, cur);
          }
        });

        await fbDb("PUT", `/session_bundles/${encodeURIComponent(sess.sessionId)}`, {
          updatedAt: Date.now(),
          tabRecords: filteredTabRecords,
          completedRecords,
          issues: allIssues,
          couriers: Array.from(courierMap.values()),
          zoneStats: filteredZoneStats,
          counts
        });
      }

      setBadge("#15803d", `v${SCRIPT_VERSION} [Primary Leader] Live (2s) • ${rollingCompletedPool.size} Comp`);
    } catch (err) {
      setBadge("#b91c1c", `v${SCRIPT_VERSION} Sync Retry: ${err?.message || "Error"}`);
    }
  }

  setTimeout(runSyncCycle, 1200);
  setInterval(runSyncCycle, 2000);
})();
