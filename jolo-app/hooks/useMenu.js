import { useEffect, useState } from "react";
import {
  collection,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
} from "@react-native-firebase/firestore";
import { db } from "@/FirebaseConfig";

/** menuVersions document → plain object with a Date. */
export function toVersion(snapshot) {
  const data = snapshot.data() ?? {};
  return {
    version: data.version ?? Number(snapshot.id),
    source: data.source ?? "imessage",
    scope: data.scope ?? "full",
    items: Array.isArray(data.items) ? data.items : [],
    changes: data.changes ?? { added: [], price_changes: [], changed: [], removed: [] },
    createdAt: data.createdAt?.toDate?.() ?? null,
    createdBy: data.createdBy ?? null,
  };
}

/** The current menu version of a café, live. `version` is null while loading or when there's no menu. */
export function useCurrentMenu(cafe) {
  const cafeId = cafe?.id;
  const current = cafe?.currentMenuVersion ?? 0;
  const [state, setState] = useState({ loading: true, version: null, error: null });

  useEffect(() => {
    if (!cafeId) return undefined;
    if (current === 0) {
      setState({ loading: false, version: null, error: null });
      return undefined;
    }
    setState((previous) => ({ ...previous, loading: true }));
    return onSnapshot(
      doc(db, "cafes", cafeId, "menuVersions", String(current)),
      (snapshot) =>
        setState({
          loading: false,
          version: snapshot.exists() ? toVersion(snapshot) : null,
          error: null,
        }),
      (error) => setState({ loading: false, version: null, error }),
    );
  }, [cafeId, current]);

  return state;
}

/** The latest `count` versions, newest first, live. */
export function useMenuHistory(cafeId, count = 20) {
  const [state, setState] = useState({ loading: true, versions: [], error: null });

  useEffect(() => {
    if (!cafeId) return undefined;
    const latest = query(
      collection(db, "cafes", cafeId, "menuVersions"),
      orderBy("version", "desc"),
      limit(count),
    );
    return onSnapshot(
      latest,
      (snapshot) =>
        setState({ loading: false, versions: snapshot.docs.map(toVersion), error: null }),
      (error) => setState({ loading: false, versions: [], error }),
    );
  }, [cafeId, count]);

  return state;
}
