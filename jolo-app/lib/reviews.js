// Customer reviews in Firestore `reviews/{id}`: posted here in the app, or over
// iMessage through the bridge (spectrum-archive-app/src/jolo/reviews.ts).
//
//   { cafeId, cafeName, rating: 1–5, comment (may be ""), authorUid (null for an
//     iMessage guest), authorName, source: "app" | "imessage", createdAt }
//
// firestore.rules checks the same shape for app posts.

export const MAX_COMMENT = 500;
export const MAX_NAME = 60;
const FALLBACK_NAME = "JOLO member";

export function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value.toDate === "function") {
    const date = value.toDate();
    return date instanceof Date && !Number.isNaN(date.getTime()) ? date : null;
  }
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value._seconds === "number") return new Date(value._seconds * 1000);
  return null;
}

const text = (value) => (typeof value === "string" ? value.trim() : "");

/** One review card, or null when the document isn't a usable review. */
export function toReview(id, data = {}) {
  const rating = Number(data.rating);
  const cafeId = text(data.cafeId);
  if (!cafeId || !Number.isFinite(rating) || rating < 1) return null;
  return {
    id: String(id),
    cafeId,
    cafeName: text(data.cafeName) || "Café",
    rating: Math.min(5, Math.round(rating)),
    comment: text(data.comment),
    user: text(data.authorName) || FALLBACK_NAME,
    authorUid: typeof data.authorUid === "string" ? data.authorUid : null,
    source: data.source === "imessage" ? "imessage" : "app",
    // A review just posted has no server time yet: it is the newest.
    createdAt: toDate(data.createdAt),
  };
}

function timeOf(review) {
  return review.createdAt instanceof Date ? review.createdAt.getTime() : Number.POSITIVE_INFINITY;
}

/** Newest first; a review still waiting for its server time goes on top. */
export function newestFirst(reviews) {
  return [...reviews].sort((a, b) => timeOf(b) - timeOf(a));
}

/** Average rating and count, for the owner's summary. */
export function ratingSummary(reviews) {
  if (!reviews.length) return { average: null, count: 0, byStar: [0, 0, 0, 0, 0] };
  const byStar = [0, 0, 0, 0, 0];
  let total = 0;
  for (const review of reviews) {
    total += review.rating;
    byStar[review.rating - 1] += 1;
  }
  return { average: Math.round((total / reviews.length) * 10) / 10, count: reviews.length, byStar };
}

/** An error message for the composer, or null when the review can be posted. */
export function validateReview({ cafe, rating, comment }) {
  if (!cafe?.id) return "Pick the café you went to.";
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return "Tap a star to rate it.";
  if ((comment ?? "").trim().length > MAX_COMMENT) {
    return `Keep it under ${MAX_COMMENT} characters.`;
  }
  return null;
}

/** The fields an app post writes; the caller adds createdAt as the server time. */
export function newReviewFields({ cafe, rating, comment, user }) {
  return {
    cafeId: cafe.id,
    cafeName: (text(cafe.name) || "Café").slice(0, 120),
    rating,
    comment: text(comment).slice(0, MAX_COMMENT),
    authorUid: user.uid,
    authorName: (text(user.displayName) || FALLBACK_NAME).slice(0, MAX_NAME),
    source: "app",
  };
}

/** "12 min ago", "2h ago", or a day label. */
export function formatReviewTime(date, now = new Date()) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "Just now";
  const minutes = Math.round((now.getTime() - date.getTime()) / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
