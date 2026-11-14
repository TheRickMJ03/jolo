import { useEffect, useState } from "react";
import { doc, onSnapshot } from "@react-native-firebase/firestore";
import { db } from "@/FirebaseConfig";

const toDate = (value) => value?.toDate?.() ?? (value instanceof Date ? value : null);

/** analytics/current → plain object with Dates. Missing fields become empty lists. */
export function toAnalytics(data) {
  if (!data) return null;
  const sources = {};
  for (const [name, info] of Object.entries(data.sources ?? {})) {
    sources[name] = { ...info, scrapedAt: toDate(info?.scrapedAt) };
  }
  return {
    generatedAt: toDate(data.generatedAt),
    area: data.area ?? null,
    otherShops: (Array.isArray(data.otherShops) ? data.otherShops : []).map((row) => ({
      ...row,
      latest: toDate(row.latest),
    })),
    nearby: {
      scope: data.nearby?.scope ?? null,
      terms: Array.isArray(data.nearby?.terms) ? data.nearby.terms : [],
      searches: data.nearby?.searches ?? 0,
    },
    web: Array.isArray(data.web) ? data.web : [],
    sources,
  };
}

/**
 * The recommend job's signals for one café (cafes/{id}/analytics/current),
 * live. Only the owner can read them. `analytics` is null until the job runs.
 */
export function useOwnerAnalytics(cafeId) {
  const [state, setState] = useState({ loading: true, analytics: null, error: null });

  useEffect(() => {
    if (!cafeId) return undefined;
    return onSnapshot(
      doc(db, "cafes", cafeId, "analytics", "current"),
      (snapshot) =>
        setState({
          loading: false,
          analytics: snapshot.exists() ? toAnalytics(snapshot.data()) : null,
          error: null,
        }),
      (error) => setState({ loading: false, analytics: null, error }),
    );
  }, [cafeId]);

  return state;
}
