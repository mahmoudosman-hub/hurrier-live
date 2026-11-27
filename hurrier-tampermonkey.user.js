// ==UserScript==
// @name         Hurrier Live Sync
// @namespace    https://hurrier-live.local/
// @version      9.5
// @description  [v9.5] Light Sync (Dashboard + Active Couriers + Queued + Dispatched + Active + Completed + Dispatcher)
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

  const SCRIPT_VERSION = "9.5";
  const GITHUB_SCRIPT_RAW_URL =
    "https://raw.githubusercontent.com/mahmoudosman-hub/hurrier-live/main/hurrier-tampermonkey.user.js";
  const FIREBASE_DB_URL =
    "https://hurrier-live-default-rtdb.europe-west1.firebasedatabase.app";
  const BASE_API = "https://eg.me.logisticsbackoffice.com/api";
  const AUTH_BRIDGE_STORAGE_KEY = "hurrier_fb_bridge_auth";
  const GM_AUTH_BRIDGE_KEY = "hurrier_fb_bridge_auth_v1";
  const SAME_PC_TAB_LOCK_KEY = "hurrier_live_same_pc_tab_lock_v2";

  const ROLLING_COMPLETED_WINDOW_MS = 2 * 3600 * 1000;
  const ROLLING_COMPLETED_GRACE_MS = 20 * 60 * 1000;
  const MANIAL_FAMILY_IDS = [10004, 10162, 10282, 10284, 10214, 10267];

  const IS_HURRIER_HOST = location.hostname === "eg.me.logisticsbackoffice.com";

  // ============================================================================
  // 1) DASHBOARD TAB AUTH BRIDGE (Runs on GitHub Pages / localhost)
  // ============================================================================
  if (!IS_HURRIER_HOST) {
    const syncDashboardAuthToGM = () => {
      try {
        const raw = window.localStorage.getItem(AUTH_BRIDGE_STORAGE_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (parsed && parsed.idToken && typeof GM_setValue === "function") {
          GM_setValue(GM_AUTH_BRIDGE_KEY, raw);
        }
      } catch {}
    };
    syncDashboardAuthToGM();
    setInterval(syncDashboardAuthToGM, 1500);
    return;
  }

  // ============================================================================
  // 2) FLOATING STATUS BADGE & GITHUB AUTO-UPDATE CHECKER
  // ============================================================================
  let latestRemoteVersion = "";
  let badgeEl = null;

  function ensureBadgeElement() {
    if (badgeEl && document.body && document.body.contains(badgeEl)) return badgeEl;
    if (!document.body) return null;
    const el = document.createElement("div");
    el.id = "hurrier-live-sync-badge";
    el.style.cssText = [
      "position:fixed",
      "bottom:14px",
      "right:14px",
      "z-index:2147483647",
      "padding:7px 14px",
      "border-radius:9999px",
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif",
      "font-size:12px",
      "font-weight:700",
      "color:#ffffff",
      "background:#0f766e",
      "box-shadow:0 6px 18px rgba(0,0,0,0.22)",
      "transition:background 0.2s ease",
      "user-select:none"
    ].join(";");
    el.textContent = `v${SCRIPT_VERSION} Starting Sync...`;
    document.body.appendChild(el);
    badgeEl = el;
    return el;
  }

  function compareVersions(v1, v2) {
    const a = String(v1 || "0").split(".").map((n) => parseInt(n, 10) || 0);
    const b = String(v2 || "0").split(".").map((n) => parseInt(n, 10) || 0);
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) {
      const diff = (a[i] || 0) - (b[i] || 0);
      if (diff !== 0) return diff > 0 ? 1 : -1;
    }
    return 0;
  }

  function setBadge(bgColor, text) {
    const el = ensureBadgeElement();
    if (!el) return;
    if (latestRemoteVersion && compareVersions(latestRemoteVersion, SCRIPT_VERSION) > 0) {
      el.style.background = "#1d4ed8";
      el.style.cursor = "pointer";
      el.textContent = `⬆ Update v${latestRemoteVersion} Ready (Click to Update)`;
      el.onclick = () => {
        window.open(`${GITHUB_SCRIPT_RAW_URL}?t=${Date.now()}`, "_blank");
      };
      return;
    }
    el.style.background = bgColor;
    el.style.cursor = "default";
    el.onclick = null;
    el.textContent = text;
  }

  ensureBadgeElement();

  function checkGitHubForScriptUpdate() {
    if (typeof GM_xmlhttpRequest !== "function") return;
    GM_xmlhttpRequest({
      method: "GET",
      url: `${GITHUB_SCRIPT_RAW_URL}?t=${Date.now()}`,
      headers: { "Cache-Control": "no-cache" },
      onload: (res) => {
        if (res.status >= 200 && res.status < 300 && res.responseText) {
          const m = res.responseText.match(/\/\/\s*@version\s+([0-9.]+)/);
          if (m && m[1] && compareVersions(m[1], SCRIPT_VERSION) > 0) {
            latestRemoteVersion = m[1].trim();
            setBadge("#1d4ed8", "");
          }
        }
      }
    });
  }
  setTimeout(checkGitHubForScriptUpdate, 4000);
  setInterval(checkGitHubForScriptUpdate, 90000);

  // ============================================================================
  // 3) HURRIER API AUTH HEADERS & FETCH WRAPPER
  // ============================================================================
  function decodeJwtPayloadSafe(jwtStr) {
    try {
      const parts = String(jwtStr || "").split(".");
      if (parts.length !== 3) return null;
      const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
      const padded = b64 + "===".slice((b64.length + 3) % 4);
      return JSON.parse(atob(padded));
    } catch {
      return null;
    }
  }

  function findHurrierBearerToken() {
    const jwtRegex = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
    let fallbackJwt = "";

    const inspectCandidateJwt = (tok, isPreferredKey) => {
      if (typeof tok !== "string") return "";
      const clean = tok.replace(/^Bearer\s+/i, "").trim();
      if (!jwtRegex.test(clean)) return "";
      const payload = decodeJwtPayloadSafe(clean);
      if (!payload) return "";
      const iss = String(payload.iss || "");
      if (iss.includes("securetoken.google.com")) return "";
      if (payload.exp && payload.exp * 1000 < Date.now() + 5000) return "";
      const aud = String(payload.aud || "");
      if (isPreferredKey || aud.includes("logistics") || iss.includes("deliveryhero")) {
        return clean;
      }
      if (!fallbackJwt) fallbackJwt = clean;
      return "";
    };

    const storages = [];
    try {
      if (window.localStorage) storages.push(window.localStorage);
    } catch {}
    try {
      if (window.sessionStorage) storages.push(window.sessionStorage);
    } catch {}

    for (const store of storages) {
      try {
        for (let i = 0; i < store.length; i++) {
          const k = store.key(i);
          if (!k || k === AUTH_BRIDGE_STORAGE_KEY) continue;
          const rawVal = store.getItem(k);
          if (!rawVal) continue;
          const kLower = k.toLowerCase();
          const preferred =
            kLower.includes("dhh") || kLower.includes("token") || kLower.includes("auth");

          const directHit = inspectCandidateJwt(rawVal, preferred);
          if (directHit) return directHit;

          const trimmed = rawVal.trim();
          if (trimmed.startsWith("{")) {
            try {
              const obj = JSON.parse(trimmed);
              const subCandidates = [
                obj?.dhhToken,
                obj?.token,
                obj?.access_token,
                obj?.accessToken,
                obj?.auth?.dhhToken,
                obj?.auth?.token
              ];
              for (const sub of subCandidates) {
                const hit = inspectCandidateJwt(sub, true);
                if (hit) return hit;
              }
            } catch {}
          }
        }
      } catch {}
    }

    try {
      const cookies = String(document.cookie || "").split(";");
      for (const c of cookies) {
        const eqIdx = c.indexOf("=");
        if (eqIdx === -1) continue;
        const ck = c.slice(0, eqIdx).trim().toLowerCase();
        const cv = decodeURIComponent(c.slice(eqIdx + 1).trim());
        const hit = inspectCandidateJwt(cv, ck.includes("dhh") || ck.includes("token"));
        if (hit) return hit;
      }
    } catch {}

    return fallbackJwt;
  }

  function getHurrierAuthHeaders() {
    const headers = { Accept: "application/json" };
    const tok = findHurrierBearerToken();
    if (tok) {
      headers.Authorization = `Bearer ${tok}`;
    }
    return headers;
  }

  async function hurrierGet(path) {
    const res = await fetch(`${BASE_API}${path}`, {
      method: "GET",
      credentials: "include",
      headers: getHurrierAuthHeaders()
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return res.json();
  }

  // ============================================================================
  // 4) FIREBASE AUTH TOKEN REFRESH & REST CLIENT
  // ============================================================================
  function readAuthBridgeObject() {
    try {
      const gmRaw = typeof GM_getValue === "function" ? GM_getValue(GM_AUTH_BRIDGE_KEY, "") : "";
      if (gmRaw) {
        const parsed = JSON.parse(gmRaw);
        if (parsed && (parsed.idToken || parsed.refreshToken)) return parsed;
      }
    } catch {}
    try {
      const lsRaw = window.localStorage.getItem(AUTH_BRIDGE_STORAGE_KEY);
      if (lsRaw) return JSON.parse(lsRaw);
    } catch {}
    return null;
  }

  function writeAuthBridgeObject(obj) {
    try {
      const serialized = JSON.stringify(obj);
      if (typeof GM_setValue === "function") {
        GM_setValue(GM_AUTH_BRIDGE_KEY, serialized);
      }
    } catch {}
  }

  function getBridgedLeaderEmail() {
    const bridge = readAuthBridgeObject();
    return String(bridge?.email || "").trim().toLowerCase();
  }

  let tokenRefreshPromise = null;

  async function getValidFirebaseIdToken(forceRefresh = false) {
    const bridge = readAuthBridgeObject();
    if (!bridge) return "";

    if (!forceRefresh && bridge.idToken) {
      const payload = decodeJwtPayloadSafe(bridge.idToken);
      if (payload && payload.exp && payload.exp * 1000 > Date.now() + 5 * 60 * 1000) {
        return bridge.idToken;
      }
    }

    if (!bridge.refreshToken || !bridge.apiKey) {
      return bridge.idToken || "";
    }

    if (tokenRefreshPromise) return tokenRefreshPromise;

    tokenRefreshPromise = new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: "POST",
        url: `https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(bridge.apiKey)}`,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        data: `grant_type=refresh_token&refresh_token=${encodeURIComponent(bridge.refreshToken)}`,
        onload: (res) => {
          tokenRefreshPromise = null;
          try {
            if (res.status >= 200 && res.status < 300) {
              const data = JSON.parse(res.responseText || "{}");
              if (data.id_token) {
                const updated = {
                  ...bridge,
                  idToken: data.id_token,
                  refreshToken: data.refresh_token || bridge.refreshToken,
                  updatedAt: Date.now()
                };
                writeAuthBridgeObject(updated);
                resolve(data.id_token);
                return;
              }
            }
          } catch {}
          resolve(bridge.idToken || "");
        },
        onerror: () => {
          tokenRefreshPromise = null;
          resolve(bridge.idToken || "");
        }
      });
    });

    return tokenRefreshPromise;
  }

  function rawFirebaseRequest(method, url, body) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url,
        headers: body !== undefined ? { "Content-Type": "application/json" } : {},
        data: body !== undefined ? JSON.stringify(body) : undefined,
        timeout: 10000,
        onload: (res) => resolve(res),
        onerror: (err) => reject(err),
        ontimeout: () => reject(new Error("Firebase timeout"))
      });
    });
  }

  async function firebaseReq(method, path, body) {
    let tok = await getValidFirebaseIdToken(false);
    const makeUrl = (t) =>
      `${FIREBASE_DB_URL}${path}.json${t ? `?auth=${encodeURIComponent(t)}` : ""}`;

    let res = await rawFirebaseRequest(method, makeUrl(tok), body);
    if (res.status === 401) {
      tok = await getValidFirebaseIdToken(true);
      if (tok) {
        res = await rawFirebaseRequest(method, makeUrl(tok), body);
      }
    }
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`FB ${res.status}`);
    }
    return res.responseText ? JSON.parse(res.responseText) : null;
  }

  // ============================================================================
  // 5) SAME-PC TAB LOCK & MULTI-PC PRIMARY LEADER ELECTION (With Heartbeat)
  // ============================================================================
  const TAB_ID = `tab_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const LEADER_INSTANCE_ID = `ldr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  let ownsLocalTabLock = false;
  let isCurrentLeader = false;

  function acquireSamePcTabLock() {
    const now = Date.now();
    try {
      const raw = window.localStorage.getItem(SAME_PC_TAB_LOCK_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        const age = now - Number(parsed?.ts || 0);
        const sameOwner = parsed?.tabId === TAB_ID;
        const newerScript =
          parsed?.version && compareVersions(SCRIPT_VERSION, parsed.version) > 0;
        if (!sameOwner && age < 8000 && !newerScript) {
          ownsLocalTabLock = false;
          return false;
        }
      }
      window.localStorage.setItem(
        SAME_PC_TAB_LOCK_KEY,
        JSON.stringify({ tabId: TAB_ID, version: SCRIPT_VERSION, ts: now })
      );
      ownsLocalTabLock = true;
      return true;
    } catch {
      ownsLocalTabLock = true;
      return true;
    }
  }

  setInterval(() => {
    if (ownsLocalTabLock) {
      try {
        window.localStorage.setItem(
          SAME_PC_TAB_LOCK_KEY,
          JSON.stringify({ tabId: TAB_ID, version: SCRIPT_VERSION, ts: Date.now() })
        );
      } catch {}
    }
  }, 2000);

  window.addEventListener("beforeunload", () => {
    if (ownsLocalTabLock) {
      try {
        const raw = window.localStorage.getItem(SAME_PC_TAB_LOCK_KEY);
        if (raw && JSON.parse(raw)?.tabId === TAB_ID) {
          window.localStorage.removeItem(SAME_PC_TAB_LOCK_KEY);
        }
      } catch {}
    }
  });

  async function ensureMultiPcLeadership() {
    const now = Date.now();
    try {
      const lock = await firebaseReq("GET", "/feeder_lock");
      const lockAge = now - Number(lock?.updatedAt || 0);
      const isMine = lock?.leaderId === LEADER_INSTANCE_ID;
      const isExpired = !lock || !lock.leaderId || lockAge > 15000;
      const isOlderVersion =
        lock?.version && compareVersions(SCRIPT_VERSION, lock.version) > 0;

      if (isMine || isExpired || isOlderVersion) {
        await firebaseReq("PUT", "/feeder_lock", {
          leaderId: LEADER_INSTANCE_ID,
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

  // Independent Leader Heartbeat so long API cycles never lose Primary Leader status
  setInterval(() => {
    if (isCurrentLeader && ownsLocalTabLock) {
      firebaseReq("PUT", "/feeder_lock", {
        leaderId: LEADER_INSTANCE_ID,
        email: getBridgedLeaderEmail(),
        version: SCRIPT_VERSION,
        updatedAt: Date.now()
      }).catch(() => {});
    }
  }, 3500);

  // ============================================================================
  // 6 & 7) ZONES REGISTRY & ACCURATE RECORD ZONE MATCHING
  // ============================================================================
  const STATIC_ZONES = [
    [1, "Heliopolis"], [2, "Mohandiseen"], [10004, "Manial"], [10162, "Manial nesting"],
    [10282, "Manial nesting p"], [10284, "Manial p"], [10214, "Hybrid fleet al manial"],
    [10267, "Hybrid al-manial bc"], [10231, "Hybrid fleet mokattam easy sports"],
    [10002, "New maadi"], [10003, "Old maadi"], [10130, "Maadi nesting sp"],
    [10020, "Helwan SP"], [10135, "Helwan sp 2"], [10009, "Zahraa maadi and meraag"],
    [10001, "Mokattam sp"], [10143, "Shobra 2 sp"], [10064, "Mokkatam asmarat sp"],
    [10094, "Sheikh zayed 2 sp"], [10251, "Hybrid fleet imbabah"], [10179, "Obour golf pt"],
    [10167, "Mohandiseen nesting p"], [10181, "Haram nesting pt"], [10138, "October hosary"],
    [10012, "Tagammoa 1 sp"], [10089, "Rehab 2 sp"], [10253, "Hybrid fleet rehab old"],
    [10069, "Shorouk city sp 1"], [10090, "Tagamo3 5 south"], [10100, "Madinaty 3 sp south park"],
    [10235, "Ain shams nesting sp"], [10286, "Hybrid fleet ain shams 2"],
    [10180, "Obour hay awal pt"], [10011, "Tagamoa 5 north"], [10074, "Hadayek el ahram sp"],
    [10091, "Mohamed naguib sp"], [10063, "Hadayek el qobba 1 sp"],
    [10102, "Madinaty 4 sp craft zone"], [10182, "Haram pt"], [10129, "Mohandiseen nesting sp"],
    [10183, "Haram pt 2"], [10115, "Ain shams (abdelhamed badawi) 2"],
    [10024, "Hay 10 and nasr city"], [10127, "Heliopolis nesting sp"], [10163, "Tahrir nesting"],
    [10160, "Rock vera"], [10166, "Mohandiseen p"], [10128, "Naser city nesting sp"],
    [10033, "Hegaz"], [10125, "Haram nesting sp"], [10000, "Nasr city sp"],
    [10165, "Madienty central park ebikes"], [10006, "Merryland"], [10139, "Haram sp 2"],
    [10022, "Tahrir"], [10005, "Sheraton"], [10045, "Shobra sp"], [10013, "Rehab 1 sp"],
    [10096, "Palm hills sp"], [10150, "Golden square"], [10047, "October hosary 2"],
    [10018, "Haram sp"], [10099, "Madinaty 2 sp central park"], [10067, "Obour hay awal sp"],
    [10092, "Hadayek el qobba 2 sp"], [10164, "Shobra nesting"], [10101, "Shorouk city sp 2"],
    [10126, "October nesting"], [10010, "Auc sp"], [10070, "Madinaty 1 sp air mall & arabesque"],
    [10141, "Wahat fardous sp"], [10113, "Ains shams (ahmed essmat) 1"], [10159, "Obour golf sp"],
    [10131, "Sheraton nesting sp"], [10161, "Zahraa maadi nesting"], [10151, "Wahat sp 2"],
    [10032, "Sheikh zayed 1 sp"], [10104, "Abasseya sp"], [10217, "Hybrid fleet mokattam mafarik"],
    [10193, "Hybrid fleet el zaitoun"], [10186, "Hybrid fleet ard el golf"],
    [10216, "Hybrid fleet sheraton"], [10229, "Hybrid fleet heliopolis rabwa"],
    [10266, "Hybrid ard el golf bc"], [10268, "Hybrid el hadeeqa el dawlia bc"],
    [10223, "Hybrid fleet shorouk 1st area"], [10234, "Hybrid fleet wahat beta gardens"],
    [10209, "Hybrid fleet tagmmoa hay 1"], [10207, "Obour industrial area hybrid fleet"],
    [10248, "Hybrid fleet sheikh zayed hay 4"], [10249, "Hybrid fleet west somed"],
    [10219, "Hybrid fleet ain shams"], [10261, "Hybrid fleet - mountain view park wahat"],
    [10226, "Hybrid fleet sheikh zayed hay 9"], [10189, "Hybrid fleet el sayeda"],
    [10029, "Beverly hills sp"], [10238, "Hybrid fleet el daher"],
    [10230, "Hybrid fleet nasrcity hay 8"], [10142, "Palm hills 2 sp"],
    [10195, "Hybrid fleet lebanon square"], [10222, "Hybrid fleet shobra"],
    [10185, "Hybrid fleet banafseg"], [10275, "Hybrid fleet toya mall"],
    [10174, "Hybrid fleet maadi"], [10184, "Hybrid fleet zayed"],
    [10212, "Hybrid fleet palm hills 1"], [10232, "Hybrid fleet maadi old"],
    [10136, "Motamyez sp"], [10218, "Hybrid fleet el hadeeka el dawlya"],
    [10196, "Hybrid fleet tayaran"], [10224, "Hybrid fleet tagmmoa auc"],
    [10225, "Hybrid fleet golden lotus"], [10188, "Hybrid fleet rock vera"],
    [10173, "Hybrid fleet rehab"], [10208, "Hybrid fleet banks center"],
    [10191, "Hybrid fleet october 4th"], [10210, "Hybrid fleet hadayek el ahram"],
    [10211, "Hybrid fleet maryoteya"], [10264, "Hybrid lebanon bc"],
    [10252, "Hybrid fleet mohafzet el giza"], [10256, "Hybrid fleet mosaddak"],
    [10262, "Hybrid fleet hadayek el ahram - area d"], [10227, "Hybrid fleet mokattam nafora"],
    [10241, "Hybrid fleet helwan"], [10215, "Hybrid fleet maadi meraag"],
    [10194, "Hybrid fleet october 6th"], [10237, "Hybrid fleet agouza"],
    [10114, "Ain shams (zatoun) 3"], [10198, "Hybrid fleet taqa"],
    [10221, "Hybrid fleet palm hills 360"], [10228, "Hybrid fleet maadi laselky"],
    [10250, "Hybrid fleet el nadi el gedid"], [10233, "Hybrid fleet shorouk 8th district"],
    [10177, "Hybrid fleet obour"], [10213, "Hybrid fleet el montazah"],
    [10265, "Hybrid taqseem laselky bc"], [10220, "Hybrid fleet october wahet el mohandseen"],
    [10260, "Obour golf hybrid fleet"], [10197, "Hybrid fleet tersa"],
    [10190, "Hybrid fleet talbya"], [10271, "Hybrid wahet el mohandsen bc"],
    [10269, "Hybrid maadi old bc"], [10192, "Shobra nesting 2"], [10273, "Hybrid fleet gardenia"],
    [10270, "Hybrid shobra bc"], [10277, "Hybrid el sayeda zeinab bc"],
    [10068, "Smart village dandy mall sp 1"], [10278, "Hybrid talbyia bc"],
    [10272, "Hybrid mohafzet el giza bc"], [10276, "Hybrid agouza bc"],
    [10281, "Hybrid fleet shorouk 4"], [10187, "Hybrid fleet shorouk 3rd"],
    [10025, "Sidi bishr sp"], [10027, "Gleem sp"], [10028, "Raml station sp"],
    [10079, "Al bitash sp"], [10085, "Semouha club sp"], [10144, "Kilo 21 sp"],
    [10199, "Gleem part-time sp"], [10200, "Gleem bicycle part-time sp"],
    [10201, "Raml station part-time sp"], [10202, "Raml station bicycle part-time sp"],
    [10203, "Semouha club bicycle part-time sp"], [10204, "Semouha club part-time sp"],
    [10205, "Sidi bishr bicycle part-time sp"], [10206, "Sidi bishr part-time sp"],
    [10239, "Hybrid fleet montaza"], [10240, "Hybrid fleet semouha plaza"],
    [10242, "Hybrid fleet ibrahimia"], [10247, "Hybrid fleet el seyouf"],
    [10254, "Hybrid fleet fleming"], [10255, "Hybrid fleet miami bc"]
  ];

  const zoneIdToNameMap = new Map();
  const zoneNameToIdMap = new Map();

  function normZoneStr(s) {
    return String(s || "")
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function stripTrailingSp(s) {
    return normZoneStr(s).replace(/\s+sp$/i, "").trim();
  }

  function registerZoneEntry(id, name) {
    const numId = Number(id);
    const cleanName = normZoneStr(name);
    if (!numId || !cleanName) return;
    zoneIdToNameMap.set(numId, cleanName);
    zoneNameToIdMap.set(cleanName, numId);
    const stripped = stripTrailingSp(cleanName);
    if (stripped && !zoneNameToIdMap.has(stripped)) {
      zoneNameToIdMap.set(stripped, numId);
    }
  }

  STATIC_ZONES.forEach(([id, name]) => registerZoneEntry(id, name));

  let lastDynamicCatalogSyncAt = 0;

  async function refreshDynamicZonesCatalogIfNeeded() {
    const now = Date.now();
    if (now - lastDynamicCatalogSyncAt < 10 * 60 * 1000) return;
    lastDynamicCatalogSyncAt = now;
    try {
      const data = await hurrierGet("/dispatcher-dashboard/cities");
      const cities = Array.isArray(data?.cities) ? data.cities : [];
      const catalogList = [];
      for (const c of cities) {
        const cityName = String(c?.name || "Cairo").trim();
        for (const z of c?.zones || []) {
          if (z && z.id && z.name) {
            registerZoneEntry(z.id, z.name);
            catalogList.push({ id: Number(z.id), name: String(z.name).trim(), city: cityName });
          }
        }
      }
      if (catalogList.length > 0) {
        firebaseReq("PUT", "/config/dynamic_zones_catalog", catalogList).catch(() => {});
      }
    } catch {}
  }

  function extractRecordZones(rec) {
    const order = rec?.order || {};
    const rawSps = Array.isArray(rec?.starting_points)
      ? rec.starting_points
      : Array.isArray(order?.drop_off_address?.starting_points)
      ? order.drop_off_address.starting_points
      : Array.isArray(order?.dropoff_address?.starting_points)
      ? order.dropoff_address.starting_points
      : Array.isArray(rec?.primary_delivery?.starting_points)
      ? rec.primary_delivery.starting_points
      : [];

    const ids = [];
    const names = [];

    for (const sp of rawSps) {
      if (typeof sp === "string") {
        const nl = normZoneStr(sp);
        if (nl) {
          names.push(nl);
          const mappedId = zoneNameToIdMap.get(nl) || zoneNameToIdMap.get(stripTrailingSp(nl));
          if (mappedId) ids.push(mappedId);
        }
      } else if (sp && typeof sp === "object") {
        if (sp.id) ids.push(Number(sp.id));
        if (sp.name) {
          const nl = normZoneStr(sp.name);
          if (nl) {
            names.push(nl);
            if (!sp.id) {
              const mappedId = zoneNameToIdMap.get(nl) || zoneNameToIdMap.get(stripTrailingSp(nl));
              if (mappedId) ids.push(mappedId);
            }
          }
        }
      }
    }

    return { ids, names };
  }

  function doesRecordMatchSessionZones(rec, zoneIdSet, hasManial, hasTahrir) {
    if (!zoneIdSet || zoneIdSet.size === 0) return true;
    const { ids, names } = extractRecordZones(rec);

    for (const id of ids) {
      if (zoneIdSet.has(Number(id))) return true;
    }

    for (const n of names) {
      if (hasManial && n.includes("manial")) return true;
      if (hasTahrir && n.startsWith("tahrir")) return true;
      const mappedId = zoneNameToIdMap.get(n) || zoneNameToIdMap.get(stripTrailingSp(n));
      if (mappedId && zoneIdSet.has(mappedId)) return true;
    }

    for (const selectedId of zoneIdSet) {
      const zName = zoneIdToNameMap.get(Number(selectedId));
      if (!zName) continue;
      const zStripped = stripTrailingSp(zName);
      if (names.some((n) => n === zName || stripTrailingSp(n) === zStripped)) {
        return true;
      }
    }

    return false;
  }

  // ============================================================================
  // 8) FOCUSED DELIVERY TABS FETCHING (ONLY Active, Dispatched, Queued)
  // ============================================================================
  const DELIVERY_ENDPOINTS = [
    { tab: "Active", path: "/dispatcher-dashboard/deliveries/active" },
    { tab: "Dispatched", path: "/dispatcher-dashboard/deliveries/dispatched" },
    { tab: "Queued", path: "/dispatcher-dashboard/deliveries/queued" }
  ];

  const cachedTabRecordsMap = new Map();
  let cachedDispatchersList = [];
  let lastDispatchersSyncAt = 0;
  let lastFullActiveSweepAt = 0;
  let lastKnownActivePageCount = 1;
  const previousWatchedLiveOrders = new Map();

  async function fetchSingleDeliveryPage(path, page) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const data = await hurrierGet(`${path}?page=${page}&per_page=50`);
        return { ok: true, records: Array.isArray(data?.records) ? data.records : [] };
      } catch {
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    return { ok: false, records: [] };
  }

  async function fetchAllDeliveryPages(path, maxPagesCap = 150) {
    const all = [];
    const seenIds = new Set();

    const addRecs = (recs) => {
      for (const r of recs) {
        const rid = String(r?.id || r?.order?.id || r?.order?.code || Math.random());
        if (!seenIds.has(rid)) {
          seenIds.add(rid);
          all.push(r);
        }
      }
    };

    const p1 = await fetchSingleDeliveryPage(path, 1);
    if (!p1.ok) return null;
    addRecs(p1.records);
    if (p1.records.length < 50) {
      return { records: all, totalPages: 1 };
    }

    let nextPage = 2;
    let totalPages = 1;
    while (nextPage <= maxPagesCap) {
      const batchPages = [];
      for (let i = 0; i < 6 && nextPage <= maxPagesCap; i++, nextPage++) {
        batchPages.push(nextPage);
      }
      const results = await Promise.all(batchPages.map((pg) => fetchSingleDeliveryPage(path, pg)));
      let reachedEnd = false;
      for (let i = 0; i < results.length; i++) {
        const res = results[i];
        if (res.ok && res.records.length > 0) {
          totalPages = Math.max(totalPages, batchPages[i]);
          addRecs(res.records);
          if (res.records.length < 50) {
            reachedEnd = true;
          }
        } else if (res.ok && res.records.length === 0) {
          reachedEnd = true;
        }
      }
      if (reachedEnd) break;
    }

    return { records: all, totalPages };
  }

  // ============================================================================
  // 9) SELECTED-ZONES COMPLETED ORDERS ENGINE (Exact Completed At • 1h / 2h)
  // ============================================================================
  const rollingCompletedPool = new Map();
  const exactCompletedMetaCache = new Map();
  const lastKnownCompletedPage = {};
  const backfilledZoneIds = new Set();

  let currentSyncZoneSig = "";
  let completedSyncGeneration = 0;
  let isCompletedSyncInProgress = false;
  let lastRollingCompletedSyncAt = 0;
  let lastMidWindowSweepAt = 0;
  let yesterdayCompletedBackfilledForSig = "";

  function parseValidTimestampMs(val) {
    if (!val) return 0;
    const s = String(val).trim();
    if (!s || s.startsWith("0001-01-01")) return 0;
    const ms = typeof val === "number" ? (val > 1e12 ? val : val * 1000) : new Date(s).getTime();
    return !Number.isNaN(ms) && ms > 946684800000 ? ms : 0;
  }

  function getCairoDateStringsForCompleted() {
    const now = new Date();
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Africa/Cairo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    });
    const hrFmt = new Intl.DateTimeFormat("en-US", {
      timeZone: "Africa/Cairo",
      hour: "numeric",
      hour12: false
    });
    const todayStr = fmt.format(now);
    const yesterdayStr = fmt.format(new Date(now.getTime() - 24 * 3600 * 1000));
    const cairoHour = Number(hrFmt.format(now)) % 24;
    return { todayStr, yesterdayStr, cairoHour };
  }

  function pruneRollingCompletedPool(unionZoneSet, hasManialUnion, hasTahrirUnion) {
    const cutoffMs = Date.now() - ROLLING_COMPLETED_WINDOW_MS - ROLLING_COMPLETED_GRACE_MS;
    for (const [key, rec] of rollingCompletedPool.entries()) {
      const compMs = Number(rec?.__completed_at_ms || 0);
      if (
        !compMs ||
        compMs < cutoffMs ||
        !doesRecordMatchSessionZones(rec, unionZoneSet, hasManialUnion, hasTahrirUnion)
      ) {
        rollingCompletedPool.delete(key);
      }
    }
  }

  async function resolveExactCompletedMetaForOrders(candidates) {
    if (!Array.isArray(candidates) || candidates.length === 0) return;

    for (let i = 0; i < candidates.length; i += 10) {
      const batch = candidates.slice(i, i + 10);
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

              if (stLower && stLower !== "completed") {
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
                        exactMs = parseValidTimestampMs(tr?.metadata?.performed_at);
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
                  cachedAt: Date.now(),
                  detailOrder: dOrder
                });
                return;
              }
            } catch {
              await new Promise((r) => setTimeout(r, 200));
            }
          }
        })
      );
    }
  }

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
    let added = 0;

    for (const { orderKey, rec } of candidates) {
      const meta = exactCompletedMetaCache.get(orderKey);
      if (!meta) continue;
      if (meta.cancelled) {
        rollingCompletedPool.delete(orderKey);
        continue;
      }
      if (meta.completedAtMs >= cutoffMs) {
        rollingCompletedPool.set(orderKey, {
          ...rec,
          __completed_at_ms: meta.completedAtMs
        });
        added++;
      }
    }
    return added;
  }

  async function safeFetchCompletedPage(dateStr, page) {
    const url = `${BASE_API}/dispatcher-dashboard/orders/completed?date=${encodeURIComponent(dateStr)}&page=${page}&per_page=50`;
    for (let attempt = 0; attempt < 3; attempt++) {
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
          await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
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
    let high = Math.max(1, lastKnownCompletedPage[dateStr] || 24);
    let lastNonEmptyRecords = [];

    const startRes = await safeFetchCompletedPage(dateStr, high);
    if (!startRes.ok) {
      return { ok: false, lastPage: lastKnownCompletedPage[dateStr] || 0, tailRecords: [] };
    }

    const startRecs = startRes.records || [];
    if (startRecs.length === 0) {
      high = Math.max(1, high - 1);
      const p1 = await safeFetchCompletedPage(dateStr, 1);
      const r1 = p1.ok && Array.isArray(p1.records) ? p1.records : [];
      if (r1.length === 0) {
        return { ok: p1.ok, lastPage: 0, tailRecords: [] };
      }
      lastNonEmptyRecords = r1;
      if (r1.length < 50) {
        lastKnownCompletedPage[dateStr] = 1;
        return { ok: true, lastPage: 1, tailRecords: r1 };
      }
    } else {
      low = high;
      lastNonEmptyRecords = startRecs;
      if (startRecs.length < 50) {
        lastKnownCompletedPage[dateStr] = high;
        return { ok: true, lastPage: high, tailRecords: startRecs };
      }
      let step = 48;
      while (high < 60000) {
        const nextProbe = Math.min(60000, high + step);
        const pRes = await safeFetchCompletedPage(dateStr, nextProbe);
        if (!pRes.ok) {
          high = nextProbe - 1;
          break;
        }
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
      if (!mRes.ok) {
        high = mid - 1;
        continue;
      }
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

  async function checkTransitionedLiveOrdersForCompletion(currentActiveAndDispRecords, unionZoneIds, hasManialUnion, hasTahrirUnion) {
    const currentCodes = new Set();
    for (const rec of currentActiveAndDispRecords) {
      if (!doesRecordMatchSessionZones(rec, unionZoneIds, hasManialUnion, hasTahrirUnion)) continue;
      const order = rec?.order || {};
      const code = String(
        order.code ||
          order.confirmation_number ||
          String(order.order_code || "").replace(/^(HF_[A-Z]{2}|ODR_[A-Z]{2})/i, "") ||
          ""
      ).trim();
      if (code) {
        currentCodes.add(code);
        previousWatchedLiveOrders.set(code, rec);
      }
    }

    const vanished = [];
    for (const [code, prevRec] of previousWatchedLiveOrders.entries()) {
      if (!currentCodes.has(code)) {
        previousWatchedLiveOrders.delete(code);
        if (!rollingCompletedPool.has(code)) {
          vanished.push({ code, prevRec });
        }
      }
    }

    if (vanished.length === 0) return;

    await Promise.allSettled(
      vanished.slice(0, 8).map(async ({ code, prevRec }) => {
        try {
          const detailData = await hurrierGet(
            `/dispatcher-dashboard/orders/detail?code=${encodeURIComponent(code)}`
          );
          const dOrder = detailData?.order || detailData || {};
          if (String(dOrder.status || "").toLowerCase() === "completed") {
            const exactMs =
              parseValidTimestampMs(dOrder.current_state_transition) ||
              parseValidTimestampMs(dOrder.event_timestamp) ||
              Date.now();
            exactCompletedMetaCache.set(code, {
              completedAtMs: exactMs,
              cancelled: false,
              cachedAt: Date.now()
            });
            const prevOrder = prevRec?.order || {};
            rollingCompletedPool.set(code, {
              order: {
                ...prevOrder,
                ...dOrder,
                confirmation_number: code,
                status: "completed",
                drop_off_address: {
                  ...(prevOrder.dropoff_address || prevOrder.drop_off_address || {}),
                  ...(dOrder.drop_off_address || {}),
                  starting_points: prevRec.starting_points || []
                }
              },
              primary_delivery: {
                courier_name: prevRec.courier_name || "-",
                courier_id: prevRec.courier_id || null,
                delivery_distance: prevRec.distance || 0
              },
              primary_delivery_timings: {},
              __completed_at_ms: exactMs
            });
          }
        } catch {}
      })
    );
  }

  function triggerRollingCompletedSyncIfNeeded(unionZoneIds, hasManialUnion, hasTahrirUnion) {
    const sortedIds = Array.from(unionZoneIds).sort((a, b) => a - b);
    const zoneSig = sortedIds.join(",");

    pruneRollingCompletedPool(unionZoneIds, hasManialUnion, hasTahrirUnion);

    const hasNewZonesToCalculate = sortedIds.some((id) => !backfilledZoneIds.has(id));
    if (zoneSig !== currentSyncZoneSig) {
      currentSyncZoneSig = zoneSig;
      if (hasNewZonesToCalculate) {
        completedSyncGeneration++;
        isCompletedSyncInProgress = false;
      }
    }

    const now = Date.now();
    if (isCompletedSyncInProgress) return;
    if (!hasNewZonesToCalculate && now - lastRollingCompletedSyncAt < 12000) return;

    isCompletedSyncInProgress = true;
    lastRollingCompletedSyncAt = now;
    const myGen = ++completedSyncGeneration;

    (async () => {
      try {
        const { todayStr, yesterdayStr, cairoHour } = getCairoDateStringsForCompleted();
        const placedCutoffMs = Date.now() - 4 * 3600 * 1000;

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
              p >= 1 && batchPages.length < 6 && walked < maxPagesToWalk;
              p--, walked++
            ) {
              batchPages.push(p);
              curPage = p - 1;
            }
            const pageResults = await Promise.all(
              batchPages.map((pg) => safeFetchCompletedPage(dateStr, pg))
            );
            if (myGen !== completedSyncGeneration) return false;

            let oldestPageTooOld = false;
            for (let i = 0; i < pageResults.length; i++) {
              const pRes = pageResults[i];
              if (pRes.ok && Array.isArray(pRes.records) && pRes.records.length > 0) {
                await ingestCompletedRecordsBatch(
                  pRes.records,
                  unionZoneIds,
                  hasManialUnion,
                  hasTahrirUnion
                );
                if (i === pageResults.length - 1) {
                  const newestPlacedMs = parseValidTimestampMs(
                    pRes.records[pRes.records.length - 1]?.order?.placed_at
                  );
                  if (newestPlacedMs > 0 && newestPlacedMs < placedCutoffMs) {
                    oldestPageTooOld = true;
                  }
                }
              }
            }
            if (oldestPageTooOld) break;
          }
          return true;
        };

        const doMidWindowSweep = Date.now() - lastMidWindowSweepAt >= 60000;
        if (doMidWindowSweep) lastMidWindowSweepAt = Date.now();
        const pagesLimit = hasNewZonesToCalculate ? 2500 : doMidWindowSweep ? 30 : 8;

        const okToday = await scanSelectedZonesForDate(todayStr, pagesLimit);

        if (
          myGen === completedSyncGeneration &&
          cairoHour < 4 &&
          (hasNewZonesToCalculate || yesterdayCompletedBackfilledForSig !== `${yesterdayStr}|${zoneSig}`)
        ) {
          const okYest = await scanSelectedZonesForDate(yesterdayStr, 400);
          if (okYest && myGen === completedSyncGeneration) {
            yesterdayCompletedBackfilledForSig = `${yesterdayStr}|${zoneSig}`;
          }
        }

        if (okToday && myGen === completedSyncGeneration) {
          sortedIds.forEach((id) => backfilledZoneIds.add(id));
        }
      } catch {} finally {
        if (myGen === completedSyncGeneration) {
          isCompletedSyncInProgress = false;
        }
      }
    })();
  }

  // ============================================================================
  // 10) FAST ON-DEMAND WATCHER (Order Details, Live Rider Status, Rider Search)
  // ============================================================================
  let lastOrderReqHandledAt = 0;
  let lastCourierReqHandledAt = 0;
  let lastRiderSearchReqId = "";
  let isOnDemandBusy = false;

  function normalizeCourierObjectForDashboard(rawObj, fallbackId, fallbackName) {
    let c = rawObj;
    let guard = 0;
    while (c && typeof c === "object" && (c.courier || c.data) && guard < 4) {
      c = c.courier || c.data;
      guard++;
    }
    c = c && typeof c === "object" ? c : {};

    const tnw =
      c.temp_not_working ||
      c.temporary_not_working ||
      c.temp_break ||
      c.not_working ||
      c.current_shift?.temp_not_working ||
      null;

    const statusUntil =
      (tnw && typeof tnw === "object" ? tnw.until || tnw.end_at || tnw.ends_at || tnw.expires_at : "") ||
      c.temp_not_working_until ||
      c.not_working_until ||
      c.status_until ||
      "";

    const performedBy =
      (tnw && typeof tnw === "object" ? tnw.performed_by || tnw.created_by || tnw.actor : "") ||
      c.temp_not_working_performed_by ||
      c.performed_by ||
      "";

    const statusReason =
      (tnw && typeof tnw === "object" ? tnw.reason || tnw.reason_text : "") ||
      c.temp_not_working_reason ||
      c.not_working_reason ||
      c.reason ||
      "";

    const isTnwActive =
      c.is_temp_not_working === true ||
      c.is_temporary_not_working === true ||
      c.temp_not_working === true ||
      (tnw &&
        typeof tnw === "object" &&
        tnw.active !== false &&
        tnw.is_active !== false &&
        (tnw.active === true || tnw.is_active === true || Boolean(statusUntil) || Boolean(statusReason)));

    let statusStr = "";
    if (isTnwActive) {
      statusStr = "Temporary not working";
    } else {
      statusStr = String(
        (typeof c.status === "string" ? c.status : c.status?.state || c.status?.name) ||
          (typeof c.state === "string" ? c.state : c.state?.name) ||
          c.working_status ||
          c.courier_status ||
          c.current_shift?.status ||
          "Working"
      );
    }

    return {
      courierId: String(c.id || c.courier_id || fallbackId || ""),
      userId: String(c.user_id || c.userId || c.id || fallbackId || ""),
      name: String(c.name || c.courier_name || fallbackName || "").trim(),
      phone: String(c.phone_number || c.mobile || c.phone || "").trim(),
      vehicle: String(
        c.vehicle_type || c.vehicle?.name || (typeof c.vehicle === "string" ? c.vehicle : "") || "Motorbike"
      ),
      contract: String(
        c.contract_type || c.contract?.name || (typeof c.contract === "string" ? c.contract : "") || ""
      ),
      balance: c.balance ?? c.wallet_balance ?? c.cash_balance ?? null,
      status: statusStr,
      statusUntil: String(statusUntil || ""),
      performedBy: String(performedBy || ""),
      statusReason: String(statusReason || "")
    };
  }

  async function fetchLiveCourierDetailFromHurrier(cid, cname) {
    const endpointsToTry = [
      `/dispatcher-dashboard/couriers/${encodeURIComponent(cid)}`,
      `/dispatcher-dashboard/couriers/detail?id=${encodeURIComponent(cid)}`,
      `/hurrier/v1/couriers/${encodeURIComponent(cid)}`
    ];

    for (const ep of endpointsToTry) {
      try {
        const data = await hurrierGet(ep);
        if (data && typeof data === "object") {
          return data;
        }
      } catch {}
    }

    const searchTerms = [cid, cname].filter(Boolean);
    for (const term of searchTerms) {
      try {
        const sData = await hurrierGet(
          `/dispatcher-dashboard/couriers?page=1&per_page=20&search=${encodeURIComponent(term)}`
        );
        const list = Array.isArray(sData?.couriers)
          ? sData.couriers
          : Array.isArray(sData?.records)
          ? sData.records
          : Array.isArray(sData)
          ? sData
          : [];
        const match =
          list.find(
            (x) => String(x?.id || x?.courier_id) === String(cid) || String(x?.user_id) === String(cid)
          ) || list[0];
        if (match) return match;
      } catch {}
    }
    return null;
  }

  async function runOnDemandRequestsLoop() {
    if (!isCurrentLeader || isOnDemandBusy) return;
    isOnDemandBusy = true;
    try {
      const cfg = await firebaseReq("GET", "/config");
      if (!cfg || typeof cfg !== "object") return;

      const oReq = cfg.order_detail_req;
      if (oReq && oReq.code && Number(oReq.requestedAt || 0) > lastOrderReqHandledAt) {
        lastOrderReqHandledAt = Number(oReq.requestedAt);
        const code = String(oReq.code).trim();
        const orderCode = String(oReq.orderCode || `HF_EG${code}`).trim();
        const [detRes, delivRes, notesRes] = await Promise.allSettled([
          hurrierGet(`/dispatcher-dashboard/orders/detail?code=${encodeURIComponent(code)}`),
          hurrierGet(`/dispatcher-dashboard/orders/detail/deliveries?code=${encodeURIComponent(orderCode)}`),
          hurrierGet(`/dispatcher-dashboard/orders/dispatcher_notes?code=${encodeURIComponent(orderCode)}`)
        ]);
        await firebaseReq("PUT", `/order_details/${encodeURIComponent(code)}`, {
          detail: detRes.status === "fulfilled" ? detRes.value : null,
          deliveries: delivRes.status === "fulfilled" ? delivRes.value : null,
          notes: notesRes.status === "fulfilled" ? notesRes.value : null,
          updatedAt: Date.now()
        });
      }

      const cReq = cfg.courier_detail_req;
      if (cReq && cReq.courierId && Number(cReq.requestedAt || 0) > lastCourierReqHandledAt) {
        lastCourierReqHandledAt = Number(cReq.requestedAt);
        const cid = String(cReq.courierId).trim();
        const rawCourier = await fetchLiveCourierDetailFromHurrier(cid, cReq.courierName || "");
        if (rawCourier) {
          const normalized = normalizeCourierObjectForDashboard(rawCourier, cid, cReq.courierName || "");
          await firebaseReq("PUT", `/courier_details/${encodeURIComponent(cid)}`, {
            courier: rawCourier?.courier || rawCourier,
            normalized,
            updatedAt: Date.now()
          });
        }
      }

      const rsReq = cfg.rider_search_req;
      if (rsReq && rsReq.reqId && rsReq.reqId !== lastRiderSearchReqId && rsReq.query) {
        lastRiderSearchReqId = rsReq.reqId;
        const q = String(rsReq.query).trim();
        const foundList = [];
        const seenKeys = new Set();

        const pushCandidate = (rawC) => {
          if (!rawC) return;
          const norm = normalizeCourierObjectForDashboard(rawC, "", "");
          const k = norm.courierId || norm.userId || norm.name;
          if (k && !seenKeys.has(k)) {
            seenKeys.add(k);
            foundList.push(norm);
          }
        };

        try {
          const sData = await hurrierGet(
            `/dispatcher-dashboard/couriers?page=1&per_page=30&search=${encodeURIComponent(q)}`
          );
          const arr = Array.isArray(sData?.couriers)
            ? sData.couriers
            : Array.isArray(sData?.records)
            ? sData.records
            : Array.isArray(sData)
            ? sData
            : [];
          arr.forEach(pushCandidate);
        } catch {}

        if (/^\d{3,10}$/.test(q) && foundList.length === 0) {
          const direct = await fetchLiveCourierDetailFromHurrier(q, "");
          if (direct) pushCandidate(direct);
        }

        await firebaseReq("PUT", "/config/rider_search_res", {
          reqId: rsReq.reqId,
          query: q,
          results: foundList,
          updatedAt: Date.now()
        });
      }
    } catch {} finally {
      isOnDemandBusy = false;
    }
  }
  setInterval(runOnDemandRequestsLoop, 1200);

  // ============================================================================
  // 11) MAIN 2-SECOND LIVE SYNC CYCLE
  // ============================================================================
  let isSyncInProgress = false;

  async function runSyncCycle() {
    if (isSyncInProgress) return;
    isSyncInProgress = true;

    try {
      if (!acquireSamePcTabLock()) {
        isCurrentLeader = false;
        setBadge("#475569", `v${SCRIPT_VERSION} [2nd Tab Standby • Sync Active in Tab 1]`);
        return;
      }

      const authToken = await getValidFirebaseIdToken(false);
      if (!authToken) {
        setBadge("#b45309", `v${SCRIPT_VERSION} Open Dashboard Tab Once to Link Auth`);
        return;
      }

      const leaderOk = await ensureMultiPcLeadership();
      const sessionsObj = (await firebaseReq("GET", "/active_sessions")) || {};
      const now = Date.now();
      const activeSessions = Object.values(sessionsObj).filter(
        (s) =>
          s &&
          s.sessionId &&
          Array.isArray(s.zoneIds) &&
          s.zoneIds.length > 0 &&
          now - Number(s.lastSeen || 0) < 35000
      );

      if (!leaderOk) {
        setBadge(
          "#0f766e",
          `v${SCRIPT_VERSION} [Backup Standby] (${activeSessions.length} Viewers)`
        );
        return;
      }

      if (activeSessions.length === 0) {
        setBadge("#92400e", `v${SCRIPT_VERSION} [Primary Leader] Standby (0 Viewers)`);
        return;
      }

      await refreshDynamicZonesCatalogIfNeeded();

      const unionZoneIds = new Set();
      activeSessions.forEach((s) => {
        s.zoneIds.forEach((zid) => {
          const n = Number(zid);
          if (n > 0) unionZoneIds.add(n);
        });
      });
      const hasManialUnion = MANIAL_FAMILY_IDS.some((id) => unionZoneIds.has(id));
      const hasTahrirUnion = unionZoneIds.has(10022) || unionZoneIds.has(10163);

      const anyoneViewingDispatcherTab = activeSessions.some(
        (s) => s.activeTab === "Dispatcher Dashboard"
      );
      if (anyoneViewingDispatcherTab || now - lastDispatchersSyncAt >= 20000) {
        lastDispatchersSyncAt = now;
        hurrierGet("/issue-service/dispatcher_dashboard")
          .then((list) => {
            if (Array.isArray(list)) cachedDispatchersList = list;
          })
          .catch(() => {});
      }

      const doFullActiveSweep =
        !cachedTabRecordsMap.has("Active") || now - lastFullActiveSweepAt >= 6000;

      const [statsRes, ...tabFetchResults] = await Promise.allSettled([
        hurrierGet("/dispatcher-dashboard/stats"),
        ...DELIVERY_ENDPOINTS.map(async (ep) => {
          if (ep.tab === "Active" && !doFullActiveSweep) {
            const prevAll = cachedTabRecordsMap.get("Active") || [];
            const pagesToRefresh = new Set([1, 2]);
            for (
              let p = Math.max(1, lastKnownActivePageCount - 4);
              p <= lastKnownActivePageCount + 1;
              p++
            ) {
              pagesToRefresh.add(p);
            }
            const refreshedPages = await Promise.all(
              Array.from(pagesToRefresh).map((pg) => fetchSingleDeliveryPage(ep.path, pg))
            );
            const mergedById = new Map();
            prevAll.forEach((r) => {
              const id = String(r?.id || r?.order?.id || r?.order?.code || "");
              if (id) mergedById.set(id, r);
            });
            refreshedPages.forEach((pr) => {
              if (pr.ok && pr.records.length > 0) {
                pr.records.forEach((r) => {
                  const id = String(r?.id || r?.order?.id || r?.order?.code || "");
                  if (id) mergedById.set(id, r);
                });
              }
            });
            return { tab: ep.tab, records: Array.from(mergedById.values()) };
          }

          const full = await fetchAllDeliveryPages(ep.path, ep.tab === "Active" ? 150 : 40);
          if (full && Array.isArray(full.records)) {
            if (ep.tab === "Active") {
              lastFullActiveSweepAt = Date.now();
              lastKnownActivePageCount = full.totalPages || 1;
            }
            cachedTabRecordsMap.set(ep.tab, full.records);
            return { tab: ep.tab, records: full.records };
          }
          return { tab: ep.tab, records: cachedTabRecordsMap.get(ep.tab) || [] };
        })
      ]);

      const allZoneStats = [];
      if (statsRes.status === "fulfilled" && Array.isArray(statsRes.value?.cities)) {
        for (const c of statsRes.value.cities) {
          const cityName = String(c?.city_name || "Cairo").trim();
          for (const z of c.zones || []) {
            const parentDelay = Number(z?.stat?.delay || 0);
            for (const sp of z.starting_points || []) {
              if (sp && sp.id) {
                const spStat = sp.stat || {};
                const rawDelay = Number(spStat.delay || 0) > 0 ? Number(spStat.delay) : parentDelay;
                allZoneStats.push({
                  id: Number(sp.id),
                  name: sp.name,
                  city: cityName,
                  zoneName: z.zone_name || "",
                  delay: Math.round(rawDelay * 10) / 10,
                  stat: spStat
                });
              }
            }
          }
        }
      }

      const latestTabRecords = {};
      for (const r of tabFetchResults) {
        if (r.status === "fulfilled" && r.value?.tab) {
          latestTabRecords[r.value.tab] = r.value.records;
        }
      }

      const combinedLiveRecs = [
        ...(latestTabRecords["Active"] || []),
        ...(latestTabRecords["Dispatched"] || [])
      ];
      checkTransitionedLiveOrdersForCompletion(
        combinedLiveRecs,
        unionZoneIds,
        hasManialUnion,
        hasTahrirUnion
      ).catch(() => {});

      triggerRollingCompletedSyncIfNeeded(unionZoneIds, hasManialUnion, hasTahrirUnion);

      const activeViewersSummary = activeSessions.map((s) => ({
        sessionId: s.sessionId,
        email: s.email || "",
        employeeName: s.employeeName || s.email || "Viewer",
        zoneCount: Array.isArray(s.zoneIds) ? s.zoneIds.length : 0,
        activeTab: s.activeTab || "Active"
      }));

      let primaryActiveMatched = 0;

      await Promise.all(
        activeSessions.map(async (sess) => {
          const sessZoneSet = new Set((sess.zoneIds || []).map(Number).filter((n) => n > 0));
          const sessHasManial = MANIAL_FAMILY_IDS.some((id) => sessZoneSet.has(id));
          const sessHasTahrir = sessZoneSet.has(10022) || sessZoneSet.has(10163);

          const sessTabRecords = {};
          const sessCounts = {};
          const activeCouriersMap = new Map();

          for (const ep of DELIVERY_ENDPOINTS) {
            const rawList = latestTabRecords[ep.tab] || [];
            const matched = rawList.filter((rec) =>
              doesRecordMatchSessionZones(rec, sessZoneSet, sessHasManial, sessHasTahrir)
            );
            sessTabRecords[ep.tab] = matched;
            sessCounts[ep.tab] = matched.length;

            if (ep.tab === "Active" || ep.tab === "Dispatched") {
              matched.forEach((rec) => {
                const cid = rec?.courier_id ? String(rec.courier_id) : "";
                if (!cid) return;
                const { ids: recZIds, names: recZNames } = extractRecordZones(rec);
                const prev = activeCouriersMap.get(cid) || {
                  id: cid,
                  courier_id: cid,
                  name: rec.courier_name || `Courier #${cid}`,
                  status: "Working",
                  vehicle_type: "Motorbike",
                  active_orders_count: 0,
                  dispatched_orders_count: 0,
                  zoneIds: [],
                  zoneNames: []
                };
                if (ep.tab === "Active") prev.active_orders_count += 1;
                if (ep.tab === "Dispatched") prev.dispatched_orders_count += 1;
                recZIds.forEach((zid) => {
                  if (!prev.zoneIds.includes(zid)) prev.zoneIds.push(zid);
                });
                recZNames.forEach((zn) => {
                  if (!prev.zoneNames.includes(zn)) prev.zoneNames.push(zn);
                });
                activeCouriersMap.set(cid, prev);
              });
            }
          }

          primaryActiveMatched = Math.max(primaryActiveMatched, sessCounts["Active"] || 0);

          const sessCompleted = Array.from(rollingCompletedPool.values())
            .filter((rec) =>
              doesRecordMatchSessionZones(rec, sessZoneSet, sessHasManial, sessHasTahrir)
            )
            .sort((a, b) => Number(b.__completed_at_ms || 0) - Number(a.__completed_at_ms || 0));

          const sessZoneStats = allZoneStats.filter((zs) => {
            if (sessZoneSet.has(Number(zs.id))) return true;
            const nl = normZoneStr(zs.name);
            if (sessHasManial && nl.includes("manial")) return true;
            if (sessHasTahrir && nl.startsWith("tahrir")) return true;
            return false;
          });
          const sessCouriers = Array.from(activeCouriersMap.values());

          await firebaseReq("PUT", `/session_bundles/${encodeURIComponent(sess.sessionId)}`, {
            updatedAt: Date.now(),
            version: SCRIPT_VERSION,
            tabRecords: sessTabRecords,
            completedRecords: sessCompleted,
            completedSyncing: isCompletedSyncInProgress,
            zoneStats: sessZoneStats,
            couriers: sessCouriers,
            dispatchers: cachedDispatchersList,
            counts: sessCounts,
            activeViewers: activeViewersSummary
          });
        })
      );

      const compLabel = isCompletedSyncInProgress
        ? `Syncing Comp (${rollingCompletedPool.size})`
        : `${rollingCompletedPool.size} Comp`;

      setBadge(
        "#15803d",
        `v${SCRIPT_VERSION} [Primary Leader] Live (2s) • ${activeSessions.length} Viewer • ${primaryActiveMatched} Act • ${compLabel}`
      );
    } catch (err) {
      setBadge("#b91c1c", `v${SCRIPT_VERSION} Sync Retry: ${err?.message || "Error"}`);
    } finally {
      isSyncInProgress = false;
    }
  }

  setTimeout(runSyncCycle, 300);
  setInterval(runSyncCycle, 2000);
})();
