/* DRT Live — vanilla JS client consuming the Cloudflare Worker proxy.
 * Covers all routes baked into data/routes.json (currently 227 and 224).
 * Depends only on Leaflet 1.9.x (loaded via CDN before this script).
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------- config
  var cfg = (window.DRT227_CONFIG && window.DRT227_CONFIG.workerBaseUrl)
    ? window.DRT227_CONFIG
    : { workerBaseUrl: 'http://localhost:8787' };
  var BASE = cfg.workerBaseUrl.replace(/\/+$/, '');

  // ---------------------------------------------------------------- state
  var map = null;
  var busLayer = null;                 // L.layerGroup for live bus markers
  var stopMarkers = {};                // stopId -> circleMarker
  var routeData = null;                // full routes.json
  var routesById = {};                 // routeId -> route object
  var tripsById = {};                  // tripId -> {routeId, directionId, label, headsign}
  var allStops = {};                   // stopId -> {stopId, name, lat, lon, routeIds: []}
  var vehicleStates = new Map();       // vehicleId -> {marker, lastLat, lastLon, lastTime, speed, heading, color}
  var latestVehiclesData = null;
  var latestTripUpdatesData = null;
  var latestTripUpdates = [];          // array of tripUpdate objects
  var arrivalsByStop = {};             // stopId -> [{routeId, label, color, time}]

  var VEH_ERR = false;                 // vehicles fetch error (primary)
  var TU_ERR = false;                  // tripupdates fetch error
  var POLL_MS = 10000;                  // poll cadence — keep in sync with the
                                        // Worker's CACHE_TTL so each poll sees
                                        // fresh upstream data (10s)
  var UNKNOWN_COLOR = '#e67e22';

  var STATUS_TEXT = { 0: 'INCOMING_AT', 1: 'STOPPED_AT', 2: 'IN_TRANSIT_TO' };

  // ---------------------------------------------------------------- DOM
  var statusPill = document.getElementById('status-pill');
  var lastUpdatedEl = document.getElementById('last-updated');

  // ---------------------------------------------------------------- helpers
  function esc(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function deg2rad(d) { return d * Math.PI / 180; }
  function rad2deg(r) { return r * 180 / Math.PI; }

  function haversine(lat1, lon1, lat2, lon2) {
    var R = 6371; // km
    var dLat = deg2rad(lat2 - lat1);
    var dLon = deg2rad(lon2 - lon1);
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
    var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  function computeBearing(lat1, lon1, lat2, lon2) {
    var y = Math.sin(deg2rad(lon2 - lon1)) * Math.cos(deg2rad(lat2));
    var x = Math.cos(deg2rad(lat1)) * Math.sin(deg2rad(lat2)) -
            Math.sin(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) * Math.cos(deg2rad(lon2 - lon1));
    return (rad2deg(Math.atan2(y, x)) + 360) % 360;
  }

  var COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  function compassPoint(deg) {
    if (deg == null) return '—';
    var i = Math.round(deg / (360 / 16)) % 16;
    if (i < 0) i += 16;
    return COMPASS[i];
  }

  function fmtTime(epochSec) {
    if (epochSec == null) return '—';
    var d = new Date(epochSec * 1000);
    return String(d.getHours()).padStart(2, '0') + ':' +
           String(d.getMinutes()).padStart(2, '0');
  }

  // compact age string: "12s", "4m", "2h"
  function compactAge(seconds) {
    var s = Math.abs(Math.round(seconds));
    if (s < 60) return s + 's';
    if (s < 3600) return Math.round(s / 60) + 'm';
    return Math.round(s / 3600) + 'h';
  }

  function consider(ts, acc) {
    if (ts == null || ts === undefined || isNaN(ts)) return;
    ts = Number(ts);
    if (acc.v == null || ts > acc.v) acc.v = ts;
  }

  function tripInfo(tripId) { return tripsById[tripId] || null; }

  function bodyStale(on) {
    document.body.classList.toggle('stale', on);
  }

  // ---------------------------------------------------------------- bus pin icon
  // Teardrop pin with a white inner circle and a bus glyph, colored per route;
  // a small badge carries the direction letter (A/B for 227, headsign initial
  // otherwise). Unknown trips get an orange pin.
  function busPinIcon(color, dirLetter) {
    var safeColor = esc(color);
    var badge = dirLetter
      ? '<circle cx="27.5" cy="9.5" r="7" fill="#1a1a1a" stroke="#ffffff" stroke-width="1.5"/>' +
        '<text x="27.5" y="13" text-anchor="middle" font-family="system-ui, sans-serif" ' +
        'font-size="8.5" font-weight="700" fill="#ffffff">' + esc(dirLetter) + '</text>'
      : '';
    var svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="34" height="46" viewBox="0 0 34 46">' +
      '<path d="M17 2.5C9 2.5 2.5 9 2.5 17c0 10.8 14.5 26.5 14.5 26.5S31.5 27.8 31.5 17C31.5 9 25 2.5 17 2.5z" ' +
      'fill="' + safeColor + '" stroke="#ffffff" stroke-width="1.6"/>' +
      '<circle cx="17" cy="16.5" r="10.2" fill="#ffffff"/>' +
      '<g fill="#1a1a1a">' +
        '<rect x="12.3" y="9.3" width="9.4" height="12.6" rx="1.6"/>' +
        '<rect x="13.6" y="10.8" width="3" height="4.4" rx="0.5" fill="#ffffff"/>' +
        '<rect x="17.4" y="10.8" width="3" height="4.4" rx="0.5" fill="#ffffff"/>' +
        '<rect x="15.6" y="16" width="1.8" height="3.4" rx="0.4" fill="#ffffff"/>' +
        '<circle cx="13.9" cy="20.2" r="0.9" fill="#ffffff"/>' +
        '<circle cx="20.1" cy="20.2" r="0.9" fill="#ffffff"/>' +
        '<rect x="13.4" y="22.4" width="7.2" height="0.9" rx="0.4"/>' +
      '</g>' +
      badge +
      '</svg>';
    return L.divIcon({
      html: svg,
      className: 'bus-pin',
      iconSize: [34, 46],
      iconAnchor: [17, 44],
      popupAnchor: [0, -40],
    });
  }

  // badge letter for the pin: A/B for routes labelled like "227A", else the
  // headsign initial ("T" for Taunton, "A" for Ajax Station)
  function dirBadgeLetter(route, directionId) {
    if (!route) return '';
    var d = route.directions && route.directions[directionId];
    if (!d) return '';
    var label = d.label || '';
    var m = label.match(/(\d+)([A-Z])$/);
    if (m) return m[2];
    var h = (d.headsign || '').trim();
    return h ? h.charAt(0).toUpperCase() : '';
  }

  // ---------------------------------------------------------------- data load
  function loadRoutes() {
    return fetch('data/routes.json')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        routeData = data;
        var routes = data.routes || [];
        for (var i = 0; i < routes.length; i++) {
          var r = routes[i];
          routesById[r.id] = r;
          for (var j = 0; j < r.trips.length; j++) {
            var t = r.trips[j];
            tripsById[t.tripId] = {
              routeId: r.id,
              directionId: t.directionId,
              label: t.label,
              headsign: t.headsign,
            };
          }
          for (var k = 0; k < r.stops.length; k++) {
            var s = r.stops[k];
            if (!allStops[s.stopId]) {
              allStops[s.stopId] = {
                stopId: s.stopId, name: s.name, lat: s.lat, lon: s.lon, routeIds: [],
              };
            }
            if (allStops[s.stopId].routeIds.indexOf(r.id) === -1) {
              allStops[s.stopId].routeIds.push(r.id);
            }
          }
        }
      });
  }

  // ---------------------------------------------------------------- map init
  function initMap() {
    map = L.map('map', {
      zoomControl: true,
      attributionControl: true
    });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      minZoom: 2,
      tileSize: 256,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);

    busLayer = L.layerGroup().addTo(map);

    var bounds = L.latLngBounds([]);
    var routes = routeData.routes || [];
    for (var i = 0; i < routes.length; i++) {
      var route = routes[i];
      for (var d = 0; d < route.directions.length; d++) {
        var dir = route.directions[d];
        var dash = dir.directionId === 0 ? '' : '9,7';
        for (var g = 0; g < dir.geometries.length; g++) {
          var coords = dir.geometries[g].coordinates;
          var latlngs = coords.map(function (c) { return [c[1], c[0]]; });
          bounds.extend(L.latLngBounds(latlngs));
          L.polyline(latlngs, {
            color: dir.color,
            weight: 5,
            opacity: 0.9,
            dashArray: dash,
            lineCap: 'round'
          })
            .bindPopup('<strong>' + esc(dir.label) + '</strong><br><small>' + esc(route.name) +
              ' &middot; to ' + esc(dir.headsign) + '</small>')
            .addTo(map);
        }
      }
    }

    // stops (deduped across routes — a stop served by both routes appears once)
    var stopIds = Object.keys(allStops);
    for (var n = 0; n < stopIds.length; n++) {
      var s = allStops[stopIds[n]];
      var badges = s.routeIds.map(function (rid) {
        var r = routesById[rid];
        return '<span class="route-chip" style="background:' + esc(r ? r.colorHex : '#666666') + '">' +
          esc(rid) + '</span>';
      }).join(' ');
      var mk = L.circleMarker([s.lat, s.lon], {
        radius: 5,
        fillColor: '#fff',
        color: '#1a1a1a',
        weight: 1.5,
        opacity: 1,
        fillOpacity: 1
      })
        .bindPopup(stopPopupContent(s))
        .addTo(map);
      mk._routeBadges = badges;
      stopMarkers[s.stopId] = mk;
    }

    map.fitBounds(bounds, { padding: [40, 24], maxZoom: 13 });
  }

  // ---------------------------------------------------------------- stop popups
  function buildArrivalsByStop(tripUpdates) {
    var now = Date.now() / 1000;
    var out = {};
    for (var i = 0; i < tripUpdates.length; i++) {
      var tu = tripUpdates[i];
      if (!tu || !tu.tripId) continue;
      var t = tripInfo(tu.tripId);
      var routeId = t ? t.routeId : tu.routeId;
      var label = t ? t.label : (tu.routeId || '?');
      var route = routesById[routeId];
      var color = route ? route.colorHex : UNKNOWN_COLOR;
      var stus = tu.stopTimeUpdates || [];
      for (var j = 0; j < stus.length; j++) {
        var stu = stus[j];
        if (!stu || !stu.stopId) continue;
        var time = (stu.arrivalTime != null) ? stu.arrivalTime : stu.departureTime;
        if (time == null || time <= now) continue;
        if (!out[stu.stopId]) out[stu.stopId] = [];
        out[stu.stopId].push({ routeId: routeId, label: label, color: color, time: time });
      }
    }
    for (var k in out) {
      out[k].sort(function (a, b) { return a.time - b.time; });
    }
    return out;
  }

  function refreshStopPopups() {
    arrivalsByStop = buildArrivalsByStop(latestTripUpdates);
    for (var sid in stopMarkers) {
      if (stopMarkers[sid]) {
        stopMarkers[sid].setPopupContent(stopPopupContent(allStops[sid]));
      }
    }
  }

  function stopPopupContent(stop) {
    var a = arrivalsByStop[stop.stopId] || [];
    var badges = stopMarkers[stop.stopId] ? stopMarkers[stop.stopId]._routeBadges : '';
    var html = '<div class="stop-popup"><strong>' + esc(stop.name) + '</strong> ' + badges + '<br>';
    html += '<small>Stop ID: ' + esc(stop.stopId) + '</small>';
    var now = Date.now() / 1000;
    var upcoming = [];
    for (var i = 0; i < a.length; i++) if (a[i].time > now) upcoming.push(a[i]);
    upcoming = upcoming.slice(0, 6);
    if (upcoming.length) {
      html += '<hr><small>Upcoming arrivals</small><ul>';
      for (var j = 0; j < upcoming.length; j++) {
        var u = upcoming[j];
        var diff = u.time - now;
        var when = diff < 60 ? 'in &lt;1 min' : 'in ' + Math.round(diff / 60) + ' min';
        html += '<li><span class="route-chip" style="background:' + esc(u.color) + '">' +
          esc(u.routeId) + '</span> ' + esc(u.label) + ' &middot; ' + when +
          ' (' + fmtTime(u.time) + ')</li>';
      }
      html += '</ul>';
    } else {
      html += '<hr><small>No upcoming arrivals reported</small>';
    }
    html += '</div>';
    return html;
  }

  // ---------------------------------------------------------------- vehicle popups
  function busPopupContent(v, state) {
    var t = tripInfo(v.tripId);
    var route = t ? routesById[t.routeId] : null;
    var dirLabel = t
      ? esc(t.label) + (t.headsign && t.label.indexOf(t.headsign) === -1
          ? ' &middot; to ' + esc(t.headsign) : '')
      : 'unknown trip';
    var speedStr = (state.speed != null && state.speed >= 0)
      ? Math.round(state.speed) + ' km/h' : '&mdash;';
    var headingStr = (state.heading != null)
      ? Math.round(state.heading) + '&deg; (' + compassPoint(state.heading) + ')' : '&mdash;';
    var statusTxt = STATUS_TEXT[v.currentStatus] || 'UNKNOWN';
    var extra = '';
    if ((v.currentStatus === 0 || v.currentStatus === 1) && v.stopId) {
      extra = ' at stop ' + esc(v.stopId);
    }
    var updateStr = v.timestamp
      ? compactAge(Date.now() / 1000 - v.timestamp) + ' ago' : '&mdash;';

    var html = '<div class="bus-popup">' +
      (route ? '<span class="route-chip" style="background:' + esc(route.colorHex) + '">' +
        esc(route.id) + '</span> ' : '') +
      '<strong>Vehicle ' + esc(v.vehicleId) + '</strong><br>' +
      '<small style="word-break:break-all;">' + esc(v.tripId) + '</small><br>' +
      '<small>' + dirLabel + '</small><br>' +
      '<small>Speed: ' + speedStr + ' &middot; Heading: ' + headingStr + '</small><br>' +
      '<small>Status: ' + statusTxt + extra + '</small><br>' +
      '<small>Updated ' + updateStr + '</small>' +
      '</div>';
    return html;
  }

  // ---------------------------------------------------------------- vehicles
  function updateVehicles(vehicles) {
    var now = Date.now() / 1000;
    var seen = new Set();

    for (var i = 0; i < vehicles.length; i++) {
      var v = vehicles[i];
      if (!v || !v.vehicleId || v.latitude == null || v.longitude == null) continue;
      seen.add(v.vehicleId);
      var lat = v.latitude, lon = v.longitude;
      var t = tripInfo(v.tripId);
      var route = t ? routesById[t.routeId] : null;
      var color = route ? route.colorHex : UNKNOWN_COLOR;
      var badge = t ? dirBadgeLetter(route, t.directionId) : '';

      var state = vehicleStates.get(v.vehicleId);
      if (!state) {
        // first sighting — create pin marker
        var marker = L.marker([lat, lon], {
          icon: busPinIcon(color, badge),
          keyboard: false,
          riseOnHover: true
        }).addTo(busLayer);
        marker.bindPopup('');
        state = {
          marker: marker,
          lastLat: lat,
          lastLon: lon,
          lastTime: (v.timestamp != null) ? v.timestamp : now,
          speed: null,
          heading: null,
          color: color,
          badge: badge
        };
        vehicleStates.set(v.vehicleId, state);
      } else {
        // existing — update position, icon (color/badge may change with the
        // assigned trip), and derive speed / heading from the previous position
        state.marker.setLatLng([lat, lon]);
        if (state.color !== color || state.badge !== badge) {
          state.marker.setIcon(busPinIcon(color, badge));
          state.color = color;
          state.badge = badge;
        }
        if (v.timestamp != null && state.lastTime != null) {
          var dt = v.timestamp - state.lastTime;
          if (dt > 0) {
            var dist = haversine(state.lastLat, state.lastLon, lat, lon); // km
            state.speed = dist / (dt / 3600); // km/h
            state.heading = computeBearing(state.lastLat, state.lastLon, lat, lon);
          }
        }
        state.lastLat = lat;
        state.lastLon = lon;
        if (v.timestamp != null) state.lastTime = v.timestamp;
      }

      state.marker.setPopupContent(busPopupContent(v, state));
    }

    // remove vehicles that vanished from the feed
    var toRemove = [];
    vehicleStates.forEach(function (value, key) {
      if (!seen.has(key)) toRemove.push(key);
    });
    for (var r = 0; r < toRemove.length; r++) {
      var rm = vehicleStates.get(toRemove[r]);
      if (rm && rm.marker) rm.marker.removeFrom(busLayer);
      vehicleStates.delete(toRemove[r]);
    }
  }

  // ---------------------------------------------------------------- fetches
  function fetchVehicles() {
    return fetch(BASE + '/api/vehicles')
      .then(function (res) {
        if (!res.ok) throw new Error('vehicles HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        if (!data || !data.ok) throw new Error('vehicles payload not ok');
        latestVehiclesData = data;
        updateVehicles(data.vehicles || []);
      });
  }

  function fetchTripUpdates() {
    return fetch(BASE + '/api/tripupdates')
      .then(function (res) {
        if (!res.ok) throw new Error('tripupdates HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        if (!data || !data.ok) throw new Error('tripupdates payload not ok');
        latestTripUpdatesData = data;
        latestTripUpdates = data.tripUpdates || [];
        refreshStopPopups();
      });
  }

  // ---------------------------------------------------------------- poll + status
  function refreshAll() {
    VEH_ERR = false;
    TU_ERR = false;
    var vP = fetchVehicles().catch(function (e) {
      VEH_ERR = true;
      console.warn('vehicles fetch:', e);
    });
    var tP = fetchTripUpdates().catch(function (e) {
      TU_ERR = true;
      console.warn('tripupdates fetch:', e);
    });
    Promise.all([vP, tP]).then(updateStatus);
  }

  function updateStatus() {
    var now = Date.now() / 1000;
    var acc = { v: null };
    if (latestVehiclesData) {
      consider(latestVehiclesData.feedTimestamp, acc);
      consider(latestVehiclesData.fetchedAt, acc);
      var vs = latestVehiclesData.vehicles || [];
      for (var i = 0; i < vs.length; i++) consider(vs[i].timestamp, acc);
    }
    if (latestTripUpdatesData) {
      consider(latestTripUpdatesData.feedTimestamp, acc);
      consider(latestTripUpdatesData.fetchedAt, acc);
      // NOTE: do NOT consider arrival/departure times here — they are future
      // predictions, not feed-freshness signals.
    }

    // per-route bus counts for the status pill
    var counts = {};
    var list = (latestVehiclesData && latestVehiclesData.vehicles) || [];
    vehicleStates.forEach(function (state, vehicleId) {
      var rid = 'other';
      for (var i = 0; i < list.length; i++) {
        if (list[i].vehicleId === vehicleId) {
          var t = tripInfo(list[i].tripId);
          if (t) rid = t.routeId;
          break;
        }
      }
      counts[rid] = (counts[rid] || 0) + 1;
    });

    var busCount = vehicleStates.size;
    var newest = acc.v;

    if (VEH_ERR) {
      statusPill.textContent = 'Connection error — retrying';
      statusPill.className = 'status-pill error';
      bodyStale(false);
    } else if (!latestVehiclesData) {
      statusPill.textContent = 'Connecting…';
      statusPill.className = 'status-pill';
      bodyStale(false);
    } else {
      // clamp: feed server clock can be slightly ahead of the browser's
      var age = now - (newest != null ? newest : now);
      if (age < 0) age = 0;
      var parts = [];
      Object.keys(routesById).forEach(function (rid) {
        if (counts[rid]) parts.push(rid + ': ' + counts[rid]);
      });
      if (counts.other) parts.push('other: ' + counts.other);
      var breakdown = parts.length ? ' (' + parts.join(', ') + ')' : '';
      if (age > 180) {
        bodyStale(true);
        statusPill.textContent = 'Stale — feed ' + compactAge(age) + ' old';
        statusPill.className = 'status-pill stale';
      } else {
        bodyStale(false);
        statusPill.textContent = 'Live · ' + busCount + (busCount === 1 ? ' bus' : ' buses') +
          breakdown + ' · updated ' + compactAge(age) + ' ago';
        statusPill.className = 'status-pill live';
      }
    }

    if (latestVehiclesData && latestVehiclesData.fetchedAt) {
      lastUpdatedEl.textContent = 'Updated ' + fmtTime(latestVehiclesData.fetchedAt) +
        '  ·  feed ' + (latestVehiclesData.feedTimestamp ? fmtTime(latestVehiclesData.feedTimestamp) : '—');
    } else {
      lastUpdatedEl.textContent = '—';
    }
  }

  function scheduleLoop() {
    refreshAll();
    setInterval(refreshAll, POLL_MS);
  }

  function init() {
    loadRoutes()
      .then(function () { initMap(); scheduleLoop(); })
      .catch(function (e) {
        console.error('route load failed:', e);
        statusPill.textContent = 'Error';
        statusPill.className = 'status-pill error';
        lastUpdatedEl.textContent = 'Could not load route data';
      });
  }

  window.addEventListener('DOMContentLoaded', init);
})();
