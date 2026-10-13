# DRT-227 Live

A live bus tracker for **Durham Region Transit route 227** (the Ajax loop).
Shows the real-time positions of all buses on route 227 on a map, auto-refreshing
every 60 seconds, with predicted arrivals at each of the 92 stops on the loop.

![stack](https://img.shields.io/badge/stack-Cloudflare%20Workers%20%2B%20Leaflet-006633)

## What it does

- **Route polylines** — 227A (clockwise, solid green) and 227B (counter-clockwise,
  dashed gray) rendered from baked-in GTFS shape data.
- **Live bus markers** — every bus currently assigned to route 227, colored by
  loop direction. Click a bus for vehicle ID, trip ID, speed, heading, and status.
- **Stop dots with arrivals** — all 92 stops; click one for the next few predicted
  arrival times, live from the GTFS-RT TripUpdates feed.
- **Staleness indicator** — if the newest feed data is more than 3 minutes old,
  the header turns amber and bus markers dim.
- **Mobile responsive** — usable at a bus stop; auto-refresh every 60 seconds.

## Architecture

```
┌────────────────────┐         ┌──────────────────────────┐        ┌───────────────────┐
│  Static frontend   │  poll   │  Cloudflare Worker       │  fetch │  DRT GTFS-RT      │
│  (Cloudflare Pages)│ ──────► │  /api/vehicles           │ ─────► │  VehiclePositions │
│  Leaflet + OSM     │  60 s   │  /api/tripupdates        │        │  TripUpdates      │
│  baked route data  │ ◄────── │  protobuf → JSON, filter │        │  (protobuf)       │
└────────────────────┘  JSON   │  route 227, CORS, 45 s   │        └───────────────────┘
                               │  in-memory cache         │
                               └──────────────────────────┘
```

- **Cloudflare Worker** (`worker/`) — stateless proxy. Fetches the DRT GTFS-RT
  protobuf feeds, decodes them with `gtfs-realtime-bindings`, filters to route 227,
  and returns clean JSON with `Access-Control-Allow-Origin: *`. Caches the upstream
  response for 45 s in-memory so all visitors share one upstream fetch. Serves the
  last good cached response if the upstream fails. No database.
- **Static frontend** (`app/`) — plain HTML + vanilla JS + Leaflet 1.9 with
  OpenStreetMap tiles. No framework, no build step.
- **Baked route data** (`app/data/route-227.json`) — generated at build time from
  the Durham Region open-data GTFS zip by `scripts/build-data.mjs`: both loop
  polylines (961 + 954 points), all 92 stops, and a tripId → direction map.

## Data sources (verified)

**Live GTFS-RT feeds** (no auth, protobuf, no CORS — hence the Worker):

- Vehicle positions: `https://drtonline.durhamregiontransit.com/gtfsrealtime/VehiclePositions`
- Trip updates: `https://drtonline.durhamregiontransit.com/gtfsrealtime/TripUpdates`

**Static GTFS**: `https://maps.durham.ca/OpenDataGTFS/GTFS_Durham_TXT.zip`
(~6.9 MB; DRT's own `drtonline.../gtfs/*.zip` host is WAF-blocked — 403).

## Local development

Prerequisites: Node.js 18+.

### 1. Run the Worker

```bash
cd worker
npm install
npx wrangler dev --port 8787
```

Check it (should return live route-227 JSON):

```bash
curl http://localhost:8787/api/health
curl http://localhost:8787/api/vehicles
curl http://localhost:8787/api/tripupdates
```

`worker/test-decode.mjs` is a dependency-free way to exercise the same decode +
filter logic against the live feeds without wrangler:

```bash
node worker/test-decode.mjs
```

### 2. Serve the frontend

The frontend expects the Worker at the URL in `app/config.js`
(defaults to `http://localhost:8787`):

```bash
cd app
python3 -m http.server 8080
# open http://localhost:8080/
```

### 3. Rebuild the static route data (optional)

```bash
node scripts/build-data.mjs
```

Downloads the GTFS zip to `data-src/` if missing and regenerates
`app/data/route-227.json`. Re-run when DRT publishes a new timetable.

## Deployment

### Worker (Cloudflare)

```bash
cd worker
npx wrangler deploy
```

Deploys as `drt-227-live-api` and prints the Worker URL, e.g.
`https://drt-227-live-api.<you>.workers.dev`.

### Frontend (Cloudflare Pages)

```bash
# from the repo root — publish the app/ directory
npx wrangler pages deploy app --project-name drt-227-live
```

Or connect the GitHub repo in the Cloudflare dashboard (Pages → create project →
this repo, build output directory: `app`, no build command).

### Wire them together

Edit `app/config.js` before deploying the frontend:

```js
window.DRT227_CONFIG = {
  workerBaseUrl: 'https://drt-227-live-api.<you>.workers.dev',
};
```

Both services are free-tier friendly: the Worker's 45 s in-memory cache keeps
upstream requests to ~1 per minute globally; Pages serves the static files.

## Worker API

| Endpoint           | Description                                                        |
| ------------------ | ------------------------------------------------------------------ |
| `GET /api/vehicles`    | Route-227 bus positions: `{ok, feedTimestamp, fetchedAt, count, vehicles[]}` |
| `GET /api/tripupdates` | Route-227 trip updates with per-stop predicted arrival times         |
| `GET /api/health`      | Liveness probe                                                     |

All endpoints are CORS-open (`*`). Timestamps are epoch **seconds**.
`currentStatus` is a numeric enum: `0` = INCOMING_AT, `1` = STOPPED_AT,
`2` = IN_TRANSIT_TO.

## Notes & data quirks (verified against the live feed)

- **The VehiclePositions feed has no `direction_id`, no speed, and no bearing.**
  Direction is resolved client-side via the baked tripId → direction map
  (from `trips.txt`); speed and heading are derived from consecutive position
  updates (haversine / initial bearing) and show `—` until the second sighting.
- **Route 227 serves 92 distinct stops** (47 clockwise / 46 counter-clockwise,
  overlapping) — not the 48 sometimes quoted.
- Durham Region's GTFS files use **non-standard column orders** in `routes.txt`,
  `trips.txt`, and `stops.txt`; `scripts/build-data.mjs` maps columns by
  verified index. Shape IDs carry timetable-version suffixes
  (`...-2026-09` / `...-2026-10`); the bake prefers the newest variant while the
  trip map covers both, since live vehicles can still reference the older one.
- GTFS-RT int64 fields arrive as Long objects and are normalized to numbers in
  the Worker before JSON serialization.

## Repo layout

```
app/                     # static frontend (deploy to Cloudflare Pages)
  index.html
  app.js                 # vanilla JS + Leaflet logic
  style.css
  config.js              # <-- set the deployed Worker URL here
  data/route-227.json    # baked GTFS (regenerate via scripts/build-data.mjs)
worker/                  # Cloudflare Worker (deploy with wrangler)
  src/worker.js
  wrangler.toml
  test-decode.mjs        # exercises the decode/filter logic against live feeds
scripts/build-data.mjs   # GTFS zip -> app/data/route-227.json
data-src/                # downloaded GTFS zip (gitignored)
```

Data © Durham Region Transit. Map tiles © OpenStreetMap contributors.
