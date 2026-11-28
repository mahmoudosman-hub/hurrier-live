// ==UserScript==
// @name         Hurrier Live Sync
// @namespace    https://mahmoudosman-hub.github.io/hurrier-live/
// @version      10.22
// @description  [v10.22] Ultra-Fast Order Transitions & Deliveries Loading (Non-Blocking Notes + 120ms Fast-Lane + Background Yield)
// @author       Mahmoud Mohammed
// ... existing code ...
(function () {
  "use strict";

  const SCRIPT_VERSION = "10.22";
  const GITHUB_SCRIPT_RAW_URL =
// ... existing code ...
  function isPriorityUrgentActive() {
    return Date.now() < priorityUrgentUntil;
  }

  async function waitWhilePriorityUrgent(maxWaitMs = 2200) {
    const start = Date.now();
    while (isPriorityUrgentActive() && Date.now() - start < maxWaitMs) {
      await new Promise((r) => setTimeout(r, 120));
    }
  }

  function buildStartingPointQueryParams(zoneIds) {
// ... existing code ...
    while (nextPage <= maxPagesCap) {
      if (expectedTotalPages > 0 && nextPage > expectedTotalPages) break;
      if (isPriorityUrgentActive()) {
        await waitWhilePriorityUrgent(2200);
      }

      const batchPages = [];
// ... existing code ...
    for (let i = 0; i < toFetch.length; i += 6) {
      if (isPriorityUrgentActive()) {
        await waitWhilePriorityUrgent(2200);
      }
      const chunk = toFetch.slice(i, i + 6);
      await Promise.all(
// ... existing code ...
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

            // Check if the order detail payload already embeds deliveries/transitions or notes
            const embeddedDeliveries =
              freshDetail?.deliveries || freshDetail?.order?.deliveries || null;
            if (!freshDeliveries && Array.isArray(embeddedDeliveries) && embeddedDeliveries.length > 0) {
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
// ... existing code ...
      const unionZoneIds = Array.from(unionZoneIdsSet);
      latestUnionZoneIds = unionZoneIds;
      latestActiveSessionsSnapshot = activeSessions;

      if (activeSessions.length === 0) {
        setBadge(
// ... existing code ...
  // Dedicated 120ms Fast-Lane for On-Demand Order Details, Notes, Courier Profiles & Searches
  let isFastOnDemandRunning = false;
  setInterval(async () => {
    if (isFastOnDemandRunning || !ownsLocalTabLock || !isCurrentLeader) return;
    isFastOnDemandRunning = true;
    try {
      await processOnDemandRequests();
    } catch {} finally {
      isFastOnDemandRunning = false;
    }
  }, 120);
})();
