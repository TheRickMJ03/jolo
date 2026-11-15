import {
  formatReviewTime,
  newestFirst,
  newReviewFields,
  ratingSummary,
  toReview,
  validateReview,
} from "@/lib/reviews";

describe("toReview", () => {
  it("reads an app review", () => {
    const review = toReview("r1", {
      cafeId: "barbaras",
      cafeName: "Barbara's",
      rating: 4,
      comment: " Great cortado ",
      authorUid: "u1",
      authorName: "Priya S.",
      source: "app",
      createdAt: new Date("2026-11-15T03:00:00Z"),
    });
    expect(review).toMatchObject({
      id: "r1",
      cafeId: "barbaras",
      cafeName: "Barbara's",
      rating: 4,
      comment: "Great cortado",
      user: "Priya S.",
      source: "app",
    });
    expect(review.createdAt).toBeInstanceOf(Date);
  });

  it("reads an iMessage review with no comment and no account", () => {
    const review = toReview("r2", {
      cafeId: "barbaras",
      cafeName: "Barbara's",
      rating: 5,
      comment: "",
      authorUid: null,
      authorName: "iMessage guest",
      source: "imessage",
      createdAt: { toDate: () => new Date("2026-11-15T03:00:00Z") },
    });
    expect(review.comment).toBe("");
    expect(review.source).toBe("imessage");
    expect(review.authorUid).toBeNull();
  });

  it("drops a document with no café or no rating", () => {
    expect(toReview("x", { rating: 5 })).toBeNull();
    expect(toReview("y", { cafeId: "a", comment: "nice" })).toBeNull();
  });
});

describe("newestFirst", () => {
  it("sorts by time, with a review still waiting for its server time on top", () => {
    const at = (id, iso) => ({ id, createdAt: iso ? new Date(iso) : null });
    const sorted = newestFirst([
      at("old", "2026-11-10T00:00:00Z"),
      at("new", "2026-11-14T00:00:00Z"),
      at("pending", null),
      at("mid", "2026-11-12T00:00:00Z"),
    ]);
    expect(sorted.map((r) => r.id)).toEqual(["pending", "new", "mid", "old"]);
  });
});

describe("ratingSummary", () => {
  it("averages to one decimal and counts each star", () => {
    expect(ratingSummary([{ rating: 5 }, { rating: 4 }, { rating: 4 }])).toEqual({
      average: 4.3,
      count: 3,
      byStar: [0, 0, 0, 2, 1],
    });
    expect(ratingSummary([]).average).toBeNull();
  });
});

describe("posting", () => {
  const cafe = { id: "barbaras", name: "Barbara's" };

  it("needs a café and a rating; the comment is optional", () => {
    expect(validateReview({ cafe: null, rating: 4, comment: "" })).toMatch(/café/);
    expect(validateReview({ cafe, rating: 0, comment: "" })).toMatch(/star/);
    expect(validateReview({ cafe, rating: 4, comment: "a".repeat(501) })).toMatch(/500/);
    expect(validateReview({ cafe, rating: 4, comment: "" })).toBeNull();
  });

  it("writes exactly the fields the rules allow", () => {
    const fields = newReviewFields({
      cafe,
      rating: 4,
      comment: "  Lovely  ",
      user: { uid: "u1", displayName: null },
    });
    expect(fields).toEqual({
      cafeId: "barbaras",
      cafeName: "Barbara's",
      rating: 4,
      comment: "Lovely",
      authorUid: "u1",
      authorName: "JOLO member",
      source: "app",
    });
  });
});

describe("formatReviewTime", () => {
  const now = new Date("2026-11-15T12:00:00Z");
  it("reads like a feed", () => {
    expect(formatReviewTime(null, now)).toBe("Just now");
    expect(formatReviewTime(new Date("2026-11-15T11:48:00Z"), now)).toBe("12 min ago");
    expect(formatReviewTime(new Date("2026-11-15T10:00:00Z"), now)).toBe("2h ago");
    expect(formatReviewTime(new Date("2026-11-14T10:00:00Z"), now)).toBe("Yesterday");
    expect(formatReviewTime(new Date("2026-11-12T12:00:00Z"), now)).toBe("3d ago");
  });
});
