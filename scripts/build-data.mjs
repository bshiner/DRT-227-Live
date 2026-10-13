#!/usr/bin/env node
/**
 * scripts/build-data.mjs — bake DRT route 227 GTFS data into static JSON.
 *
 * Reads data-src/GTFS_Durham_TXT.zip (Durham Region Open Data GTFS feed) and
 * writes app/data/route-227.json for the static frontend. No npm dependencies;
 * runs with plain `node scripts/build-data.mjs` (Node 18+).
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
const OUT_PATH = join(ROOT, 'app', 'data', 'route-227.json');

const ROUTE_ID = '227';

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
  const header = rows[0];
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
const routes = csvTable(entries, 'routes.txt');
const route = routes.find(r => r[3] === ROUTE_ID);
if (!route) throw new Error(`route ${ROUTE_ID} not found in routes.txt`);
const routeColor = `#${route[2]}`;
const agencyId = route[6];

// 227A = clockwise (direction 0), 227B = counter-clockwise (direction 1)
const DIRECTION_LABELS = { 0: '227A', 1: '227B' };
const DIRECTION_COLORS = { 0: routeColor, 1: '#888888' };

// trips.txt: trip_headsign,trip_id,direction_name,route_id,wheelchair_accessible,block_id,service_id,direction_id,shape_id
// The live VehiclePositions feed carries tripId but NOT directionId, so we bake
// a tripId -> direction map here; the frontend uses it to color buses by loop.
const trips = csvTable(entries, 'trips.txt').filter(t => t[3] === ROUTE_ID);
console.log(`trips for route ${ROUTE_ID}: ${trips.length}`);

const tripMap = trips.map(t => ({
  tripId: t[1],
  directionId: Number(t[7]),
  headsign: t[0],
  label: DIRECTION_LABELS[Number(t[7])] ?? String(t[7]),
}));

// direction_id -> best shape_id (prefer the -2026-10 timetable variant)
const dirShapes = new Map(); // directionId -> { shapeId, headsign }
for (const t of trips) {
  const directionId = Number(t[7]);
  const shapeId = t[8];
  const headsign = t[0];
  const cur = dirShapes.get(directionId);
  if (!cur || shapeId > cur.shapeId) { // lexicographically "-2026-10" > "-2026-09"
    dirShapes.set(directionId, { shapeId, headsign });
  }
}
console.log('direction -> shape:', JSON.stringify([...dirShapes.entries()], null, 1));

// shapes.txt: shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence,shape_dist_traveled
const shapeRows = csvTable(entries, 'shapes.txt');
const shapes = new Map(); // shapeId -> [{lat,lon,seq}]
for (const s of shapeRows) {
  const id = s[0];
  if (!shapes.has(id)) shapes.set(id, []);
  shapes.get(id).push({ lat: parseFloat(s[1]), lon: parseFloat(s[2]), seq: parseInt(s[3], 10) });
}

const directions = [...dirShapes.entries()]
  .sort((a, b) => a[0] - b[0])
  .map(([directionId, { shapeId, headsign }]) => {
    const pts = (shapes.get(shapeId) || [])
      .slice()
      .sort((a, b) => a.seq - b.seq)
      .map(p => [round6(p.lon), round6(p.lat)]);
    if (pts.length === 0) throw new Error(`no shape points for ${shapeId}`);
    return {
      directionId,
      label: DIRECTION_LABELS[directionId] ?? String(directionId),
      headsign,
      color: DIRECTION_COLORS[directionId] ?? '#666666',
      shapeId,
      geometry: { type: 'LineString', coordinates: pts },
    };
  });

// stop_times.txt: trip_id,arrival_time,departure_time,stop_id,stop_sequence,... (standard order)
const tripIds = new Set(trips.map(t => t[1]));
const servedStopIds = new Set();
for (const st of csvTable(entries, 'stop_times.txt')) {
  if (tripIds.has(st[0])) servedStopIds.add(st[3]);
}

// stops.txt: stop_code,zone_id,parent_station,stop_timezone,stop_url,location_type,stop_lon,wheelchair_boarding,stop_lat,stop_id,stop_name,preferred,stop_desc
const stops = csvTable(entries, 'stops.txt')
  .filter(s => servedStopIds.has(s[9]))
  .map(s => ({ stopId: s[9], name: s[10], lat: round6(parseFloat(s[8])), lon: round6(parseFloat(s[6])) }))
  .sort((a, b) => (a.stopId < b.stopId ? -1 : a.stopId > b.stopId ? 1 : 0));

const missing = [...servedStopIds].filter(id => !stops.some(s => s.stopId === id));
if (missing.length) throw new Error(`stop_ids referenced but missing from stops.txt: ${missing.join(', ')}`);

const out = {
  route: { id: ROUTE_ID, name: `Route ${ROUTE_ID}`, color: routeColor.replace('#', ''), agency: agencyId },
  generatedFrom: 'GTFS_Durham_TXT.zip',
  trips: tripMap,
  directions,
  stops,
};

mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, JSON.stringify(out, null, 1));

// ---------- verification ----------
console.log(`\nwrote ${OUT_PATH}`);
console.log(`directions: ${out.directions.length}`);
for (const d of out.directions) {
  console.log(`  ${d.label} (dir ${d.directionId}) shape=${d.shapeId} points=${d.geometry.coordinates.length}`);
}
console.log(`stops: ${out.stops.length}`);
console.log(`trips: ${out.trips.length}`);
const s3068 = out.stops.find(s => s.stopId === '3068');
console.log(`stop 3068: ${s3068 ? `${s3068.name} @ ${s3068.lat}, ${s3068.lon}` : 'MISSING'}`);
if (out.directions.length !== 2) throw new Error('expected exactly 2 directions');
for (const d of out.directions) {
  if (d.geometry.coordinates.length < 50) throw new Error(`${d.label}: too few shape points`);
}
if (!s3068 || !s3068.name.includes('Range Line Eastbound @ Poplar')) {
  throw new Error('stop 3068 sanity check failed');
}
if (Math.abs(s3068.lat - 43.828856) > 0.001 || Math.abs(s3068.lon - -78.99938) > 0.001) {
  throw new Error('stop 3068 coordinates off');
}
console.log('\nALL CHECKS PASSED');

function round6(n) { return Math.round(n * 1e6) / 1e6; }
