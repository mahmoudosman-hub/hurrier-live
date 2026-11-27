// ==UserScript==
// @name         Hurrier Live Sync
// @namespace    https://hurrier-live.local/
// @version      9.6
// @description  [v9.6] Full Zone Couriers + Exact Courier Status & Balance + Fast Sync
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

  const SCRIPT_VERSION = "9.6";
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
  let lastFullActiveSweepAt = 0;
  let lastKnownActivePageCount = 1;
  const previousWatchedLiveOrders = new Map();

  // ============================================================================
  // 8.B) SELECTED ZONES COURIERS ENGINE (/dispatcher-dashboard/couriers?starting_point_id=...)
  // ============================================================================
  const zoneCouriersCacheMap = new Map();
  const couriersByCourierIdMap = new Map();
  const couriersByUserIdMap = new Map();
  let isCouriersSyncInProgress = false;
  let lastZoneCouriersSweepAt = 0;

  function formatCairo24hTime(isoVal) {
    if (!isoVal) return "";
    const s = String(isoVal).trim();
    if (!s || s.startsWith("0001-01-01")) return "";
    const d = typeof isoVal === "number" ? new Date(isoVal > 1e12 ? isoVal : isoVal * 1000) : new Date(s);
    if (Number.isNaN(d.getTime()) || d.getTime() <= 946684800000) return "";
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: "Africa/Cairo",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).format(d);
  }

  function mapZoneCourierItem(entry, fallbackZoneId) {
    const c = entry?.courier || {};
    const v = entry?.vehicle || {};
    const meta = entry?.current_state_metadata || {};
    const spId = Number(meta.starting_point_id || fallbackZoneId || 0);
    const spName = zoneIdToNameMap.get(spId) || "";
    const rawSt = String(c.status || "working").toLowerCase();

    let stateTime24h = "";
    if (rawSt === "break" || rawSt.includes("temp") || rawSt === "not_working") {
      stateTime24h = formatCairo24hTime(meta.ended_at || entry?.active_shift_ended_at);
    } else if (rawSt === "late" || rawSt === "ready" || rawSt === "starting") {
      stateTime24h = formatCairo24hTime(entry?.active_shift_started_at || meta.shift_started_at);
    } else if (rawSt === "ending") {
      stateTime24h = formatCairo24hTime(entry?.active_shift_ended_at || meta.shift_ended_at);
    }

    const vType = String(v.vehicle_type_name || "Bike").trim();
    const vBag = String(v.vehicle_bag_type_name || "").trim();

    const mapped = {
      id: String(c.id || ""),
      courier_id: String(c.id || ""),
      user_id: String(c.user_id || ""),
      name: String(c.name || "").trim(),
      phone_number: String(c.phone_number || "").trim(),
      status: rawSt,
      has_ending_shift: Boolean(entry?.has_ending_shift),
      vehicle_type: vType,
      vehicle_full: vBag ? `${vType}-${vBag}` : vType,
      contract_type: String(c.contract_type || "").trim(),
      contract_name: String(c.contract_name || "").trim(),
      active_orders_count: Number(entry?.active_delivery_count ?? 0),
      state_time_24h: stateTime24h,
      status_until: String(meta.ended_at || ""),
      performed_by: String(meta.performed_by || ""),
      status_reason: String(meta.reason || ""),
      starting_point_id: spId,
      zoneIds: spId ? [spId] : [],
      zoneNames: spName ? [spName] : []
    };

    if (mapped.id) couriersByCourierIdMap.set(mapped.id, mapped);
    if (mapped.user_id) couriersByUserIdMap.set(mapped.user_id, mapped);
    return mapped;
  }

  async function fetchZoneCouriersBatch(zoneIdsList) {
    for (let i = 0; i < zoneIdsList.length; i += 8) {
      const batch = zoneIdsList.slice(i, i + 8);
      await Promise.allSettled(
        batch.map(async (zid) => {
          try {
            const data = await hurrierGet(
              `/dispatcher-dashboard/couriers?starting_point_id=${encodeURIComponent(zid)}`
            );
            const rawList = Array.isArray(data?.couriers) ? data.couriers : [];
            const mappedList = rawList
              .map((item) => mapZoneCourierItem(item, zid))
              .filter((m) => m.id);
            zoneCouriersCacheMap.set(Number(zid), {
              updatedAt: Date.now(),
              couriers: mappedList
            });
          } catch {}
        })
      );
    }
  }

  async function syncSelectedZonesCouriers(unionZoneIds, hasManialUnion, hasTahrirUnion) {
    const expandedIds = new Set(Array.from(unionZoneIds).map(Number).filter((n) => n > 0));
    if (hasManialUnion) MANIAL_FAMILY_IDS.forEach((id) => expandedIds.add(id));
    if (hasTahrirUnion) {
      expandedIds.add(10022);
      expandedIds.add(10163);
    }

    const allTargetIds = Array.from(expandedIds);
    const uncachedIds = allTargetIds.filter((id) => !zoneCouriersCacheMap.has(id));

    if (uncachedIds.length > 0 && !isCouriersSyncInProgress) {
      isCouriersSyncInProgress = true;
      try {
        await fetchZoneCouriersBatch(uncachedIds);
        lastZoneCouriersSweepAt = Date.now();
      } finally {
        isCouriersSyncInProgress = false;
      }
      return;
    }

    const now = Date.now();
    if (!isCouriersSyncInProgress && now - lastZoneCouriersSweepAt >= 5000) {
      isCouriersSyncInProgress = true;
      lastZoneCouriersSweepAt = now;
      fetchZoneCouriersBatch(allTargetIds)
        .catch(() => {})
        .finally(() => {
          isCouriersSyncInProgress = false;
        });
    }
  }

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
  // 9) ROLLING COMPLETED ORDERS ENGINE (Selected Zones Only + Exact Completed Time)
  // ============================================================================
  const rollingCompletedPool = new Map();
  const completedExactTimeCache = new Map();
  let isCompletedSyncInProgress = false;
  let lastCompletedSweepAt = 0;
  let lastCompletedZonesSignature = "";
  let cachedLastCompletedPage = { dateStr: "", page: 1, ts: 0 };

  function getCairoDateStringsForWindow() {
    const now = new Date();
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Africa/Cairo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    });
    const hourFmt = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Africa/Cairo",
      hour: "2-digit",
      hour12: false
    });
    const todayStr = fmt.format(now);
    const cairoHour = parseInt(hourFmt.format(now), 10) || 0;
    const dates = [todayStr];
    if (cairoHour < 3) {
      const yest = new Date(now.getTime() - 24 * 3600 * 1000);
      dates.push(fmt.format(yest));
    }
    return dates;
  }

  async function fetchCompletedPage(dateStr, page) {
    try {
      const data = await hurrierGet(
        `/dispatcher-dashboard/orders/completed?date=${encodeURIComponent(dateStr)}&page=${page}&per_page=50`
      );
      return Array.isArray(data?.records) ? data.records : [];
    } catch {
      return [];
    }
  }

  async function findLastCompletedPageForDate(dateStr) {
    const now = Date.now();
    let low =
      cachedLastCompletedPage.dateStr === dateStr && now - cachedLastCompletedPage.ts < 60000
        ? Math.max(1, cachedLastCompletedPage.page - 2)
        : 1;

    const lowRecs = await fetchCompletedPage(dateStr, low);
    if (lowRecs.length === 0) {
      low = 1;
      const p1 = await fetchCompletedPage(dateStr, 1);
      if (p1.length === 0) return 0;
      if (p1.length < 50) return 1;
    } else if (lowRecs.length < 50) {
      cachedLastCompletedPage = { dateStr, page: low, ts: now };
      return low;
    }

    let step = 4;
    let high = low + step;
    while (high <= 60000) {
      const recs = await fetchCompletedPage(dateStr, high);
      if (recs.length === 0) break;
      low = high;
      if (recs.length < 50) {
        cachedLastCompletedPage = { dateStr, page: high, ts: now };
        return high;
      }
      step *= 2;
      high = Math.min(60000, low + step);
      if (high === low) break;
    }

    let left = low;
    let right = high;
    while (left < right) {
      const mid = Math.ceil((left + right) / 2);
      const recs = await fetchCompletedPage(dateStr, mid);
      if (recs.length > 0) {
        left = mid;
        if (recs.length < 50) break;
      } else {
        right = mid - 1;
      }
    }

    cachedLastCompletedPage = { dateStr, page: left, ts: now };
    return left;
  }

  function getCompletedRecordCode(rec) {
    const o = rec?.order || {};
    return String(
      o.confirmation_number ||
        o.code ||
        String(o.order_code || "").replace(/^(HF_[A-Z]{2}|ODR_[A-Z]{2})/i, "") ||
        o.id ||
        ""
    ).trim();
  }

  async function resolveExactCompletedTimeMs(rec) {
    const code = getCompletedRecordCode(rec);
    if (!code) return null;
    if (completedExactTimeCache.has(code)) {
      return completedExactTimeCache.get(code);
    }

    try {
      const det = await hurrierGet(`/dispatcher-dashboard/orders/detail?code=${encodeURIComponent(code)}`);
      const dOrder = det?.order || det;
      const st = String(dOrder?.status || "").toLowerCase();
      if (st.includes("cancel")) {
        completedExactTimeCache.set(code, { cancelled: true, ms: 0 });
        return { cancelled: true, ms: 0 };
      }
      const trIso = dOrder?.current_state_transition || dOrder?.event_timestamp || "";
      const trMs = trIso ? new Date(trIso).getTime() : 0;
      if (trMs > 946684800000) {
        const resObj = { cancelled: false, ms: trMs };
        completedExactTimeCache.set(code, resObj);
        return resObj;
      }
    } catch {}

    const placedIso = rec?.order?.placed_at || "";
    const fallbackMs = placedIso ? new Date(placedIso).getTime() : 0;
    return fallbackMs > 946684800000 ? { cancelled: false, ms: fallbackMs } : null;
  }

  async function ingestCompletedRecordsBatch(recs, unionZoneIds, hasManialUnion, hasTahrirUnion) {
    const cutoffMs = Date.now() - (ROLLING_COMPLETED_WINDOW_MS + ROLLING_COMPLETED_GRACE_MS);
    const zoneMatched = recs.filter((rec) => {
      const st = String(rec?.order?.status || rec?.status || "completed").toLowerCase();
      if (st.includes("cancel")) return false;
      return doesRecordMatchSessionZones(rec, unionZoneIds, hasManialUnion, hasTahrirUnion);
    });

    for (let i = 0; i < zoneMatched.length; i += 8) {
      const chunk = zoneMatched.slice(i, i + 8);
      await Promise.allSettled(
        chunk.map(async (rec) => {
          const code = getCompletedRecordCode(rec);
          if (!code) return;
          const exact = await resolveExactCompletedTimeMs(rec);
          if (!exact || exact.cancelled || !exact.ms) {
            rollingCompletedPool.delete(code);
            return;
          }
          if (exact.ms >= cutoffMs) {
            rollingCompletedPool.set(code, {
              ...rec,
              __completed_at_ms: exact.ms
            });
          }
        })
      );
    }
  }

  async function checkTransitionedLiveOrdersForCompletion(
    liveRecs,
    unionZoneIds,
    hasManialUnion,
    hasTahrirUnion
  ) {
    const currentCodes = new Set();
    const nextWatched = new Map();

    for (const rec of liveRecs) {
      if (!doesRecordMatchSessionZones(rec, unionZoneIds, hasManialUnion, hasTahrirUnion)) continue;
      const code = getCompletedRecordCode(rec);
      if (code) {
        currentCodes.add(code);
        nextWatched.set(code, rec);
      }
    }

    const disappeared = [];
    for (const [code, prevRec] of previousWatchedLiveOrders.entries()) {
      if (!currentCodes.has(code) && !rollingCompletedPool.has(code)) {
        disappeared.push({ code, prevRec });
      }
    }

    previousWatchedLiveOrders.clear();
    for (const [k, v] of nextWatched.entries()) {
      previousWatchedLiveOrders.set(k, v);
    }

    if (disappeared.length === 0) return;

    await Promise.allSettled(
      disappeared.slice(0, 8).map(async ({ code, prevRec }) => {
        try {
          const det = await hurrierGet(`/dispatcher-dashboard/orders/detail?code=${encodeURIComponent(code)}`);
          const dOrder = det?.order || det;
          const st = String(dOrder?.status || "").toLowerCase();
          if (st !== "completed") return;
          const trIso = dOrder?.current_state_transition || dOrder?.event_timestamp || "";
          const trMs = trIso ? new Date(trIso).getTime() : Date.now();
          completedExactTimeCache.set(code, { cancelled: false, ms: trMs });
          const synthRec = {
            order: {
              ...(prevRec?.order || {}),
              ...dOrder,
              confirmation_number: code,
              status: "completed",
              drop_off_address: {
                ...(dOrder?.drop_off_address || prevRec?.order?.dropoff_address || {}),
                starting_points: prevRec?.starting_points || []
              }
            },
            primary_delivery: {
              courier_name: prevRec?.courier_name || "",
              courier_id: prevRec?.courier_id || null,
              delivery_distance: prevRec?.distance || 0
            },
            primary_delivery_timings: {},
            __completed_at_ms: trMs
          };
          rollingCompletedPool.set(code, synthRec);
        } catch {}
      })
    );
  }

  async function syncRollingCompletedOrdersPool(
    unionZoneIds,
    hasManialUnion,
    hasTahrirUnion,
    isFullSweep
  ) {
    const dates = getCairoDateStringsForWindow();
    const placedStopCutoffMs = Date.now() - 4.5 * 3600 * 1000;

    for (const dateStr of dates) {
      const lastPage = await findLastCompletedPageForDate(dateStr);
      if (lastPage <= 0) continue;

      const maxPagesToScan = isFullSweep ? 45 : 8;
      const minPage = Math.max(1, lastPage - maxPagesToScan + 1);

      for (let p = lastPage; p >= minPage; p -= 5) {
        const batchPages = [];
        for (let k = 0; k < 5 && p - k >= minPage; k++) {
          batchPages.push(p - k);
        }
        const pageArrays = await Promise.all(
          batchPages.map((pg) => fetchCompletedPage(dateStr, pg))
        );
        const flatRecs = pageArrays.flat();
        if (flatRecs.length === 0) break;

        await ingestCompletedRecordsBatch(
          flatRecs,
          unionZoneIds,
          hasManialUnion,
          hasTahrirUnion
        );

        let oldestPlacedInBatch = Infinity;
        for (const r of flatRecs) {
          const pMs = r?.order?.placed_at ? new Date(r.order.placed_at).getTime() : 0;
          if (pMs > 0 && pMs < oldestPlacedInBatch) oldestPlacedInBatch = pMs;
        }
        if (oldestPlacedInBatch < placedStopCutoffMs) {
          break;
        }
      }
    }

    const pruneCutoffMs = Date.now() - (ROLLING_COMPLETED_WINDOW_MS + ROLLING_COMPLETED_GRACE_MS);
    for (const [code, rec] of rollingCompletedPool.entries()) {
      if (Number(rec?.__completed_at_ms || 0) < pruneCutoffMs) {
        rollingCompletedPool.delete(code);
      }
    }
  }

  function triggerRollingCompletedSyncIfNeeded(unionZoneIds, hasManialUnion, hasTahrirUnion) {
    if (isCompletedSyncInProgress) return;
    const sig = Array.from(unionZoneIds).sort((a, b) => a - b).join(",");
    const zonesChanged = sig !== lastCompletedZonesSignature;
    const now = Date.now();

    if (!zonesChanged && now - lastCompletedSweepAt < 15000) return;

    const isFullSweep = zonesChanged || rollingCompletedPool.size === 0;
    lastCompletedZonesSignature = sig;
    lastCompletedSweepAt = now;
    isCompletedSyncInProgress = true;

    syncRollingCompletedOrdersPool(unionZoneIds, hasManialUnion, hasTahrirUnion, isFullSweep)
      .catch(() => {})
      .finally(() => {
        isCompletedSyncInProgress = false;
      });
  }

  // ============================================================================
  // 10) FAST ON-DEMAND WATCHER (Order Details, Exact Courier Detail + Balance, Rider Search)
  // ============================================================================
  let lastOrderReqHandledAt = 0;
  let lastCourierReqHandledAt = 0;
  let lastRiderSearchReqId = "";
  let isOnDemandBusy = false;

  function normalizeCourierObjectForDashboard(rawObj, balanceVal, fallbackId, fallbackName) {
    let c = rawObj;
    let guard = 0;
    while (c && typeof c === "object" && (c.courier || c.data) && guard < 4) {
      c = c.courier || c.data;
      guard++;
    }
    c = c && typeof c === "object" ? c : {};

    const meta = c.status_meta_data || c.current_state_metadata || {};
    const rawSt = String(
      typeof c.status === "string" ? c.status : c.status?.state || c.status?.name || ""
    )
      .trim()
      .toLowerCase();

    let statusStr = "Working";
    if (
      rawSt === "break" ||
      rawSt.includes("temp_not_working") ||
      rawSt.includes("temporary_not_working") ||
      rawSt.includes("temp_break") ||
      rawSt.includes("temp_offline")
    ) {
      statusStr = "Temporary not working";
    } else if (rawSt === "ending") {
      statusStr = "Ending";
    } else if (rawSt === "ready" || rawSt === "starting") {
      statusStr = "Starting";
    } else if (rawSt === "late") {
      statusStr = "Late";
    } else if (rawSt === "not_working" || rawSt === "offline") {
      statusStr = "Not working";
    } else if (rawSt === "working") {
      statusStr = "Working";
    } else if (rawSt) {
      statusStr = rawSt;
    }

    const isBreakOrOffline =
      statusStr === "Temporary not working" || statusStr === "Not working";

    const vehicleStr =
      typeof c.vehicle === "string" && c.vehicle.trim()
        ? c.vehicle.trim()
        : c.vehicle?.vehicle_type_name
        ? [c.vehicle.vehicle_type_name, c.vehicle.vehicle_bag_type_name].filter(Boolean).join("-")
        : String(c.vehicle_full || c.vehicle_type || "Bike-Standard box");

    return {
      courierId: String(c.id || c.courier_id || fallbackId || ""),
      userId: String(c.user_id || c.userId || ""),
      name: String(c.name || c.courier_name || fallbackName || "").trim(),
      phone: String(c.phone_number || c.mobile || c.phone || "").trim(),
      vehicle: vehicleStr,
      contract: String(c.contract_info?.type || c.contract_type || "").trim(),
      contractName: String(c.contract_info?.name || c.contract_name || "").trim(),
      balance: balanceVal ?? c.balance ?? null,
      rawStatus: rawSt,
      status: statusStr,
      statusUntil: isBreakOrOffline ? String(c.status_until || meta.ended_at || "") : "",
      performedBy: isBreakOrOffline ? String(meta.performed_by || "") : "",
      statusReason: isBreakOrOffline ? String(meta.reason || "") : ""
    };
  }

  async function fetchLiveCourierDetailAndBalance(idOrUserId, cname) {
    const cleanKey = String(idOrUserId || "").trim();
    let realCourierId = cleanKey;

    if (!couriersByCourierIdMap.has(cleanKey) && couriersByUserIdMap.has(cleanKey)) {
      realCourierId = couriersByUserIdMap.get(cleanKey).id;
    }

    try {
      const detailData = await hurrierGet(
        `/dispatcher-dashboard/courier/detail?courier_id=${encodeURIComponent(realCourierId)}`
      );
      const cObj = detailData?.courier || detailData;
      if (cObj && (cObj.id || cObj.user_id || cObj.phone_number)) {
        let balanceVal = null;
        if (cObj.user_id) {
          try {
            const balData = await hurrierGet(
              `/dispatcher-dashboard/v3/couriers/${encodeURIComponent(cObj.user_id)}/balance`
            );
            if (balData && balData.balance !== undefined) {
              balanceVal = balData.balance;
            }
          } catch {}
        }
        return { courierObj: cObj, balanceVal };
      }
    } catch {}

    const cachedFromZone =
      couriersByCourierIdMap.get(realCourierId) ||
      couriersByUserIdMap.get(cleanKey) ||
      (cname
        ? Array.from(couriersByCourierIdMap.values()).find(
            (x) => normZoneStr(x.name) === normZoneStr(cname)
          )
        : null);

    if (cachedFromZone) {
      let balanceVal = null;
      if (cachedFromZone.user_id) {
        try {
          const balData = await hurrierGet(
            `/dispatcher-dashboard/v3/couriers/${encodeURIComponent(cachedFromZone.user_id)}/balance`
          );
          if (balData && balData.balance !== undefined) {
            balanceVal = balData.balance;
          }
        } catch {}
      }
      return { courierObj: cachedFromZone, balanceVal };
    }

    return null;
  }

  function normalizePhoneDigitsForMatch(rawStr) {
    const digits = String(rawStr || "").replace(/\D/g, "");
    if (!digits) return { rawDigits: "", core10: "" };
    let core = digits;
    if (core.startsWith("0020") && core.length >= 13) core = core.slice(4);
    else if (core.startsWith("20") && core.length === 12 && core[2] === "1") core = core.slice(2);
    else if (core.startsWith("0") && core.length === 11 && core[1] === "1") core = core.slice(1);
    return {
      rawDigits: digits,
      core10: core.length === 10 && core.startsWith("1") ? core : ""
    };
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
        const reqKey = String(cReq.courierId).trim();
        const liveRes = await fetchLiveCourierDetailAndBalance(reqKey, cReq.courierName || "");
        if (liveRes && liveRes.courierObj) {
          const normalized = normalizeCourierObjectForDashboard(
            liveRes.courierObj,
            liveRes.balanceVal,
            reqKey,
            cReq.courierName || ""
          );
          const payload = {
            courier: liveRes.courierObj,
            balance: liveRes.balanceVal,
            normalized,
            requestedAt: Number(cReq.requestedAt),
            updatedAt: Date.now()
          };
          await firebaseReq("PUT", `/courier_details/${encodeURIComponent(reqKey)}`, payload);
          if (normalized.courierId && normalized.courierId !== reqKey) {
            await firebaseReq(
              "PUT",
              `/courier_details/${encodeURIComponent(normalized.courierId)}`,
              payload
            );
          }
        }
      }

      const rsReq = cfg.rider_search_req;
      if (rsReq && rsReq.reqId && rsReq.reqId !== lastRiderSearchReqId && rsReq.query) {
        lastRiderSearchReqId = rsReq.reqId;
        const rawQ = String(rsReq.query).trim();
        const cleanDigits = rawQ.replace(/^#/, "");
        const qLower = rawQ.toLowerCase();
        const qPhone = normalizePhoneDigitsForMatch(rawQ);

        const matchedIds = new Set();
        const candidateIds = [];

        for (const c of couriersByCourierIdMap.values()) {
          const cPhone = normalizePhoneDigitsForMatch(c.phone_number || "");
          const uidMatch =
            c.user_id &&
            (c.user_id === cleanDigits || (cleanDigits.length >= 5 && c.user_id.includes(cleanDigits)));
          const cidMatch = c.id === cleanDigits;
          const phoneMatch =
            (qPhone.core10 && cPhone.core10 === qPhone.core10) ||
            (qPhone.rawDigits.length >= 7 && cPhone.rawDigits.includes(qPhone.rawDigits));
          const nameMatch =
            c.name && !/^\d+$/.test(cleanDigits) && c.name.toLowerCase().includes(qLower);

          if ((uidMatch || cidMatch || phoneMatch || nameMatch) && !matchedIds.has(c.id)) {
            matchedIds.add(c.id);
            candidateIds.push(c.id);
          }
        }

        if (/^\d{3,10}$/.test(cleanDigits) && candidateIds.length === 0) {
          candidateIds.push(cleanDigits);
        }

        const foundList = [];
        const topIds = candidateIds.slice(0, 6);
        await Promise.allSettled(
          topIds.map(async (cid) => {
            const liveRes = await fetchLiveCourierDetailAndBalance(cid, "");
            if (liveRes && liveRes.courierObj) {
              foundList.push(
                normalizeCourierObjectForDashboard(liveRes.courierObj, liveRes.balanceVal, cid, "")
              );
            }
          })
        );

        await firebaseReq("PUT", "/config/rider_search_res", {
          reqId: rsReq.reqId,
          query: rawQ,
          results: foundList,
          updatedAt: Date.now()
        });
      }
    } catch {} finally {
      isOnDemandBusy = false;
    }
  }
  setInterval(runOnDemandRequestsLoop, 700);

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

      await syncSelectedZonesCouriers(unionZoneIds, hasManialUnion, hasTahrirUnion);

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
          const sessCouriersMap = new Map();

          const sessExpandedZoneSet = new Set(sessZoneSet);
          if (sessHasManial) MANIAL_FAMILY_IDS.forEach((id) => sessExpandedZoneSet.add(id));
          if (sessHasTahrir) {
            sessExpandedZoneSet.add(10022);
            sessExpandedZoneSet.add(10163);
          }

          for (const zid of sessExpandedZoneSet) {
            const zEntry = zoneCouriersCacheMap.get(Number(zid));
            if (zEntry && Array.isArray(zEntry.couriers)) {
              zEntry.couriers.forEach((c) => {
                const key = `${zid}_${c.id}`;
                sessCouriersMap.set(key, c);
              });
            }
          }

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
                if (!cid || couriersByCourierIdMap.has(cid)) return;
                const fallbackKey = `ord_${cid}`;
                if (!sessCouriersMap.has(fallbackKey)) {
                  const { ids: recZIds, names: recZNames } = extractRecordZones(rec);
                  sessCouriersMap.set(fallbackKey, {
                    id: cid,
                    courier_id: cid,
                    user_id: "",
                    name: rec.courier_name || `Courier #${cid}`,
                    phone_number: "",
                    status: "",
                    vehicle_type: "Bike",
                    vehicle_full: "Bike-Standard box",
                    active_orders_count: ep.tab === "Active" ? 1 : 0,
                    starting_point_id: 0,
                    zoneIds: recZIds,
                    zoneNames: recZNames
                  });
                }
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
          const sessCouriers = Array.from(sessCouriersMap.values());

          await firebaseReq("PUT", `/session_bundles/${encodeURIComponent(sess.sessionId)}`, {
            updatedAt: Date.now(),
            version: SCRIPT_VERSION,
            tabRecords: sessTabRecords,
            completedRecords: sessCompleted,
            completedSyncing: isCompletedSyncInProgress,
            zoneStats: sessZoneStats,
            couriers: sessCouriers,
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
