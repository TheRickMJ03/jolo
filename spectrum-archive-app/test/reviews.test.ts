import "./setup.ts";

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  GUEST_NAME,
  isComment,
  markAsked,
  parseRating,
  planReview,
  reviewDoc,
  reviewDue,
  saveReviewWith,
  skipsComment,
  withoutYes,
} from "../src/jolo/reviews.ts";
import type { JoloState } from "../src/jolo/types.ts";

test("ratings are read from numbers, words, stars and x/5", () => {
  assert.deepEqual(parseRating("4"), { rating: 4, rest: "" });
  assert.deepEqual(parseRating("4 stars"), { rating: 4, rest: "" });
  assert.deepEqual(parseRating("4/5"), { rating: 4, rest: "" });
  assert.deepEqual(parseRating("five out of five, loved it"), { rating: 5, rest: "loved it" });
  assert.deepEqual(parseRating("⭐⭐⭐"), { rating: 3, rest: "" });
  assert.deepEqual(parseRating("I'd say 3 - slow service"), { rating: 3, rest: "I'd say slow service" });
});

test("the yes that answered \"did you go?\" is left out of the comment", () => {
  assert.equal(withoutYes("yes, I went, perfect latte"), "perfect latte");
  assert.equal(withoutYes("Yesterday was great"), "Yesterday was great");
});

test("no rating, out of range, decimals, or two different numbers are unclear", () => {
  assert.equal(parseRating("great"), null);
  assert.equal(parseRating("0"), null);
  assert.equal(parseRating("7"), null);
  assert.equal(parseRating("4.5"), null);
  assert.equal(parseRating("3 or 4"), null);
});

test("leftover words count as a comment only when they say something", () => {
  assert.equal(isComment(""), false);
  assert.equal(isComment("stars"), false);
  assert.equal(isComment("yes!"), false);
  assert.equal(isComment("loved the oat latte"), true);
  assert.equal(skipsComment("Skip"), true);
  assert.equal(skipsComment("no thanks."), true);
  assert.equal(skipsComment("not bad at all"), false);
});

test("a review is planned for customers only, replaced by a newer café, and never repeated", () => {
  const state: JoloState = { role: "customer" };
  assert.ok(planReview(state, { cafeId: "a", cafeName: "A" }, 0, 1000));
  assert.ok(planReview(state, { cafeId: "b", cafeName: "B" }, 0, 1000));
  assert.equal(state.review?.cafeId, "b");
  assert.equal(reviewDue(state, 999), false);
  assert.equal(reviewDue(state, 1000), true);
  markAsked(state);
  assert.equal(planReview(state, { cafeId: "c", cafeName: "C" }, 0, 1000), null); // one at a time
  delete state.review;
  assert.equal(planReview(state, { cafeId: "b", cafeName: "B" }, 0, 1000), null); // asked before
  assert.equal(planReview({ role: "owner" }, { cafeId: "a", cafeName: "A" }), null);
});

test("the stored review names the app account, or a guest, and never the phone", async () => {
  const added: unknown[] = [];
  const db = {
    async author(phone: string) {
      return phone === "+19085551234" ? { uid: "u1", name: "Sam R." } : null;
    },
    async add(_id: string, review: unknown) {
      added.push(review);
    },
  };
  await saveReviewWith(db, { phone: "(908) 555-1234", cafeId: "barbaras", cafeName: "Barbara's", rating: 5, comment: " Great " });
  await saveReviewWith(db, { phone: "terminal-user", cafeId: "barbaras", cafeName: "Barbara's", rating: 2, comment: "" });
  assert.deepEqual(added, [
    { cafeId: "barbaras", cafeName: "Barbara's", rating: 5, comment: "Great", authorUid: "u1", authorName: "Sam R.", source: "imessage" },
    { cafeId: "barbaras", cafeName: "Barbara's", rating: 2, comment: "", authorUid: null, authorName: GUEST_NAME, source: "imessage" },
  ]);
  assert.equal(reviewDoc({ phone: "", cafeId: "x", cafeName: "X", rating: 9, comment: "a".repeat(600) }, null).rating, 5);
});
