// ==UserScript==
// @name         Hurrier Live Sync
// @namespace    https://hurrier-live.local/
// @version      8.4
// @description  [v8.4] Clean Syntax + Auth Bridge + Live Multi-Page Active Sync + Rolling 2h Completed At
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

  const SCRIPT_VERSION = "8.4";
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
  const ZONE_CATALOG_PAIRS = [
    [1, "Heliopolis"], [2, "Mohandiseen"], [10004, "Manial"], [10004, "Manial sp"],
    [10231, "Hybrid fleet mokattam easy sports"], [10002, "New maadi"], [10003, "Old maadi"],
    [10130, "Maadi nesting sp"], [10020, "Helwan SP"], [10009, "Zahraa maadi and meraag"],
    [10001, "Mokattam sp"], [10143, "Shobra 2 sp"], [10064, "Mokkatam asmarat sp"],
    [10094, "Sheikh zayed 2 sp"], [10251, "Hybrid fleet imbabah"], [10179, "Obour golf pt"],
    [10167, "Mohandiseen nesting p"], [10181, "Haram nesting pt"], [10138, "October hosary"],
    [10012, "Tagammoa 1 sp"], [10089, "Rehab 2 sp"], [10069, "Shorouk city sp 1"],
    [10090, "Tagamo3 5 south"], [10100, "Madinaty 3 sp south park"], [10235, "Ain shams nesting sp"],
    [10180, "Obour hay awal pt"], [10011, "Tagamoa 5 north"], [10074, "Hadayek el ahram sp"],
    [10091, "Mohamed naguib sp"], [10063, "Hadayek el qobba 1 sp"], [10102, "Madinaty 4 sp craft zone"],
    [10182, "Haram pt"], [10129, "Mohandiseen nesting sp"], [10183, "Haram pt 2"],
    [10115, "Ain shams (abdelhamed badawi) 2"], [10024, "Hay 10 and nasr city"], [10127, "Heliopolis nesting sp"],
    [10163, "Tahrir nesting"], [10160, "Rock vera"], [10166, "Mohandiseen p"],
    [10128, "Naser city nesting sp"], [10033, "Hegaz"], [10125, "Haram nesting sp"],
    [10000, "Nasr city sp"], [10165, "Madienty central park ebikes"], [10006, "Merryland"],
    [10139, "Haram sp 2"], [10022, "Tahrir"], [10162, "Manial nesting"],
    [10005, "Sheraton"], [10045, "Shobra sp"], [10013, "Rehab 1 sp"],
    [10096, "Palm hills sp"], [10150, "Golden square"], [10047, "October hosary 2"],
    [10018, "Haram sp"], [10099, "Madinaty 2 sp central park"], [10067, "Obour hay awal sp"],
    [10092, "Hadayek el qobba 2 sp"], [10164, "Shobra nesting"], [10101, "Shorouk city sp 2"],
    [10126, "October nesting"], [10010, "Auc sp"], [10070, "Madinaty 1 sp air mall & arabesque"],
    [10141, "Wahat fardous sp"], [10113, "Ains shams (ahmed essmat) 1"], [10159, "Obour golf sp"],
    [10131, "Sheraton nesting sp"], [10161, "Zahraa maadi nesting"], [10151, "Wahat sp 2"],
    [10032, "Sheikh zayed 1 sp"], [10104, "Abasseya sp"], [10217, "Hybrid fleet mokattam mafarik"],
    [10193, "Hybrid fleet el zaitoun"], [10186, "Hybrid fleet ard el golf"], [10216, "Hybrid fleet sheraton"],
    [10229, "Hybrid fleet heliopolis rabwa"], [10266, "Hybrid ard el golf bc"], [10223, "Hybrid fleet shorouk 1st area"],
    [10234, "Hybrid fleet wahat beta gardens"], [10209, "Hybrid fleet tagmmoa hay 1"], [10207, "Obour industrial area hybrid fleet"],
    [10248, "Hybrid fleet sheikh zayed hay 4"], [10249, "Hybrid fleet west somed"], [10219, "Hybrid fleet ain shams"],
    [10261, "Hybrid fleet - mountain view park wahat"], [10226, "Hybrid fleet sheikh zayed hay 9"], [10189, "Hybrid fleet el sayeda"],
    [10214, "Hybrid fleet al manial"], [10029, "Beverly hills sp"], [10238, "Hybrid fleet el daher"],
    [10230, "Hybrid fleet nasrcity hay 8"], [10142, "Palm hills 2 sp"], [10195, "Hybrid fleet lebanon square"],
    [10222, "Hybrid fleet shobra"], [10185, "Hybrid fleet banafseg"], [10275, "Hybrid fleet toya mall"],
    [10174, "Hybrid fleet maadi"], [10184, "Hybrid fleet zayed"], [10212, "Hybrid fleet palm hills 1"],
    [10232, "Hybrid fleet maadi old"], [10136, "Motamyez sp"], [10218, "Hybrid fleet el hadeeka el dawlya"],
    [10196, "Hybrid fleet tayaran"], [10224, "Hybrid fleet tagmmoa auc"], [10225, "Hybrid fleet golden lotus"],
    [10188, "Hybrid fleet rock vera"], [10173, "Hybrid fleet rehab"], [10208, "Hybrid fleet banks center"],
    [10191, "Hybrid fleet october 4th"], [10210, "Hybrid fleet hadayek el ahram"], [10211, "Hybrid fleet maryoteya"],
    [10264, "Hybrid lebanon bc"], [10252, "Hybrid fleet mohafzet el giza"], [10256, "Hybrid fleet mosaddak"],
    [10262, "Hybrid fleet hadayek el ahram - area d"], [10227, "Hybrid fleet mokattam nafora"], [10241, "Hybrid fleet helwan"],
    [10215, "Hybrid fleet maadi meraag"], [10194, "Hybrid fleet october 6th"], [10237, "Hybrid fleet agouza"],
    [10114, "Ain shams (zatoun) 3"], [10198, "Hybrid fleet taqa"], [10221, "Hybrid fleet palm hills 360"],
    [10228, "Hybrid fleet maadi laselky"], [10250, "Hybrid fleet el nadi el gedid"], [10233, "Hybrid fleet shorouk 8th district"],
    [10177, "Hybrid fleet obour"], [10213, "Hybrid fleet el montazah"], [10265, "Hybrid taqseem laselky bc"],
    [10220, "Hybrid fleet october wahet el mohandseen"], [10260, "Obour golf hybrid fleet"], [10197, "Hybrid fleet tersa"],
    [10190, "Hybrid fleet talbya"], [10271, "Hybrid wahet el mohandsen bc"], [10269, "Hybrid maadi old bc"],
    [10192, "Shobra nesting 2"], [10273, "Hybrid fleet gardenia"], [10267, "Hybrid al-manial bc"],
    [10270, "Hybrid shobra bc"], [10277, "Hybrid el sayeda zeinab bc"], [10068, "Smart village dandy mall sp 1"],
    [10278, "Hybrid talbyia bc"], [10272, "Hybrid mohafzet el giza bc"], [10276, "Hybrid agouza bc"],
    [10281, "Hybrid fleet shorouk 4"], [10187, "Hybrid fleet shorouk 3rd"], [10027, "Gleem sp"], [10028, "Raml station sp"]
  ];

  const ZONE_NAME_TO_ID = new Map();
  ZONE_CATALOG_PAIRS.forEach(([id, name]) => {
    ZONE_NAME_TO_ID.set(String(name).trim().toLowerCase(), Number(id));
  });

  const TAB_INSTANCE_ID = `tab_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const LOCAL_TAB_LOCK_KEY = "hurrier_live_sync_local_tab_lock";
  let remoteAvailableVersion = "";
  let citiesSyncedOnce = false;
  let isSyncInProgress = false;

  const rollingCompletedPool = new Map();
  const lastKnownCompletedPage = {};
  let lastRollingCompletedSyncAt = 0;
  let initialCompletedBackfillDone = false;

  const cachedActiveById = new Map();
  let lastFullActiveSweepAt = 0;
  let lastKnownActivePages = 12;

  let lastOrderDetailReqAt = 0;
  let lastCourierDetailReqAt = 0;
  let lastRiderSearchReqId = "";

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
        data.cities.forEach((city) => {
          (city.zones || []).forEach((z) => {
            if (z && z.id && z.name) {
              const cleanName = String(z.name).trim().toLowerCase();
              ZONE_NAME_TO_ID.set(cleanName, Number(z.id));
              ZONE_NAME_TO_ID.set(`${cleanName} sp`, Number(z.id));
            }
          });
        });
        citiesSyncedOnce = true;
      }
    } catch {}
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
        if (!sp) return;
        if (typeof sp === "string") {
          const key = sp.trim().toLowerCase();
          const mappedId = ZONE_NAME_TO_ID.get(key) || ZONE_NAME_TO_ID.get(`${key} sp`);
          if (mappedId) ids.add(mappedId);
        } else if (typeof sp === "object") {
          if (sp.id) ids.add(Number(sp.id));
          if (sp.name) {
            const key = String(sp.name).trim().toLowerCase();
            const mappedId = ZONE_NAME_TO_ID.get(key) || ZONE_NAME_TO_ID.get(`${key} sp`);
            if (mappedId) ids.add(mappedId);
          }
        }
      });
    };
    collect(rec?.starting_points);
    collect(rec?.order?.drop_off_address?.starting_points);
    collect(rec?.order?.dropoff_address?.starting_points);
    return ids;
  }

  // Multi-page fetcher for Queued / Dispatched / Preorder / Actionable / WaitForAssembled
  async function fetchPaginatedDeliveries(path, maxPages = 6) {
    const all = [];
    try {
      const p1 = await hurrierGet(`${path}?page=1&per_page=50`);
      const r1 = Array.isArray(p1?.records) ? p1.records : [];
      all.push(...r1);
      if (r1.length < 50 || maxPages <= 1) return all;

      const pages = [];
      for (let pg = 2; pg <= maxPages; pg++) pages.push(pg);
      const settled = await Promise.allSettled(
        pages.map((pg) => hurrierGet(`${path}?page=${pg}&per_page=50`))
      );
      for (const s of settled) {
        if (s.status === "fulfilled" && Array.isArray(s.value?.records)) {
          all.push(...s.value.records);
          if (s.value.records.length < 50) break;
        }
      }
    } catch {}
    return all;
  }

  // Smart Multi-Page Active Deliveries Sync (Full sweep every 12s + Fast tail pages every 2s)
  async function syncActiveDeliveries(totalActiveHint) {
    const now = Date.now();
    const estPages = Math.min(40, Math.max(6, Math.ceil((totalActiveHint || 600) / 50) + 2));
    const needFullSweep = cachedActiveById.size === 0 || now - lastFullActiveSweepAt >= 12000;

    if (needFullSweep) {
      lastFullActiveSweepAt = now;
      const freshMap = new Map();
      let reachedEnd = false;
      let highestNonEmptyPage = 1;

      for (let batchStart = 1; batchStart <= estPages && !reachedEnd; batchStart += 6) {
        const batchPages = [];
        for (let p = batchStart; p < batchStart + 6 && p <= estPages; p++) {
          batchPages.push(p);
        }
        const results = await Promise.allSettled(
          batchPages.map((pg) => hurrierGet(`/dispatcher-dashboard/deliveries/active?page=${pg}&per_page=50`))
        );
        results.forEach((res, idx) => {
          if (res.status === "fulfilled") {
            const recs = Array.isArray(res.value?.records) ? res.value.records : [];
            if (recs.length > 0) {
              highestNonEmptyPage = Math.max(highestNonEmptyPage, batchPages[idx]);
              recs.forEach((r) => {
                const key = String(r.id || r.order?.id || r.order?.code || Math.random());
                freshMap.set(key, r);
              });
            }
            if (recs.length < 50) {
              reachedEnd = true;
            }
          }
        });
      }

      if (freshMap.size > 0) {
        cachedActiveById.clear();
        freshMap.forEach((v, k) => cachedActiveById.set(k, v));
        lastKnownActivePages = highestNonEmptyPage;
      }
    } else {
      // Fast 2s update of newest tail pages
      const startTail = Math.max(1, lastKnownActivePages - 3);
      const endTail = lastKnownActivePages + 1;
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

  // Rolling 2-Hour Completed Orders Pool (by Completed At, excluding Cancelled)
  function ingestCompletedRecordsBatch(records) {
    if (!Array.isArray(records) || records.length === 0) return 0;
    const cutoffMs = Date.now() - (ROLLING_COMPLETED_WINDOW_MS + ROLLING_COMPLETED_GRACE_MS);
    let added = 0;

    for (const rec of records) {
      if (!rec || typeof rec !== "object") continue;
      const order = rec.order || {};
      const stLower = String(order.status || rec.status || "").toLowerCase();
      if (stLower.includes("cancel")) continue;

      const orderKey = String(
        order.confirmation_number ||
          order.code ||
          String(order.order_code || "").replace(/^(HF_[A-Z]{2}|ODR_[A-Z]{2})/i, "") ||
          order.id ||
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
      added++;
    }
    return added;
  }

  async function discoverLastCompletedPage(dateStr) {
    const p1 = await hurrierGet(`/dispatcher-dashboard/orders/completed?date=${dateStr}&page=1&per_page=50`);
    const p1Recs = Array.isArray(p1?.records) ? p1.records : [];
    if (p1Recs.length === 0) return 0;
    ingestCompletedRecordsBatch(p1Recs);
    if (p1Recs.length < 50) return 1;

    const explicitTotal = Number(
      p1?.total_records ?? p1?.total_count ?? p1?.total ?? p1?.count ?? p1?.pagination?.total ?? 0
    );
    if (explicitTotal > 0) {
      return Math.max(1, Math.ceil(explicitTotal / 50));
    }

    let low = Math.max(1, lastKnownCompletedPage[dateStr] || 1);
    let step = 1;
    let high = low;

    while (high <= 16384) {
      const probePage = low + step;
      const res = await hurrierGet(`/dispatcher-dashboard/orders/completed?date=${dateStr}&page=${probePage}&per_page=50`);
      const recs = Array.isArray(res?.records) ? res.records : [];
      if (recs.length === 0) {
        high = probePage - 1;
        break;
      }
      ingestCompletedRecordsBatch(recs);
      low = probePage;
      if (recs.length < 50) {
        lastKnownCompletedPage[dateStr] = probePage;
        return probePage;
      }
      step *= 2;
      high = low + step;
    }

    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      const res = await hurrierGet(`/dispatcher-dashboard/orders/completed?date=${dateStr}&page=${mid}&per_page=50`);
      const recs = Array.isArray(res?.records) ? res.records : [];
      if (recs.length > 0) {
        ingestCompletedRecordsBatch(recs);
        low = mid;
        if (recs.length < 50) break;
      } else {
        high = mid - 1;
      }
    }

    lastKnownCompletedPage[dateStr] = Math.max(1, low);
    return lastKnownCompletedPage[dateStr];
  }

  async function pullCompletedWindowForDate(dateStr, minPlacedCutoffMs, isIncremental) {
    try {
      const prevKnown = lastKnownCompletedPage[dateStr] || 1;
      const totalPages = await discoverLastCompletedPage(dateStr);
      if (totalPages <= 0) return;

      if (isIncremental) {
        const startPg = Math.max(1, Math.min(prevKnown - 2, totalPages - 3));
        const pages = [];
        for (let pg = totalPages; pg >= startPg; pg--) pages.push(pg);
        const settled = await Promise.allSettled(
          pages.map((pg) => hurrierGet(`/dispatcher-dashboard/orders/completed?date=${dateStr}&page=${pg}&per_page=50`))
        );
        settled.forEach((s) => {
          if (s.status === "fulfilled" && Array.isArray(s.value?.records)) {
            ingestCompletedRecordsBatch(s.value.records);
          }
        });
        return;
      }

      // Initial Backfill: Scan backwards from newest page (totalPages) downwards
      const minPage = Math.max(1, totalPages - 45);
      let stopEarly = false;
      for (let cursor = totalPages; cursor >= minPage && !stopEarly; cursor -= 5) {
        const batch = [];
        for (let pg = cursor; pg > cursor - 5 && pg >= minPage; pg--) {
          batch.push(pg);
        }
        const settled = await Promise.allSettled(
          batch.map((pg) => hurrierGet(`/dispatcher-dashboard/orders/completed?date=${dateStr}&page=${pg}&per_page=50`))
        );
        for (const s of settled) {
          if (s.status === "fulfilled" && Array.isArray(s.value?.records) && s.value.records.length > 0) {
            const recs = s.value.records;
            ingestCompletedRecordsBatch(recs);
            const newestInPage = recs[recs.length - 1];
            const placedMs = newestInPage?.order?.placed_at ? new Date(newestInPage.order.placed_at).getTime() : 0;
            if (placedMs > 0 && placedMs < minPlacedCutoffMs) {
              stopEarly = true;
            }
          }
        }
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

  // Main Sync Loop (Every 2 Seconds, Overlap-Safe)
  async function runSyncCycle() {
    if (isSyncInProgress) return;
    isSyncInProgress = true;

    try {
      if (!acquireSamePcTabLock()) {
        setBadge("#475569", `v${SCRIPT_VERSION} [Local Tab Standby]`);
        return;
      }

      const fbToken = await getValidFirebaseToken(false);
      if (!fbToken) {
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

      const dispMaxPages = Math.min(8, Math.max(2, Math.ceil((totalEgyptDispatched || 100) / 50) + 1));
      const queuedMaxPages = Math.min(8, Math.max(2, Math.ceil((totalEgyptQueued || 100) / 50) + 1));

      // 2) Fetch All Live Delivery Queues + Rolling Completed Pool
      const [
        activeRecords,
        dispatchedRecords,
        queuedRecords,
        actionableRecords,
        preorderRecords,
        waitRecords
      ] = await Promise.all([
        syncActiveDeliveries(totalEgyptActive),
        fetchPaginatedDeliveries("/dispatcher-dashboard/deliveries/dispatched", dispMaxPages),
        fetchPaginatedDeliveries("/dispatcher-dashboard/deliveries/queued", queuedMaxPages),
        fetchPaginatedDeliveries("/dispatcher-dashboard/deliveries/actionable", 3),
        fetchPaginatedDeliveries("/dispatcher-dashboard/deliveries/preorder", 3),
        fetchPaginatedDeliveries("/dispatcher-dashboard/deliveries/wait_for_assembled", 3)
      ]);

      await syncRollingCompletedOrdersPool(false);

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
        const filterBySessionZones = (records) =>
          (Array.isArray(records) ? records : []).filter((rec) => {
            if (targetSet.size === 0) return true;
            const recSpIds = extractRecordStartingPointIds(rec);
            if (recSpIds.size === 0) return false;
            for (const id of recSpIds) {
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
