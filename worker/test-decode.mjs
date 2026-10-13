import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
const FeedMessage = GtfsRealtimeBindings.transit_realtime.FeedMessage;
import { shapeVehicles, shapeTripUpdates } from './src/worker.js';

const VEHICLES_URL = 'https://drtonline.durhamregiontransit.com/gtfsrealtime/VehiclePositions';
const TRIP_UPDATES_URL = 'https://drtonline.durhamregiontransit.com/gtfsrealtime/TripUpdates';

async function fetchFeed(url) {
  const res = await fetch(url);
  const buf = await res.arrayBuffer();
  return FeedMessage.decode(new Uint8Array(buf));
}

async function main() {
  const vehicleFeed = await fetchFeed(VEHICLES_URL);
  const vehiclesResult = shapeVehicles(vehicleFeed);
  console.log('=== Vehicles ===');
  console.log('Count:', vehiclesResult.count);
  console.log('FeedTimestamp:', vehiclesResult.feedTimestamp);
  console.log('FetchedAt:', vehiclesResult.fetchedAt);
  console.log('Sample:', JSON.stringify(vehiclesResult.vehicles[0], null, 2));

  const tripFeed = await fetchFeed(TRIP_UPDATES_URL);
  const tripResult = shapeTripUpdates(tripFeed);
  console.log('\n=== Trip Updates ===');
  console.log('Count:', tripResult.count);
  console.log('FeedTimestamp:', tripResult.feedTimestamp);
  console.log('FetchedAt:', tripResult.fetchedAt);
  console.log('Sample:', JSON.stringify(tripResult.tripUpdates[0], null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
