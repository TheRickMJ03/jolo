import { useCallback, useState } from "react";
import { useFocusEffect } from "expo-router";
import {
  collection,
  getDocsFromServer,
  limit,
  orderBy,
  query,
} from "@react-native-firebase/firestore";
import { db } from "@/FirebaseConfig";

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value.toDate === "function") {
    const date = value.toDate();
    return date instanceof Date && !Number.isNaN(date.getTime()) ? date : null;
  }
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

function toActivityEvent(snapshot) {
  const data = snapshot.data() ?? {};
  const cafeIds = Array.isArray(data.cafeIds) ? data.cafeIds.filter((id) => typeof id === "string" && id) : [];
  return {
    id: snapshot.id,
    type: data.type ?? "search",
    cafeId: data.cafeId ?? null,
    cafeIds,
    text: data.text ?? "",
    historyOnly: Boolean(data.historyOnly),
    createdAt: toDate(data.createdAt),
  };
}

async function loadEvents(pathQuery) {
  const snap = await getDocsFromServer(pathQuery);
  return snap.docs.map(toActivityEvent);
}

/** Finder searches, plus what this phone asked JOLO over iMessage. */
export function useUserActivity(user) {
  const uid = user?.uid ?? null;
  const phone = user?.phoneNumber ?? null;
  const [state, setState] = useState({ loading: true, events: [], error: null });

  const load = useCallback(async () => {
    if (!uid) {
      setState({ loading: false, events: [], error: null });
      return;
    }
    setState((previous) => ({
      ...previous,
      loading: previous.events.length === 0,
      error: null,
    }));
    const events = [];
    let appFailed = false;
    try {
      events.push(
        ...(await loadEvents(
          query(collection(db, "users", uid, "events"), orderBy("createdAt", "desc"), limit(100)),
        )),
      );
    } catch {
      appFailed = true;
    }
    if (phone) {
      try {
        events.push(
          ...(await loadEvents(
            query(
              collection(db, "customerAsks", phone, "items"),
              orderBy("createdAt", "desc"),
              limit(50),
            ),
          )),
        );
      } catch (error) {
        console.warn(`[jolo] iMessage asks: ${error?.message ?? error}`);
      }
    }
    setState({
      loading: false,
      events,
      error: appFailed && events.length === 0 ? "load" : null,
    });
  }, [uid, phone]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  return state;
}
