import { useCallback, useEffect, useState } from "react";
import { collection, getDocs } from "@react-native-firebase/firestore";
import { db } from "@/FirebaseConfig";

/**
 * Firestore café → the Finder's shape. Cafés seeded from OpenStreetMap have a
 * `location`; a café an owner created over iMessage may only have an address,
 * so `coordinate` is null for it and the Finder lists it without a pin.
 */
export function toCafe(doc) {
  const data = doc.data() ?? {};
  const { latitude, longitude } = data.location ?? {};
  const hasCoordinate = Number.isFinite(latitude) && Number.isFinite(longitude);
  return {
    id: doc.id,
    name: data.name ?? "Café",
    municipality: data.municipality,
    address: data.address,
    isChain: data.isChain,
    hours: data.hours,
    website: data.website,
    phone: data.phone,
    amenities: data.amenities,
    coordinate: hasCoordinate ? { latitude, longitude } : null,
    rating: data.ratingCount > 0 ? data.ratingSum / data.ratingCount : null,
    ratingCount: data.ratingCount ?? 0,
  };
}

// The seeded county is small (~70 cafés), so one read of the whole collection is
// cheaper and simpler than geo queries.
export function useCafes() {
  const [state, setState] = useState({ cafes: [], loading: true, error: null });

  const load = useCallback(async () => {
    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const snapshot = await getDocs(collection(db, "cafes"));
      setState({ cafes: snapshot.docs.map(toCafe), loading: false, error: null });
    } catch (error) {
      setState({ cafes: [], loading: false, error });
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return { ...state, reload: load };
}
