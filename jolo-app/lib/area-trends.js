// "Trending near you": the job ranks drinks for the whole area; the phone
// knows where the person is. Nearby cards come first, in the job's order
// within each band, so a walkable café beats a better-scored one 9 miles off.

import { distanceMiles, formatDistance, isInServiceArea } from "@/lib/geo";

/** Miles bands, nearest first. A card with no location sorts after all of them. */
export const DISTANCE_BANDS = [1.5, 5, 15];

const band = (miles) => {
  if (miles == null) return DISTANCE_BANDS.length + 1;
  const index = DISTANCE_BANDS.findIndex((limit) => miles <= limit);
  return index === -1 ? DISTANCE_BANDS.length : index;
};

/**
 * Cards with `miles` and a `distanceLabel`, nearest band first. Without a
 * position, or from outside the service area, the job's order stands.
 */
export function nearestFirst(cards, coords) {
  const list = Array.isArray(cards) ? cards : [];
  if (!coords || !isInServiceArea(coords)) {
    return list.map((card) => ({ ...card, miles: null, distanceLabel: null }));
  }
  return list
    .map((card, rank) => {
      const lat = card.location?.lat;
      const lng = card.location?.lng;
      const miles =
        Number.isFinite(lat) && Number.isFinite(lng)
          ? distanceMiles(coords, { latitude: lat, longitude: lng })
          : null;
      return { ...card, rank, miles, distanceLabel: miles == null ? null : formatDistance(miles) };
    })
    .sort((a, b) => band(a.miles) - band(b.miles) || a.rank - b.rank)
    .map(({ rank: _rank, ...card }) => card);
}
