import { useEffect, useState } from "react";
import { collection, limit, onSnapshot, query, where } from "@react-native-firebase/firestore";
import { db } from "@/FirebaseConfig";

/** Firestore café document → the shape the screens use. */
export function toCafe(snapshot) {
  const data = snapshot.data() ?? {};
  return {
    id: snapshot.id,
    name: data.name ?? "Your café",
    address: data.address ?? null,
    ownerPhone: data.ownerPhone ?? null,
    currentMenuVersion: data.currentMenuVersion ?? 0,
    menuUpdatedAt: data.menuUpdatedAt?.toDate?.() ?? null,
  };
}

/**
 * The café whose ownerPhone is the signed-in user's verified phone number,
 * live: a new menu version sent by iMessage shows up without a refresh.
 *
 * status: "loading" | "ready" | "no-phone" (email account) | "not-linked" | "error"
 */
export function useOwnerCafe(user) {
  const phone = user?.phoneNumber ?? null;
  const [state, setState] = useState({ status: "loading", cafe: null, error: null });

  useEffect(() => {
    if (!phone) {
      setState({ status: "no-phone", cafe: null, error: null });
      return undefined;
    }
    setState({ status: "loading", cafe: null, error: null });
    const owned = query(collection(db, "cafes"), where("ownerPhone", "==", phone), limit(2));
    return onSnapshot(
      owned,
      (snapshot) => {
        if (snapshot.empty) {
          setState({ status: "not-linked", cafe: null, error: null });
          return;
        }
        if (snapshot.size > 1) {
          console.warn(`[jolo] ${phone} owns more than one café; showing the first.`);
        }
        setState({ status: "ready", cafe: toCafe(snapshot.docs[0]), error: null });
      },
      (error) => setState({ status: "error", cafe: null, error }),
    );
  }, [phone]);

  return state;
}
