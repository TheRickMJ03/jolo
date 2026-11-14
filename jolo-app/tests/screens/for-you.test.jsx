import { fireEvent, render, screen } from "@testing-library/react-native";
import ForYouScreen from "@/features/for-you/index";
import SavedScreen from "@/features/for-you/saved";
import AccountScreen from "@/features/for-you/account";

const record = jest.fn();
let mockState;

jest.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: { uid: "u1", phoneNumber: "+19085905037" },
    signOut: jest.fn(),
  }),
}));
jest.mock("@/lib/user-session", () => ({
  useForYouState: () => mockState,
}));
jest.mock("@/FirebaseConfig", () => ({ usingEmulators: false }));

const cortado = {
  cafeId: "demo-barbaras",
  itemId: "cortado",
  itemName: "Cortado",
  cafeName: "Barbara's",
  priceLabel: "$4.50",
  prices: [{ size: null, usd: 4.5 }],
  updatedLabel: "updated today",
  why: "Barbara's is serving Cortado for $4.50, updated today.",
  saved: false,
  source: "popular",
};
const latte = {
  ...cortado,
  itemId: "latte",
  itemName: "Lavender Oat Latte",
  priceLabel: "$5.75",
  prices: [{ size: null, usd: 5.75 }],
  why: "You keep coming back to oat milk espresso. Lavender oat lattes are showing up in recent café writing, and Barbara's has one for $5.75.",
};

beforeEach(() => {
  record.mockClear();
  mockState = {
    loading: false,
    error: null,
    source: "popular",
    cards: [cortado, latte],
    catalog: [cortado, latte],
    saved: [],
    taste: null,
    record,
  };
});

describe("For you", () => {
  it("shows the café, the menu price, and why", async () => {
    await render(<ForYouScreen />);
    expect(screen.getByText("Popular on fresh menus")).toBeTruthy();
    expect(screen.getByText("Cortado")).toBeTruthy();
    expect(screen.getByText("$4.50")).toBeTruthy();
    expect(screen.getByText(/Barbara's is serving Cortado/)).toBeTruthy();
  });

  it("records a search and narrows the list to drinks that match", async () => {
    await render(<ForYouScreen />);
    await fireEvent.changeText(screen.getByLabelText("Search drinks"), "oat milk latte");
    await fireEvent.press(screen.getByRole("button", { name: "Search" }));
    expect(record).toHaveBeenCalledWith({ type: "search", text: "oat milk latte" });
    expect(screen.getByText("Lavender Oat Latte")).toBeTruthy();
    expect(screen.queryByText("Cortado")).toBeNull();
    expect(screen.getByText("Matching drinks")).toBeTruthy();
  });

  it("records an order, a save, and a dismiss against that drink", async () => {
    mockState = { ...mockState, cards: [cortado], catalog: [cortado] };
    await render(<ForYouScreen />);
    await fireEvent.press(screen.getByRole("button", { name: "I ordered this" }));
    await fireEvent.press(screen.getByRole("button", { name: "Save" }));
    await fireEvent.press(screen.getByRole("button", { name: "Not for me" }));
    expect(record).toHaveBeenCalledWith({
      type: "purchase",
      cafeId: "demo-barbaras",
      itemId: "cortado",
      itemName: "Cortado",
    });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ type: "save", itemId: "cortado" }),
    );
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ type: "dismiss", itemId: "cortado" }),
    );
  });

  it("explains an empty menu", async () => {
    mockState = { ...mockState, cards: [], catalog: [] };
    await render(<ForYouScreen />);
    expect(screen.getByText("No drinks yet")).toBeTruthy();
  });
});

describe("Saved", () => {
  it("lists a saved drink and unsaves it", async () => {
    mockState = { ...mockState, saved: [{ ...latte, saved: true }] };
    await render(<SavedScreen />);
    expect(screen.getByText("Lavender Oat Latte")).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Saved" }));
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ type: "unsave", itemId: "latte" }),
    );
  });

  it("has an empty state", async () => {
    await render(<SavedScreen />);
    expect(screen.getByText("Nothing saved")).toBeTruthy();
  });
});

describe("Account", () => {
  it("shows the phone and the niche strings", async () => {
    mockState = { ...mockState, taste: { niches: ["oat milk espresso drinks"] } };
    await render(<AccountScreen />);
    expect(screen.getByLabelText("Signed in as: (908) 590-5037")).toBeTruthy();
    expect(screen.getByText("oat milk espresso drinks")).toBeTruthy();
  });
});
