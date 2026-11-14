import {
  assembleForYou,
  cardsForSession,
  coldStartCards,
  hydrateCards,
  isRecommendable,
  personalWhy,
  pickVariant,
  savedCards,
  searchDrinks,
  visibleCards,
  whyPopular,
} from "@/lib/recommendations";

const now = new Date("2026-11-14T15:00:00Z");
const today = new Date("2026-11-14T12:00:00Z");
const threeDays = new Date("2026-11-11T12:00:00Z");

const drink = (id, item, extra = {}) => ({
  id,
  item,
  category: "drink",
  prices: [{ size: null, usd: 4.5 }],
  confidence: 1,
  available: true,
  ...extra,
});

const barbaras = { id: "demo-barbaras", name: "Barbara's", menuUpdatedAt: today };
const older = { id: "older", name: "Older Café", menuUpdatedAt: threeDays };

describe("isRecommendable", () => {
  it("keeps a confirmed available drink", () => {
    expect(isRecommendable(drink("cortado", "Cortado"))).toBe(true);
    expect(isRecommendable(drink("latte", "Latte", { confidence: 0.7 }))).toBe(true);
  });

  it("drops food, sold-out items, and reads the owner has not confirmed", () => {
    expect(isRecommendable(drink("muffin", "Muffin", { category: "food" }))).toBe(false);
    expect(isRecommendable(drink("oat", "Oat Milk", { category: "modifier" }))).toBe(false);
    expect(isRecommendable(drink("latte", "Latte", { available: false }))).toBe(false);
    expect(isRecommendable(drink("mystery", "Mystery", { confidence: 0.4 }))).toBe(false);
  });
});

describe("cold start", () => {
  const menus = {
    "demo-barbaras": [
      drink("cortado", "Cortado", { prices: [{ size: null, usd: 4.5 }] }),
      drink("latte", "Latte", { prices: [{ size: null, usd: 5 }] }),
      drink("muffin", "Muffin", { category: "food" }),
    ],
    older: [drink("cappuccino", "Cappuccino")],
  };

  it("ranks drinks people ask about, and only from a fresh menu", () => {
    const cards = coldStartCards({
      cafes: [
        barbaras,
        older,
        { id: "stale", name: "Stale", menuUpdatedAt: new Date("2026-10-01") },
      ],
      menusByCafe: { ...menus, stale: [drink("mocha", "Mocha")] },
      topItemsByCafe: { "demo-barbaras": [{ name: "Latte", mentions: 6 }] },
      now,
    });
    expect(cards.map((card) => card.itemName)).toEqual(["Latte", "Cortado", "Cappuccino"]);
    expect(cards[0].why).toBe(
      "People have been asking about Latte. Barbara's has one for $5.00, updated today.",
    );
    expect(cards[0].priceUsd).toBe(5);
    expect(cards.some((card) => card.itemName === "Mocha" || card.itemName === "Muffin")).toBe(
      false,
    );
  });

  it("says what the café is serving when nobody has asked yet", () => {
    expect(
      whyPopular({
        itemName: "Cortado",
        cafeName: "Barbara's",
        priceLabel: "$4.50",
        mentions: 0,
        updatedLabel: "updated today",
      }),
    ).toBe("Barbara's is serving Cortado for $4.50, updated today.");
  });
});

describe("personal cards", () => {
  it("writes the spec's sentence from the menu price", () => {
    expect(
      personalWhy({
        tasteLead: "You keep coming back to oat milk espresso",
        phrase: "Lavender oat latte",
        cafeName: "Barbara's",
        priceLabel: "$5.75",
      }),
    ).toBe(
      "You keep coming back to oat milk espresso. Lavender oat lattes are showing up in recent café writing, and Barbara's has one for $5.75.",
    );
  });

  it("replaces a stored price with the one on the menu now", () => {
    const cards = hydrateCards(
      [
        {
          cafeId: "demo-barbaras",
          itemId: "lavender",
          tasteLead: "You keep coming back to oat milk espresso",
          phrase: "Lavender oat latte",
          why: "old sentence for $1.00.",
          score: 0.9,
        },
        { cafeId: "demo-barbaras", itemId: "gone", phrase: "Missing", tasteLead: "Hi", score: 1 },
      ],
      [barbaras],
      {
        "demo-barbaras": [
          drink("lavender", "Lavender Oat Latte", { prices: [{ size: null, usd: 5.75 }] }),
        ],
      },
      now,
    );
    expect(cards).toHaveLength(1);
    expect(cards[0].priceUsd).toBe(5.75);
    expect(cards[0].why).toContain("for $5.75");
    expect(cards[0].why).not.toContain("$1.00");
  });
});

describe("events on the list", () => {
  const cards = [
    {
      cafeId: "demo-barbaras",
      itemId: "cortado",
      itemName: "Cortado",
      cafeName: "Barbara's",
    },
    {
      cafeId: "demo-barbaras",
      itemId: "latte",
      itemName: "Latte",
      cafeName: "Barbara's",
    },
  ];

  it("hides an ordered drink and a dismissed one, and marks a save", () => {
    const visible = visibleCards(cards, [
      { type: "save", cafeId: "demo-barbaras", itemId: "latte", itemName: "Latte" },
      { type: "purchase", cafeId: "demo-barbaras", itemId: "cortado", itemName: "Cortado" },
      { type: "dismiss", cafeId: "demo-barbaras", itemId: "latte", itemName: "Latte" },
    ]);
    expect(visible.map((card) => card.itemName)).toEqual([]);
  });

  it("lets a later unsave undo a save", () => {
    const saved = savedCards(cards, [
      {
        type: "save",
        cafeId: "demo-barbaras",
        itemId: "latte",
        itemName: "Latte",
        createdAt: new Date("2026-11-01"),
      },
      {
        type: "unsave",
        cafeId: "demo-barbaras",
        itemId: "latte",
        itemName: "Latte",
        createdAt: new Date("2026-11-02"),
      },
    ]);
    expect(saved).toEqual([]);
  });
});

describe("the session", () => {
  it("splits sessions in half and keeps the popular list until personal cards exist", () => {
    expect(pickVariant(0.1)).toBe("personal");
    expect(pickVariant(0.6)).toBe("popular");
    expect(
      cardsForSession({ personal: [], popular: [{ itemName: "Latte" }], variant: "personal" })
        .source,
    ).toBe("popular");
    expect(
      cardsForSession({
        personal: [{ itemName: "Oat" }],
        popular: [{ itemName: "Latte" }],
        variant: "personal",
      }).source,
    ).toBe("personal");
  });

  it("searches the drink and the café, skipping filler words", () => {
    const cards = [
      { itemName: "Lavender Oat Latte", cafeName: "Barbara's" },
      { itemName: "Cortado", cafeName: "Barbara's" },
    ];
    expect(searchDrinks(cards, "oat milk latte").map((card) => card.itemName)).toEqual([
      "Lavender Oat Latte",
    ]);
    expect(searchDrinks(cards, "something less sweet")).toEqual(cards);
  });
});

describe("assembleForYou", () => {
  it("shows personal cards to that half, and the popular list to the other", () => {
    const cafes = [barbaras];
    const menusByCafe = {
      "demo-barbaras": [
        drink("cortado", "Cortado"),
        drink("lavender", "Lavender Oat Latte", { prices: [{ size: null, usd: 5.75 }] }),
      ],
    };
    const personal = [
      {
        cafeId: "demo-barbaras",
        itemId: "lavender",
        phrase: "Lavender oat latte",
        tasteLead: "You keep coming back to oat milk espresso",
        score: 1,
      },
    ];
    const personalView = assembleForYou({
      cafes,
      menusByCafe,
      personal,
      events: [],
      variant: "personal",
      now,
    });
    const popularView = assembleForYou({
      cafes,
      menusByCafe,
      personal,
      events: [],
      variant: "popular",
      now,
    });
    expect(personalView.source).toBe("personal");
    expect(personalView.cards.map((card) => card.itemName)).toEqual(["Lavender Oat Latte"]);
    expect(personalView.cards[0].priceUsd).toBe(5.75);
    expect(popularView.source).toBe("popular");
    expect(popularView.cards.map((card) => card.itemName).sort()).toEqual([
      "Cortado",
      "Lavender Oat Latte",
    ]);
  });
});
