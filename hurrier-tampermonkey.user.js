// ==UserScript==
// @name         Hurrier Live Sync
// @namespace    https://mahmoudosman-hub.github.io/hurrier-live/
// @version      10.18
// @description  [v10.18] Exact 64-bit Order/Delivery ID Parser (Fixes 18-digit Rounding 404s & Split Collisions) + Priority Fast-Lane (<1s Order Logs) + VO# Fallback Lookup
// @author       Mahmoud Mohammed
// ... existing code ...
(function () {
  "use strict";

  const SCRIPT_VERSION = "10.18";
  const GITHUB_SCRIPT_RAW_URL =
// ... existing code ...
    return "";
  }

  // Preserve 16+ digit integer IDs (18-digit Hurrier order.id / delivery.id) as exact strings
  // before JSON.parse so IEEE-754 floating-point rounding never alters the last digits into 404s.
  function parseHurrierJsonSafe(rawText) {
    if (!rawText || typeof rawText !== "string") return null;
    const safeText = rawText.replace(/([:\[,]\s*)(-?\d{16,})(?=\s*[,\]\}])/g, '$1"$2"');
    return JSON.parse(safeText);
  }

  async function hurrierGet(path) {
    const url = path.startsWith("http") ? path : `${BASE_API}${path}`;
    const jwt = getHurrierBearerToken();
    const headers = {
      Accept: "application/json"
    };
    if (jwt) {
      headers.Authorization = `Bearer ${jwt}`;
    }
    const res = await fetch(url, {
      method: "GET",
      headers,
      credentials: "include"
    });
    if (!res.ok) throw new Error(`HURRIER_${res.status}`);
    const rawText = await res.text();
    return parseHurrierJsonSafe(rawText);
  }

  // ============================================================================
// ... existing code ...
  // Processed Request Trackers & Priority Fast-Lane Gate
  const processedOrderDetailReqs = new Map();
  const orderDetailAttemptCounts = new Map();
  let lastHandledCourierDetailTs = 0;
  let lastHandledRiderSearchId = "";
  const processedCompletedIdReqs = new Map();
  const processedCompletedRangeReqs = new Map();
  let priorityUrgentUntil = 0;

  function triggerPriorityFastLane(durationMs = 2500) {
    priorityUrgentUntil = Math.max(priorityUrgentUntil, Date.now() + durationMs);
  }

  function isPriorityUrgentActive() {
    return Date.now() < priorityUrgentUntil;
  }

  function buildStartingPointQueryParams(zoneIds) {
// ... existing code ...
    while (nextPage <= maxPagesCap) {
      if (expectedTotalPages > 0 && nextPage > expectedTotalPages) break;
      if (isPriorityUrgentActive()) {
        await new Promise((r) => setTimeout(r, 350));
      }

      const batchPages = [];
// ... existing code ...
    for (let i = 0; i < toFetch.length; i += 6) {
      if (isPriorityUrgentActive()) break;
      const chunk = toFetch.slice(i, i + 6);
// ... existing code ...
  // Catch orders that disappear from Active/Dispatched and turn into Completed in real time
  function resolveInternalOrderId(code, explicitInternalId = "", vendorOrderNumber = "") {
    const cleanCode = String(code || "")
      .trim()
      .replace(/^(HF_[A-Z]{2}|ODR_[A-Z]{2})/i, "")
      .trim();
    const cleanVo = String(vendorOrderNumber || "").trim();

    // 1) Prefer fresh exact-string 18-digit order.id from live in-memory tabs (never rounded)
    for (const tabKey of ["Active", "Dispatched", "Queued"]) {
      const list = cachedTabRecordsMap.get(tabKey) || [];
      for (const r of list) {
        const ord = r?.order || {};
        const rCode = String(
          ord.code ||
            ord.confirmation_number ||
            String(ord.order_code || "").replace(/^(HF_[A-Z]{2}|ODR_[A-Z]{2})/i, "") ||
            ""
        ).trim();
        const rVo = String(ord.vendor_order_number || "").trim();
        if ((cleanCode && rCode === cleanCode) || (cleanVo && cleanVo !== "-" && rVo === cleanVo)) {
          const oid = String(ord.id || r?.id || "").trim();
          if (oid && oid !== cleanCode) return oid;
        }
      }
    }

    // 2) Check sharedCompletedMap (both by confirmation code and VO#)
    if (cleanCode && sharedCompletedMap.has(cleanCode)) {
      const fromComp = sharedCompletedMap.get(cleanCode);
      const compOid = String(fromComp?.order?.id || "").trim();
      if (compOid && compOid !== cleanCode) return compOid;
    }
    if (cleanVo && cleanVo !== "-") {
      for (const rec of sharedCompletedMap.values()) {
        const ord = rec?.order || {};
        if (String(ord.vendor_order_number || "").trim() === cleanVo) {
          const compOid = String(ord.id || "").trim();
          if (compOid && compOid !== cleanCode) return compOid;
        }
      }
    }

    if (cleanCode && prevLiveOrdersMap.has(cleanCode)) {
      const fromPrev = prevLiveOrdersMap.get(cleanCode);
      const prevOid = String(fromPrev?.order?.id || fromPrev?.id || "").trim();
      if (prevOid && prevOid !== cleanCode) return prevOid;
    }

    const exp = String(explicitInternalId || "").trim();
    if (exp && exp !== cleanCode) return exp;
    return "";
  }

  async function catchCompletedTransitionsFromLiveOrders(globalTabRecords) {
// ... existing code ...
    // A) Per-Order Detail + Deliveries + Dispatcher Notes Requests (Parallel + Retry + Zero Null Overwrite)
    try {
      const reqs = await firebaseReq("GET", "/config/order_detail_reqs");
      if (reqs && typeof reqs === "object") {
        const entries = Object.entries(reqs).filter(([, v]) => v && v.code);
        if (entries.length > 0) {
          triggerPriorityFastLane(2500);
        }
        await Promise.all(
          entries.slice(0, 6).map(async ([key, req]) => {
            const code = String(req.code).trim();
            const reqTs = Number(req.requestedAt || 0);
            const reqSig = `${reqTs}`;
            if (processedOrderDetailReqs.get(code) === reqSig) return;
            processedOrderDetailReqs.set(code, reqSig);

            const orderCode = String(req.orderCode || `HF_EG${code}`).trim();
            const vendorOrderNumber = String(req.vendorOrderNumber || "").trim();
            const internalId = resolveInternalOrderId(
              code,
              req.internalOrderId,
              vendorOrderNumber
            );

            const fetchOrderDetailAnyId = async () => {
              if (internalId && internalId !== code) {
                try {
                  const rInt = await hurrierGetWithRetry(
                    `/orders/${encodeURIComponent(internalId)}`,
                    1,
                    200
                  );
                  if (rInt && (rInt.order || rInt.id || rInt.code)) return rInt;
                } catch {}
              }
              try {
                const r1 = await hurrierGetWithRetry(`/orders/${encodeURIComponent(code)}`, 1, 200);
                if (r1 && (r1.order || r1.id || r1.code)) return r1;
              } catch {}
              try {
                const rSearch = await hurrierGetWithRetry(
                  `/orders?code=${encodeURIComponent(code)}`,
                  1,
                  200
                );
                const foundOrd = Array.isArray(rSearch?.orders)
                  ? rSearch.orders[0]
                  : Array.isArray(rSearch?.records)
                  ? rSearch.records[0]?.order || rSearch.records[0]
                  : rSearch?.order || null;
                if (foundOrd && foundOrd.id) {
                  return await hurrierGetWithRetry(
                    `/orders/${encodeURIComponent(String(foundOrd.id))}`,
                    1,
                    200
                  );
                }
              } catch {}
              return null;
            };

            const fetchOrderDeliveriesAnyId = async () => {
              if (internalId && internalId !== code) {
                try {
                  const dInt = await hurrierGetWithRetry(
                    `/orders/${encodeURIComponent(internalId)}/deliveries`,
                    2,
                    200
                  );
                  const listInt = Array.isArray(dInt?.deliveries)
                    ? dInt.deliveries
                    : Array.isArray(dInt?.records)
                    ? dInt.records
                    : Array.isArray(dInt)
                    ? dInt
                    : [];
                  if (listInt.length > 0) return dInt;
                } catch {}
              }
              try {
                const d1 = await hurrierGetWithRetry(
                  `/orders/${encodeURIComponent(code)}/deliveries`,
                  1,
                  200
                );
                const list1 = Array.isArray(d1?.deliveries)
                  ? d1.deliveries
                  : Array.isArray(d1?.records)
                  ? d1.records
                  : Array.isArray(d1)
                  ? d1
                  : [];
                if (list1.length > 0) return d1;
              } catch (err) {
                if (!internalId) throw err;
              }
              return null;
            };
// ... existing code ...
            const payload = {
              code,
              detail: finalDetail,
              deliveries: finalDeliveries,
              deliveriesFetched: Boolean(hasDeliveries || isGenuine404),
              notFound: isGenuine404,
              notes: finalNotes,
              updatedAt: Date.now()
            };
            await firebaseReq("PUT", `/order_details/${encodeURIComponent(code)}`, payload);
          })
        );
      }
    } catch {}

    // B) On-Demand Courier Detail + Balance
    try {
      const cReq = await firebaseReq("GET", "/config/courier_detail_req");
      if (cReq && cReq.courierId && Number(cReq.requestedAt || 0) > lastHandledCourierDetailTs) {
        triggerPriorityFastLane(2000);
        lastHandledCourierDetailTs = Number(cReq.requestedAt);
// ... existing code ...
  async function runSyncTick() {
    if (isSyncTickRunning || isPriorityUrgentActive()) return;
    isSyncTickRunning = true;
// ... existing code ...
  // Dedicated 250ms Fast-Lane for On-Demand Order Details, Notes, Courier Profiles & Searches
  let isFastOnDemandRunning = false;
  setInterval(async () => {
    if (isFastOnDemandRunning || !ownsLocalTabLock || !isCurrentLeader) return;
    isFastOnDemandRunning = true;
    try {
      await processOnDemandRequests();
    } catch {} finally {
      isFastOnDemandRunning = false;
    }
  }, 250);
})();
