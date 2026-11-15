import { useCallback, useEffect, useState } from "react";
import {
  addDoc,
  collection,
  getDocsFromServer,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  where,
} from "@react-native-firebase/firestore";
import { db } from "@/FirebaseConfig";
import { newestFirst, newReviewFields, toReview } from "@/lib/reviews";

const REVIEW_LIMIT = 100;

function fromSnapshot(snapshot) {
  return newestFirst(
    snapshot.docs.map((docSnap) => toReview(docSnap.id, docSnap.data() ?? {})).filter(Boolean),
  );
}

/**
 * Reviews, newest first and live: a review posted in the app or texted in over
 * iMessage shows up without a refresh. cafeId narrows it to one café (the
 * owner's Reviews tab); without it, every café (the Social feed).
 */
export function useReviews({ cafeId } = {}) {
  const [state, setState] = useState({ loading: true, reviews: [], error: null });

  useEffect(() => {
    let active = true;
    setState({ loading: true, reviews: [], error: null });
    const reviews = collection(db, "reviews");
    const feed = cafeId
      ? query(
          reviews,
          where("cafeId", "==", cafeId),
          orderBy("createdAt", "desc"),
          limit(REVIEW_LIMIT),
        )
      : query(reviews, orderBy("createdAt", "desc"), limit(REVIEW_LIMIT));

    const apply = (snapshot) => {
      if (active) setState({ loading: false, reviews: fromSnapshot(snapshot), error: null });
    };
    const fail = (error) => {
      console.warn(`[jolo] reviews: ${error?.message ?? error}`);
      if (active) setState((previous) => ({ ...previous, loading: false, error }));
    };

    // The emulator's watch stream can close before its first snapshot (see
    // useOwnerCafe), so a one-shot read fills the list in either way.
    getDocsFromServer(feed).then(apply).catch(fail);
    const unsubscribe = onSnapshot(
      feed,
      (snapshot) => {
        // An empty cache is not "no reviews": the server hasn't answered yet.
        if (snapshot.empty && snapshot.metadata?.fromCache) return;
        apply(snapshot);
      },
      fail,
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, [cafeId]);

  return state;
}

/** Posts a review as the signed-in user. The live feed picks it up on its own. */
export function usePostReview(user) {
  const [posting, setPosting] = useState(false);
  const post = useCallback(
    async ({ cafe, rating, comment }) => {
      if (!user?.uid) throw new Error("Sign in to post a review.");
      setPosting(true);
      try {
        await addDoc(collection(db, "reviews"), {
          ...newReviewFields({ cafe, rating, comment, user }),
          createdAt: serverTimestamp(),
        });
      } finally {
        setPosting(false);
      }
    },
    [user],
  );
  return { post, posting };
}
