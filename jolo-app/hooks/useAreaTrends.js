import { useCallback, useEffect, useState } from "react";
import { doc, getDocFromServer } from "@react-native-firebase/firestore";
import { db } from "@/FirebaseConfig";

export const AREA_ID = "union-county-nj";

/**
 * Drinks trending on local menus (areas/{id}), written by the recommend job.
 * Each card carries the café, the menu price and the signals behind it.
 */
export function useAreaTrends(areaId = AREA_ID) {
  const [state, setState] = useState({ loading: true, name: null, trending: [], error: null });

  const load = useCallback(async () => {
    setState((previous) => ({ ...previous, loading: true, error: null }));
    try {
      const snapshot = await getDocFromServer(doc(db, "areas", areaId));
      const data = snapshot.exists() ? snapshot.data() : null;
      setState({
        loading: false,
        name: data?.name ?? null,
        trending: Array.isArray(data?.trending) ? data.trending : [],
        error: null,
      });
    } catch (error) {
      setState({ loading: false, name: null, trending: [], error });
    }
  }, [areaId]);

  useEffect(() => {
    load();
  }, [load]);

  return { ...state, reload: load };
}
