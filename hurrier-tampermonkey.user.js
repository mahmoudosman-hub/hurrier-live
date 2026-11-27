// ==UserScript==
// @name         Hurrier Live Sync
// @namespace    https://hurrier-live.local/
// @version      9.4
// @description  [v9.4] Light Sync (Dashboard + Active Couriers + Queued + Dispatched + Active + Completed + Dispatcher)
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

  const SCRIPT_VERSION = "9.4";
  const GITHUB_SCRIPT_RAW_URL =
    "https://raw.githubusercontent.com/mahmoudosman-hub/hurrier-live/main/hurrier-tampermonkey.user.js";
  const FIREBASE_DB_URL =
    "https://hurrier-live-default-rtdb.europe-west1.firebasedatabase.app";
  const AUTH_BRIDGE_STORAGE_KEY = "hurrier_fb_bridge_auth";
  const GM_AUTH_BRIDGE_KEY = "hurrier_fb_bridge_auth_v1";

  const IS_HURRIER_HOST = location.hostname === "eg.me.logisticsbackoffice.com";

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

  async function fetchAllDeliveryPages(path, maxPagesCap = 120) {
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
        const placedCutoffMs = Date.now() - 3.5 * 3600 * 1000;

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
      vehicle: String(c.vehicle_type || c.vehicle?.name || (typeof c.vehicle === "string" ? c.vehicle : "") || "Motorbike"),
      contract: String(c.contract_type || c.contract?.name || (typeof c.contract === "string" ? c.contract : "") || ""),
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
          list.find((x) => String(x?.id || x?.courier_id) === String(cid) || String(x?.user_id) === String(cid)) ||
          list[0];
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

      // 1) Order Details Request
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

      // 2) Live Courier Details Request (Always Fresh on Modal Click)
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

      // 3) Live Rider Search Request
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

      // Lightweight Dispatcher Dashboard refresh only when needed (or every 20s)
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

      // Fetch ONLY /stats + Active + Dispatched + Queued
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

      // Extract Zone Stats + Delay from /stats (for Dashboard & Active Couriers)
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

      // Instant Transition Catcher (Active/Dispatched -> Completed) + Background Rolling 2h Sync
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

      // Publish Filtered Bundle per Connected Viewer Session
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
