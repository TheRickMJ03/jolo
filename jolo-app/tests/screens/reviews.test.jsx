import { fireEvent, render, screen } from "@testing-library/react-native";
import SocialView from "@/app/user/social";
import ReviewsScreen from "@/app/owner/reviews";

// The first render loads both screens and their icon fonts, which is slow on a cold run.
jest.setTimeout(60_000);

const mockPost = jest.fn();
let mockReviews;
let mockReviewsArgs;

jest.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { uid: "u1", displayName: "Sam" } }) }));
jest.mock("@/lib/owner-context", () => ({
  useCafe: () => ({ id: "barbaras", name: "Barbara's" }),
}));
jest.mock("@/hooks/useAreaTrends", () => ({
  useAreaTrends: () => ({ loading: false, trending: [], error: null }),
}));
jest.mock("@/hooks/useUserLocation", () => ({ useUserLocation: () => ({ coords: null }) }));
jest.mock("@/hooks/useForYou", () => ({
  useForYou: () => ({ loading: false, source: "popular", cards: [], record: jest.fn() }),
}));
jest.mock("@/hooks/useCafes", () => ({
  useCafes: () => ({
    cafes: [
      { id: "barbaras", name: "Barbara's", municipality: "Westfield" },
      { id: "curiosity", name: "Curiosity", municipality: "Princeton" },
    ],
  }),
}));
jest.mock("@/hooks/useReviews", () => ({
  useReviews: (args) => {
    mockReviewsArgs = args;
    return { loading: false, reviews: mockReviews, error: null };
  },
  usePostReview: () => ({ post: mockPost, posting: false }),
}));

const review = (id, overrides = {}) => ({
  id,
  cafeId: "barbaras",
  cafeName: "Barbara's",
  rating: 4,
  comment: "Great cortado",
  user: "Priya S.",
  authorUid: "u2",
  source: "app",
  createdAt: new Date(),
  ...overrides,
});

beforeEach(() => {
  mockPost.mockReset();
  mockReviews = [
    review("r1", {
      comment: "Texted this one in",
      user: "iMessage guest",
      source: "imessage",
      rating: 5,
    }),
    review("r2", {
      comment: "Solid latte",
      user: "Marcus T.",
      cafeName: "Curiosity",
      cafeId: "curiosity",
    }),
  ];
});

describe("Social reviews", () => {
  it("lists every café's reviews in the order the hook gives them, newest first", async () => {
    await render(<SocialView />);
    expect(mockReviewsArgs).toBeUndefined();
    const comments = screen
      .getAllByText(/Texted this one in|Solid latte/)
      .map((n) => n.props.children);
    expect(comments).toEqual(["Texted this one in", "Solid latte"]);
    expect(screen.getByText(/via iMessage/)).toBeTruthy();
    expect(screen.getByLabelText("5 out of 5 stars")).toBeTruthy();
  });

  it("says how to start when there are none", async () => {
    mockReviews = [];
    await render(<SocialView />);
    expect(screen.getByText(/No reviews yet/)).toBeTruthy();
  });

  it("posts a review from the Write button", async () => {
    await render(<SocialView />);
    await fireEvent.press(screen.getByRole("button", { name: "Write a review" }));

    // Nothing picked yet: the sheet says what's missing instead of posting.
    await fireEvent.press(screen.getByRole("button", { name: "Post" }));
    expect(screen.getByText("Pick the café you went to.")).toBeTruthy();
    expect(mockPost).not.toHaveBeenCalled();

    await fireEvent.changeText(screen.getByLabelText("Search cafés"), "curio");
    await fireEvent.press(screen.getByRole("button", { name: "Curiosity" }));
    await fireEvent.press(screen.getByRole("button", { name: "4 stars" }));
    await fireEvent.changeText(screen.getByLabelText("Comment"), " Loved the matcha ");
    await fireEvent.press(screen.getByRole("button", { name: "Post" }));

    expect(mockPost).toHaveBeenCalledWith({
      cafe: expect.objectContaining({ id: "curiosity", name: "Curiosity" }),
      rating: 4,
      comment: "Loved the matcha",
    });
  });

  it("keeps the sheet open with an error when posting fails", async () => {
    mockPost.mockRejectedValueOnce(new Error("offline"));
    await render(<SocialView />);
    await fireEvent.press(screen.getByRole("button", { name: "Write a review" }));
    await fireEvent.press(screen.getByRole("button", { name: "Barbara's" }));
    await fireEvent.press(screen.getByRole("button", { name: "2 stars" }));
    await fireEvent.press(screen.getByRole("button", { name: "Post" }));
    expect(screen.getByText(/Couldn't post your review/)).toBeTruthy();
  });
});

describe("Owner reviews", () => {
  it("shows only this café's reviews, with the average", async () => {
    mockReviews = [
      review("a", { rating: 5 }),
      review("b", { rating: 4 }),
      review("c", { rating: 3 }),
    ];
    await render(<ReviewsScreen />);
    expect(mockReviewsArgs).toEqual({ cafeId: "barbaras" });
    expect(screen.getByText("4.0")).toBeTruthy();
    expect(screen.getByText("3 reviews")).toBeTruthy();
    expect(screen.getByLabelText("5 stars: 1")).toBeTruthy();
  });

  it("explains an empty tab", async () => {
    mockReviews = [];
    await render(<ReviewsScreen />);
    expect(screen.getByText("No reviews yet")).toBeTruthy();
  });
});
