/* DRT-227 Live — vanilla JS client consuming the Cloudflare Worker proxy.
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
  var routeData = null;                // full route-227.json
  var tripsById = {};                 // tripId -> {directionId, label, headsign}
  var directions = [];               // [{directionId, label, headsign, color, geometry}]
  var stops = [];                    // [{stopId, name, lat, lon}]
  var stopLookup = {};               // stopId -> stop
  var vehicleStates = new Map();     // vehicleId -> {marker, lastLat, lastLon, lastTime, speed, heading, dirColor}
  var latestVehiclesData = null;
  var latestTripUpdatesData = null;
  var latestTripUpdates = [];        // array of tripUpdate objects
  var arrivalsByStop = {};           // stopId -> [{label, headsign, time}]

  var VEH_ERR = false;               // vehicles fetch error (primary)
  var TU_ERR = false;                 // tripupdates fetch error
  var POLL_MS = 60000;

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

  function directionForTrip(tripId) {
    var t = tripsById[tripId];
    if (!t) return null;
    var d = directions[t.directionId];
    return d || null;
  }

  function bodyStale(on) {
    document.body.classList.toggle('stale', on);
  }

  // ---------------------------------------------------------------- data load
  function loadRoute() {
    return fetch('data/route-227.json')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        routeData = data;
        for (var i = 0; i < data.trips.length; i++) {
          var t = data.trips[i];
          tripsById[t.tripId] = t;
        }
        directions = data.directions || [];
        stops = data.stops || [];
        for (var j = 0; j < stops.length; j++) stopLookup[stops[j].stopId] = stops[j];
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

    // route direction polylines
    var bounds = L.latLngBounds([]);
    for (var i = 0; i < directions.length; i++) {
      var dir = directions[i];
      var latlngs = dir.geometry.coordinates.map(function (c) {
        return [c[1], c[0]]; // [lon,lat] -> [lat,lng]
      });
      bounds.extend(L.latLngBounds(latlngs));
      var dash = dir.directionId === 0 ? '' : '10,8';
      L.polyline(latlngs, {
        color: dir.color,
        weight: 5,
        opacity: 0.9,
        dashArray: dash,
        lineCap: 'round'
      })
        .bindPopup('<strong>' + esc(dir.label) + ' &mdash; ' + esc(dir.headsign) + '</strong>')
        .addTo(map);
    }

    // stops
    for (var k = 0; k < stops.length; k++) {
      var s = stops[k];
      var mk = L.circleMarker([s.lat, s.lon], {
        radius: 5,
        fillColor: '#fff',
        color: '#1a1a1a',
        weight: 1.5,
        opacity: 1,
        fillOpacity: 1
      }).bindPopup(stopPopupContent(s)).addTo(map);
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
      var t = tripsById[tu.tripId];
      var label = t ? t.label : '?';
      var hs = t ? t.headsign : '';
      var stus = tu.stopTimeUpdates || [];
      for (var j = 0; j < stus.length; j++) {
        var stu = stus[j];
        if (!stu || !stu.stopId) continue;
        var time = (stu.arrivalTime != null) ? stu.arrivalTime : stu.departureTime;
        if (time == null || time <= now) continue;
        if (!out[stu.stopId]) out[stu.stopId] = [];
        out[stu.stopId].push({ label: label, headsign: hs, time: time });
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
      if (stopMarkers[sid]) stopMarkers[sid].setPopupContent(stopPopupContent(stopLookup[sid]));
    }
  }

  function stopPopupContent(stop) {
    var a = arrivalsByStop[stop.stopId] || [];
    var html = '<div class="stop-popup"><strong>' + esc(stop.name) + '</strong><br>';
    html += '<small>Stop ID: ' + esc(stop.stopId) + '</small>';
    var now = Date.now() / 1000;
    var upcoming = [];
    for (var i = 0; i < a.length; i++) if (a[i].time > now) upcoming.push(a[i]);
    upcoming = upcoming.slice(0, 5);
    if (upcoming.length) {
      html += '<hr><small>Upcoming arrivals</small><ul>';
      for (var j = 0; j < upcoming.length; j++) {
        var u = upcoming[j];
        var diff = u.time - now;
        var when = diff < 60 ? 'in &lt;1 min' : 'in ' + Math.round(diff / 60) + ' min';
        html += '<li>' + esc(u.label) + ' &middot; ' + when + ' (' + fmtTime(u.time) + ')</li>';
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
    var dir = directionForTrip(v.tripId);
    var dirLabel = dir
      ? esc(dir.label) + ' &mdash; ' + esc(dir.headsign)
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
      var dir = directionForTrip(v.tripId);
      var color = dir ? dir.color : '#e67e22';

      var state = vehicleStates.get(v.vehicleId);
      if (!state) {
        // first sighting — create marker
        var marker = L.circleMarker([lat, lon], {
          radius: 7,
          fillColor: color,
          color: '#fff',
          weight: 2,
          fillOpacity: 0.9,
          opacity: 1
        }).addTo(busLayer);

        var applyClass = function (m) {
          var el = m.getElement();
          if (el) el.classList.add('bus-marker');
        };
        marker.on('add', function () { applyClass(this); });
        applyClass(marker);

        marker.bindPopup('');
        state = {
          marker: marker,
          lastLat: lat,
          lastLon: lon,
          lastTime: (v.timestamp != null) ? v.timestamp : now,
          speed: null,
          heading: null,
          dirColor: color
        };
        vehicleStates.set(v.vehicleId, state);
      } else {
        // existing — update position & maybe color
        state.marker.setLatLng([lat, lon]);
        if (state.dirColor !== color) {
          state.marker.setStyle({ fillColor: color });
          state.dirColor = color;
        }
        // derive speed / heading from previous position
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
      if (age > 180) {
        bodyStale(true);
        statusPill.textContent = 'Stale — feed ' + compactAge(age) + ' old';
        statusPill.className = 'status-pill stale';
      } else {
        bodyStale(false);
        statusPill.textContent = 'Live · ' + busCount + ' buses · updated ' +
          compactAge(age) + ' ago';
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
    loadRoute()
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

