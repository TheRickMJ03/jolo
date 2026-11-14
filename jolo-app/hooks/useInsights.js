import { useEffect, useState } from "react";
import { collection, limit, onSnapshot, orderBy, query } from "@react-native-firebase/firestore";
import { db } from "@/FirebaseConfig";

/** The latest weekly insights for a café, newest week first. Written by the agent's backend. */
export function useInsights(cafeId, weeks = 8) {
  const [state, setState] = useState({ loading: true, weeks: [], error: null });

  useEffect(() => {
    if (!cafeId) return undefined;
    const latest = query(
      collection(db, "cafes", cafeId, "insights"),
      orderBy("weekStart", "desc"),
      limit(weeks),
    );
    return onSnapshot(
      latest,
      (snapshot) =>
        setState({
          loading: false,
          weeks: snapshot.docs.map((week) => {
            const data = week.data() ?? {};
            return {
              weekStart: data.weekStart ?? week.id,
              counts: data.counts ?? {},
              topItems: Array.isArray(data.topItems) ? data.topItems : [],
              summary: typeof data.summary === "string" ? data.summary : null,
              generatedAt: data.generatedAt?.toDate?.() ?? null,
            };
          }),
          error: null,
        }),
      (error) => setState({ loading: false, weeks: [], error }),
    );
  }, [cafeId, weeks]);

  return state;
}
