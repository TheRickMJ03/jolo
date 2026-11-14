import { useCallback, useEffect, useMemo, useState } from "react";
import {
  collection,
  doc,
  getDocFromServer,
  getDocsFromServer,
  limit,
  orderBy,
  query,
} from "@react-native-firebase/firestore";
import { db } from "@/FirebaseConfig";
import { appendEvent, buildEvent } from "@/lib/events";
import { writeEvent } from "@/lib/events-store";
import { assembleForYou } from "@/lib/recommendations";

const EMPTY = {
  loading: false,
  cafes: [],
  menusByCafe: {},
  personal: [],
  events: [],
  taste: null,
};

function toDate(value) {
  return value?.toDate?.() ?? null;
}

function toCafe(snapshot) {
  const data = snapshot.data() ?? {};
  return {
    id: snapshot.id,
    name: data.name ?? "Café",
    address: data.address ?? null,
    currentMenuVersion: data.currentMenuVersion ?? 0,
    menuUpdatedAt: toDate(data.menuUpdatedAt),
  };
}

function toEvent(snapshot) {
  const data = snapshot.data() ?? {};
  return {
    id: snapshot.id,
    type: data.type,
    cafeId: data.cafeId,
    itemId: data.itemId,
    itemName: data.itemName,
    text: data.text,
    createdAt: toDate(data.createdAt),
  };
}

async function loadMenus(cafes) {
  const menusByCafe = {};
  await Promise.all(
    cafes.map(async (cafe) => {
      if (!cafe.currentMenuVersion) {
        menusByCafe[cafe.id] = [];
        return;
      }
      const snapshot = await getDocFromServer(
        doc(db, "cafes", cafe.id, "menuVersions", String(cafe.currentMenuVersion)),
      );
      const items = snapshot.exists() ? snapshot.data()?.items : [];
      menusByCafe[cafe.id] = Array.isArray(items) ? items : [];
    }),
  );
  return menusByCafe;
}

/** Cafés, current menus, this person's events, and any cards the worker has written. */
export async function loadForYou(uid) {
  const [cafeSnap, recommendationSnap, tasteSnap, eventSnap] = await Promise.all([
    getDocsFromServer(query(collection(db, "cafes"), orderBy("menuUpdatedAt", "desc"), limit(30))),
    getDocFromServer(doc(db, "users", uid, "recommendations", "current")),
    getDocFromServer(doc(db, "users", uid, "taste", "current")),
    getDocsFromServer(
      query(collection(db, "users", uid, "events"), orderBy("createdAt", "desc"), limit(200)),
    ),
  ]);

  const cafes = cafeSnap.docs.map(toCafe);
  const menusByCafe = await loadMenus(cafes);
  const recommendation = recommendationSnap.exists() ? recommendationSnap.data() : null;
  const taste = tasteSnap.exists() ? tasteSnap.data() : null;
  return {
    cafes,
    menusByCafe,
    personal: Array.isArray(recommendation?.cards) ? recommendation.cards : [],
    events: eventSnap.docs.map(toEvent),
    taste: taste
      ? { niches: Array.isArray(taste.niches) ? taste.niches : [], facets: taste.facets ?? {} }
      : null,
  };
}

export function useForYou(user, variant = "popular") {
  const uid = user?.uid ?? null;
  const [loaded, setLoaded] = useState({ ...EMPTY, loading: true, error: null });
  const [events, setEvents] = useState([]);
  const [writeError, setWriteError] = useState(false);

  useEffect(() => {
    if (!uid) {
      setLoaded({ ...EMPTY, loading: false, error: null });
      setEvents([]);
      return undefined;
    }
    let active = true;
    setEvents([]);
    setWriteError(false);
    setLoaded({ ...EMPTY, loading: true, error: null });
    loadForYou(uid)
      .then((data) => {
        if (!active) return;
        setLoaded({ ...data, loading: false, error: null });
        setEvents(data.events);
      })
      .catch(() => {
        if (!active) return;
        setLoaded({ ...EMPTY, loading: false, error: true });
      });
    return () => {
      active = false;
    };
  }, [uid]);

  const record = useCallback(
    async (input) => {
      if (!uid) return;
      let event;
      try {
        event = buildEvent({ ...input, createdAt: new Date() });
      } catch {
        setWriteError(true);
        return;
      }
      setEvents((current) => appendEvent(current, event));
      setWriteError(false);
      try {
        await writeEvent(uid, input);
      } catch {
        setEvents((current) => current.filter((item) => item !== event));
        setWriteError(true);
      }
    },
    [uid],
  );

  const view = useMemo(
    () =>
      assembleForYou({
        cafes: loaded.cafes,
        menusByCafe: loaded.menusByCafe,
        personal: loaded.personal,
        events,
        variant,
      }),
    [loaded, events, variant],
  );

  return {
    loading: loaded.loading,
    error: loaded.error ? "load" : writeError ? "save" : null,
    taste: loaded.taste,
    record,
    ...view,
  };
}
