// ==UserScript==
// @name         Hurrier Live Sync
// @namespace    https://hurrier-live.local/
// @version      9.1
// @description  [v9.1] Selected-Zones-Only Completed At (1h/2h) + Instant Zone-Switch Recalculation
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

  const SCRIPT_VERSION = "9.1";
  const GITHUB_SCRIPT_RAW_URL =
    "https://raw.githubusercontent.com/mahmoudosman-hub/hurrier-live/main/hurrier-tampermonkey.user.js";
  const FIREBASE_DB_URL = "https://hurrier-live-default-rtdb.europe-west1.firebasedatabase.app";
  const BASE_API = "https://eg.me.logisticsbackoffice.com/api";
  const AUTH_BRIDGE_STORAGE_KEY = "hurrier_fb_bridge_auth";
  const ROLLING_COMPLETED_WINDOW_MS = 2 * 3600 * 1000;
  const ROLLING_COMPLETED_GRACE_MS = 15 * 60 * 1000;
  const ROLLING_COMPLETED_SYNC_MS = 10000;

  // 1) Dashboard Host Mode: Bridge Firebase Auth Token to GM Storage ONLY
  const IS_HURRIER_HOST = window.location.hostname === "eg.me.logisticsbackoffice.com";
  if (!IS_HURRIER_HOST) {
    let lastBridgedRaw = "";
    const syncAuthFromDashboard = () => {
      try {
        const raw = window.localStorage.getItem(AUTH_BRIDGE_STORAGE_KEY) || "";
        if (raw && raw !== lastBridgedRaw) {
          lastBridgedRaw = raw;
          GM_setValue(AUTH_BRIDGE_STORAGE_KEY, raw);
        }
      } catch {}
    };
    syncAuthFromDashboard();
    setInterval(syncAuthFromDashboard, 1500);
    return;
  }

  // 2) Hurrier Host Mode: Zone Catalog + Dynamic Cities Sync
  const MANIAL_FAMILY_IDS = [10004, 10162, 10282, 10284, 10214, 10267];

  const ZONE_CATALOG_PAIRS = [
    [1, "Heliopolis"], [2, "Mohandiseen"], [10004, "Manial"], [10004, "Manial sp"],
    [10162, "Manial nesting"], [10282, "Manial nesting p"], [10284, "Manial p"],
    [10214, "Hybrid fleet al manial"], [10267, "Hybrid al-manial bc"],
    [10231, "Hybrid fleet mokattam easy sports"], [10002, "New maadi"], [10003, "Old maadi"],
    [10130, "Maadi nesting sp"], [10020, "Helwan SP"], [10135, "Helwan sp 2"],
    [10009, "Zahraa maadi and meraag"], [10001, "Mokattam sp"], [10143, "Shobra 2 sp"],
    [10064, "Mokkatam asmarat sp"], [10094, "Sheikh zayed 2 sp"], [10251, "Hybrid fleet imbabah"],
    [10179, "Obour golf pt"], [10167, "Mohandiseen nesting p"], [10181, "Haram nesting pt"],
    [10138, "October hosary"], [10012, "Tagammoa 1 sp"], [10089, "Rehab 2 sp"],
    [10253, "Hybrid fleet rehab old"], [10069, "Shorouk city sp 1"], [10090, "Tagamo3 5 south"],
    [10100, "Madinaty 3 sp south park"], [10235, "Ain shams nesting sp"], [10286, "Hybrid fleet ain shams 2"],
    [10180, "Obour hay awal pt"], [10011, "Tagamoa 5 north"], [10074, "Hadayek el ahram sp"],
    [10091, "Mohamed naguib sp"], [10063, "Hadayek el qobba 1 sp"], [10102, "Madinaty 4 sp craft zone"],
    [10182, "Haram pt"], [10129, "Mohandiseen nesting sp"], [10183, "Haram pt 2"],
    [10115, "Ain shams (abdelhamed badawi) 2"], [10024, "Hay 10 and nasr city"], [10127, "Heliopolis nesting sp"],
    [10163, "Tahrir nesting"], [10160, "Rock vera"], [10166, "Mohandiseen p"],
    [10128, "Naser city nesting sp"], [10033, "Hegaz"], [10125, "Haram nesting sp"],
    [10000, "Nasr city sp"], [10165, "Madienty central park ebikes"], [10006, "Merryland"],
    [10139, "Haram sp 2"], [10022, "Tahrir"], [10005, "Sheraton"],
    [10045, "Shobra sp"], [10013, "Rehab 1 sp"], [10096, "Palm hills sp"],
    [10150, "Golden square"], [10047, "October hosary 2"], [10018, "Haram sp"],
    [10099, "Madinaty 2 sp central park"], [10067, "Obour hay awal sp"], [10092, "Hadayek el qobba 2 sp"],
    [10164, "Shobra nesting"], [10101, "Shorouk city sp 2"], [10126, "October nesting"],
    [10010, "Auc sp"], [10070, "Madinaty 1 sp air mall & arabesque"], [10141, "Wahat fardous sp"],
    [10113, "Ains shams (ahmed essmat) 1"], [10159, "Obour golf sp"], [10131, "Sheraton nesting sp"],
    [10161, "Zahraa maadi nesting"], [10151, "Wahat sp 2"], [10032, "Sheikh zayed 1 sp"],
    [10104, "Abasseya sp"], [10217, "Hybrid fleet mokattam mafarik"], [10193, "Hybrid fleet el zaitoun"],
    [10186, "Hybrid fleet ard el golf"], [10216, "Hybrid fleet sheraton"], [10229, "Hybrid fleet heliopolis rabwa"],
    [10266, "Hybrid ard el golf bc"], [10268, "Hybrid el hadeeqa el dawlia bc"], [10223, "Hybrid fleet shorouk 1st area"],
    [10234, "Hybrid fleet wahat beta gardens"], [10209, "Hybrid fleet tagmmoa hay 1"], [10207, "Obour industrial area hybrid fleet"],
    [10248, "Hybrid fleet sheikh zayed hay 4"], [10249, "Hybrid fleet west somed"], [10219, "Hybrid fleet ain shams"],
    [10261, "Hybrid fleet - mountain view park wahat"], [10226, "Hybrid fleet sheikh zayed hay 9"], [10189, "Hybrid fleet el sayeda"],
    [10029, "Beverly hills sp"], [10238, "Hybrid fleet el daher"], [10230, "Hybrid fleet nasrcity hay 8"],
    [10142, "Palm hills 2 sp"], [10195, "Hybrid fleet lebanon square"], [10222, "Hybrid fleet shobra"],
    [10185, "Hybrid fleet banafseg"], [10275, "Hybrid fleet toya mall"], [10174, "Hybrid fleet maadi"],
    [10184, "Hybrid fleet zayed"], [10212, "Hybrid fleet palm hills 1"], [10232, "Hybrid fleet maadi old"],
    [10136, "Motamyez sp"], [10218, "Hybrid fleet el hadeeka el dawlya"], [10196, "Hybrid fleet tayaran"],
    [10224, "Hybrid fleet tagmmoa auc"], [10225, "Hybrid fleet golden lotus"], [10188, "Hybrid fleet rock vera"],
    [10173, "Hybrid fleet rehab"], [10208, "Hybrid fleet banks center"], [10191, "Hybrid fleet october 4th"],
    [10210, "Hybrid fleet hadayek el ahram"], [10211, "Hybrid fleet maryoteya"], [10264, "Hybrid lebanon bc"],
    [10252, "Hybrid fleet mohafzet el giza"], [10256, "Hybrid fleet mosaddak"], [10262, "Hybrid fleet hadayek el ahram - area d"],
    [10227, "Hybrid fleet mokattam nafora"], [10241, "Hybrid fleet helwan"], [10215, "Hybrid fleet maadi meraag"],
    [10194, "Hybrid fleet october 6th"], [10237, "Hybrid fleet agouza"], [10114, "Ain shams (zatoun) 3"],
    [10198, "Hybrid fleet taqa"], [10221, "Hybrid fleet palm hills 360"], [10228, "Hybrid fleet maadi laselky"],
    [10250, "Hybrid fleet el nadi el gedid"], [10233, "Hybrid fleet shorouk 8th district"], [10177, "Hybrid fleet obour"],
    [10213, "Hybrid fleet el montazah"], [10265, "Hybrid taqseem laselky bc"], [10220, "Hybrid fleet october wahet el mohandseen"],
    [10260, "Obour golf hybrid fleet"], [10197, "Hybrid fleet tersa"], [10190, "Hybrid fleet talbya"],
    [10271, "Hybrid wahet el mohandsen bc"], [10269, "Hybrid maadi old bc"], [10192, "Shobra nesting 2"],
    [10273, "Hybrid fleet gardenia"], [10270, "Hybrid shobra bc"], [10277, "Hybrid el sayeda zeinab bc"],
    [10068, "Smart village dandy mall sp 1"], [10278, "Hybrid talbyia bc"], [10272, "Hybrid mohafzet el giza bc"],
    [10276, "Hybrid agouza bc"], [10281, "Hybrid fleet shorouk 4"], [10187, "Hybrid fleet shorouk 3rd"],
    [10025, "Sidi bishr sp"], [10027, "Gleem sp"], [10028, "Raml station sp"],
    [10079, "Al bitash sp"], [10085, "Semouha club sp"], [10144, "Kilo 21 sp"]
  ];

  const ZONE_NAME_TO_ID = new Map();
  ZONE_CATALOG_PAIRS.forEach(([id, name]) => {
    ZONE_NAME_TO_ID.set(String(name).trim().toLowerCase(), Number(id));
  });

  // Core Runtime State (Single Clean Declarations)
  const TAB_INSTANCE_ID = `tab_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const LOCAL_TAB_LOCK_KEY = "hurrier_live_sync_local_tab_lock";
  const LOCAL_TAB_LOCK_TTL_MS = 12000;
  const FEEDER_LOCK_TTL_MS = 15000;
  let remoteAvailableVersion = "";
  let citiesSyncedOnce = false;
  let isSyncInProgress = false;
  let ownsLocalTabLock = false;
  let isCurrentPrimaryLeader = false;

  // Active Deliveries & Transition State
  const cachedActiveById = new Map();
  let lastFullActiveSweepAt = 0;
  let lastKnownActivePages = 10;
  let prevWatchedPipelineOrders = new Map();

  // On-Demand Modal / Search State
  let lastOrderDetailReqAt = Date.now() - 10000;
  let lastCourierDetailReqAt = Date.now() - 10000;
  let lastRiderSearchReqId = "";

  // Selected-Zones Rolling 2h Completed State
  const rollingCompletedPool = new Map();
  const exactCompletedMetaCache = new Map();
  const lastKnownCompletedPage = {};
  const backfilledZoneIds = new Set();
  let currentSyncZoneSig = "";
  let completedSyncGeneration = 0;
  let isCompletedSyncInProgress = false;
  let lastRollingCompletedSyncAt = 0;
  let yesterdayCompletedBackfilledForSig = "";

  function getBridgedLeaderEmail() {
    try {
      const raw = GM_getValue(AUTH_BRIDGE_STORAGE_KEY, "");
      const parsed = raw ? JSON.parse(raw) : null;
      return String(parsed?.email || "").trim();
    } catch {
      return "";
    }
  }

  function acquireSamePcTabLock() {
    try {
      const now = Date.now();
      const raw = window.localStorage.getItem(LOCAL_TAB_LOCK_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      if (
        parsed &&
        parsed.tabId &&
        parsed.tabId !== TAB_INSTANCE_ID &&
        now - (parsed.ts || 0) < LOCAL_TAB_LOCK_TTL_MS
      ) {
        ownsLocalTabLock = false;
        isCurrentPrimaryLeader = false;
        return false;
      }
      window.localStorage.setItem(
        LOCAL_TAB_LOCK_KEY,
        JSON.stringify({ tabId: TAB_INSTANCE_ID, ts: now })
      );
      ownsLocalTabLock = true;
      return true;
    } catch {
      ownsLocalTabLock = true;
      return true;
    }
  }

  // Independent heartbeat so long (>6s) sync cycles NEVER lose local tab lock or /feeder_lock
  setInterval(() => {
    const now = Date.now();
    if (ownsLocalTabLock) {
      try {
        const raw = window.localStorage.getItem(LOCAL_TAB_LOCK_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        if (!parsed || parsed.tabId === TAB_INSTANCE_ID) {
          window.localStorage.setItem(
            LOCAL_TAB_LOCK_KEY,
            JSON.stringify({ tabId: TAB_INSTANCE_ID, ts: now })
          );
        }
      } catch {}
    }
    if (ownsLocalTabLock && isCurrentPrimaryLeader) {
      fbDb("PUT", "/feeder_lock", {
        leaderId: TAB_INSTANCE_ID,
        leaderEmail: getBridgedLeaderEmail(),
        version: SCRIPT_VERSION,
        ts: now
      }).catch(() => {});
    }
  }, 2500);

  window.addEventListener("beforeunload", () => {
    ownsLocalTabLock = false;
    isCurrentPrimaryLeader = false;
    try {
      const raw = window.localStorage.getItem(LOCAL_TAB_LOCK_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed && parsed.tabId === TAB_INSTANCE_ID) {
        window.localStorage.removeItem(LOCAL_TAB_LOCK_KEY);
      }
    } catch {}
  });

  // Floating Status Badge (Guaranteed Mount)
  const badge = document.createElement("div");
  Object.assign(badge.style, {
    position: "fixed",
    bottom: "14px",
    right: "14px",
    zIndex: "2147483647",
    padding: "7px 14px",
    borderRadius: "9999px",
    background: "#334155",
    color: "#ffffff",
    fontFamily: "system-ui, -apple-system, sans-serif",
    fontSize: "12px",
    fontWeight: "700",
    boxShadow: "0 4px 14px rgba(0,0,0,0.25)",
    cursor: "pointer",
    userSelect: "none",
    transition: "background 0.2s ease"
  });
  badge.textContent = `v${SCRIPT_VERSION} Initializing...`;
  badge.addEventListener("click", () => {
    if (remoteAvailableVersion) {
      window.open(GITHUB_SCRIPT_RAW_URL, "_blank");
    }
  });

  function ensureBadgeMounted() {
    if (document.body && !document.body.contains(badge)) {
      document.body.appendChild(badge);
    }
  }
  ensureBadgeMounted();

  function setBadge(bg, text) {
    ensureBadgeMounted();
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

  async function syncCitiesZoneMapOnce() {
    if (citiesSyncedOnce) return;
    try {
      const data = await hurrierGet("/dispatcher-dashboard/cities");
      if (Array.isArray(data?.cities)) {
        const dynamicCatalog = [];
        data.cities.forEach((city) => {
          const cityName = String(city?.name || "Cairo").trim();
          (city.zones || []).forEach((z) => {
            if (z && z.id && z.name) {
              const cleanName = String(z.name).trim().toLowerCase();
              const noSp = cleanName.replace(/\s+sp$/i, "").trim();
              ZONE_NAME_TO_ID.set(cleanName, Number(z.id));
              ZONE_NAME_TO_ID.set(`${cleanName} sp`, Number(z.id));
              if (noSp) ZONE_NAME_TO_ID.set(noSp, Number(z.id));
              if (cityName === "Cairo" || cityName === "Alexandria") {
                dynamicCatalog.push({ id: Number(z.id), name: String(z.name).trim(), city: cityName });
              }
            }
          });
        });
        citiesSyncedOnce = true;
        if (dynamicCatalog.length > 0) {
          fbDb("PUT", "/config/dynamic_zones_catalog", dynamicCatalog).catch(() => {});
        }
      }
    } catch {}
  }
  function extractRecordStartingPointsMeta(rec) {
    const ids = new Set();
    const names = [];
    const collect = (arr) => {
      if (!Array.isArray(arr)) return;
      arr.forEach((sp) => {
        if (!sp) return;
        if (typeof sp === "string") {
          const key = sp.trim().toLowerCase();
          if (key) names.push(key);
          const noSp = key.replace(/\s+sp$/i, "").trim();
          const mappedId = ZONE_NAME_TO_ID.get(key) || ZONE_NAME_TO_ID.get(`${key} sp`) || ZONE_NAME_TO_ID.get(noSp);
          if (mappedId) ids.add(mappedId);
        } else if (typeof sp === "object") {
          if (sp.id) ids.add(Number(sp.id));
          if (sp.name) {
            const key = String(sp.name).trim().toLowerCase();
            if (key) names.push(key);
            const noSp = key.replace(/\s+sp$/i, "").trim();
            const mappedId = ZONE_NAME_TO_ID.get(key) || ZONE_NAME_TO_ID.get(`${key} sp`) || ZONE_NAME_TO_ID.get(noSp);
            if (mappedId) ids.add(mappedId);
          }
        }
      });
    };
    collect(rec?.starting_points);
    collect(rec?.order?.drop_off_address?.starting_points);
    collect(rec?.order?.dropoff_address?.starting_points);
    return { ids, names };
  }

  function doesRecordMatchSessionZones(rec, targetSet, hasManialSelected, hasTahrirSelected) {
    if (!targetSet || targetSet.size === 0) return true;
    const { ids, names } = extractRecordStartingPointsMeta(rec);
    for (const id of ids) {
      if (targetSet.has(id)) return true;
    }
    if (hasManialSelected && names.some((n) => n.includes("manial"))) {
      return true;
    }
    if (hasTahrirSelected && names.some((n) => n.startsWith("tahrir"))) {
      return true;
    }
    return false;
  }

  // Multi-page fetcher for Queued / Dispatched / Preorder / Actionable / WaitForAssembled (Scans ALL pages until < 50)
  async function fetchPaginatedDeliveries(path, maxPages = 35) {
    const all = [];
    try {
      const p1 = await hurrierGet(`${path}?page=1&per_page=50`);
      const r1 = Array.isArray(p1?.records) ? p1.records : [];
      all.push(...r1);
      if (r1.length < 50 || maxPages <= 1) return all;

      let reachedEnd = false;
      for (let startPg = 2; startPg <= maxPages && !reachedEnd; startPg += 5) {
        const batch = [];
        for (let pg = startPg; pg < startPg + 5 && pg <= maxPages; pg++) batch.push(pg);
        const settled = await Promise.allSettled(
          batch.map((pg) => hurrierGet(`${path}?page=${pg}&per_page=50`))
        );
        for (const s of settled) {
          if (s.status === "fulfilled" && Array.isArray(s.value?.records)) {
            all.push(...s.value.records);
            if (s.value.records.length < 50) reachedEnd = true;
          }
        }
      }
    } catch {}
    return all;
  }

  // 100% Complete Multi-Page Active Deliveries Sync (No 40-page cap: scans until true end page + 2s live tail delta)
  async function syncActiveDeliveries() {
    const now = Date.now();
    const SAFETY_MAX_PAGES = 250;
    const needFullSweep = cachedActiveById.size === 0 || now - lastFullActiveSweepAt >= 10000;

    if (needFullSweep) {
      lastFullActiveSweepAt = now;
      const freshMap = new Map();
      let reachedEnd = false;
      let highestNonEmptyPage = 1;
      let hadUnrecoveredError = false;

      for (let batchStart = 1; batchStart <= SAFETY_MAX_PAGES && !reachedEnd; batchStart += 8) {
        const batchPages = [];
        for (let p = batchStart; p < batchStart + 8 && p <= SAFETY_MAX_PAGES; p++) {
          batchPages.push(p);
        }
        const results = await Promise.allSettled(
          batchPages.map((pg) => hurrierGet(`/dispatcher-dashboard/deliveries/active?page=${pg}&per_page=50`))
        );

        for (let idx = 0; idx < results.length; idx++) {
          const pg = batchPages[idx];
          let recs = null;
          if (results[idx].status === "fulfilled") {
            recs = Array.isArray(results[idx].value?.records) ? results[idx].value.records : [];
          } else {
            try {
              const retryData = await hurrierGet(`/dispatcher-dashboard/deliveries/active?page=${pg}&per_page=50`);
              recs = Array.isArray(retryData?.records) ? retryData.records : [];
            } catch {
              hadUnrecoveredError = true;
            }
          }

          if (Array.isArray(recs)) {
            if (recs.length > 0) {
              highestNonEmptyPage = Math.max(highestNonEmptyPage, pg);
              recs.forEach((r) => {
                const key = String(r.id || r.order?.id || r.order?.code || "");
                if (key) freshMap.set(key, r);
              });
            }
            if (recs.length < 50) {
              reachedEnd = true;
            }
          }
        }
      }

      if (freshMap.size > 0) {
        if (!hadUnrecoveredError) {
          cachedActiveById.clear();
        }
        freshMap.forEach((v, k) => cachedActiveById.set(k, v));
        lastKnownActivePages = highestNonEmptyPage;
      }
    } else {
      // Fast 2s update of newest tail pages so brand-new active orders appear immediately
      const startTail = Math.max(1, lastKnownActivePages - 4);
      const endTail = lastKnownActivePages + 3;
      const tailPages = [];
      for (let p = startTail; p <= endTail; p++) tailPages.push(p);

      const results = await Promise.allSettled(
        tailPages.map((pg) => hurrierGet(`/dispatcher-dashboard/deliveries/active?page=${pg}&per_page=50`))
      );
      results.forEach((res, idx) => {
        if (res.status === "fulfilled") {
          const recs = Array.isArray(res.value?.records) ? res.value.records : [];
          if (recs.length > 0) {
            lastKnownActivePages = Math.max(lastKnownActivePages, tailPages[idx]);
            recs.forEach((r) => {
              const key = String(r.id || r.order?.id || r.order?.code || "");
              if (key) cachedActiveById.set(key, r);
            });
          }
        }
      });
    }

    return Array.from(cachedActiveById.values());
  }

  function parseValidTimestampMs(val) {
    if (!val) return 0;
    const ms = typeof val === "number" ? (val > 1e12 ? val : val * 1000) : new Date(val).getTime();
    return !Number.isNaN(ms) && ms > 946684800000 ? ms : 0;
  }

  function getCairoDateStringsForCompleted() {
    const now = new Date();
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Africa/Cairo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hour12: false
    });
    const parts = fmt.formatToParts(now);
    const getP = (t) => parts.find((p) => p.type === t)?.value || "";
    const todayStr = `${getP("year")}-${getP("month")}-${getP("day")}`;
    const cairoHour = Number(getP("hour") || 0) % 24;

    const yest = new Date(now.getTime() - 24 * 3600 * 1000);
    const yParts = fmt.formatToParts(yest);
    const getYP = (t) => yParts.find((p) => p.type === t)?.value || "";
    const yesterdayStr = `${getYP("year")}-${getYP("month")}-${getYP("day")}`;

    return { todayStr, yesterdayStr, cairoHour };
  }

  // Exact Completed At Resolver for Selected Zones ONLY (Cached once per order)
  async function resolveExactCompletedMetaForOrders(candidates) {
    if (!Array.isArray(candidates) || candidates.length === 0) return;

    for (let i = 0; i < candidates.length; i += 6) {
      const batch = candidates.slice(i, i + 6);
      await Promise.allSettled(
        batch.map(async ({ orderKey, orderCode }) => {
          if (exactCompletedMetaCache.has(orderKey)) return;
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              const detailData = await hurrierGet(
                `/dispatcher-dashboard/orders/detail?code=${encodeURIComponent(orderKey)}`
              );
              const dOrder = detailData?.order || detailData || {};
              const stLower = String(dOrder.status || "").toLowerCase();
              if (stLower.includes("cancel")) {
                exactCompletedMetaCache.set(orderKey, {
                  completedAtMs: 0,
                  cancelled: true,
                  cachedAt: Date.now()
                });
                return;
              }

              let exactMs =
                parseValidTimestampMs(dOrder.current_state_transition) ||
                parseValidTimestampMs(dOrder.event_timestamp) ||
                parseValidTimestampMs(dOrder.completed_at) ||
                parseValidTimestampMs(dOrder.delivered_at);

              if (!exactMs) {
                try {
                  const delivData = await hurrierGet(
                    `/dispatcher-dashboard/orders/detail/deliveries?code=${encodeURIComponent(orderCode)}`
                  );
                  const deliveries = Array.isArray(delivData?.deliveries) ? delivData.deliveries : [];
                  for (const del of deliveries) {
                    const transitions = Array.isArray(del?.transitions) ? del.transitions : [];
                    for (let t = transitions.length - 1; t >= 0; t--) {
                      const tr = transitions[t];
                      if (String(tr?.to_state || "").toLowerCase() === "completed") {
                        exactMs =
                          parseValidTimestampMs(tr?.metadata?.performed_at) ||
                          parseValidTimestampMs(tr?.created_at);
                        if (exactMs) break;
                      }
                    }
                    if (exactMs) break;
                  }
                } catch {}
              }

              if (exactMs > 0) {
                exactCompletedMetaCache.set(orderKey, {
                  completedAtMs: exactMs,
                  cancelled: false,
                  cachedAt: Date.now()
                });
                return;
              }
            } catch {
              if (attempt === 0) await new Promise((r) => setTimeout(r, 250));
            }
          }
        })
      );
    }
  }

  // Filter ONLY Selected Zones' Orders & Keep Strictly Last 2h by Completed At
  async function ingestCompletedRecordsBatch(records, unionZoneSet, hasManialUnion, hasTahrirUnion) {
    if (!Array.isArray(records) || records.length === 0) return 0;

    const candidates = [];
    for (const rec of records) {
      const order = rec?.order || {};
      const stLower = String(order.status || rec?.status || "").toLowerCase();
      if (stLower.includes("cancel")) continue;
      if (!doesRecordMatchSessionZones(rec, unionZoneSet, hasManialUnion, hasTahrirUnion)) continue;

      const orderKey = String(
        order.confirmation_number ||
          order.code ||
          String(order.order_code || "").replace(/^(HF_[A-Z]{2}|ODR_[A-Z]{2})/i, "") ||
          order.id ||
          ""
      ).trim();
      if (!orderKey) continue;
      const orderCode = String(order.order_code || `HF_EG${orderKey}`).trim();
      candidates.push({ orderKey, orderCode, rec });
    }

    if (candidates.length === 0) return 0;

    const uncached = candidates.filter((c) => !exactCompletedMetaCache.has(c.orderKey));
    if (uncached.length > 0) {
      await resolveExactCompletedMetaForOrders(uncached);
    }

    const cutoffMs = Date.now() - ROLLING_COMPLETED_WINDOW_MS - ROLLING_COMPLETED_GRACE_MS;
    let addedInWindow = 0;

    for (const { orderKey, rec } of candidates) {
      const meta = exactCompletedMetaCache.get(orderKey);
      if (meta?.cancelled) {
        rollingCompletedPool.delete(orderKey);
        continue;
      }
      const order = rec?.order || {};
      const fallbackMs =
        parseValidTimestampMs(order.scheduled_dropoff_at) || parseValidTimestampMs(order.placed_at);
      const completedAtMs = meta?.completedAtMs || fallbackMs;

      if (completedAtMs >= cutoffMs) {
        rollingCompletedPool.set(orderKey, {
          ...rec,
          __completed_at_ms: completedAtMs
        });
        addedInWindow++;
      }
    }
    return addedInWindow;
  }

  async function safeFetchCompletedPage(dateStr, page) {
    const url = `${BASE_API}/dispatcher-dashboard/orders/completed?date=${encodeURIComponent(dateStr)}&page=${page}&per_page=50`;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(url, {
          method: "GET",
          credentials: "include",
          headers: getHurrierAuthHeaders()
        });
        if (res.status === 400 || res.status === 404) {
          return { ok: true, records: [] };
        }
        if (res.status === 429 || res.status >= 500) {
          await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
          continue;
        }
        if (!res.ok) return { ok: false, records: null };
        const data = await res.json();
        return { ok: true, records: Array.isArray(data?.records) ? data.records : [] };
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    return { ok: false, records: null };
  }

  async function discoverLastCompletedPage(dateStr) {
    let low = 1;
    let high = Math.max(1, lastKnownCompletedPage[dateStr] || 16);
    let lastNonEmptyRecords = [];

    const startRes = await safeFetchCompletedPage(dateStr, high);
    if (!startRes.ok) {
      return { ok: false, lastPage: lastKnownCompletedPage[dateStr] || 0, tailRecords: [] };
    }

    const startRecs = startRes.records || [];
    if (startRecs.length === 0) {
      high = Math.max(1, high - 1);
      if (high === 1) {
        const p1 = await safeFetchCompletedPage(dateStr, 1);
        const r1 = p1.ok && Array.isArray(p1.records) ? p1.records : [];
        if (r1.length > 0) lastKnownCompletedPage[dateStr] = 1;
        return { ok: p1.ok, lastPage: r1.length > 0 ? 1 : 0, tailRecords: r1 };
      }
    } else {
      low = high;
      lastNonEmptyRecords = startRecs;
      if (startRecs.length < 50) {
        lastKnownCompletedPage[dateStr] = high;
        return { ok: true, lastPage: high, tailRecords: startRecs };
      }
      let step = 16;
      while (high < 50000) {
        const nextProbe = Math.min(50000, high + step);
        const pRes = await safeFetchCompletedPage(dateStr, nextProbe);
        if (!pRes.ok) break;
        const pRecs = pRes.records || [];
        if (pRecs.length > 0) {
          low = nextProbe;
          lastNonEmptyRecords = pRecs;
          if (pRecs.length < 50) {
            lastKnownCompletedPage[dateStr] = nextProbe;
            return { ok: true, lastPage: nextProbe, tailRecords: pRecs };
          }
          high = nextProbe;
          step = Math.min(2048, step * 2);
        } else {
          high = nextProbe - 1;
          break;
        }
      }
    }

    let best = low;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const mRes = await safeFetchCompletedPage(dateStr, mid);
      if (!mRes.ok) break;
      const mRecs = mRes.records || [];
      if (mRecs.length > 0) {
        best = mid;
        lastNonEmptyRecords = mRecs;
        if (mRecs.length < 50) break;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    if (best >= 1) lastKnownCompletedPage[dateStr] = best;
    return { ok: true, lastPage: Math.max(1, best), tailRecords: lastNonEmptyRecords };
  }

  // Instant Capture when an Order in Selected Zones moves from Active/Dispatched -> Completed
  async function captureRecentlyCompletedFromPipeline(
    activeRecords,
    dispatchedRecords,
    queuedRecords,
    unionZoneIds
  ) {
    if (!unionZoneIds || unionZoneIds.size === 0) {
      prevWatchedPipelineOrders.clear();
      return;
    }

    const hasManial = MANIAL_FAMILY_IDS.some((id) => unionZoneIds.has(id));
    const hasTahrir = unionZoneIds.has(10022) || unionZoneIds.has(10163);

    const currentCodesInPipeline = new Set();
    const recordCodeOf = (r) =>
      String(
        r?.order?.code ||
          r?.order?.confirmation_number ||
          String(r?.order?.order_code || "").replace(/^(HF_[A-Z]{2}|ODR_[A-Z]{2})/i, "") ||
          ""
      ).trim();

    [...activeRecords, ...dispatchedRecords, ...queuedRecords].forEach((r) => {
      const c = recordCodeOf(r);
      if (c) currentCodesInPipeline.add(c);
    });

    const nextWatchedMap = new Map();
    [...activeRecords, ...dispatchedRecords].forEach((r) => {
      if (doesRecordMatchSessionZones(r, unionZoneIds, hasManial, hasTahrir)) {
        const c = recordCodeOf(r);
        if (c) nextWatchedMap.set(c, r);
      }
    });

    const disappeared = [];
    for (const [code, prevRec] of prevWatchedPipelineOrders.entries()) {
      if (!currentCodesInPipeline.has(code) && !rollingCompletedPool.has(code)) {
        disappeared.push({ code, prevRec });
      }
    }
    prevWatchedPipelineOrders = nextWatchedMap;

    if (disappeared.length === 0) return;

    const cutoffMs = Date.now() - ROLLING_COMPLETED_WINDOW_MS - ROLLING_COMPLETED_GRACE_MS;
    await Promise.allSettled(
      disappeared.slice(0, 8).map(async ({ code, prevRec }) => {
        try {
          const detailData = await hurrierGet(
            `/dispatcher-dashboard/orders/detail?code=${encodeURIComponent(code)}`
          );
          const dOrder = detailData?.order || detailData || {};
          const stLower = String(dOrder.status || "").toLowerCase();
          if (stLower !== "completed") return;

          const exactMs =
            parseValidTimestampMs(dOrder.current_state_transition) ||
            parseValidTimestampMs(dOrder.event_timestamp) ||
            Date.now();
          if (exactMs < cutoffMs) return;

          exactCompletedMetaCache.set(code, {
            completedAtMs: exactMs,
            cancelled: false,
            cachedAt: Date.now()
          });

          if (rollingCompletedPool.has(code)) return;

          const placedIso = dOrder.placed_at || prevRec?.order?.send_to_restaurant_at || "";
          const placedMs = parseValidTimestampMs(placedIso);
          const sps = Array.isArray(prevRec?.starting_points) ? prevRec.starting_points : [];

          rollingCompletedPool.set(code, {
            __completed_at_ms: exactMs,
            starting_points: sps,
            order: {
              id: dOrder.order_id || prevRec?.order?.id || code,
              order_code: dOrder.order_code || prevRec?.order?.order_code || `HF_EG${code}`,
              confirmation_number: code,
              vendor_name:
                dOrder.vendor?.vendor_name ||
                dOrder.restaurant_name ||
                prevRec?.order?.vendor_name ||
                "-",
              vendor_code: dOrder.vendor?.vendor_code || "",
              vendor_order_number:
                dOrder.vendor?.vendor_order_number || prevRec?.order?.vendor_order_number || "-",
              placed_at: placedIso,
              total: dOrder.order_value ?? prevRec?.order?.order_value ?? 0,
              status: "completed",
              is_preorder: Boolean(dOrder.is_pre_order || prevRec?.order?.is_pre_order),
              deliveries_dropoff_issues: "",
              drop_off_address: {
                city: dOrder.drop_off_address?.city_name || "Cairo",
                starting_points: sps
              }
            },
            primary_delivery: {
              courier_name: prevRec?.courier_name || "-",
              courier_id: prevRec?.courier_id || "",
              delivery_distance: prevRec?.distance || 0
            },
            primary_delivery_timings: {
              total_time:
                placedMs > 0 && exactMs >= placedMs ? Math.round((exactMs - placedMs) / 1000) : null
            }
          });
        } catch {}
      })
    );
  }

  // Selected-Zones-Only Completed Pool Sync (Recalculates Immediately When Zones Change)
  async function syncRollingCompletedOrdersPool(activeSessions) {
    const now = Date.now();
    const unionZoneIds = new Set();
    (Array.isArray(activeSessions) ? activeSessions : []).forEach((s) => {
      (Array.isArray(s?.zoneIds) ? s.zoneIds : []).forEach((id) => unionZoneIds.add(Number(id)));
    });

    if (unionZoneIds.size === 0) {
      rollingCompletedPool.clear();
      backfilledZoneIds.clear();
      return;
    }

    const hasManialUnion = MANIAL_FAMILY_IDS.some((id) => unionZoneIds.has(id));
    const hasTahrirUnion = unionZoneIds.has(10022) || unionZoneIds.has(10163);
    const pruneCutoff = now - ROLLING_COMPLETED_WINDOW_MS - ROLLING_COMPLETED_GRACE_MS;

    // Prune anything older than 2h OR belonging to deselected zones immediately
    for (const [k, rec] of rollingCompletedPool.entries()) {
      if (
        (rec.__completed_at_ms || 0) < pruneCutoff ||
        !doesRecordMatchSessionZones(rec, unionZoneIds, hasManialUnion, hasTahrirUnion)
      ) {
        rollingCompletedPool.delete(k);
      }
    }
    for (const oldZid of Array.from(backfilledZoneIds)) {
      if (!unionZoneIds.has(oldZid)) {
        backfilledZoneIds.delete(oldZid);
      }
    }

    const zoneSig = Array.from(unionZoneIds).sort((a, b) => a - b).join(",");
    const hasNewZonesToCalculate = Array.from(unionZoneIds).some((id) => !backfilledZoneIds.has(id));

    // If user changed zones while an old scan was running, abort old scan & start new zones immediately
    if (isCompletedSyncInProgress) {
      if (hasNewZonesToCalculate && currentSyncZoneSig !== zoneSig) {
        completedSyncGeneration++;
      } else {
        return;
      }
    }

    if (!hasNewZonesToCalculate && now - lastRollingCompletedSyncAt < ROLLING_COMPLETED_SYNC_MS) {
      return;
    }

    const myGen = ++completedSyncGeneration;
    currentSyncZoneSig = zoneSig;
    isCompletedSyncInProgress = true;
    lastRollingCompletedSyncAt = now;

    try {
      const { todayStr, yesterdayStr, cairoHour } = getCairoDateStringsForCompleted();
      const placedCutoffMs = now - 2.75 * 3600 * 1000;

      const scanSelectedZonesForDate = async (dateStr, maxPagesToWalk) => {
        const disc = await discoverLastCompletedPage(dateStr);
        if (myGen !== completedSyncGeneration) return false;
        if (!disc.ok || disc.lastPage <= 0) return false;

        if (disc.tailRecords.length > 0) {
          await ingestCompletedRecordsBatch(
            disc.tailRecords,
            unionZoneIds,
            hasManialUnion,
            hasTahrirUnion
          );
        }

        let curPage = disc.lastPage - 1;
        let walked = 1;
        while (curPage >= 1 && walked < maxPagesToWalk && myGen === completedSyncGeneration) {
          const batchPages = [];
          for (
            let p = curPage;
            p >= 1 && batchPages.length < 5 && walked < maxPagesToWalk;
            p--, walked++
          ) {
            batchPages.push(p);
            curPage = p - 1;
          }
          const pageResults = await Promise.all(
            batchPages.map((pg) => safeFetchCompletedPage(dateStr, pg))
          );
          if (myGen !== completedSyncGeneration) return false;

          let reachedOlderThanWindow = false;
          for (const pRes of pageResults) {
            if (pRes.ok && Array.isArray(pRes.records) && pRes.records.length > 0) {
              await ingestCompletedRecordsBatch(
                pRes.records,
                unionZoneIds,
                hasManialUnion,
                hasTahrirUnion
              );
              const newestPlacedMs = parseValidTimestampMs(
                pRes.records[pRes.records.length - 1]?.order?.placed_at
              );
              if (newestPlacedMs > 0 && newestPlacedMs < placedCutoffMs) {
                reachedOlderThanWindow = true;
              }
            }
          }
          if (reachedOlderThanWindow) break;
        }
        return true;
      };

      const okToday = await scanSelectedZonesForDate(todayStr, hasNewZonesToCalculate ? 900 : 6);

      if (
        myGen === completedSyncGeneration &&
        cairoHour < 3 &&
        (hasNewZonesToCalculate || yesterdayCompletedBackfilledForSig !== `${yesterdayStr}|${zoneSig}`)
      ) {
        const okYest = await scanSelectedZonesForDate(yesterdayStr, 300);
        if (okYest && myGen === completedSyncGeneration) {
          yesterdayCompletedBackfilledForSig = `${yesterdayStr}|${zoneSig}`;
        }
      }

      if (okToday && myGen === completedSyncGeneration) {
        unionZoneIds.forEach((id) => backfilledZoneIds.add(id));
      }
    } finally {
      if (myGen === completedSyncGeneration) {
        isCompletedSyncInProgress = false;
      }
    }
  }

  function getSessionRollingCompletedPayload(zoneIds) {
    const targetSet = new Set((Array.isArray(zoneIds) ? zoneIds : []).map(Number));
    const hasManialSelected = MANIAL_FAMILY_IDS.some((id) => targetSet.has(id));
    const hasTahrirSelected = targetSet.has(10022) || targetSet.has(10163);
    const cutoffMs = Date.now() - ROLLING_COMPLETED_WINDOW_MS - ROLLING_COMPLETED_GRACE_MS;

    return Array.from(rollingCompletedPool.values())
      .filter(
        (rec) =>
          (rec.__completed_at_ms || 0) >= cutoffMs &&
          doesRecordMatchSessionZones(rec, targetSet, hasManialSelected, hasTahrirSelected)
      )
      .sort((a, b) => (b.__completed_at_ms || 0) - (a.__completed_at_ms || 0));
  }

  function unwrapCourierObj(raw) {
    let cur = raw;
    let guard = 0;
    while (
      cur &&
      typeof cur === "object" &&
      !Array.isArray(cur) &&
      (cur.courier || cur.data) &&
      typeof (cur.courier || cur.data) === "object" &&
      guard < 4
    ) {
      cur = cur.courier || cur.data;
      guard++;
    }
    return cur && typeof cur === "object" ? cur : null;
  }

  function extractNormalizedCourierSummary(raw) {
    const c = unwrapCourierObj(raw) || {};
    let tnwSub = null;
    const subKeys = [
      "temp_not_working",
      "temporary_not_working",
      "temp_break",
      "temporary_break",
      "not_working",
      "not_working_status",
      "break_info",
      "current_break",
      "status_info",
      "state_info",
      "availability"
    ];
    for (const k of subKeys) {
      if (c[k] && typeof c[k] === "object" && !Array.isArray(c[k])) {
        tnwSub = c[k];
        break;
      }
    }
    if (!tnwSub && c.current_shift && typeof c.current_shift === "object") {
      for (const k of subKeys) {
        if (c.current_shift[k] && typeof c.current_shift[k] === "object") {
          tnwSub = c.current_shift[k];
          break;
        }
      }
    }

    const statusObj =
      typeof c.status === "object" && c.status !== null
        ? c.status
        : typeof c.state === "object" && c.state !== null
        ? c.state
        : null;

    const statusUntil = String(
      tnwSub?.until ||
        tnwSub?.end_at ||
        tnwSub?.ends_at ||
        tnwSub?.end_time ||
        tnwSub?.expires_at ||
        c.temp_not_working_until ||
        c.temporary_not_working_until ||
        c.not_working_until ||
        c.status_until ||
        c.state_until ||
        c.break_until ||
        statusObj?.until ||
        statusObj?.end_at ||
        ""
    ).trim();

    const validUntil =
      statusUntil &&
      !statusUntil.startsWith("0001-01-01") &&
      (/^\d{1,2}:\d{2}/.test(statusUntil) || parseValidTimestampMs(statusUntil) > Date.now() - 60000);

    const performedBy = String(
      tnwSub?.performed_by ||
        tnwSub?.created_by ||
        tnwSub?.actor ||
        c.temp_not_working_performed_by ||
        c.not_working_performed_by ||
        c.status_performed_by ||
        c.performed_by ||
        statusObj?.performed_by ||
        ""
    ).trim();

    const statusReason = String(
      tnwSub?.reason ||
        tnwSub?.reason_text ||
        tnwSub?.title ||
        c.temp_not_working_reason ||
        c.not_working_reason ||
        c.status_reason ||
        c.break_reason ||
        c.reason ||
        statusObj?.reason ||
        ""
    ).trim();

    const tnwActive =
      c.is_temp_not_working === true ||
      c.is_temporary_not_working === true ||
      c.temp_not_working === true ||
      c.temporary_not_working === true ||
      (tnwSub &&
        tnwSub.active !== false &&
        tnwSub.is_active !== false &&
        tnwSub.enabled !== false &&
        (tnwSub.active === true || tnwSub.is_active === true || validUntil || Boolean(statusReason)));

    const rawSt =
      [
        typeof c.temporary_not_working === "string" ? c.temporary_not_working : "",
        typeof c.temp_not_working === "string" ? c.temp_not_working : "",
        statusObj?.state,
        statusObj?.status,
        statusObj?.name,
        typeof c.state === "string" ? c.state : "",
        typeof c.courier_state === "string" ? c.courier_state : "",
        typeof c.working_state === "string" ? c.working_state : "",
        typeof c.current_state === "string" ? c.current_state : "",
        typeof c.status === "string" ? c.status : "",
        typeof c.courier_status === "string" ? c.courier_status : "",
        typeof c.working_status === "string" ? c.working_status : "",
        typeof c.availability_status === "string" ? c.availability_status : "",
        typeof c.shift_status === "string" ? c.shift_status : "",
        c.current_shift?.status,
        c.current_shift?.state
      ].find((s) => typeof s === "string" && s.trim() !== "") || "";

    const stLower = rawSt.toLowerCase();
    let status = "Working";
    if (
      tnwActive ||
      stLower.includes("temp_not_working") ||
      stLower.includes("temporary_not_working") ||
      stLower.includes("temporary not working") ||
      stLower.includes("temp_break")
    ) {
      status = "Temporary not working";
    } else if (
      stLower === "not_working" ||
      stLower === "not working" ||
      stLower.includes("offline") ||
      stLower.includes("unavailable") ||
      (!stLower && c.is_working === false)
    ) {
      status = "Not working";
    } else if (stLower === "break" || stLower === "on_break" || stLower === "on break") {
      status = "On Break";
    } else if (stLower.includes("ending")) {
      status = "Ending";
    } else if (stLower.includes("starting")) {
      status = "Starting";
    } else if (rawSt) {
      status = rawSt
        .split("_")
        .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : ""))
        .join(" ");
    }

    return {
      courierId: String(c.id || c.courier_id || ""),
      userId: String(c.user_id || c.userId || c.id || ""),
      name: String(c.name || c.courier_name || "").trim(),
      phone: String(c.phone_number || c.mobile || c.phone || "").trim(),
      vehicle: String(c.vehicle_type || c.vehicle?.name || (typeof c.vehicle === "string" ? c.vehicle : "") || "Motorbike").trim(),
      contract: String(c.contract_type || c.contract?.name || (typeof c.contract === "string" ? c.contract : "") || c.employment_type || "").trim(),
      balance: c.balance ?? c.wallet_balance ?? c.cash_balance ?? null,
      status,
      statusUntil: statusUntil && !statusUntil.startsWith("0001-01-01") ? statusUntil : "",
      performedBy,
      statusReason
    };
  }

  async function fetchFullHurrierCourier(cid, courierName = "") {
    const cleanId = String(cid || "").trim();
    const endpoints = [
      `/dispatcher-dashboard/couriers/${encodeURIComponent(cleanId)}`,
      `/dispatcher-dashboard/couriers/detail?id=${encodeURIComponent(cleanId)}`,
      `/hurrier/v1/couriers/${encodeURIComponent(cleanId)}`
    ];

    let merged = {};
    for (const ep of endpoints) {
      try {
        const res = await hurrierGet(ep);
        const unwrapped = unwrapCourierObj(res);
        if (unwrapped && Object.keys(unwrapped).length > 0) {
          merged = { ...merged, ...unwrapped };
          if (merged.user_id || merged.phone_number || merged.status || merged.state || merged.temp_not_working) {
            break;
          }
        }
      } catch {}
    }

    if (!merged.user_id || !merged.phone_number || (!merged.status && !merged.state)) {
      const queries = [cleanId, String(courierName || "").trim()].filter(Boolean);
      for (const q of queries) {
        try {
          const searchRes = await hurrierGet(
            `/dispatcher-dashboard/couriers?search=${encodeURIComponent(q)}&per_page=15`
          );
          const recs = Array.isArray(searchRes?.records)
            ? searchRes.records
            : Array.isArray(searchRes?.couriers)
            ? searchRes.couriers
            : Array.isArray(searchRes)
            ? searchRes
            : [];
          const hit =
            recs.find((r) => String(r.id) === cleanId || String(r.user_id) === cleanId) || recs[0];
          if (hit) {
            const hitUnwrapped = unwrapCourierObj(hit) || hit;
            merged = { ...hitUnwrapped, ...merged };
            if (hit.id && String(hit.id) !== cleanId && !merged.temp_not_working) {
              try {
                const byRealId = await hurrierGet(
                  `/dispatcher-dashboard/couriers/${encodeURIComponent(hit.id)}`
                );
                const unwReal = unwrapCourierObj(byRealId);
                if (unwReal) merged = { ...merged, ...unwReal };
              } catch {}
            }
            break;
          }
        } catch {}
      }
    }

    return Object.keys(merged).length > 0 ? merged : null;
  }

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

      // 2) Courier Details (Unwrapped + Normalized with Real Status & Temporary Not Working)
      if (
        cfg.courier_detail_req &&
        cfg.courier_detail_req.requestedAt > lastCourierDetailReqAt &&
        cfg.courier_detail_req.courierId
      ) {
        lastCourierDetailReqAt = cfg.courier_detail_req.requestedAt;
        const cid = String(cfg.courier_detail_req.courierId).trim();
        const cName = String(cfg.courier_detail_req.courierName || "").trim();
        const cData = await fetchFullHurrierCourier(cid, cName);
        const normalized = cData ? extractNormalizedCourierSummary(cData) : null;
        await fbDb("PUT", `/courier_details/${encodeURIComponent(cid)}`, {
          courier: cData,
          normalized,
          updatedAt: Date.now()
        });
      }

      // 3) Live Rider Search (Enriched with Real Courier Status)
      if (cfg.rider_search_req && cfg.rider_search_req.reqId && cfg.rider_search_req.reqId !== lastRiderSearchReqId) {
        lastRiderSearchReqId = cfg.rider_search_req.reqId;
        const q = String(cfg.rider_search_req.query || "").trim();
        let results = [];
        try {
          const sRes = await hurrierGet(`/dispatcher-dashboard/couriers?search=${encodeURIComponent(q)}&per_page=25`);
          const recs = Array.isArray(sRes?.records)
            ? sRes.records
            : Array.isArray(sRes?.couriers)
            ? sRes.couriers
            : Array.isArray(sRes)
            ? sRes
            : [];
          const enrichedTop = await Promise.all(
            recs.slice(0, 6).map(async (r) => {
              const rid = String(r.id || r.courier_id || "").trim();
              if (!rid) return extractNormalizedCourierSummary(r);
              const full = await fetchFullHurrierCourier(rid, r.name || r.courier_name || "");
              return extractNormalizedCourierSummary(full ? { ...r, ...full } : r);
            })
          );
          const rest = recs.slice(6).map((r) => extractNormalizedCourierSummary(r));
          results = [...enrichedTop, ...rest];
        } catch {}
        await fbDb("PUT", "/config/rider_search_res", {
          reqId: lastRiderSearchReqId,
          results,
          updatedAt: Date.now()
        });
      }
    } catch {}
  }

  // Main Sync Loop (Every 2 Seconds, Overlap-Safe)
  async function runSyncCycle() {
    if (isSyncInProgress) return;
    isSyncInProgress = true;

    try {
      if (!acquireSamePcTabLock()) {
        setBadge("#475569", `v${SCRIPT_VERSION} [2nd Tab Standby • Sync Active in Tab 1]`);
        return;
      }

      const fbToken = await getValidFirebaseToken(false);
      if (!fbToken) {
        isCurrentPrimaryLeader = false;
        setBadge("#92400e", `v${SCRIPT_VERSION} Standby (Open Dashboard Tab Once)`);
        return;
      }

      await syncCitiesZoneMapOnce();

      const sessRes = await fbDb("GET", "/active_sessions");
      const allSessions = sessRes.data || {};
      const now = Date.now();
      const activeSessions = Object.values(allSessions).filter(
        (s) => s && Array.isArray(s.zoneIds) && s.zoneIds.length > 0 && now - (s.lastSeen || 0) < 45000
      );

      // Cross-PC Leader Election (/feeder_lock) with Version Priority + Continuous Heartbeat
      const lockRes = await fbDb("GET", "/feeder_lock");
      const lock = lockRes.data;
      const lockIsNewerOrSame =
        lock && compareVersions(lock.version || "0", SCRIPT_VERSION) >= 0;
      if (
        lock &&
        lock.leaderId !== TAB_INSTANCE_ID &&
        lockIsNewerOrSame &&
        now - (lock.ts || 0) < FEEDER_LOCK_TTL_MS
      ) {
        isCurrentPrimaryLeader = false;
        const leaderTag = lock.leaderEmail ? ` • ${lock.leaderEmail.split("@")[0]}` : "";
        setBadge(
          "#0f766e",
          `v${SCRIPT_VERSION} [Backup Standby${leaderTag}] (${activeSessions.length} Viewers)`
        );
        return;
      }

      isCurrentPrimaryLeader = true;
      await fbDb("PUT", "/feeder_lock", {
        leaderId: TAB_INSTANCE_ID,
        leaderEmail: getBridgedLeaderEmail(),
        version: SCRIPT_VERSION,
        ts: now
      });

      await processOnDemandDashboardRequests();

      // 1) Fetch Stats & Issues first to know exact counts
      const [statsRes, issuesRes] = await Promise.allSettled([
        hurrierGet("/dispatcher-dashboard/stats"),
        hurrierGet("/issue-service/dispatcher_dashboard")
      ]);

      const statsData = statsRes.status === "fulfilled" ? statsRes.value : {};
      const allZoneStats = [];
      let totalEgyptActive = 0;
      let totalEgyptDispatched = 0;
      let totalEgyptQueued = 0;

      if (Array.isArray(statsData?.cities)) {
        statsData.cities.forEach((city) => {
          totalEgyptActive += Number(city?.stat?.active_count || 0);
          totalEgyptDispatched += Number(city?.stat?.dispatched_count || 0);
          totalEgyptQueued += Number(city?.stat?.queued_count || 0);
          (city.zones || []).forEach((zone) => {
            (zone.starting_points || []).forEach((sp) => {
              allZoneStats.push({
                id: Number(sp.id),
                name: sp.name,
                city: city.city_name,
                stat: sp.stat || {}
              });
            });
          });
        });
      }

      const dispMaxPages = Math.min(35, Math.max(4, Math.ceil((totalEgyptDispatched || 150) / 50) + 4));
      const queuedMaxPages = Math.min(35, Math.max(4, Math.ceil((totalEgyptQueued || 150) / 50) + 4));

      // 2) Fetch All Live Delivery Queues + Trigger Non-Blocking Rolling Completed Sync
      const [
        activeRecords,
        dispatchedRecords,
        queuedRecords,
        actionableRecords,
        preorderRecords,
        waitRecords
      ] = await Promise.all([
        syncActiveDeliveries(),
        fetchPaginatedDeliveries("/dispatcher-dashboard/deliveries/dispatched", dispMaxPages),
        fetchPaginatedDeliveries("/dispatcher-dashboard/deliveries/queued", queuedMaxPages),
        fetchPaginatedDeliveries("/dispatcher-dashboard/deliveries/actionable", 15),
        fetchPaginatedDeliveries("/dispatcher-dashboard/deliveries/preorder", 15),
        fetchPaginatedDeliveries("/dispatcher-dashboard/deliveries/wait_for_assembled", 15)
      ]);

      const unionWatchedZones = new Set();
      activeSessions.forEach((s) => {
        (Array.isArray(s.zoneIds) ? s.zoneIds : []).forEach((id) => unionWatchedZones.add(Number(id)));
      });

      captureRecentlyCompletedFromPipeline(
        activeRecords,
        dispatchedRecords,
        queuedRecords,
        unionWatchedZones
      ).catch(() => {});
      syncRollingCompletedOrdersPool(activeSessions).catch(() => {});

      const tabAllRecords = {
        Active: activeRecords,
        Dispatched: dispatchedRecords,
        Queued: queuedRecords,
        Actionable: actionableRecords,
        "Pre-order": preorderRecords,
        "Waiting for Assembly": waitRecords,
        Upcoming: [],
        Cancelled: []
      };

      const allIssues =
        issuesRes.status === "fulfilled" && Array.isArray(issuesRes.value) ? issuesRes.value : [];

      const activeViewersSummary = activeSessions.map((s) => ({
        sessionId: s.sessionId,
        email: s.email || "",
        employeeName: s.employeeName || s.email || "User",
        zoneCount: Array.isArray(s.zoneIds) ? s.zoneIds.length : 0,
        activeTab: s.activeTab || "Active"
      }));

      let primaryActiveMatched = 0;

      for (const sess of activeSessions) {
        const targetSet = new Set((Array.isArray(sess.zoneIds) ? sess.zoneIds : []).map(Number));
        const hasManialSelected = MANIAL_FAMILY_IDS.some((id) => targetSet.has(id));
        const hasTahrirSelected = targetSet.has(10022) || targetSet.has(10163);
        const filterBySessionZones = (records) =>
          (Array.isArray(records) ? records : []).filter((rec) =>
            doesRecordMatchSessionZones(rec, targetSet, hasManialSelected, hasTahrirSelected)
          );

        const filteredTabRecords = {};
        const counts = {};
        Object.entries(tabAllRecords).forEach(([tName, recs]) => {
          const matched = filterBySessionZones(recs);
          filteredTabRecords[tName] = matched;
          counts[tName] = matched.length;
        });

        primaryActiveMatched = counts.Active || 0;
        const completedRecords = getSessionRollingCompletedPayload(sess.zoneIds);
        const filteredZoneStats = allZoneStats.filter((sp) => targetSet.has(Number(sp.id)));

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
          completedSyncing: isCompletedSyncInProgress,
          issues: allIssues,
          couriers: Array.from(courierMap.values()),
          zoneStats: filteredZoneStats,
          activeViewers: activeViewersSummary,
          counts
        });
      }

      setBadge(
        "#15803d",
        `v${SCRIPT_VERSION} [Primary Leader] Live (2s) • ${activeSessions.length} Viewer • ${primaryActiveMatched} Act • ${rollingCompletedPool.size} Comp`
      );
    } catch (err) {
      setBadge("#b91c1c", `v${SCRIPT_VERSION} Sync Retry: ${err?.message || "Error"}`);
    } finally {
      isSyncInProgress = false;
    }
  }

  setTimeout(runSyncCycle, 800);
  setInterval(runSyncCycle, 2000);
})();
