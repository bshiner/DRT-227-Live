// gtfs-realtime-bindings is a CommonJS package: default-import and dig into
// transit_realtime (named import does not work in ESM or the Workers runtime).
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
const FeedMessage = GtfsRealtimeBindings.transit_realtime.FeedMessage;

// Routes to include, e.g. "227,224" (env ROUTE_IDS; default matches the app).
function parseRouteIds(env) {
  const raw = (env && env.ROUTE_IDS) || '227,224';
  return new Set(String(raw).split(',').map(s => s.trim()).filter(Boolean));
}

function toNum(v) {
  return (v && typeof v === 'object' && 'toNumber' in v) ? v.toNumber() : Number(v);
}

export function shapeVehicles(feedMessage, routeIds) {
  const ids = routeIds || new Set(['227']);
  const feedTimestamp = toNum(feedMessage?.header?.timestamp) || null;
  const fetchedAt = Math.round(Date.now() / 1000);
  const vehicles = [];
  for (const entity of (feedMessage?.entity || [])) {
    const v = entity?.vehicle;
    if (!v) continue;
    const routeId = v?.trip?.routeId;
    if (!ids.has(routeId)) continue;
    vehicles.push({
      routeId: routeId,
      vehicleId: v?.vehicle?.id,
      tripId: v?.trip?.tripId,
      startDate: v?.trip?.startDate,
      latitude: v?.position?.latitude,
      longitude: v?.position?.longitude,
      currentStopSequence: v?.currentStopSequence,
      currentStatus: v?.currentStatus,
      stopId: v?.stopId,
      timestamp: toNum(v?.timestamp) || null,
    });
  }
  return { ok: true, feedTimestamp, fetchedAt, count: vehicles.length, vehicles };
}

export function shapeTripUpdates(feedMessage, routeIds) {
  const ids = routeIds || new Set(['227']);
  const feedTimestamp = toNum(feedMessage?.header?.timestamp) || null;
  const fetchedAt = Math.round(Date.now() / 1000);
  const tripUpdates = [];
  for (const entity of (feedMessage?.entity || [])) {
    const tu = entity?.tripUpdate;
    if (!tu) continue;
    const routeId = tu?.trip?.routeId;
    if (!ids.has(routeId)) continue;
    const stopTimeUpdates = [];
    for (const stu of (tu?.stopTimeUpdate || [])) {
      stopTimeUpdates.push({
        stopId: stu?.stopId,
        stopSequence: stu?.stopSequence,
        arrivalTime: toNum(stu?.arrival?.time) || null,
        departureTime: toNum(stu?.departure?.time) || null,
        scheduleRelationship: stu?.scheduleRelationship,
      });
    }
    tripUpdates.push({
      routeId: routeId,
      tripId: tu?.trip?.tripId,
      startDate: tu?.trip?.startDate,
      stopTimeUpdates,
    });
  }
  return { ok: true, feedTimestamp, fetchedAt, count: tripUpdates.length, tripUpdates };
}

const cache = {};
const inflight = {};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  };
}

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(),
    },
  });
}

async function fetchAndShape(url, shapeFn, cacheKey, ttl) {
  const fresh = cache[cacheKey];
  if (fresh && fresh.expiresAt > Date.now() / 1000) return fresh.data;
  if (inflight[cacheKey]) return inflight[cacheKey];

  const promise = (async () => {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`upstream returned ${res.status}`);
      const buf = await res.arrayBuffer();
      const feedMessage = FeedMessage.decode(new Uint8Array(buf));
      const data = shapeFn(feedMessage);
      cache[cacheKey] = { data, expiresAt: Date.now() / 1000 + ttl };
      return data;
    } catch (e) {
      const entry = cache[cacheKey];
      if (entry && entry.data) return entry.data;
      throw new Error(`fetch/decode failed: ${e.message || e}`);
    } finally {
      delete inflight[cacheKey];
    }
  })();
  inflight[cacheKey] = promise;
  return promise;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (path === '/api/health') {
      return jsonResponse({ ok: true, service: 'drt-227-live' });
    }

    const ttl = Number(env?.CACHE_TTL || 45);
    const routeIds = parseRouteIds(env);

    try {
      if (path === '/api/vehicles') {
        const data = await fetchAndShape(
          env.UPSTREAM_VEHICLES,
          (feed) => shapeVehicles(feed, routeIds),
          'vehicles',
          ttl
        );
        return jsonResponse(data);
      }
      if (path === '/api/tripupdates') {
        const data = await fetchAndShape(
          env.UPSTREAM_TRIPUPDATES,
          (feed) => shapeTripUpdates(feed, routeIds),
          'tripupdates',
          ttl
        );
        return jsonResponse(data);
      }
      return jsonResponse({ ok: false, error: 'not found' }, 404);
    } catch (e) {
      return jsonResponse({ ok: false, error: e.message || String(e) }, 502);
    }
  },
};
