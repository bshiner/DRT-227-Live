#!/usr/bin/env node
/**
 * scripts/build-data.mjs — bake DRT route data into static JSON for the frontend.
 *
 * Reads data-src/GTFS_Durham_TXT.zip (Durham Region Open Data GTFS feed) and
 * writes app/data/routes.json covering every route in ROUTES below. No npm
 * dependencies; runs with plain `node scripts/build-data.mjs` (Node 18+).
 *
 * NOTE: this feed uses non-standard column orders in several files — the
 * column indices below were verified against the live feed and are not the
 * canonical GTFS order.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const ZIP_PATH = join(ROOT, 'data-src', 'GTFS_Durham_TXT.zip');
const OUT_PATH = join(ROOT, 'app', 'data', 'routes.json');

// Routes to bake. Official route_color is 006633 for both, so 224 gets its own
// app hue to keep the two routes visually distinct; per-direction colors are
// solid (direction 0) vs a lighter variant (direction 1, dashed on the map).
const ROUTES = [
  {
    id: '227',
    color: '#006633',
    dirColors: { 0: '#006633', 1: '#4c9a77' },
    dirLabels: { 0: '227A', 1: '227B' },
  },
  {
    id: '224',
    color: '#1f6fb2',
    dirColors: { 0: '#1f6fb2', 1: '#7aa8d4' },
    dirLabels: { 0: '224 to Taunton', 1: '224 to Ajax Station' },
  },
];

// ---------- minimal zip reader (stored + deflated entries) ----------
function readZipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = {};
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break; // central directory header
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const data = buf.subarray(dataStart, dataStart + compSize);
    entries[name] = method === 0 ? data : inflateRawSync(data);
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// ---------- tiny CSV parser (handles quoted fields, CRLF) ----------
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function csvTable(entries, filename) {
  const rows = parseCsv(entries[filename].toString('utf8'));
  return rows.slice(1).filter(r => r.length && r.some(f => f !== ''));
}

// ---------- main ----------
// Durham Region open-data GTFS zip (their own gtfs host is WAF-blocked).
const GTFS_URL = 'https://maps.durham.ca/OpenDataGTFS/GTFS_Durham_TXT.zip';
if (!existsSync(ZIP_PATH)) {
  console.log(`downloading ${GTFS_URL}`);
  mkdirSync(dirname(ZIP_PATH), { recursive: true });
  const res = await fetch(GTFS_URL);
  if (!res.ok) throw new Error(`GTFS download failed: HTTP ${res.status}`);
  writeFileSync(ZIP_PATH, Buffer.from(await res.arrayBuffer()));
}

const buf = readFileSync(ZIP_PATH);
const entries = readZipEntries(buf);

// routes.txt: route_desc,route_url,route_color,route_id,route_type,route_long_name,agency_id,route_short_name,route_text_color
const routeRows = csvTable(entries, 'routes.txt');
// trips.txt: trip_headsign,trip_id,direction_name,route_id,wheelchair_accessible,block_id,service_id,direction_id,shape_id
const tripRows = csvTable(entries, 'trips.txt');
// shapes.txt: shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence,shape_dist_traveled
const shapeRows = csvTable(entries, 'shapes.txt');
// stop_times.txt: trip_id,arrival_time,departure_time,stop_id,stop_sequence,... (standard order)
const stopTimeRows = csvTable(entries, 'stop_times.txt');
// stops.txt: stop_code,zone_id,parent_station,stop_timezone,stop_url,location_type,stop_lon,wheelchair_boarding,stop_lat,stop_id,stop_name,preferred,stop_desc
const stopRows = csvTable(entries, 'stops.txt');

// shape points grouped by shape_id
const shapes = new Map();
for (const s of shapeRows) {
  if (!shapes.has(s[0])) shapes.set(s[0], []);
  shapes.get(s[0]).push({ lat: parseFloat(s[1]), lon: parseFloat(s[2]), seq: parseInt(s[3], 10) });
}

// stops by id
const stopsById = new Map();
for (const s of stopRows) {
  stopsById.set(s[9], { stopId: s[9], name: s[10], lat: round6(parseFloat(s[8])), lon: round6(parseFloat(s[6])) });
}

function buildRoute(spec) {
  const route = routeRows.find(r => r[3] === spec.id);
  if (!route) throw new Error(`route ${spec.id} not found in routes.txt`);

  const trips = tripRows.filter(t => t[3] === spec.id);
  if (!trips.length) throw new Error(`no trips for route ${spec.id}`);

  // direction_id -> shape ids used (prefer the -2026-10 timetable variant per
  // base shape; some routes have a main shape plus branch shapes per direction).
  // The live VehiclePositions feed carries tripId but NOT directionId, so the
  // tripId -> direction map baked here is what lets the frontend color buses.
  const dirShapes = new Map(); // directionId -> Map(baseShapeId -> best shapeId)
  const dirHeadsign = new Map();
  const tripMap = [];
  for (const t of trips) {
    const directionId = Number(t[7]);
    const shapeId = t[8];
    if (!dirShapes.has(directionId)) dirShapes.set(directionId, new Map());
    const m = dirShapes.get(directionId);
    const base = shapeId.replace(/_Timetable_-_\d{4}-\d{2}$/, '');
    const cur = m.get(base);
    if (!cur || shapeId > cur) m.set(base, shapeId); // "-2026-10" > "-2026-09"
    if (!dirHeadsign.has(directionId)) dirHeadsign.set(directionId, t[0]);
    tripMap.push({
      tripId: t[1],
      directionId,
      headsign: t[0],
      label: spec.dirLabels[directionId] ?? String(directionId),
    });
  }

  const directions = [...dirShapes.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([directionId, bestByBase]) => {
      const shapeIds = [...bestByBase.values()];
      const geometries = shapeIds.map(shapeId => {
        const pts = (shapes.get(shapeId) || [])
          .slice()
          .sort((a, b) => a.seq - b.seq)
          .map(p => [round6(p.lon), round6(p.lat)]);
        if (pts.length === 0) throw new Error(`no shape points for ${shapeId}`);
        return { type: 'LineString', coordinates: pts };
      });
      return {
        directionId,
        label: spec.dirLabels[directionId] ?? String(directionId),
        headsign: dirHeadsign.get(directionId),
        color: spec.dirColors[directionId] ?? spec.color,
        shapeIds,
        geometries,
      };
    });

  // stops served by this route (distinct stop_ids across ALL its trips)
  const tripIds = new Set(trips.map(t => t[1]));
  const servedStopIds = new Set();
  for (const st of stopTimeRows) {
    if (tripIds.has(st[0])) servedStopIds.add(st[3]);
  }
  const missing = [...servedStopIds].filter(id => !stopsById.has(id));
  if (missing.length) throw new Error(`stop_ids referenced but missing from stops.txt: ${missing.join(', ')}`);
  const stops = [...servedStopIds]
    .map(id => stopsById.get(id))
    .sort((a, b) => (a.stopId < b.stopId ? -1 : a.stopId > b.stopId ? 1 : 0));

  return {
    id: spec.id,
    name: `Route ${spec.id}`,
    color: route[2],
    colorHex: spec.color,
    agency: route[6],
    directions,
    stops,
    trips: tripMap,
  };
}

const routes = ROUTES.map(buildRoute);

const out = {
  generatedFrom: 'GTFS_Durham_TXT.zip',
  routeIds: routes.map(r => r.id),
  routes,
};

mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, JSON.stringify(out, null, 1));

// ---------- verification ----------
console.log(`wrote ${OUT_PATH}`);
for (const r of routes) {
  console.log(`\nroute ${r.id} (${r.name}, color ${r.color}):`);
  for (const d of r.directions) {
    const pts = d.geometries.map(g => g.coordinates.length).join('+');
    console.log(`  ${d.label} (dir ${d.directionId}) shapes=${d.shapeIds.length} points=${pts} headsign="${d.headsign}"`);
  }
  console.log(`  stops: ${r.stops.length} | trips: ${r.trips.length}`);
}

const r227 = routes.find(r => r.id === '227');
if (!r227 || r227.directions.length !== 2) throw new Error('route 227: expected 2 directions');
for (const d of r227.directions) {
  if (d.geometries[0].coordinates.length < 50) throw new Error(`227 ${d.label}: too few shape points`);
}
const s3068 = r227.stops.find(s => s.stopId === '3068');
if (!s3068 || !s3068.name.includes('Range Line Eastbound @ Poplar')) {
  throw new Error('stop 3068 sanity check failed');
}
if (Math.abs(s3068.lat - 43.828856) > 0.001 || Math.abs(s3068.lon - -78.99938) > 0.001) {
  throw new Error('stop 3068 coordinates off');
}
const r224 = routes.find(r => r.id === '224');
if (!r224 || r224.directions.length !== 2) throw new Error('route 224: expected 2 directions');
if (r224.stops.length < 50) throw new Error('route 224: unexpected stop count');
console.log('\nALL CHECKS PASSED');

function round6(n) { return Math.round(n * 1e6) / 1e6; }
