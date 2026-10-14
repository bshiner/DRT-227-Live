# DRT Live

A live bus tracker for **Durham Region Transit routes 227 and 224** (the Ajax
loop and the Ajax–Taunton corridor). Shows the real-time positions of all buses
on both routes on a map, auto-refreshing every 60 seconds, with predicted
arrivals at every stop on either route.

![stack](https://img.shields.io/badge/stack-Cloudflare%20Workers%20%2B%20Leaflet-006633)

## What it does

- **Route polylines** — 227A (clockwise, solid green) and 227B (counter-clockwise,
  dashed light green); 224 to Taunton (solid blue) and 224 to Ajax Station
  (dashed light blue), including branch shapes.
- **Live bus markers** — every bus currently assigned to either route, shown as
  a teardrop map pin colored by route with a bus glyph and a direction badge
  (A/B for 227, T for Taunton, A for Ajax Station). Click a bus for vehicle ID,
  trip ID, speed, heading, and status.
- **Stop dots with arrivals** — all 164 unique stops across both routes (92 on
  227, 79 on 224, 7 shared); click one for the next few predicted arrival times,
  live from the GTFS-RT TripUpdates feed, color-tagged per route.
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
- **Baked route data** (`app/data/routes.json`) — generated at build time from
  the Durham Region open-data GTFS zip by `scripts/build-data.mjs`: every
  direction's polylines (227: 961 + 954 points; 224: main + branch shapes per
  direction), all stops per route, and a tripId → direction map per route.

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
`app/data/routes.json`. The routes covered are listed in the `ROUTES` array at
the top of the script — add an entry (route id, app colors, direction labels) to
track another route, and add its id to `ROUTE_IDS` in `worker/wrangler.toml`.
Re-run when DRT publishes a new timetable.

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
| `GET /api/vehicles`    | Bus positions for the configured routes (default 227, 224): `{ok, feedTimestamp, fetchedAt, count, vehicles[]}` — each vehicle carries its `routeId` |
| `GET /api/tripupdates` | Trip updates with per-stop predicted arrival times for the configured routes; each tripUpdate carries its `routeId` |
| `GET /api/health`      | Liveness probe                                                     |

All endpoints are CORS-open (`*`). Timestamps are epoch **seconds**.
`currentStatus` is a numeric enum: `0` = INCOMING_AT, `1` = STOPPED_AT,
`2` = IN_TRANSIT_TO. The routes served are set by the `ROUTE_IDS` env var
(comma-separated) in `worker/wrangler.toml`.

## Notes & data quirks (verified against the live feed)

- **The VehiclePositions feed has no `direction_id`, no speed, and no bearing.**
  Direction is resolved client-side via the baked tripId → direction maps
  (from `trips.txt`); speed and heading are derived from consecutive position
  updates (haversine / initial bearing) and show `—` until the second sighting.
- **Route 227 serves 92 distinct stops** (47 clockwise / 46 counter-clockwise,
  overlapping) and **route 224 serves 79**; 7 stops are shared, so the map shows
  164 unique stop dots, each tagged with the routes that serve it.
- **Both routes' official `route_color` is 006633**, so the app assigns 224 its
  own blue (`#1f6fb2`) to keep the two routes visually distinct; direction is
  shown by solid vs dashed lines and by the badge letter on each bus pin.
- **Route 224 has branch shapes** (a second shape per direction used by a
  handful of trips) — all are rendered.
- Durham Region's GTFS files use **non-standard column orders** in `routes.txt`,
  `trips.txt`, and `stops.txt`; `scripts/build-data.mjs` maps columns by
  verified index. Shape IDs carry timetable-version suffixes
  (`...-2026-09` / `...-2026-10`); the bake prefers the newest variant while the
  trip maps cover both, since live vehicles can still reference the older one.
- GTFS-RT int64 fields arrive as Long objects and are normalized to numbers in
  the Worker before JSON serialization.

## Repo layout

```
app/                     # static frontend (deploy to Cloudflare Pages)
  index.html
  app.js                 # vanilla JS + Leaflet logic
  style.css
  config.js              # <-- set the deployed Worker URL here
  data/routes.json       # baked GTFS (regenerate via scripts/build-data.mjs)
worker/                  # Cloudflare Worker (deploy with wrangler)
  src/worker.js
  wrangler.toml
  test-decode.mjs        # exercises the decode/filter logic against live feeds
scripts/build-data.mjs   # GTFS zip -> app/data/routes.json
data-src/                # downloaded GTFS zip (gitignored)
```

Data © Durham Region Transit. Map tiles © OpenStreetMap contributors.
