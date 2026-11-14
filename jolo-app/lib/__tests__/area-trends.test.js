import { nearestFirst } from "@/lib/area-trends";

// Westfield, inside the service area.
const HERE = { latitude: 40.6589, longitude: -74.3474 };
const card = (id, lat, lng) => ({ itemId: id, location: lat == null ? null : { lat, lng } });

const CARDS = [
  card("far-but-best", 40.75, -74.2), // ~10 miles
  card("no-location", null, null),
  card("near", 40.66, -74.35), // walkable
  card("mid", 40.7, -74.3), // a few miles
];

it("puts walkable cafés first, keeping the job's order within each band", () => {
  const sorted = nearestFirst(CARDS, HERE);
  expect(sorted.map((c) => c.itemId)).toEqual(["near", "mid", "far-but-best", "no-location"]);
  expect(sorted[0].distanceLabel).toMatch(/mi$/);
  expect(sorted[3].distanceLabel).toBeNull();
});

it("keeps the job's order with no position or from outside the area", () => {
  expect(nearestFirst(CARDS, null).map((c) => c.itemId)).toEqual(CARDS.map((c) => c.itemId));
  const sanFrancisco = { latitude: 37.77, longitude: -122.42 };
  const sorted = nearestFirst(CARDS, sanFrancisco);
  expect(sorted.map((c) => c.itemId)).toEqual(CARDS.map((c) => c.itemId));
  expect(sorted.every((c) => c.distanceLabel === null)).toBe(true);
});

it("handles no cards", () => {
  expect(nearestFirst(undefined, HERE)).toEqual([]);
});
