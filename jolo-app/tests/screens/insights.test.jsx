import { fireEvent, render, screen } from "@testing-library/react-native";
import InsightsScreen from "@/app/owner/insights";

const NOW = new Date();
const mockCafe = { id: "cafe1", name: "Barbara's", currentMenuVersion: 3, menuUpdatedAt: NOW };
const mockItems = [
  {
    id: "cortado",
    item: "Cortado",
    category: "drink",
    prices: [{ size: null, usd: 4.5 }],
    confidence: 1,
    available: true,
  },
  {
    id: "mystery",
    item: "Mystery Brew",
    category: "drink",
    prices: [{ size: null, usd: 5 }],
    confidence: 0.3,
    available: true,
  },
];
let mockAnalytics;
const mockWeeks = [
  {
    weekStart: "2026-11-09",
    counts: { customerQuestions: 42 },
    topItems: [{ name: "Cortado", mentions: 9 }],
    summary: "Questions doubled after the price change.",
  },
  { weekStart: "2026-11-02", counts: { customerQuestions: 21 }, topItems: [] },
];

jest.mock("@/lib/owner-context", () => ({ useCafe: () => mockCafe }));
jest.mock("@/hooks/useMenu", () => ({
  useCurrentMenu: () => ({ loading: false, version: { items: mockItems }, error: null }),
  useMenuHistory: () => ({ loading: false, versions: [], error: null }),
}));
jest.mock("@/hooks/useInsights", () => ({
  useInsights: () => ({ loading: false, weeks: mockWeeks, error: null }),
}));
jest.mock("@/hooks/useOwnerAnalytics", () => ({
  useOwnerAnalytics: () => ({ loading: false, analytics: mockAnalytics, error: null }),
}));

beforeEach(() => {
  mockAnalytics = {
    generatedAt: NOW,
    area: "Westfield",
    otherShops: [{ name: "Lavender Oat Latte", addedAt: 2, servedAt: 2, cafes: ["Ayala"] }],
    nearby: { scope: "Westfield", terms: [{ term: "Oat milk", count: 3 }], searches: 5 },
    web: [
      {
        name: "Lavender oat latte",
        momentum: "rising",
        sources: ["blogs", "reddit"],
        mentions: 6,
        example: { title: "Lavender oat lattes are everywhere", url: "https://example.com/post" },
      },
    ],
    sources: { blogs: { ok: true }, reddit: { ok: true }, tiktok: { ok: false } },
  };
});

it("puts suggestions, the menu, customer asks and every trend source in one place", async () => {
  await render(<InsightsScreen />);
  expect(screen.getByText("Updated today · Café blogs · Reddit · TikTok off")).toBeTruthy();
  expect(screen.getByText("Consider adding Lavender oat latte")).toBeTruthy();
  expect(
    screen.getByText("Rising on café blogs and Reddit · Added at 2 other shops this month"),
  ).toBeTruthy();
  expect(screen.getByText("Check 1 item on your menu")).toBeTruthy();
  for (const title of [
    "Your menu",
    "Customer asks",
    "Other shops",
    "Asked about in Westfield",
    "On the web",
  ]) {
    expect(screen.getByText(title)).toBeTruthy();
  }
  expect(screen.getByText("Week of Nov 9 · 2× last week")).toBeTruthy();
  expect(screen.getByText("“Lavender oat lattes are everywhere”")).toBeTruthy();
  expect(screen.getAllByText("Not on menu").length).toBe(2);
});

it("opens past weeks on demand", async () => {
  await render(<InsightsScreen />);
  expect(screen.queryByText(/Week of Nov 2/)).toBeNull();
  await fireEvent.press(screen.getByText("Past weeks (1)"));
  expect(screen.getByText("Week of Nov 2 · 21 customer questions")).toBeTruthy();
});

it("still shows the menu and asks before the trends job has run", async () => {
  mockAnalytics = null;
  await render(<InsightsScreen />);
  expect(screen.getByText("Your menu")).toBeTruthy();
  expect(screen.getByText("Customer asks")).toBeTruthy();
  expect(screen.getByText("Trends are on their way")).toBeTruthy();
  expect(screen.queryByText("On the web")).toBeNull();
});
