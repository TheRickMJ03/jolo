import { useEffect, useState } from "react";
import {
  collection,
  getDocsFromServer,
  limit,
  onSnapshot,
  query,
  where,
} from "@react-native-firebase/firestore";
import { db } from "@/FirebaseConfig";

/** Firestore café document → the shape the screens use. */
export function toCafe(snapshot) {
  const data = snapshot.data() ?? {};
  return {
    id: snapshot.id,
    name: data.name ?? "Your café",
    ownerName: data.ownerName ?? null,
    address: data.address ?? null,
    ownerPhone: data.ownerPhone ?? null,
    currentMenuVersion: data.currentMenuVersion ?? 0,
    menuUpdatedAt: data.menuUpdatedAt?.toDate?.() ?? null,
  };
}

/**
 * The café whose ownerPhone is the signed-in user's verified phone number.
 * status: "loading" | "ready" | "no-phone" (email account, or signed out) |
 * "not-linked" | "error"
 *
 * The status is tied to the uid and phone it was fetched for, so a brand-new
 * sign-in stays on "loading" instead of briefly inheriting "no café".
 */
export function useOwnerCafe(user) {
  const phone = user?.phoneNumber ?? null;
  const uid = user?.uid ?? null;
  const [state, setState] = useState({
    status: "loading",
    cafe: null,
    error: null,
    phone: undefined,
    uid: undefined,
  });

  useEffect(() => {
    if (!uid || !phone) {
      setState({ status: "no-phone", cafe: null, error: null, phone, uid });
      return undefined;
    }
    setState({ status: "loading", cafe: null, error: null, phone, uid });
    let active = true;
    const owned = query(collection(db, "cafes"), where("ownerPhone", "==", phone), limit(2));
    const apply = (snapshot) => {
      if (!active) return;
      if (snapshot.empty) {
        setState({ status: "not-linked", cafe: null, error: null, phone, uid });
        return;
      }
      if (snapshot.size > 1) {
        console.warn(`[jolo] ${phone} owns more than one café; showing the first.`);
      }
      setState({ status: "ready", cafe: toCafe(snapshot.docs[0]), error: null, phone, uid });
    };

    // The watch stream against this emulator gets closed (too_many_pings) before
    // it delivers a snapshot, which left this screen spinning. A one-shot read
    // still returns the café.
    getDocsFromServer(owned)
      .then(apply)
      .catch((error) => {
        if (active) setState({ status: "error", cafe: null, error, phone, uid });
      });

    const unsubscribe = onSnapshot(
      owned,
      (snapshot) => {
        // An empty cache is not "no café": the server hasn't answered yet.
        if (snapshot.empty && snapshot.metadata?.fromCache) return;
        apply(snapshot);
      },
      () => {
        if (!active) return;
        // A dead watch stream must not hide a café the one-shot read already showed.
        setState((current) =>
          current.status === "ready"
            ? current
            : { status: "error", cafe: null, error: true, phone, uid },
        );
      },
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, [uid, phone]);

  if (!uid || !phone) return { status: "no-phone", cafe: null, error: null };
  if (state.uid !== uid || state.phone !== phone) {
    return { status: "loading", cafe: null, error: null };
  }
  return { status: state.status, cafe: state.cafe, error: state.error };
}
