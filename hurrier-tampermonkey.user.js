// ==UserScript==
// @name         Hurrier Live Sync
// @namespace    https://hurrier-live.local/
// @version      9.2
// @description  [v9.2] Clean Header + Reliable Selected-Zones Completed At (1h/2h) + Leader Fix
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

  const SCRIPT_VERSION = "9.2";
  const GITHUB_SCRIPT_RAW_URL =
    "https://raw.githubusercontent.com/mahmoudosman-hub/hurrier-live/main/hurrier-tampermonkey.user.js";
<!-- ... existing code ... -->
  let currentSyncZoneSig = "";
  let completedSyncGeneration = 0;
  let isCompletedSyncInProgress = false;
  let lastRollingCompletedSyncAt = 0;
  let lastMidWindowSweepAt = 0;
  let yesterdayCompletedBackfilledForSig = "";

  function getBridgedLeaderEmail() {
<!-- ... existing code ... -->
  // Exact Completed At Resolver for Selected Zones ONLY (Cached once per order, Rate-Limit Safe)
  async function resolveExactCompletedMetaForOrders(candidates) {
    if (!Array.isArray(candidates) || candidates.length === 0) return;

    for (let i = 0; i < candidates.length; i += 4) {
      const batch = candidates.slice(i, i + 4);
      await Promise.allSettled(
        batch.map(async ({ orderKey, orderCode }) => {
          if (exactCompletedMetaCache.has(orderKey)) return;
          for (let attempt = 0; attempt < 3; attempt++) {
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
              await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
            }
          }
        })
      );
      if (i + 4 < candidates.length) {
        await new Promise((r) => setTimeout(r, 60));
      }
    }
  }

  // Filter ONLY Selected Zones' Orders & Keep Strictly Last 2h by Verified Completed At
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
        addedInWindow++;
      }
    }
    return addedInWindow;
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
          await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
          continue;
        }
        if (!res.ok) return { ok: false, records: null };
        const data = await res.json();
        return { ok: true, records: Array.isArray(data?.records) ? data.records : [] };
      } catch {
        await new Promise((r) => setTimeout(r, 250));
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
      let step = 32;
      while (high < 50000) {
        const nextProbe = Math.min(50000, high + step);
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
<!-- ... existing code ... -->
    try {
      const { todayStr, yesterdayStr, cairoHour } = getCairoDateStringsForCompleted();
      const placedCutoffMs = now - 3.5 * 3600 * 1000;

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
            p >= 1 && batchPages.length < 4 && walked < maxPagesToWalk;
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

      const doMidWindowSweep = now - lastMidWindowSweepAt >= 60000;
      if (doMidWindowSweep) lastMidWindowSweepAt = now;
      const pagesLimit = hasNewZonesToCalculate ? 2500 : doMidWindowSweep ? 40 : 8;

      const okToday = await scanSelectedZonesForDate(todayStr, pagesLimit);

      if (
        myGen === completedSyncGeneration &&
        cairoHour < 3 &&
        (hasNewZonesToCalculate || yesterdayCompletedBackfilledForSig !== `${yesterdayStr}|${zoneSig}`)
      ) {
        const okYest = await scanSelectedZonesForDate(yesterdayStr, 400);
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
<!-- ... existing code ... -->
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

  setTimeout(runSyncCycle, 800);
  setInterval(runSyncCycle, 2000);
})();
