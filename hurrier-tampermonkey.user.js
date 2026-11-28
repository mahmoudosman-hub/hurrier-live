// ... existing code ...
// @version      10.0
// @description  [v10.0] Unified Device Multi-Tab Instant Handoff + Full Active Deliveries Pagination & Zone Match + Shared 2h Completed Archive
// @updateURL    https://raw.githubusercontent.com/mahmoudosman-hub/hurrier-live/main/hurrier-tampermonkey.user.js
// ... existing code ...
  const SCRIPT_VERSION = "10.0";
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
// ... existing code ...
  // ============================================================================
  // 5) UNIFIED DEVICE MULTI-TAB INSTANT HANDOFF & MULTI-PC PRIMARY LEADER ELECTION
  // ============================================================================
  // All Hurrier tabs on the SAME PC share ONE persistent Device ID and ONE shared Leader ID
  // so opening/switching/closing multiple tabs hands off leadership in ~0s without Standby flicker,
  // while OTHER admins on DIFFERENT PCs remain in Backup Standby until this PC stops feeding.
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
// ... existing code ...
  async function fetchSingleDeliveryPage(path, page) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const data = await hurrierGet(`${path}?page=${page}&per_page=50`);
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
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    return { ok: false, records: [], totalHint: 0 };
  }

  async function fetchAllDeliveryPages(path, maxPagesCap = 180) {
    const all = [];
    const seenIds = new Set();

    const addRecs = (recs) => {
      for (const r of recs) {
        const rid = String(
          r?.id ?? r?.order?.id ?? r?.order?.code ?? r?.order?.order_code ?? ""
        ).trim();
        const dedupKey = rid || `idx_${all.length}_${Math.random().toString(36).slice(2, 7)}`;
        if (!seenIds.has(dedupKey)) {
          seenIds.add(dedupKey);
          all.push(r);
        }
      }
    };

    const p1 = await fetchSingleDeliveryPage(path, 1);
    if (!p1.ok) return null;
    addRecs(p1.records);

    const expectedTotalPages =
      p1.totalHint > 0 ? Math.min(maxPagesCap, Math.ceil(p1.totalHint / 50)) : 0;

    if (p1.records.length < 50 && (!expectedTotalPages || expectedTotalPages <= 1)) {
      return { records: all, totalPages: 1 };
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

      const results = await Promise.all(batchPages.map((pg) => fetchSingleDeliveryPage(path, pg)));
      let batchHadRecords = false;
      let explicitEndReached = false;

      for (let i = 0; i < results.length; i++) {
        const res = results[i];
        if (res.ok && res.records.length > 0) {
          batchHadRecords = true;
          totalPages = Math.max(totalPages, batchPages[i]);
          addRecs(res.records);
          if (res.records.length < 50 && (!expectedTotalPages || batchPages[i] >= expectedTotalPages)) {
            explicitEndReached = true;
          }
        } else if (res.ok && res.records.length === 0) {
          explicitEndReached = true;
        }
      }

      if (!batchHadRecords) {
        consecutiveEmptyBatches++;
        if (consecutiveEmptyBatches >= 2) break;
      } else {
        consecutiveEmptyBatches = 0;
        if (explicitEndReached && (!expectedTotalPages || totalPages >= expectedTotalPages)) {
          break;
        }
      }
    }

    return { records: all, totalPages };
  }

  // ============================================================================
// ... existing code ...
    try {
      if (!acquireSamePcTabLock()) {
        isCurrentLeader = false;
        setBadge("#0f766e", `v${SCRIPT_VERSION} [Device Tab Standby • Active Tab Feeding]`);
        return;
      }

      const authToken = await getValidFirebaseIdToken(false);
// ... existing code ...
      const doFullActiveSweep =
        !cachedTabRecordsMap.has("Active") || now - lastFullActiveSweepAt >= 5000;

      const [statsRes, ...tabFetchResults] = await Promise.allSettled([
        hurrierGet("/dispatcher-dashboard/stats"),
        ...DELIVERY_ENDPOINTS.map(async (ep) => {
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
              Array.from(pagesToRefresh).map((pg) => fetchSingleDeliveryPage(ep.path, pg))
            );
            const mergedById = new Map();
            prevAll.forEach((r, idx) => {
              const id = String(r?.id ?? r?.order?.id ?? r?.order?.code ?? `prev_${idx}`);
              mergedById.set(id, r);
            });
            refreshedPages.forEach((pr) => {
              if (pr.ok && pr.records.length > 0) {
                pr.records.forEach((r, idx) => {
                  const id = String(r?.id ?? r?.order?.id ?? r?.order?.code ?? `ref_${pr.records.length}_${idx}`);
                  mergedById.set(id, r);
                });
              }
            });
            return { tab: ep.tab, records: Array.from(mergedById.values()) };
          }

          const full = await fetchAllDeliveryPages(ep.path, ep.tab === "Active" ? 180 : 50);
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
// ... existing code ...
      // Build complete live Zone Name -> ID lookup from stats + catalog so zero starting_points are dropped
      const liveZoneNameToId = new Map();
      (Array.isArray(ALL_ZONES_CATALOG) ? ALL_ZONES_CATALOG : []).forEach((z) => {
        if (z?.id && z?.name) {
          liveZoneNameToId.set(String(z.name).trim().toLowerCase(), Number(z.id));
        }
      });
      if (statsRes.status === "fulfilled" && Array.isArray(statsRes.value?.cities)) {
        statsRes.value.cities.forEach((cityObj) => {
          (cityObj?.zones || []).forEach((zGrp) => {
            (zGrp?.starting_points || []).forEach((sp) => {
              if (sp?.id && sp?.name) {
                liveZoneNameToId.set(String(sp.name).trim().toLowerCase(), Number(sp.id));
              }
            });
          });
        });
      }

      // Ensure session bundle filtering matches Hurrier API starting_point_id[] 1:1 (including empty starting_points)
      const recordMatchesSessionZones = (rec, sessZoneIdSet, sessZoneNameSet) => {
        const rawSps = Array.isArray(rec?.starting_points)
          ? rec.starting_points
          : Array.isArray(rec?.order?.drop_off_address?.starting_points)
          ? rec.order.drop_off_address.starting_points
          : Array.isArray(rec?.order?.dropoff_address?.starting_points)
          ? rec.order.dropoff_address.starting_points
          : [];

        if (rawSps.length === 0) return true;

        return rawSps.some((sp) => {
          if (sp && typeof sp === "object" && sp.id && sessZoneIdSet.has(Number(sp.id))) {
            return true;
          }
          const spName = String(typeof sp === "string" ? sp : sp?.name || "")
            .trim()
            .toLowerCase();
          if (!spName) return false;
          if (sessZoneNameSet.has(spName)) return true;
          const mappedId = liveZoneNameToId.get(spName);
          if (mappedId && sessZoneIdSet.has(mappedId)) return true;
          const stripped = spName.replace(/\s+sp$/i, "").trim();
          const mappedStrippedId = liveZoneNameToId.get(`${stripped} sp`);
          return Boolean(mappedStrippedId && sessZoneIdSet.has(mappedStrippedId));
        });
      };
// ... existing code ...
