import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
const FeedMessage = GtfsRealtimeBindings.transit_realtime.FeedMessage;
import { shapeVehicles, shapeTripUpdates } from './src/worker.js';

const VEHICLES_URL = 'https://drtonline.durhamregiontransit.com/gtfsrealtime/VehiclePositions';
const TRIP_UPDATES_URL = 'https://drtonline.durhamregiontransit.com/gtfsrealtime/TripUpdates';
const ROUTE_IDS = new Set(['227', '224']);

async function fetchFeed(url) {
  const res = await fetch(url);
  const buf = await res.arrayBuffer();
  return FeedMessage.decode(new Uint8Array(buf));
}

async function main() {
  const vehicleFeed = await fetchFeed(VEHICLES_URL);
  const vehiclesResult = shapeVehicles(vehicleFeed, ROUTE_IDS);
  console.log('=== Vehicles ===');
  console.log('Count:', vehiclesResult.count);
  const byRoute = {};
  for (const v of vehiclesResult.vehicles) byRoute[v.routeId] = (byRoute[v.routeId] || 0) + 1;
  console.log('By route:', JSON.stringify(byRoute));
  console.log('FeedTimestamp:', vehiclesResult.feedTimestamp);
  console.log('FetchedAt:', vehiclesResult.fetchedAt);
  console.log('Sample:', JSON.stringify(vehiclesResult.vehicles[0], null, 2));

  const tripFeed = await fetchFeed(TRIP_UPDATES_URL);
  const tripResult = shapeTripUpdates(tripFeed, ROUTE_IDS);
  console.log('\n=== Trip Updates ===');
  console.log('Count:', tripResult.count);
  const tuByRoute = {};
  for (const tu of tripResult.tripUpdates) tuByRoute[tu.routeId] = (tuByRoute[tu.routeId] || 0) + 1;
  console.log('By route:', JSON.stringify(tuByRoute));
  console.log('FeedTimestamp:', tripResult.feedTimestamp);
  console.log('FetchedAt:', tripResult.fetchedAt);
  console.log('Sample:', JSON.stringify(tripResult.tripUpdates[0], null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
