// Reviews over iMessage (docs/conversation-design.md, "Reviews").
//
// When a customer looks at a café, the agent says which one (cafe_interest).
// Some time later JOLO asks whether they went and want to leave a review; a yes
// leads to a 1–5 rating and a comment, saved to Firestore `reviews/{id}` with
// source "imessage". The app's Social tab and the café owner's Reviews tab read
// that collection.
//
// The timer lives in this process. If the bridge restarts before it fires, the
// question is asked after the customer's next message instead.
import { randomUUID } from "node:crypto";

import {
  firestoreEmulatorHost,
  firestoreProjectId,
  firestoreServiceAccount,
  reviewPromptDelayMs,
  skipDotenv,
} from "../env.ts";
import { toE164 } from "./link-cafe.ts";
import type { JoloState, ReviewFollowUp } from "./types.ts";

export const MAX_COMMENT = 500;
/** Cafés already asked about, so one person is never asked about the same café twice. */
const MAX_REMEMBERED = 50;
export const GUEST_NAME = "iMessage guest";

// ---------------------------------------------------------------------------
// Reading replies
// ---------------------------------------------------------------------------

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 };

/**
 * "4", "4 stars", "4/5", "four out of five, great latte" → the rating and
 * whatever else they wrote (a comment sent in the same text). Null when there
 * is no rating from 1 to 5, or when there are two different ones.
 */
export function parseRating(text: string): { rating: number; rest: string } | null {
  const lowered = text.toLowerCase().normalize("NFKC");
  const pattern = /(?<![\d.])(\d+(?:\.\d+)?|one|two|three|four|five)(?![\d.])(\s*(?:\/\s*5|out of (?:5|five)))?(\s*(?:stars?|⭐️?))?/gu;
  const found: { value: number; start: number; end: number }[] = [];
  for (const match of lowered.matchAll(pattern)) {
    const token = match[1]!;
    const value = NUMBER_WORDS[token] ?? Number(token);
    found.push({ value, start: match.index!, end: match.index! + match[0].length });
  }
  const stars = [...text].filter((char) => char === "⭐").length;
  if (found.length === 0 && stars >= 1 && stars <= 5) {
    return { rating: stars, rest: text.replaceAll("⭐", "").replaceAll("️", "").trim() };
  }
  const ratings = new Set(found.map((entry) => entry.value));
  if (ratings.size !== 1) return null;
  const rating = found[0]!.value;
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return null;
  // The text around each rating, with the separators that joined it ("5, great", "3 - slow") trimmed.
  const pieces: string[] = [];
  let cursor = 0;
  for (const entry of found) {
    pieces.push(text.slice(cursor, entry.start));
    cursor = entry.end;
  }
  pieces.push(text.slice(cursor));
  const rest = pieces
    .map((piece) => piece.replace(/^[\s,.;:!\-–—]+|[\s,;:\-–—]+$/gu, ""))
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();
  return { rating, rest };
}

/** "yes, I went, great latte" → "great latte": the answer to "did you go?" isn't part of the comment. */
export function withoutYes(text: string): string {
  return text.replace(/^(?:(?:yes|yeah|yep|yup|ya|sure|i did|we did|i went|we went|did)\b[\s,.!]*)+/iu, "").trim();
}

/** True when the leftover text is worth keeping as a comment (not "yes", "stars", "!"). */
export function isComment(text: string): boolean {
  const letters = text.replace(/[^\p{L}]/gu, "");
  if (letters.length < 3) return false;
  return !/^(yes|yeah|yep|yup|sure|ok|okay|stars?)$/iu.test(text.trim().replace(/[^\p{L}\s]/gu, "").trim());
}

const SKIP = new Set(["skip", "no", "nope", "nah", "none", "nothing", "n/a", "na", "pass", "no thanks", "no comment", "that's it", "thats it"]);

/** "skip" or "no thanks" at the comment question: save just the rating. */
export function skipsComment(text: string): boolean {
  return SKIP.has(text.trim().toLowerCase().replace(/[.!]+$/u, ""));
}

// ---------------------------------------------------------------------------
// When to ask
// ---------------------------------------------------------------------------

/**
 * Plans the review question for a café the customer just looked at. A newer
 * café replaces one that hasn't been asked about yet; a question already
 * asked, or a café asked about before, is left alone. Returns the follow-up
 * that was planned, or null.
 */
export function planReview(
  state: JoloState,
  cafe: { cafeId: string; cafeName: string },
  now = Date.now(),
  delayMs = reviewPromptDelayMs,
): ReviewFollowUp | null {
  if (state.role !== "customer" || !cafe.cafeId || !cafe.cafeName) return null;
  if (state.review && state.review.stage !== "scheduled") return null;
  if (state.reviewedCafes?.includes(cafe.cafeId)) return null;
  state.review = {
    cafeId: cafe.cafeId,
    cafeName: cafe.cafeName,
    stage: "scheduled",
    dueAt: new Date(now + delayMs).toISOString(),
  };
  return state.review;
}

/** A planned question whose time has come. */
export function reviewDue(state: JoloState, now = Date.now()): boolean {
  return state.review?.stage === "scheduled" && Date.parse(state.review.dueAt) <= now;
}

/** The question was asked: remember the café so it isn't asked about again. */
export function markAsked(state: JoloState): void {
  if (!state.review) return;
  state.review.stage = "asked";
  const asked = (state.reviewedCafes ?? []).filter((id) => id !== state.review!.cafeId);
  asked.push(state.review.cafeId);
  state.reviewedCafes = asked.slice(-MAX_REMEMBERED);
}

const timers = new Map<string, NodeJS.Timeout>();

/**
 * Calls `fire` once the follow-up is due. One timer per conversation; a newer
 * plan replaces the older timer. The timer never keeps the process alive.
 */
export function scheduleReviewTimer(spaceId: string, dueAt: string, fire: () => Promise<void>): void {
  cancelReviewTimer(spaceId);
  const wait = Math.max(0, Date.parse(dueAt) - Date.now());
  const timer = setTimeout(() => {
    timers.delete(spaceId);
    fire().catch((error) => {
      console.error(`[jolo] review question not sent: ${error instanceof Error ? error.message : error}`);
    });
  }, wait);
  timer.unref?.();
  timers.set(spaceId, timer);
}

export function cancelReviewTimer(spaceId: string): void {
  const timer = timers.get(spaceId);
  if (timer) clearTimeout(timer);
  timers.delete(spaceId);
}

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

export interface NewReview {
  /** The texter's handle; turned into E.164 to find their app account. Never stored. */
  phone: string;
  cafeId: string;
  cafeName: string;
  rating: number;
  comment: string;
}

/** The Firestore document, as the app reads it (jolo-app/lib/reviews.js). */
export interface ReviewDoc {
  cafeId: string;
  cafeName: string;
  rating: number;
  comment: string;
  authorUid: string | null;
  authorName: string;
  source: "imessage";
}

export type ReviewDb = {
  /** The app account signed in with this phone, if there is one. */
  author(phone: string): Promise<{ uid: string; name: string | null } | null>;
  add(id: string, review: ReviewDoc): Promise<void>;
};

export function reviewDoc(review: NewReview, author: { uid: string; name: string | null } | null): ReviewDoc {
  return {
    cafeId: review.cafeId.slice(0, 80),
    cafeName: review.cafeName.trim().slice(0, 120) || "Café",
    rating: Math.min(5, Math.max(1, Math.round(review.rating))),
    comment: review.comment.trim().slice(0, MAX_COMMENT),
    authorUid: author?.uid ?? null,
    authorName: author?.name?.trim().slice(0, 60) || GUEST_NAME,
    source: "imessage",
  };
}

export async function saveReviewWith(db: ReviewDb, review: NewReview): Promise<string> {
  const phone = toE164(review.phone);
  const author = phone ? await db.author(phone).catch(() => null) : null;
  const id = randomUUID();
  await db.add(id, reviewDoc(review, author));
  return id;
}

/** The default writer: the emulator when FIRESTORE_EMULATOR_HOST is set, else the Admin SDK. */
export async function saveReview(review: NewReview): Promise<void> {
  if (firestoreEmulatorHost) {
    await saveReviewWith(emulatorDb(firestoreEmulatorHost), review);
    return;
  }
  if (!firestoreServiceAccount && skipDotenv) return;
  adminDb ??= openAdmin().catch((error) => {
    adminDb = undefined;
    throw error;
  });
  await saveReviewWith(await adminDb, review);
}

function emulatorDb(host: string): ReviewDb {
  const base = `http://${host}/v1/projects/${firestoreProjectId}/databases/(default)/documents`;
  const headers = { Authorization: "Bearer owner", "content-type": "application/json" };
  return {
    async author(phone) {
      const response = await fetch(`${base}:runQuery`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          structuredQuery: {
            from: [{ collectionId: "private", allDescendants: true }],
            where: {
              fieldFilter: { field: { fieldPath: "phoneNumber" }, op: "EQUAL", value: { stringValue: phone } },
            },
            limit: 1,
          },
        }),
      });
      if (!response.ok) return null;
      const rows = (await response.json()) as { document?: { name: string } }[];
      const path = rows.find((row) => row.document)?.document?.name ?? "";
      const uid = path.match(/\/users\/([^/]+)\/private\//)?.[1];
      if (!uid) return null;
      const profile = await fetch(`${base}/users/${uid}`, { headers });
      const body = profile.ok ? ((await profile.json()) as { fields?: { displayName?: { stringValue?: string } } }) : {};
      return { uid, name: body.fields?.displayName?.stringValue ?? null };
    },
    async add(id, review) {
      const response = await fetch(`${base}/reviews?documentId=${id}`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          fields: {
            cafeId: { stringValue: review.cafeId },
            cafeName: { stringValue: review.cafeName },
            rating: { integerValue: String(review.rating) },
            comment: { stringValue: review.comment },
            authorUid: review.authorUid ? { stringValue: review.authorUid } : { nullValue: null },
            authorName: { stringValue: review.authorName },
            source: { stringValue: review.source },
            createdAt: { timestampValue: new Date().toISOString() },
          },
        }),
      });
      if (!response.ok) throw new Error(`review save failed: ${response.status} ${await response.text()}`);
    },
  };
}

let adminDb: Promise<ReviewDb> | undefined;

async function openAdmin(): Promise<ReviewDb> {
  const { applicationDefault, cert, getApps, initializeApp } = await import("firebase-admin/app");
  const { FieldValue, getFirestore } = await import("firebase-admin/firestore");
  const app =
    getApps()[0] ??
    initializeApp({
      credential: firestoreServiceAccount ? cert(firestoreServiceAccount) : applicationDefault(),
      projectId: firestoreProjectId,
    });
  const db = getFirestore(app);
  return {
    async author(phone) {
      const snap = await db.collectionGroup("private").where("phoneNumber", "==", phone).limit(1).get();
      const user = snap.docs[0]?.ref.parent.parent;
      if (!user) return null;
      const profile = await user.get();
      const name = profile.get("displayName");
      return { uid: user.id, name: typeof name === "string" ? name : null };
    },
    async add(id, review) {
      await db.collection("reviews").doc(id).set({ ...review, createdAt: FieldValue.serverTimestamp() });
    },
  };
}
