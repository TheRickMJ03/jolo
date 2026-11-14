import {
  askSummary,
  buildSuggestions,
  findOnMenu,
  isDrinkPhrase,
  menuStats,
  menuTiles,
  nameOverlap,
  otherShopRows,
  sourcesLine,
  webRows,
} from "@/lib/owner-insights";

const NOW = new Date("2026-11-14T12:00:00Z");
const daysAgo = (days) => new Date(NOW.getTime() - days * 86_400_000);

const drink = (id, name, usd, extra = {}) => ({
  id,
  item: name,
  category: "drink",
  prices: usd == null ? [] : [{ size: null, usd }],
  confidence: 1,
  available: true,
  ...extra,
});

const MENU = [
  drink("cortado", "Cortado", 4.5),
  drink("latte", "Latte", 3.5),
  drink("matcha", "Iced Matcha Latte", 6.25),
  drink("mocha", "Mocha", 5, { available: false }),
  drink("mystery", "Mystery Brew", null, { confidence: 0.3 }),
  {
    id: "muffin",
    item: "Muffin",
    category: "food",
    prices: [{ size: null, usd: 3 }],
    confidence: 1,
  },
];

const ANALYTICS = {
  generatedAt: NOW,
  area: "Westfield",
  otherShops: [
    { name: "Lavender Oat Latte", addedAt: 2, servedAt: 2, cafes: ["Ayala", "Black Drop"] },
    { name: "Cortado", addedAt: 0, servedAt: 3, cafes: ["Ayala"] },
  ],
  nearby: {
    scope: "Westfield",
    terms: [
      { term: "Mocha", count: 4 },
      { term: "Oat milk", count: 3 },
    ],
    searches: 7,
  },
  web: [
    { name: "Lavender oat latte", momentum: "rising", sources: ["reddit"], mentions: 6 },
    { name: "Iced matcha", momentum: "steady", sources: ["blogs"], mentions: 2 },
  ],
  sources: {
    blogs: { ok: true, posts: 12 },
    reddit: { ok: true, posts: 14 },
    tiktok: { ok: false, error: "off: no SCRAPFLY_KEY", posts: 0 },
  },
};

const WEEKS = [
  {
    weekStart: "2026-11-09",
    counts: { customerQuestions: 42, uniqueCustomers: 17 },
    topItems: [{ name: "Cortado", mentions: 9 }],
    summary: "Questions doubled.",
  },
  { weekStart: "2026-11-02", counts: { customerQuestions: 21 }, topItems: [] },
];

describe("matching a name to the menu", () => {
  it("scores the share of words the item shares", () => {
    expect(nameOverlap("oat milk latte", "Lavender Oat Latte")).toBeCloseTo(2 / 3);
    expect(nameOverlap("", "Latte")).toBe(0);
  });

  it("finds an exact or near drink, either name the longer one", () => {
    expect(findOnMenu("iced matcha", MENU).id).toBe("matcha");
    expect(findOnMenu("Cortado", MENU).id).toBe("cortado");
    expect(findOnMenu("Lavender oat latte", MENU)).toBeNull();
    expect(findOnMenu("Muffin", MENU)).toBeNull();
  });

  it("knows a drink phrase from an extra", () => {
    expect(isDrinkPhrase("Mocha")).toBe(true);
    expect(isDrinkPhrase("Oat milk")).toBe(false);
  });
});

describe("menuStats", () => {
  it("counts the live menu and the price changes in the last 30 days", () => {
    const versions = [
      { createdAt: daysAgo(3), changes: { price_changes: [{}, {}] } },
      { createdAt: daysAgo(40), changes: { price_changes: [{}] } },
    ];
    const stats = menuStats(MENU, versions, NOW);
    expect(stats).toMatchObject({
      items: 6,
      drinks: 5,
      food: 1,
      toCheck: 1,
      soldOut: 1,
      noPrice: 1,
      priceChanges: 2,
    });
    expect(stats.drinkPrices).toEqual({ min: 3.5, median: 4.75, max: 6.25 });
    const tiles = Object.fromEntries(menuTiles(stats).map((tile) => [tile.key, tile]));
    expect(tiles.range.value).toBe("$3.50–$6.25");
    expect(tiles.toCheck.warn).toBe(true);
  });

  it("handles an empty menu", () => {
    const stats = menuStats([], [], NOW);
    expect(stats.drinkPrices).toBeNull();
    expect(menuTiles(stats).find((tile) => tile.key === "range").value).toBe("–");
  });
});

describe("askSummary", () => {
  it("compares this week's questions with last week's", () => {
    expect(askSummary(WEEKS)).toMatchObject({ questions: 42, change: "2× last week" });
    expect(
      askSummary([
        { counts: { customerQuestions: 11 }, topItems: [] },
        { counts: { customerQuestions: 10 } },
      ]).change,
    ).toBe("+10% on last week");
    expect(askSummary([{ counts: {}, topItems: [] }]).change).toBeNull();
    expect(askSummary([])).toBeNull();
  });
});

describe("buildSuggestions", () => {
  const suggestions = buildSuggestions({ items: MENU, analytics: ANALYTICS, weeks: WEEKS });
  const byKind = (kind) => suggestions.filter((row) => row.kind === kind);

  it("suggests adding a drink trending online and added at other shops, with its evidence", () => {
    const [add] = byKind("add");
    expect(add.title).toBe("Consider adding Lavender oat latte");
    expect(add.reasons).toEqual(["Rising on Reddit", "Added at 2 other shops this month"]);
    expect(suggestions[0]).toBe(add);
  });

  it("suggests bringing back a sold-out drink people search for", () => {
    const [restock] = byKind("restock");
    expect(restock.title).toBe("Bring back your Mocha");
    expect(restock.reasons).toEqual(["4 searches in Westfield"]);
  });

  it("suggests featuring drinks already on the menu", () => {
    const titles = byKind("feature").map((row) => row.title);
    expect(titles).toContain("Feature your Iced Matcha Latte");
    expect(titles).toContain("Feature your Cortado");
    const cortado = byKind("feature").find((row) => row.title.endsWith("Cortado"));
    expect(cortado.reasons).toEqual(["Most asked about this week"]);
  });

  it("ends with the items the reader wasn't sure of, and never an extra like oat milk", () => {
    expect(suggestions.at(-1)).toMatchObject({ kind: "check", title: "Check 1 item on your menu" });
    expect(suggestions.some((row) => /oat milk/i.test(row.title))).toBe(false);
    expect(suggestions.length).toBeLessThanOrEqual(5);
  });

  it("merges two names for one drink into a single suggestion", () => {
    const rows = buildSuggestions({
      items: [],
      analytics: {
        otherShops: [{ name: "Iced Matcha Latte", addedAt: 2, servedAt: 2 }],
        nearby: { scope: "Union County", terms: [{ term: "Iced matcha", count: 2 }] },
        web: [{ name: "Cold brew", momentum: "steady", sources: ["blogs"] }],
      },
      weeks: [],
    });
    expect(rows[0]).toMatchObject({
      title: "Consider adding Iced Matcha Latte",
      reasons: ["Added at 2 other shops this month", "2 searches in Union County"],
    });
    expect(rows[1].reasons).toEqual(["Talked about on café blogs"]);
  });

  it("works with no analytics yet: only the menu check", () => {
    expect(buildSuggestions({ items: MENU, analytics: null, weeks: [] })).toEqual([
      expect.objectContaining({ kind: "check" }),
    ]);
    expect(buildSuggestions({ items: [], analytics: null, weeks: [] })).toEqual([]);
  });

  it("stops suggesting a drink once it is on the menu", () => {
    const withIt = [...MENU, drink("lav", "Lavender Oat Latte", 5.75)];
    const after = buildSuggestions({ items: withIt, analytics: ANALYTICS, weeks: WEEKS });
    expect(after.find((row) => row.kind === "add")).toBeUndefined();
    expect(after[0].title).toBe("Feature your Lavender Oat Latte");
  });
});

describe("rows and the sources line", () => {
  it("marks other-shop and web rows on or off the menu", () => {
    const shops = otherShopRows(ANALYTICS, MENU);
    expect(shops).toEqual([
      expect.objectContaining({
        name: "Lavender Oat Latte",
        onMenu: false,
        detail: "Added at 2 this month: Ayala, Black Drop",
      }),
    ]);
    // Cortado is a staple other shops serve; it only shows when this menu lacks it.
    const without = otherShopRows(ANALYTICS, MENU.slice(1));
    expect(without[1]).toMatchObject({ name: "Cortado", detail: "Served at 3 other shops" });
    const web = webRows(ANALYTICS, MENU);
    expect(web.map((row) => row.onMenu)).toEqual([false, true]);
    expect(web[0].sourceLabels).toEqual(["Reddit"]);
  });

  it("says when it ran and which sources worked", () => {
    expect(sourcesLine(ANALYTICS, NOW)).toBe("Updated today · Café blogs · Reddit · TikTok off");
    expect(sourcesLine(null, NOW)).toBe("");
    expect(
      sourcesLine({ generatedAt: NOW, sources: { reddit: { ok: true, posts: 0 } } }, NOW),
    ).toBe("Updated today · Reddit: nothing found");
  });
});
