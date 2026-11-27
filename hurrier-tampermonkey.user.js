// ==UserScript==
// @name         Hurrier Live Sync
// @namespace    https://hurrier-live.local/
// @version      8.0
// @description  [v8.0] Permanent Auto-Update + Binary-Search Rolling 2h Completed At + Real Hurrier Order Detail APIs
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

  const SCRIPT_VERSION = "8.0";
  const GITHUB_SCRIPT_RAW_URL =
    "https://raw.githubusercontent.com/mahmoudosman-hub/hurrier-live/main/hurrier-tampermonkey.user.js";
  const FIREBASE_DB_URL = "https://hurrier-live-default-rtdb.europe-west1.firebasedatabase.app";
  const BASE_API = "https://eg.me.logisticsbackoffice.com/api";
  const AUTH_BRIDGE_STORAGE_KEY = "hurrier_fb_bridge_auth";
  const ROLLING_COMPLETED_WINDOW_MS = 2 * 3600 * 1000;
  const ROLLING_COMPLETED_SYNC_MS = 10000;

  // --- CROSS-DOMAIN ADMIN AUTH BRIDGE (Dashboard github.io -> Hurrier) ---
  if (window.location.hostname !== "eg.me.logisticsbackoffice.com") {
    const syncBridgeFromDashboard = () => {
      try {
        const raw = window.localStorage.getItem(AUTH_BRIDGE_STORAGE_KEY);
        if (raw && typeof GM_setValue === "function") {
          GM_setValue(AUTH_BRIDGE_STORAGE_KEY, raw);
        }
      } catch {}
    };
    syncBridgeFromDashboard();
    setInterval(syncBridgeFromDashboard, 1500);
    return;
  }

  // --- CORE TIMING, TAB LOCK & CACHE STATE DECLARATIONS ---
  const SYNC_INTERVAL_MS = 2000;
  const LEADER_LEASE_MS = 6000;
  const SESSION_STALE_MS = 45000;
  const LOCAL_CHANNEL_NAME = "hurrier_live_sync_pc_channel_v75";
  const LOCAL_TAB_STORAGE_KEY = "hurrier_live_sync_local_tab_leader_v75";
  const LOCAL_TAB_HEARTBEAT_MS = 1000;
  const LOCAL_TAB_TIMEOUT_MS = 3500;

  const TAB_ID = `tab_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const FEEDER_INSTANCE_ID = `feeder_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  let localBroadcastChannel = null;
  let localLeaderTabId = TAB_ID;
  let localLeaderLastSeen = Date.now();
  let isSyncing = false;
  let isRiderSearchPolling = false;
  let lastSuccessAt = null;
  let lastErrorMsg = "";
  let currentModeLabel = `v${SCRIPT_VERSION} Starting...`;
  let totalPushCount = 0;
  let badgeEl = null;
  let bgPrewarmCursor = 0;
  let latestUnionZoneIds = [];
  let latestActiveCourierEntries = [];
  let cachedZoneRosterEntries = [];
  let cachedZoneRosterFetchedAt = 0;
  let remoteAvailableVersion = "";
  let lastRollingCompletedSyncAt = 0;
  let initialCompletedBackfillDone = false;
  let capturedCompletedApiBaseUrl = "";

  const CAPTURED_AUTH_HEADERS = {};
  const courierNameToIdMap = new Map();
  const courierDetailCache = new Map();
  const riderSearchCache = new Map();
  const orderDetailCache = new Map();
  const rollingCompletedPool = new Map();
  const lastRiderSearchSigBySession = new Map();

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
      rec?.delivered_at,
      rec?.dropped_off_at
    ];

    for (const val of candidates) {
      if (val) {
        const ms = typeof val === "number" ? (val > 1e12 ? val : val * 1000) : new Date(val).getTime();
        if (!Number.isNaN(ms) && ms > 0) return ms;
      }
    }

    // Exact calculation from Hurrier's placed_at + total_time (Hurrier returns minutes when < 240, seconds when >= 240)
    const placedMs = order.placed_at ? new Date(order.placed_at).getTime() : 0;
    const rawTotalTime = Number(timings.total_time);
    if (placedMs > 0 && !Number.isNaN(rawTotalTime) && rawTotalTime > 0) {
      const durationMs = rawTotalTime < 240 ? rawTotalTime * 60 * 1000 : rawTotalTime * 1000;
      return placedMs + durationMs;
    }

    if (order.updated_at) {
      const updMs = new Date(order.updated_at).getTime();
      if (!Number.isNaN(updMs) && updMs > 0) return updMs;
    }
    return 0;
  }

  function compareSemverStrings(a, b) {
    const pa = String(a || "0").split(".").map((n) => Number(n) || 0);
    const pb = String(b || "0").split(".").map((n) => Number(n) || 0);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
      const va = pa[i] || 0;
      const vb = pb[i] || 0;
      if (va > vb) return 1;
      if (va < vb) return -1;
    }
    return 0;
  }

  async function checkGitHubScriptUpdate() {
    try {
      const res = await gmHttpRequest({
        method: "GET",
        url: `${GITHUB_SCRIPT_RAW_URL}?t=${Date.now()}`
      });
      if (!res.ok || !res.text) return;
      const match = res.text.match(/\/\/\s*@version\s+([^\s]+)/);
      if (match && match[1]) {
        const latestVer = match[1].trim();
        if (compareSemverStrings(latestVer, SCRIPT_VERSION) > 0) {
          remoteAvailableVersion = latestVer;
          updateBadge(true);
        }
      }
    } catch {}
  }

  function sanitizeCourierStorageKey(rawKey) {
    return String(rawKey || "")
      .trim()
      .replace(/[.#$\[\]\/\\]/g, "_")
      .slice(0, 80);
  }

  function normalizePhoneDigits(rawStr) {
    const digits = String(rawStr || "").replace(/\D/g, "");
    if (!digits) return { rawDigits: "", core10: "" };
    let core = digits;
    if (core.startsWith("0020") && core.length >= 13) {
      core = core.slice(4);
    } else if (core.startsWith("20") && core.length === 12 && core[2] === "1") {
      core = core.slice(2);
    } else if (core.startsWith("0") && core.length === 11 && core[1] === "1") {
      core = core.slice(1);
    }
    const core10 = core.length === 10 && core.startsWith("1") ? core : "";
    return { rawDigits: digits, core10 };
  }

  function matchRiderProfileByQuery(profile, rawQuery) {
    if (!profile) return 0;
    const cleanQ = String(rawQuery || "").trim();
    if (!cleanQ) return 0;
    const qLower = cleanQ.toLowerCase();
    const { rawDigits, core10 } = normalizePhoneDigits(cleanQ);

    const cid = String(profile.courierId || "").trim();
    const uid = String(profile.userId || "").trim();
    const cname = String(profile.name || "").trim().toLowerCase();
    const pPhone = normalizePhoneDigits(profile.phone || "");

    if (core10 && pPhone.core10 && core10 === pPhone.core10) return 100;
    if (rawDigits.length >= 7 && pPhone.rawDigits && pPhone.rawDigits.includes(rawDigits)) return 90;
    if (uid && (uid === cleanQ || uid === rawDigits)) return 95;
    if (cid && (cid === cleanQ || cid === rawDigits)) return 92;
    if (cname && cname === qLower) return 85;
    if (cname && cname.includes(qLower) && qLower.length >= 3) return 70;
    if (rawDigits.length >= 4 && ((uid && uid.includes(rawDigits)) || (cid && cid.includes(rawDigits)))) return 60;
    return 0;
  }

  function chunkArray(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) {
      out.push(arr.slice(i, i + size));
    }
    return out;
  }

  function ingestPassiveCouriersPayload(payload) {
    try {
      const rootObj = payload?.courier && typeof payload.courier === "object" ? payload.courier : null;
      const list = Array.isArray(payload?.couriers)
        ? payload.couriers
        : Array.isArray(payload?.records)
        ? payload.records
        : Array.isArray(payload)
        ? payload
        : rootObj
        ? [rootObj]
        : [];

      list.forEach((c) => {
        if (!c || typeof c !== "object") return;
        const cid = String(c.id || c.courier_id || "").trim();
        const uid = String(c.user_id || payload?.user_id || "").trim();
        const cname = String(c.name || c.courier_name || "").trim();
        const phone = String(c.phone_number || c.phone || c.mobile || "").trim();
        if (!cid && !uid) return;

        if (cid && cname) courierNameToIdMap.set(cname.toLowerCase(), cid);
        if (uid && cname && !cid) courierNameToIdMap.set(cname.toLowerCase(), uid);

        const primaryKey = sanitizeCourierStorageKey(cid || uid);
        const existingEntry = primaryKey ? courierDetailCache.get(primaryKey) : null;
        if (primaryKey && (!existingEntry || (!existingEntry.data?.fetchedFromApi && (phone || uid)))) {
          const mergedCourier = { ...(existingEntry?.data?.courier || {}), ...c };
          const docObj = {
            storageKey: primaryKey,
            courierId: cid || existingEntry?.data?.courierId || "",
            userId: uid || existingEntry?.data?.userId || cid,
            courierName: cname || existingEntry?.data?.courierName || "",
            fetchedFromApi: Boolean(phone || existingEntry?.data?.fetchedFromApi),
            courier: mergedCourier,
            user_id: uid || existingEntry?.data?.user_id || null,
            status_until: payload?.status_until ?? existingEntry?.data?.status_until ?? null,
            contract_info: payload?.contract_info ?? existingEntry?.data?.contract_info ?? null,
            status_meta_data: payload?.status_meta_data ?? existingEntry?.data?.status_meta_data ?? null,
            updatedAt: new Date().toISOString()
          };
          const record = { fetchedAt: Date.now(), data: docObj };
          courierDetailCache.set(primaryKey, record);
          if (cid) courierDetailCache.set(sanitizeCourierStorageKey(cid), record);
          if (uid) courierDetailCache.set(sanitizeCourierStorageKey(uid), record);
          if (cname) courierDetailCache.set(sanitizeCourierStorageKey(cname.toLowerCase()), record);
        }
      });
    } catch {}
  }

  (function hookPageAuthHeaders() {
    try {
      if (typeof window !== "undefined" && typeof window.fetch === "function") {
        const origFetch = window.fetch;
        window.fetch = function (input, init) {
          const urlStr = typeof input === "string" ? input : input?.url || "";
          try {
            if (urlStr.includes("/api/") && init && init.headers) {
              const h = init.headers;
              if (typeof h.forEach === "function") {
                h.forEach((v, k) => {
                  if (/^(authorization|x-csrf-token|x-xsrf-token|x-auth-token)$/i.test(k) && v) {
                    CAPTURED_AUTH_HEADERS[k] = v;
                  }
                });
              } else if (typeof h === "object") {
                Object.entries(h).forEach(([k, v]) => {
                  if (/^(authorization|x-csrf-token|x-xsrf-token|x-auth-token)$/i.test(k) && v) {
                    CAPTURED_AUTH_HEADERS[k] = v;
                  }
                });
              }
            }
          } catch {}
          const promise = origFetch.apply(this, arguments);
          if (urlStr.includes("/api/") && /courier/i.test(urlStr)) {
            promise
              .then((resp) => {
                if (resp && resp.ok && typeof resp.clone === "function") {
                  resp
                    .clone()
                    .json()
                    .then((json) => ingestPassiveCouriersPayload(json))
                    .catch(() => {});
                }
              })
              .catch(() => {});
          }
          if (urlStr.includes("/api/") && /orders\/completed/i.test(urlStr)) {
            capturedCompletedApiBaseUrl = urlStr;
            promise
              .then((resp) => {
                if (resp && resp.ok && typeof resp.clone === "function") {
                  resp
                    .clone()
                    .json()
                    .then((json) => ingestCompletedRecordsBatch(json?.records || json?.orders || []))
                    .catch(() => {});
                }
              })
              .catch(() => {});
          }
          return promise;
        };
      }

      if (typeof XMLHttpRequest !== "undefined") {
        const origOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function (method, url) {
          this.__hurrierUrl = String(url || "");
          return origOpen.apply(this, arguments);
        };
        const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
        XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
          try {
            if (/^(authorization|x-csrf-token|x-xsrf-token|x-auth-token)$/i.test(String(k)) && v) {
              CAPTURED_AUTH_HEADERS[k] = v;
            }
          } catch {}
          return origSetHeader.apply(this, arguments);
        };
        const origSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.send = function () {
          if (this.__hurrierUrl && this.__hurrierUrl.includes("/api/") && /courier/i.test(this.__hurrierUrl)) {
            this.addEventListener("load", function () {
              try {
                if (this.status >= 200 && this.status < 300 && this.responseText) {
                  ingestPassiveCouriersPayload(JSON.parse(this.responseText));
                }
              } catch {}
            });
          }
          return origSend.apply(this, arguments);
        };
      }
    } catch {}
  })();

  // --- LEVEL 1: SAME-PC MULTI-TAB COORDINATION (BroadcastChannel + LocalStorage) ---
  function initLocalTabCoordinator() {
    try {
      if (typeof BroadcastChannel !== "undefined") {
        localBroadcastChannel = new BroadcastChannel(LOCAL_CHANNEL_NAME);
        localBroadcastChannel.onmessage = (ev) => {
          const msg = ev?.data;
          if (!msg || typeof msg !== "object") return;
          if (msg.type === "HEARTBEAT" && msg.tabId && msg.tabId !== TAB_ID) {
            if (localLeaderTabId === TAB_ID && msg.startedAt < Number(TAB_ID.split("_")[1] || 0)) {
              localLeaderTabId = msg.tabId;
              localLeaderLastSeen = Date.now();
            } else if (localLeaderTabId !== TAB_ID) {
              localLeaderTabId = msg.tabId;
              localLeaderLastSeen = Date.now();
            }
          } else if (msg.type === "RELEASE" && msg.tabId === localLeaderTabId) {
            localLeaderTabId = TAB_ID;
            localLeaderLastSeen = Date.now();
          }
        };
      }
    } catch {}

    setInterval(() => {
      try {
        const now = Date.now();
        const rawStored = window.localStorage.getItem(LOCAL_TAB_STORAGE_KEY);
        const parsed = rawStored ? JSON.parse(rawStored) : null;

        if (!parsed || !parsed.tabId || now - Number(parsed.ts || 0) > LOCAL_TAB_TIMEOUT_MS) {
          localLeaderTabId = TAB_ID;
          localLeaderLastSeen = now;
          window.localStorage.setItem(LOCAL_TAB_STORAGE_KEY, JSON.stringify({ tabId: TAB_ID, ts: now }));
          if (localBroadcastChannel) {
            localBroadcastChannel.postMessage({ type: "HEARTBEAT", tabId: TAB_ID, ts: now });
          }
        } else if (parsed.tabId === TAB_ID) {
          localLeaderTabId = TAB_ID;
          localLeaderLastSeen = now;
          window.localStorage.setItem(LOCAL_TAB_STORAGE_KEY, JSON.stringify({ tabId: TAB_ID, ts: now }));
          if (localBroadcastChannel) {
            localBroadcastChannel.postMessage({ type: "HEARTBEAT", tabId: TAB_ID, ts: now });
          }
        } else {
          localLeaderTabId = parsed.tabId;
          localLeaderLastSeen = Number(parsed.ts || now);
        }
      } catch {}
    }, LOCAL_TAB_HEARTBEAT_MS);

    window.addEventListener("beforeunload", () => {
      try {
        if (localLeaderTabId === TAB_ID) {
          window.localStorage.removeItem(LOCAL_TAB_STORAGE_KEY);
          if (localBroadcastChannel) {
            localBroadcastChannel.postMessage({ type: "RELEASE", tabId: TAB_ID });
          }
        }
      } catch {}
    });
  }

  function ensureLocalTabLeadership() {
    const now = Date.now();
    try {
      const rawStored = window.localStorage.getItem(LOCAL_TAB_STORAGE_KEY);
      const parsed = rawStored ? JSON.parse(rawStored) : null;
      if (!parsed || !parsed.tabId || now - Number(parsed.ts || 0) > LOCAL_TAB_TIMEOUT_MS) {
        localLeaderTabId = TAB_ID;
        localLeaderLastSeen = now;
        window.localStorage.setItem(LOCAL_TAB_STORAGE_KEY, JSON.stringify({ tabId: TAB_ID, ts: now }));
        return true;
      }
      if (parsed.tabId === TAB_ID) {
        window.localStorage.setItem(LOCAL_TAB_STORAGE_KEY, JSON.stringify({ tabId: TAB_ID, ts: now }));
        return true;
      }
      localLeaderTabId = parsed.tabId;
      localLeaderLastSeen = Number(parsed.ts || now);
      return false;
    } catch {
      return localLeaderTabId === TAB_ID || now - localLeaderLastSeen > LOCAL_TAB_TIMEOUT_MS;
    }
  }

  // --- ADMIN AUTH BRIDGE & TOKEN REFRESH ---
  function readStoredAdminBridgeAuth() {
    try {
      const raw =
        (typeof GM_getValue === "function" ? GM_getValue(AUTH_BRIDGE_STORAGE_KEY, "") : "") ||
        window.localStorage.getItem(AUTH_BRIDGE_STORAGE_KEY);
      if (!raw) return null;
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (!parsed || !parsed.idToken || parsed.role !== "admin") return null;
      return parsed;
    } catch {
      return null;
    }
  }

  function gmHttpRequest(options) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest === "function") {
        GM_xmlhttpRequest({
          method: options.method || "GET",
          url: options.url,
          headers: options.headers || {},
          data: options.data || undefined,
          onload: (res) => {
            resolve({
              ok: res.status >= 200 && res.status < 300,
              status: res.status,
              text: res.responseText || ""
            });
          },
          onerror: (err) => reject(new Error(err?.error || "GM_xmlhttpRequest network error"))
        });
      } else {
        fetch(options.url, {
          method: options.method || "GET",
          headers: options.headers || {},
          body: options.data || undefined
        })
          .then(async (r) => ({
            ok: r.ok,
            status: r.status,
            text: await r.text()
          }))
          .then(resolve)
          .catch(reject);
      }
    });
  }

  async function getValidAdminIdToken() {
    const authObj = readStoredAdminBridgeAuth();
    if (!authObj) return null;

    if (authObj.expiresAt && Date.now() < Number(authObj.expiresAt) - 120000) {
      return authObj.idToken;
    }

    if (authObj.refreshToken && authObj.apiKey) {
      try {
        const refreshRes = await gmHttpRequest({
          method: "POST",
          url: `https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(authObj.apiKey)}`,
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          data: `grant_type=refresh_token&refresh_token=${encodeURIComponent(authObj.refreshToken)}`
        });
        if (refreshRes.ok) {
          const tokenJson = JSON.parse(refreshRes.text);
          if (tokenJson.id_token) {
            const updated = {
              ...authObj,
              idToken: tokenJson.id_token,
              refreshToken: tokenJson.refresh_token || authObj.refreshToken,
              expiresAt: Date.now() + Number(tokenJson.expires_in || 3600) * 1000
            };
            const serialized = JSON.stringify(updated);
            if (typeof GM_setValue === "function") GM_setValue(AUTH_BRIDGE_STORAGE_KEY, serialized);
            try {
              window.localStorage.setItem(AUTH_BRIDGE_STORAGE_KEY, serialized);
            } catch {}
            return updated.idToken;
          }
        }
      } catch {}
    }

    return authObj.idToken;
  }

  async function firebaseRequest(method, path, bodyObj = null) {
    const idToken = await getValidAdminIdToken();
    if (!idToken) {
      throw new Error("Admin Sign-In Required (افتح الداشبورد وسجل دخول بحساب Admin)");
    }
    const cleanPath = String(path || "").replace(/^\/+/, "");
    const url = `${FIREBASE_DB_URL}/${cleanPath}.json?auth=${encodeURIComponent(idToken)}`;
    const res = await gmHttpRequest({
      method,
      url,
      headers: bodyObj !== null ? { "Content-Type": "application/json" } : {},
      data: bodyObj !== null ? JSON.stringify(bodyObj) : undefined
    });
    if (!res.ok) {
      throw new Error(`Firebase HTTP ${res.status}`);
    }
    return res.text ? JSON.parse(res.text) : null;
  }

  // --- LEVEL 2: MULTI-PC / MULTI-BRANCH AUTO-LEADER ELECTION ---
  async function ensureFeederLeadership(adminEmail) {
    const now = Date.now();
    const lockData = await firebaseRequest("GET", "feeder_lock").catch(() => null);

    if (
      !lockData ||
      !lockData.feederId ||
      lockData.feederId === FEEDER_INSTANCE_ID ||
      now - Number(lockData.heartbeatAt || 0) > LEADER_LEASE_MS
    ) {
      await firebaseRequest("PUT", "feeder_lock", {
        feederId: FEEDER_INSTANCE_ID,
        leaderEmail: adminEmail || "admin",
        heartbeatAt: now
      });
      return { isLeader: true, leaderEmail: adminEmail };
    }

    return {
      isLeader: false,
      leaderEmail: lockData.leaderEmail || "Another Admin PC"
    };
  }

  // --- HURRIER API HELPERS ---
  function getHurrierRequestOptions() {
    const csrfMeta =
      document.querySelector('meta[name="csrf-token"]')?.getAttribute("content") ||
      document.querySelector('meta[name="xsrf-token"]')?.getAttribute("content") ||
      "";
    const headers = {
      Accept: "application/json, text/plain, */*",
      ...CAPTURED_AUTH_HEADERS
    };
    if (csrfMeta && !headers["X-CSRF-Token"]) {
      headers["X-CSRF-Token"] = csrfMeta;
    }
    return {
      credentials: "include",
      headers
    };
  }

  async function safeFetchJson(url, opts) {
    try {
      const res = await fetch(url, opts);
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  async function fetchAllPagesForEndpoint(baseUrl, opts, maxPages = 10) {
    const sep = baseUrl.includes("?") ? "&" : "?";
    const page1 = await safeFetchJson(`${baseUrl}${sep}page=1&per_page=50`, opts);
    if (!page1) return { records: [], metadata: { total_count: 0 } };

    const firstRecords = Array.isArray(page1.records) ? page1.records : Array.isArray(page1) ? page1 : [];
    const totalCount = Number(page1.metadata?.total_count ?? firstRecords.length);
    const totalPages = Math.min(maxPages, Math.max(1, Math.ceil(totalCount / 50)));

    if (totalPages <= 1) {
      return { records: firstRecords, metadata: { total_count: totalCount } };
    }

    const pageNums = [];
    for (let p = 2; p <= totalPages; p++) pageNums.push(p);

    const extraPages = await Promise.all(
      pageNums.map((p) => safeFetchJson(`${baseUrl}${sep}page=${p}&per_page=50`, opts))
    );

    const allRecords = [...firstRecords];
    extraPages.forEach((pg) => {
      if (pg && Array.isArray(pg.records)) {
        allRecords.push(...pg.records);
      }
    });

    return {
      records: allRecords,
      metadata: { total_count: Math.max(totalCount, allRecords.length) }
    };
  }

  async function fetchFullCourierDetails(courierToken, opts, forceRefresh = false) {
    const [rawId, rawName] = String(courierToken || "").split("|");
    const idStr = String(rawId || "").trim();
    const nameStr = String(rawName || "").trim();
    const lookupKey = sanitizeCourierStorageKey(idStr || nameStr.toLowerCase());
    if (!lookupKey) return null;

    const cached = courierDetailCache.get(lookupKey);
    if (!forceRefresh && cached && cached.data?.fetchedFromApi && Date.now() - cached.fetchedAt < 120000) {
      return cached;
    }

    let detailPayload = null;
    if (idStr) {
      detailPayload = await safeFetchJson(
        `${BASE_API}/dispatcher-dashboard/courier/detail?courier_id=${encodeURIComponent(idStr)}`,
        opts
      );
      if (!detailPayload) {
        detailPayload = await safeFetchJson(
          `${BASE_API}/dispatcher-dashboard/courier/detail?user_id=${encodeURIComponent(idStr)}`,
          opts
        );
      }
    }

    if (!detailPayload && nameStr) {
      const searchRes = await safeFetchJson(
        `${BASE_API}/dispatcher-dashboard/couriers?search=${encodeURIComponent(nameStr)}`,
        opts
      );
      const list = Array.isArray(searchRes?.couriers)
        ? searchRes.couriers
        : Array.isArray(searchRes?.records)
        ? searchRes.records
        : Array.isArray(searchRes)
        ? searchRes
        : [];
      const found =
        list.find((c) => String(c?.name || "").trim().toLowerCase() === nameStr.toLowerCase()) || list[0];
      if (found?.id) {
        detailPayload = await safeFetchJson(
          `${BASE_API}/dispatcher-dashboard/courier/detail?courier_id=${encodeURIComponent(found.id)}`,
          opts
        );
      }
    }

    if (!detailPayload || typeof detailPayload !== "object") return cached || null;

    const cObj = detailPayload.courier || detailPayload;
    const cid = String(cObj.id || idStr || "").trim();
    const uid = String(detailPayload.user_id || cObj.user_id || cid || "").trim();
    const cname = String(cObj.name || nameStr || "").trim();

    const docObj = {
      storageKey: sanitizeCourierStorageKey(cid || uid || cname.toLowerCase()),
      courierId: cid,
      userId: uid,
      courierName: cname,
      fetchedFromApi: true,
      courier: cObj,
      user_id: uid || null,
      balance: detailPayload.balance ?? cObj.balance ?? null,
      status_until: detailPayload.status_until ?? null,
      contract_info: detailPayload.contract_info ?? null,
      status_meta_data: detailPayload.status_meta_data ?? null,
      updatedAt: new Date().toISOString()
    };

    const record = { fetchedAt: Date.now(), data: docObj };
    courierDetailCache.set(lookupKey, record);
    if (cid) courierDetailCache.set(sanitizeCourierStorageKey(cid), record);
    if (uid) courierDetailCache.set(sanitizeCourierStorageKey(uid), record);
    if (cname) courierDetailCache.set(sanitizeCourierStorageKey(cname.toLowerCase()), record);

    return record;
  }

  function formatCachedDocToSearchResult(d) {
    if (!d || typeof d !== "object") return null;
    const c = d.courier || {};
    const statusMeta = d.status_meta_data || c.status_meta_data || {};
    const contractInfo = d.contract_info || c.contract_info || {};
    const contractStr = [contractInfo.type, contractInfo.name].filter(Boolean).join(" • ");
    const cid = String(d.courierId || c.id || "").trim();
    const uid = String(d.userId || d.user_id || c.user_id || cid || "").trim();
    const cname = String(d.courierName || c.name || "").trim();
    const phone = String(c.phone_number || c.phone || c.mobile || "").trim();
    if (!cid && !uid && !cname) return null;
    return {
      courierId: cid,
      userId: uid,
      name: cname || `Courier #${cid || uid}`,
      phone,
      status: String(c.status || "working"),
      statusUntil: d.status_until || "",
      performedBy: String(statusMeta.performed_by || ""),
      statusReason: String(statusMeta.reason || statusMeta.comment || ""),
      vehicle: String(c.vehicle || "-"),
      fleetId: String(c.fleet_id || "-"),
      contract: contractStr || "-",
      balance: d.balance ?? null
    };
  }

  function extractCouriersArrayFromResponse(res) {
    if (!res) return [];
    if (Array.isArray(res?.couriers)) return res.couriers;
    if (Array.isArray(res?.records)) return res.records;
    if (Array.isArray(res?.data?.couriers)) return res.data.couriers;
    if (Array.isArray(res?.data)) return res.data;
    if (Array.isArray(res)) return res;
    if (res?.courier && typeof res.courier === "object") return [res.courier];
    return [];
  }

  async function loadFullZoneAndCityRoster(opts, forceRefresh = false) {
    if (!forceRefresh && cachedZoneRosterEntries.length > 0 && Date.now() - cachedZoneRosterFetchedAt < 45000) {
      return cachedZoneRosterEntries;
    }

    const rosterMap = new Map();
    const ingestList = (res) => {
      const arr = extractCouriersArrayFromResponse(res);
      if (arr.length > 0) ingestPassiveCouriersPayload(arr);
      arr.forEach((c) => {
        if (!c || typeof c !== "object") return;
        const cid = String(c.id || c.courier_id || "").trim();
        const uid = String(c.user_id || "").trim();
        const cname = String(c.name || c.courier_name || "").trim();
        const key = cid || uid || cname.toLowerCase();
        if (!key) return;
        if (!rosterMap.has(key)) {
          rosterMap.set(key, {
            courierId: cid,
            userId: uid,
            courierName: cname,
            phone: String(c.phone_number || c.phone || c.mobile || "").trim(),
            status: String(c.status || "working").trim(),
            vehicle: String(c.vehicle || "-").trim(),
            fleetId: String(c.fleet_id || "-").trim()
          });
        }
      });
    };

    const zoneIds = Array.isArray(latestUnionZoneIds) ? latestUnionZoneIds.slice(0, 25) : [];
    const tasks = [
      safeFetchJson(`${BASE_API}/dispatcher-dashboard/couriers?city_id=1&per_page=1000`, opts).then(ingestList),
      safeFetchJson(`${BASE_API}/dispatcher-dashboard/couriers?city_id=200&per_page=500`, opts).then(ingestList),
      safeFetchJson(`${BASE_API}/dispatcher-dashboard/couriers?per_page=1000`, opts).then(ingestList)
    ];

    const zoneBatches = chunkArray(zoneIds, 8);
    for (const batch of zoneBatches) {
      await Promise.all(
        batch.flatMap((zid) => [
          safeFetchJson(`${BASE_API}/dispatcher-dashboard/couriers?starting_point_id=${encodeURIComponent(zid)}`, opts).then(ingestList),
          safeFetchJson(`${BASE_API}/dispatcher-dashboard/starting_points/${encodeURIComponent(zid)}/couriers`, opts).then(ingestList)
        ])
      );
    }

    await Promise.all(tasks);
    if (rosterMap.size > 0) {
      cachedZoneRosterEntries = Array.from(rosterMap.values());
      cachedZoneRosterFetchedAt = Date.now();
    }
    return cachedZoneRosterEntries;
  }

  async function searchCouriersInHurrier(rawQuery, opts) {
    const cleanQ = String(rawQuery || "").trim();
    if (!cleanQ) return [];

    const cacheKey = cleanQ.toLowerCase();
    const cached = riderSearchCache.get(cacheKey);
    if (cached && cached.results.length > 0 && Date.now() - cached.fetchedAt < 15000) {
      return cached.results;
    }

    const { rawDigits, core10 } = normalizePhoneDigits(cleanQ);
    const isPhoneQuery =
      core10.length === 10 || (rawDigits.length >= 9 && /^(\+?20|0020|01)/.test(cleanQ.replace(/[\s\-()]+/g, "")));
    const isPureDigits = /^\d+$/.test(rawDigits) && rawDigits.length >= 3 && rawDigits.length <= 12 && !isPhoneQuery;

    // 1) Instant check in local memory courierDetailCache
    const directMatchedMap = new Map();
    const pushDirectMatch = (resObj) => {
      if (!resObj) return;
      const score = matchRiderProfileByQuery(resObj, cleanQ);
      if (score <= 0) return;
      const key = resObj.courierId || resObj.userId || resObj.name.toLowerCase();
      if (!directMatchedMap.has(key)) {
        directMatchedMap.set(key, { r: resObj, score });
      }
    };

    courierDetailCache.forEach((entry) => {
      if (entry?.data) {
        pushDirectMatch(formatCachedDocToSearchResult(entry.data));
      }
    });

    if (directMatchedMap.size > 0) {
      const topMatches = Array.from(directMatchedMap.values())
        .sort((a, b) => b.score - a.score)
        .map(({ r }) => r)
        .slice(0, 5);
      const enrichedQuick = await Promise.all(
        topMatches.map(async (m) => {
          if (!m.phone && (m.courierId || m.name)) {
            const full = await fetchFullCourierDetails(`${m.courierId}|${m.name}`, opts, false);
            if (full?.data) {
              if (full.data.courierId) {
                firebaseRequest("PUT", `courier_details/${sanitizeCourierStorageKey(full.data.courierId)}`, full.data).catch(() => {});
              }
              return formatCachedDocToSearchResult(full.data) || m;
            }
          }
          return m;
        })
      );
      riderSearchCache.set(cacheKey, { fetchedAt: Date.now(), results: enrichedQuick });
      return enrichedQuick;
    }

    // 2) Check Firebase courier_details cache
    try {
      const fbCouriers = await firebaseRequest("GET", "courier_details").catch(() => null);
      if (fbCouriers && typeof fbCouriers === "object") {
        Object.values(fbCouriers).forEach((doc) => {
          if (doc && typeof doc === "object") {
            const formatted = formatCachedDocToSearchResult(doc);
            if (formatted) {
              if (formatted.courierId) {
                courierDetailCache.set(sanitizeCourierStorageKey(formatted.courierId), {
                  fetchedAt: Date.now(),
                  data: doc
                });
              }
              if (formatted.userId) {
                courierDetailCache.set(sanitizeCourierStorageKey(formatted.userId), {
                  fetchedAt: Date.now(),
                  data: doc
                });
              }
              pushDirectMatch(formatted);
            }
          }
        });
      }
    } catch {}

    if (directMatchedMap.size > 0) {
      const fbList = Array.from(directMatchedMap.values())
        .sort((a, b) => b.score - a.score)
        .map(({ r }) => r)
        .slice(0, 5);
      riderSearchCache.set(cacheKey, { fetchedAt: Date.now(), results: fbList });
      return fbList;
    }

    // 3) Query Hurrier API endpoints + full zone/city courier roster (including 0-order working/break/ending riders)
    const searchTerms = new Set([cleanQ]);
    if (core10) {
      searchTerms.add(`0${core10}`);
      searchTerms.add(`+20${core10}`);
      searchTerms.add(`20${core10}`);
      searchTerms.add(core10);
    } else if (rawDigits && rawDigits !== cleanQ) {
      searchTerms.add(rawDigits);
    }

    const candidateMap = new Map();
    const addCandidate = (cObj) => {
      if (!cObj || typeof cObj !== "object") return;
      const cid = String(cObj.id || cObj.courier_id || "").trim();
      const uid = String(cObj.user_id || "").trim();
      const cname = String(cObj.name || cObj.courier_name || "").trim();
      const key = cid || uid || cname.toLowerCase();
      if (!key) return;
      if (!candidateMap.has(key)) {
        candidateMap.set(key, {
          courierId: cid,
          userId: uid,
          name: cname,
          phone: String(cObj.phone_number || cObj.phone || cObj.mobile || "").trim(),
          status: String(cObj.status || "").trim(),
          vehicle: String(cObj.vehicle || "").trim(),
          fleetId: String(cObj.fleet_id || "").trim()
        });
      }
    };

    const apiTasks = [];
    Array.from(searchTerms)
      .slice(0, 4)
      .forEach((term) => {
        apiTasks.push(
          safeFetchJson(`${BASE_API}/dispatcher-dashboard/couriers?search=${encodeURIComponent(term)}`, opts).then(
            (res) => extractCouriersArrayFromResponse(res).forEach(addCandidate)
          )
        );
        apiTasks.push(
          safeFetchJson(`${BASE_API}/dispatcher-dashboard/couriers?query=${encodeURIComponent(term)}`, opts).then(
            (res) => extractCouriersArrayFromResponse(res).forEach(addCandidate)
          )
        );
        apiTasks.push(
          safeFetchJson(`${BASE_API}/couriers?search=${encodeURIComponent(term)}`, opts).then((res) =>
            extractCouriersArrayFromResponse(res).forEach(addCandidate)
          )
        );
        apiTasks.push(
          safeFetchJson(`${BASE_API}/courier-service/couriers?search=${encodeURIComponent(term)}`, opts).then((res) =>
            extractCouriersArrayFromResponse(res).forEach(addCandidate)
          )
        );
      });

    if (isPureDigits) {
      apiTasks.push(
        safeFetchJson(
          `${BASE_API}/dispatcher-dashboard/courier/detail?courier_id=${encodeURIComponent(rawDigits)}`,
          opts
        ).then((detailRes) => {
          const cObj = detailRes?.courier || detailRes;
          if (cObj && (cObj.id || cObj.name)) {
            addCandidate({ ...cObj, user_id: detailRes?.user_id || cObj.user_id });
          }
        })
      );
      apiTasks.push(
        safeFetchJson(
          `${BASE_API}/dispatcher-dashboard/courier/detail?user_id=${encodeURIComponent(rawDigits)}`,
          opts
        ).then((detailRes) => {
          const cObj = detailRes?.courier || detailRes;
          if (cObj && (cObj.id || cObj.name)) {
            addCandidate({ ...cObj, user_id: detailRes?.user_id || cObj.user_id || rawDigits });
          }
        })
      );
      apiTasks.push(
        safeFetchJson(`${BASE_API}/dispatcher-dashboard/couriers?user_id=${encodeURIComponent(rawDigits)}`, opts).then(
          (res) => extractCouriersArrayFromResponse(res).forEach(addCandidate)
        )
      );
      apiTasks.push(
        safeFetchJson(`${BASE_API}/dispatcher-dashboard/couriers?user_ids[]=${encodeURIComponent(rawDigits)}`, opts).then(
          (res) => extractCouriersArrayFromResponse(res).forEach(addCandidate)
        )
      );
      apiTasks.push(
        safeFetchJson(`${BASE_API}/dispatcher-dashboard/couriers/${encodeURIComponent(rawDigits)}`, opts).then(
          (res) => extractCouriersArrayFromResponse(res).forEach(addCandidate)
        )
      );
    }

    const [rosterList] = await Promise.all([loadFullZoneAndCityRoster(opts, false), Promise.all(apiTasks)]);

    rosterList.forEach((rEntry) => {
      const score = matchRiderProfileByQuery(
        {
          courierId: rEntry.courierId,
          userId: rEntry.userId,
          name: rEntry.courierName,
          phone: rEntry.phone
        },
        cleanQ
      );
      if (score > 0) {
        addCandidate({
          id: rEntry.courierId,
          user_id: rEntry.userId,
          name: rEntry.courierName,
          phone_number: rEntry.phone,
          status: rEntry.status,
          vehicle: rEntry.vehicle,
          fleet_id: rEntry.fleetId
        });
      }
    });

    const rawCandidates = Array.from(candidateMap.values()).slice(0, 12);
    const enrichedResults = [];

    await Promise.all(
      rawCandidates.map(async (cand) => {
        const token = `${cand.courierId || cand.userId}|${cand.name}`;
        const full = await fetchFullCourierDetails(token, opts, false);
        if (full && full.data) {
          const formatted = formatCachedDocToSearchResult(full.data);
          if (formatted) {
            enrichedResults.push(formatted);
            if (formatted.courierId) {
              firebaseRequest("PUT", `courier_details/${sanitizeCourierStorageKey(formatted.courierId)}`, full.data).catch(() => {});
            }
          }
        } else if (cand.name || cand.courierId || cand.userId) {
          enrichedResults.push({
            courierId: cand.courierId,
            userId: cand.userId || cand.courierId,
            name: cand.name || `Courier #${cand.courierId || cand.userId}`,
            phone: cand.phone,
            status: cand.status || "working",
            statusUntil: "",
            performedBy: "",
            statusReason: "",
            vehicle: cand.vehicle || "-",
            fleetId: cand.fleetId || "-",
            contract: "-",
            balance: null
          });
        }
      })
    );

    let scored = enrichedResults
      .map((r) => ({ r, score: matchRiderProfileByQuery(r, cleanQ) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .map(({ r }) => r)
      .slice(0, 5);

    // 4) Fallback for Phone Search: enrich uncached zone/city roster couriers in parallel batches
    if (scored.length === 0 && isPhoneQuery) {
      const seenPoolKeys = new Set();
      const combinedPool = [];
      [...latestActiveCourierEntries, ...rosterList].forEach((entry) => {
        const k = sanitizeCourierStorageKey(entry.courierId || entry.userId || entry.courierName.toLowerCase());
        if (k && !seenPoolKeys.has(k) && !courierDetailCache.get(k)?.data?.fetchedFromApi) {
          seenPoolKeys.add(k);
          combinedPool.push(entry);
        }
      });

      const batches = chunkArray(combinedPool.slice(0, 180), 18);
      for (const batch of batches) {
        const batchMatches = [];
        await Promise.all(
          batch.map(async (entry) => {
            const full = await fetchFullCourierDetails(
              `${entry.courierId || entry.userId}|${entry.courierName}`,
              opts,
              false
            );
            if (full && full.data) {
              const formatted = formatCachedDocToSearchResult(full.data);
              if (formatted) {
                if (formatted.courierId) {
                  firebaseRequest("PUT", `courier_details/${sanitizeCourierStorageKey(formatted.courierId)}`, full.data).catch(() => {});
                }
                if (matchRiderProfileByQuery(formatted, cleanQ) > 0) {
                  batchMatches.push(formatted);
                }
              }
            }
          })
        );
        if (batchMatches.length > 0) {
          scored = batchMatches.slice(0, 5);
          break;
        }
      }
    }

    if (scored.length > 0) {
      riderSearchCache.set(cacheKey, { fetchedAt: Date.now(), results: scored });
    }
    return scored;
  }

  async function fetchFullOrderDetails(orderToken, opts) {
    const [rawOrderId, rawDeliveryId] = String(orderToken || "").split("|");
    const cleanOrderId = String(rawOrderId || "")
      .replace(/^(HF_[A-Z]{2}|ODR_[A-Z]{2})/i, "")
      .trim();
    const cleanDelId = String(rawDeliveryId || "").trim();
    if (!cleanOrderId) return null;

    const cached = orderDetailCache.get(cleanOrderId);
    if (cached && Date.now() - cached.fetchedAt < 8000) {
      return cached.data;
    }

    const codeWithPrefix = `HF_EG${cleanOrderId}`;
    const [detailRes, deliveriesRes, notesRes, issuesRes] = await Promise.all([
      safeFetchJson(`${BASE_API}/dispatcher-dashboard/orders/detail?code=${encodeURIComponent(cleanOrderId)}`, opts),
      safeFetchJson(`${BASE_API}/dispatcher-dashboard/orders/detail/deliveries?code=${encodeURIComponent(codeWithPrefix)}`, opts),
      safeFetchJson(`${BASE_API}/dispatcher-dashboard/orders/dispatcher_notes?code=${encodeURIComponent(codeWithPrefix)}`, opts),
      safeFetchJson(`${BASE_API}/issue-service/orders/${encodeURIComponent(cleanOrderId)}/issues`, opts)
    ]);

    const mainOrder = detailRes?.order || detailRes;
    const deliveriesList = Array.isArray(deliveriesRes?.deliveries)
      ? deliveriesRes.deliveries
      : Array.isArray(deliveriesRes?.records)
      ? deliveriesRes.records
      : Array.isArray(deliveriesRes)
      ? deliveriesRes
      : [];

    if (!mainOrder && deliveriesList.length === 0) {
      return cached?.data || null;
    }

    const doc = {
      orderId: cleanOrderId,
      order: mainOrder || {},
      deliveries: deliveriesList,
      dispatcher_notes: Array.isArray(notesRes?.dispatcher_notes)
        ? notesRes.dispatcher_notes
        : Array.isArray(notesRes?.notes)
        ? notesRes.notes
        : Array.isArray(notesRes)
        ? notesRes
        : [],
      order_issues: Array.isArray(issuesRes?.issues)
        ? issuesRes.issues
        : Array.isArray(issuesRes)
        ? issuesRes
        : [],
      updatedAt: new Date().toISOString()
    };

    orderDetailCache.set(cleanOrderId, { fetchedAt: Date.now(), data: doc });
    return doc;
  }

  // Background Rolling 2-Hour Completed Orders Pool (indexed by Completed At + Auto-Cleanup > 2h)
  function ingestCompletedRecordsBatch(records) {
    if (!Array.isArray(records) || records.length === 0) return 0;
    const cutoffMs = Date.now() - ROLLING_COMPLETED_WINDOW_MS;
    let freshCount = 0;

    for (const rec of records) {
      const order = rec?.order || {};
      const orderKey = String(
        order.id ||
          order.confirmation_number ||
          String(order.order_code || "").replace(/^(HF_[A-Z]{2}|ODR_[A-Z]{2})/i, "") ||
          ""
  async function fetchCompletedPageForDate(dateStr, pageNum, opts) {
    const params = new URLSearchParams();
    params.set("date", dateStr);
    params.set("page", String(pageNum));
    params.set("per_page", "50");
    const url = `${BASE_API}/dispatcher-dashboard/orders/completed?${params.toString()}`;
    return safeFetchJson(url, opts);
  }

  function getPageFirstPlacedMs(pageRes) {
    const recs = Array.isArray(pageRes?.records)
      ? pageRes.records
      : Array.isArray(pageRes?.orders)
      ? pageRes.orders
      : [];
    for (const r of recs) {
      const p = r?.order?.placed_at;
      if (p) {
        const ms = new Date(p).getTime();
        if (!Number.isNaN(ms) && ms > 0) return ms;
      }
    }
    return 0;
  }

  async function findFirstCompletedPageAfterCutoff(dateStr, totalPages, minPlacedMs, opts) {
    if (totalPages <= 1) return 1;
    let low = 1;
    let high = totalPages;
    let bestPage = totalPages;
    let steps = 0;

    while (low <= high && steps < 9) {
      steps += 1;
      const mid = Math.floor((low + high) / 2);
      const midRes = await fetchCompletedPageForDate(dateStr, mid, opts);
      const recs = Array.isArray(midRes?.records) ? midRes.records : [];
      ingestCompletedRecordsBatch(recs);

      const firstMs = getPageFirstPlacedMs(midRes);
      if (!firstMs) {
        high = mid - 1;
        continue;
      }
      if (firstMs >= minPlacedMs) {
        bestPage = mid;
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }
    return Math.max(1, bestPage - 1);
  }

  async function pullCompletedWindowForDate(dateStr, minPlacedMs, isIncremental, opts) {
    const page1Res = await fetchCompletedPageForDate(dateStr, 1, opts);
    if (!page1Res) return;
    const p1Recs = Array.isArray(page1Res?.records)
      ? page1Res.records
      : Array.isArray(page1Res?.orders)
      ? page1Res.orders
      : [];
    ingestCompletedRecordsBatch(p1Recs);

    const totalCount = Number(page1Res?.metadata?.total_count ?? p1Recs.length);
    const totalPages = Math.max(1, Math.ceil(totalCount / 50));
    if (totalPages <= 1) return;

    const p1FirstMs = getPageFirstPlacedMs(page1Res);
    let startPage = 1;
    if (p1FirstMs > 0 && p1FirstMs < minPlacedMs) {
      startPage = await findFirstCompletedPageAfterCutoff(dateStr, totalPages, minPlacedMs, opts);
    }

    // On incremental cycles after initial backfill, scan the newest 30 pages from totalPages downward
    const effectiveStart = isIncremental ? Math.max(startPage, totalPages - 30) : Math.max(startPage, totalPages - 90);
    const pagesToPull = [];
    for (let p = totalPages; p >= effectiveStart; p--) {
      pagesToPull.push(p);
    }

    const batches = chunkArray(pagesToPull, 6);
    for (const batch of batches) {
      await Promise.all(
        batch.map(async (p) => {
          const res = await fetchCompletedPageForDate(dateStr, p, opts);
          const recs = Array.isArray(res?.records) ? res.records : Array.isArray(res?.orders) ? res.orders : [];
          ingestCompletedRecordsBatch(recs);
        })
      );
    }
  }

  async function syncRollingCompletedOrdersPool(unionZoneIds, opts, force = false) {
    const now = Date.now();
    const cutoffMs = now - ROLLING_COMPLETED_WINDOW_MS;

    // 1) Auto-delete any stored order whose Completed At is older than 2 hours
    for (const [key, entry] of rollingCompletedPool.entries()) {
      if (!entry || entry.completedAtMs < cutoffMs) {
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

    // Pull orders placed in the last 3.5h for today in Cairo (using Binary Search to skip early pages)
    await pullCompletedWindowForDate(todayStr, minPlacedCutoffMs, isIncremental, opts);

    // If between 12:00 AM and 4:00 AM Cairo time, also pull cross-midnight orders from yesterday's tail
    if (cairoHour < 4) {
      await pullCompletedWindowForDate(yesterdayStr, minPlacedCutoffMs, isIncremental, opts);
    }

    initialCompletedBackfillDone = true;

    // Final cleanup pass after ingestion
    const afterCutoff = Date.now() - ROLLING_COMPLETED_WINDOW_MS;
    for (const [key, entry] of rollingCompletedPool.entries()) {
      if (!entry || entry.completedAtMs < afterCutoff) {
        rollingCompletedPool.delete(key);
      }
    }
  }

  function getSessionRollingCompletedPayload(sessionZoneIds) {
    const cutoffMs = Date.now() - ROLLING_COMPLETED_WINDOW_MS;
    const targetSet = new Set((Array.isArray(sessionZoneIds) ? sessionZoneIds : []).map(Number));
    const matched = [];

    for (const [key, entry] of rollingCompletedPool.entries()) {
      if (!entry || entry.completedAtMs < cutoffMs) {
        rollingCompletedPool.delete(key);
        continue;
      }
      if (targetSet.size === 0 || entry.zoneIds.length === 0 || entry.zoneIds.some((z) => targetSet.has(z))) {
        matched.push(entry);
      }
    }

    matched.sort((a, b) => b.completedAtMs - a.completedAtMs);
    const records = matched.map((m) => m.record);
    return {
      records,
      metadata: {
        total_count: records.length,
        window_hours: 2,
        updated_at: new Date().toISOString()
      }
    };
  }

  async function processOrderDetailRequests(opts, validSessions = []) {
    try {
      const [reqOrderList, reqCourierList] = await Promise.all([
        firebaseRequest("GET", "config/requested_order_details").catch(() => []),
        firebaseRequest("GET", "config/requested_courier_details").catch(() => [])
      ]);

      if (Array.isArray(reqOrderList) && reqOrderList.length > 0) {
        const tokens = reqOrderList.slice(0, 6).map(String);
        await Promise.all(
          tokens.map(async (tok) => {
            const doc = await fetchFullOrderDetails(tok, opts);
            if (doc && doc.orderId) {
              await firebaseRequest("PUT", `order_details/${doc.orderId}`, doc).catch(() => {});
            }
          })
        );
        await firebaseRequest("PUT", "config/requested_order_details", []).catch(() => {});
      }

      if (Array.isArray(reqCourierList) && reqCourierList.length > 0) {
        const cTokens = reqCourierList.slice(0, 12).map(String);
        await Promise.all(
          cTokens.map(async (tok) => {
            const rec = await fetchFullCourierDetails(tok, opts, false);
            if (rec && rec.data && rec.data.storageKey) {
              await firebaseRequest("PUT", `courier_details/${rec.data.storageKey}`, rec.data).catch(() => {});
            }
          })
        );
        await firebaseRequest("PUT", "config/requested_courier_details", []).catch(() => {});
      }

      for (const sess of validSessions) {
        if (sess?.rider_search_req?.query && sess?.session_id) {
          const sig = `${sess.rider_search_req.query}_${sess.rider_search_req.requested_at || ""}`;
          if (lastRiderSearchSigBySession.get(sess.session_id) !== sig) {
            lastRiderSearchSigBySession.set(sess.session_id, sig);
            const results = await searchCouriersInHurrier(sess.rider_search_req.query, opts);
            await firebaseRequest("PUT", `session_bundles/${sess.session_id}/rider_search_result`, {
              query: sess.rider_search_req.query,
              results,
              searchedAt: new Date().toISOString()
            }).catch(() => {});
          }
        }
      }
    } catch {}
  }

  function extractZoneIdsFromDeliveryRecord(rec) {
    const ids = new Set();
    const sps = Array.isArray(rec?.starting_points)
      ? rec.starting_points
      : Array.isArray(rec?.order?.starting_points)
      ? rec.order.starting_points
      : [];
    sps.forEach((sp) => {
      if (sp && typeof sp === "object") {
        const n = Number(sp.id || sp.starting_point_id);
        if (!Number.isNaN(n) && n > 0) ids.add(n);
      }
    });
    return Array.from(ids);
  }

  function filterRecordsForSessionZones(records, sessionZoneIds) {
    if (!Array.isArray(sessionZoneIds) || sessionZoneIds.length === 0) return [];
    const targetSet = new Set(sessionZoneIds.map(Number));
    return (Array.isArray(records) ? records : []).filter((rec) => {
      const recZids = extractZoneIdsFromDeliveryRecord(rec);
      if (recZids.length === 0) return true;
      return recZids.some((z) => targetSet.has(z));
    });
  }

  // --- MAIN SYNC LOOP (EVERY 2 SECONDS) ---
  async function syncCycle() {
    if (isSyncing) return;
    isSyncing = true;

    try {
      const storedAuth = readStoredAdminBridgeAuth();
      if (!storedAuth) {
        lastErrorMsg = "افتح الداشبورد وسجّل دخول بحساب Admin لتفعيل التشفير";
        currentModeLabel = `v${SCRIPT_VERSION} Waiting Admin Login`;
        updateBadge(false);
        return;
      }

      // Level 1: Same-PC Tab Lock
      if (!ensureLocalTabLeadership()) {
        lastSuccessAt = new Date();
        lastErrorMsg = "";
        currentModeLabel = `v${SCRIPT_VERSION} Local Tab Standby (Active in another tab on this PC)`;
        updateBadge(true);
        return;
      }

      // Level 2: Multi-PC / Multi-Branch Auto-Leader Election & Instant Failover
      const leadership = await ensureFeederLeadership(storedAuth.email);
      if (!leadership.isLeader) {
        lastSuccessAt = new Date();
        lastErrorMsg = "";
        currentModeLabel = `v${SCRIPT_VERSION} Standby Backup (Leader: ${leadership.leaderEmail})`;
        updateBadge(true);
        return;
      }

      const opts = getHurrierRequestOptions();
      const sessionsMap = await firebaseRequest("GET", "active_sessions");
      const now = Date.now();
      const validSessions = [];

      if (sessionsMap && typeof sessionsMap === "object") {
        for (const [sid, sData] of Object.entries(sessionsMap)) {
          if (!sData || typeof sData !== "object") continue;
          if (now - Number(sData.heartbeat_at || 0) > SESSION_STALE_MS) {
            firebaseRequest("DELETE", `active_sessions/${sid}`).catch(() => {});
            firebaseRequest("DELETE", `session_bundles/${sid}`).catch(() => {});
          } else if (Array.isArray(sData.zone_ids) && sData.zone_ids.length > 0) {
            validSessions.push({ ...sData, session_id: sid });
          }
        }
      }

      if (validSessions.length === 0) {
        await processOrderDetailRequests(opts, []);
        lastSuccessAt = new Date();
        lastErrorMsg = "";
        currentModeLabel = `v${SCRIPT_VERSION} Primary Leader • Standby (0 Emp)`;
        updateBadge(true);
        return;
      }

      const unionZoneSet = new Set();
      validSessions.forEach((s) => {
        (s.zone_ids || []).forEach((z) => {
          const n = Number(z);
          if (!Number.isNaN(n) && n >= 10000 && n < 90000) unionZoneSet.add(n);
        });
      });
      const unionZoneIds = Array.from(unionZoneSet);
      latestUnionZoneIds = unionZoneIds;

      const zoneQuery = unionZoneIds.map((id) => `starting_point_id[]=${encodeURIComponent(id)}`).join("&");

      const [statsRes, activeRes, queuedRes, dispatchedRes, actionableRes, preorderRes, waitingRes, dispatchersRes, issuesRes] =
        await Promise.all([
          safeFetchJson(`${BASE_API}/dispatcher-dashboard/stats?${zoneQuery}`, opts),
          fetchAllPagesForEndpoint(`${BASE_API}/dispatcher-dashboard/deliveries/active?${zoneQuery}`, opts, 12),
          fetchAllPagesForEndpoint(`${BASE_API}/dispatcher-dashboard/deliveries/queued?${zoneQuery}`, opts, 8),
          fetchAllPagesForEndpoint(`${BASE_API}/dispatcher-dashboard/deliveries/dispatched?${zoneQuery}`, opts, 8),
          fetchAllPagesForEndpoint(`${BASE_API}/dispatcher-dashboard/deliveries/actionable?${zoneQuery}`, opts, 6),
          fetchAllPagesForEndpoint(`${BASE_API}/dispatcher-dashboard/deliveries/preorder?${zoneQuery}`, opts, 6),
          fetchAllPagesForEndpoint(`${BASE_API}/dispatcher-dashboard/deliveries/waiting_for_assembly?${zoneQuery}`, opts, 4),
          safeFetchJson(`${BASE_API}/issue-service/dispatcher_dashboard`, opts),
          safeFetchJson(`${BASE_API}/issue-service/issues?${zoneQuery}`, opts)
        ]);

      // Track active riders from current deliveries for fast phone search
      const activeRidersMap = new Map();
      [...(activeRes.records || []), ...(dispatchedRes.records || [])].forEach((r) => {
        const cid = String(r?.courier_id || "").trim();
        const cname = String(r?.courier_name || "").trim();
        if (cid && cname && !activeRidersMap.has(cid)) {
          activeRidersMap.set(cid, { courierId: cid, userId: "", courierName: cname });
        }
      });
      latestActiveCourierEntries = Array.from(activeRidersMap.values());

      // Discover all zones from stats
      const discoveredZones = [];
      if (statsRes && Array.isArray(statsRes.cities)) {
        statsRes.cities.forEach((c) => {
          (c.zones || []).forEach((z) => {
            (z.starting_points || []).forEach((sp) => {
              if (sp?.id && sp?.name) {
                discoveredZones.push({ id: Number(sp.id), name: sp.name, city: c.city_name || "Cairo" });
              }
            });
          });
        });
      }

      // Automatically maintain Rolling 2-Hour Completed Orders pool (by Completed At + Auto-Cleanup > 2h)
      await syncRollingCompletedOrdersPool(unionZoneIds, opts, false);

      // Push personalized bundles to each active employee session
      await Promise.all(
        validSessions.map(async (sess) => {
          const sZones = (sess.zone_ids || []).map(Number);
          const bundlePayload = {
            active: { records: filterRecordsForSessionZones(activeRes.records, sZones) },
            queued: { records: filterRecordsForSessionZones(queuedRes.records, sZones) },
            dispatched: { records: filterRecordsForSessionZones(dispatchedRes.records, sZones) },
            actionable: { records: filterRecordsForSessionZones(actionableRes.records, sZones) },
            preorder: { records: filterRecordsForSessionZones(preorderRes.records, sZones) },
            waitingAssembly: { records: filterRecordsForSessionZones(waitingRes.records, sZones) },
            completed: getSessionRollingCompletedPayload(sZones),
            stats: statsRes || null,
            dispatchers: Array.isArray(dispatchersRes) ? dispatchersRes : [],
            issues: issuesRes || [],
            discoveredZonesList: discoveredZones,
            syncedAt: new Date().toISOString()
          };

          const existingBundle = await firebaseRequest("GET", `session_bundles/${sess.session_id}/rider_search_result`).catch(() => null);
          if (existingBundle) {
            bundlePayload.rider_search_result = existingBundle;
          }

          await firebaseRequest("PUT", `session_bundles/${sess.session_id}`, bundlePayload).catch(() => {});
        })
      );

      await processOrderDetailRequests(opts, validSessions);

      // Background-prewarm 5 riders per cycle (including 0-order zone riders) so User ID & Phone search is instant
      const prewarmSource =
        cachedZoneRosterEntries.length > 0 ? cachedZoneRosterEntries : latestActiveCourierEntries;
      if (prewarmSource.length > 0) {
        const toPrewarm = [];
        for (let i = 0; i < prewarmSource.length && toPrewarm.length < 5; i++) {
          const idx = (bgPrewarmCursor + i) % prewarmSource.length;
          const cand = prewarmSource[idx];
          const k = sanitizeCourierStorageKey(cand.courierId || cand.userId);
          if (k && !courierDetailCache.get(k)?.data?.fetchedFromApi) {
            toPrewarm.push(cand);
          }
        }
        bgPrewarmCursor = (bgPrewarmCursor + 5) % prewarmSource.length;
        if (toPrewarm.length > 0) {
          Promise.all(
            toPrewarm.map(async (cand) => {
              const full = await fetchFullCourierDetails(
                `${cand.courierId || cand.userId}|${cand.courierName}`,
                opts,
                false
              );
              if (full && full.data && full.data.courierId) {
                firebaseRequest("PUT", `courier_details/${sanitizeCourierStorageKey(full.data.courierId)}`, full.data).catch(() => {});
              }
            })
          ).catch(() => {});
        }
      }

      lastSuccessAt = new Date();
      lastErrorMsg = "";
      totalPushCount += 1;
      currentModeLabel = `v${SCRIPT_VERSION} [Primary Leader] Live (2s) • ${validSessions.length} Emp • ${unionZoneIds.length} Zones • #${totalPushCount}`;
      updateBadge(true);
    } catch (err) {
      lastErrorMsg = err?.message || "Sync Error";
      currentModeLabel = `v${SCRIPT_VERSION} Sync Notice: ${lastErrorMsg}`;
      updateBadge(false);
    } finally {
      isSyncing = false;
    }
  }

  // --- FLOATING STATUS BADGE ---
  function createBadge() {
    if (document.getElementById("hurrier-live-sync-badge")) return;
    badgeEl = document.createElement("div");
    badgeEl.id = "hurrier-live-sync-badge";
    badgeEl.style.cssText = [
      "position:fixed",
      "bottom:14px",
      "right:16px",
      "z-index:999999",
      "padding:6px 14px",
      "border-radius:999px",
      "font-family:system-ui,-apple-system,sans-serif",
      "font-size:12px",
      "font-weight:700",
      "color:#ffffff",
      "background:#1e293b",
      "box-shadow:0 4px 14px rgba(0,0,0,0.22)",
      "cursor:pointer",
      "user-select:none",
      "transition:background 0.25s ease"
    ].join(";");
    badgeEl.textContent = `Hurrier Sync v${SCRIPT_VERSION}: Starting...`;
    badgeEl.title = "اضغط للمزامنة الفورية الآن (أو لتثبيت التحديث الجديد إن وجد)";
    badgeEl.addEventListener("click", () => {
      if (remoteAvailableVersion) {
        window.open(GITHUB_SCRIPT_RAW_URL, "_blank");
        return;
      }
      syncCycle();
    });
    document.body.appendChild(badgeEl);
  }

  function updateBadge(isOk) {
    if (!badgeEl) createBadge();
    if (!badgeEl) return;
    const timeStr = lastSuccessAt
      ? lastSuccessAt.toLocaleTimeString("en-GB", { hour12: false })
      : new Date().toLocaleTimeString("en-GB", { hour12: false });

    if (remoteAvailableVersion) {
      badgeEl.style.background = "#2563eb";
      badgeEl.textContent = `⬆ Update v${remoteAvailableVersion} Ready (Click to Update) • ${timeStr}`;
      return;
    }

    if (!isOk) {
      badgeEl.style.background = "#dc2626";
      badgeEl.textContent = `${currentModeLabel} • ${timeStr}`;
    } else if (currentModeLabel.includes("Local Tab Standby")) {
      badgeEl.style.background = "#475569";
      badgeEl.textContent = `${currentModeLabel} • ${timeStr}`;
    } else if (currentModeLabel.includes("Standby Backup") || currentModeLabel.includes("Standby (0 Emp)")) {
      badgeEl.style.background = "#92400e";
      badgeEl.textContent = `${currentModeLabel} • ${timeStr}`;
    } else {
      badgeEl.style.background = "#065f46";
      badgeEl.textContent = `${currentModeLabel} • ${timeStr}`;
    }
  }

  // Fast 700ms poller dedicated to instant Rider Search & Order Detail requests
  function startFastRequestPoller() {
    setInterval(async () => {
      if (isRiderSearchPolling) return;
      if (!ensureLocalTabLeadership()) return;
      const storedAuth = readStoredAdminBridgeAuth();
      if (!storedAuth) return;

      isRiderSearchPolling = true;
      try {
        const opts = getHurrierRequestOptions();
        const sessionsMap = await firebaseRequest("GET", "active_sessions").catch(() => null);
        const now = Date.now();
        const activeList = [];
        if (sessionsMap && typeof sessionsMap === "object") {
          for (const [sid, sData] of Object.entries(sessionsMap)) {
            if (sData && now - Number(sData.heartbeat_at || 0) <= SESSION_STALE_MS) {
              activeList.push({ ...sData, session_id: sid });
            }
          }
        }
        await processOrderDetailRequests(opts, activeList);
      } catch {} finally {
        isRiderSearchPolling = false;
      }
    }, 700);
  }

  function bootstrap() {
    createBadge();
    initLocalTabCoordinator();
    checkGitHubScriptUpdate();
    setInterval(checkGitHubScriptUpdate, 60000);
    syncCycle();
    setInterval(syncCycle, SYNC_INTERVAL_MS);
    startFastRequestPoller();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrap);
  } else {
    bootstrap();
  }
})();
