import {
  buildNextVersion,
  changeLines,
  diffMenus,
  formatPrice,
  formatPrices,
  groupBySection,
  needsCheck,
  normalizeItem,
  NothingToSaveError,
  parsePriceInput,
  slugify,
  uniqueItemId,
  validateItem,
} from "@/lib/menu";

// Items as the menu reader returns them, plus id and available (docs/contracts.md §1).
const make = (id, item, section, category, prices, extra = {}) => ({
  id,
  section,
  item,
  category,
  prices,
  add_ons: [],
  variants: [],
  tags: [],
  confidence: 1,
  available: true,
  ...extra,
});
const cortado = make("cortado", "Cortado", "Coffee", "drink", [{ size: null, usd: 4.5 }]);
const muffin = make("muffin", "Muffin", "Bakery", "food", [{ size: null, usd: 3.25 }]);
const latte = make("latte", "Latte", "Coffee", "drink", [
  { size: "small", usd: 3.5 },
  { size: "large", usd: 4.25 },
]);
const priced = (item, usd) => ({ ...item, prices: [{ size: null, usd }] });

describe("prices", () => {
  it("formats dollars", () => {
    expect(formatPrice(4.75)).toBe("$4.75");
    expect(formatPrice(4.5)).toBe("$4.50");
    expect(formatPrice(0)).toBe("$0.00");
    expect(formatPrice(null)).toBe("No price");
  });

  it("formats an item's prices, with sizes when it has them", () => {
    expect(formatPrices(cortado.prices)).toBe("$4.50");
    expect(formatPrices(latte.prices)).toBe("small $3.50 · large $4.25");
    expect(formatPrices([])).toBe("No price");
  });

  it("parses what an owner types, without floating-point drift", () => {
    expect(parsePriceInput("4.75")).toBe(4.75);
    expect(parsePriceInput("$4.75")).toBe(4.75);
    expect(parsePriceInput("4.5")).toBe(4.5);
    expect(parsePriceInput("4")).toBe(4);
    expect(parsePriceInput("0.29")).toBe(0.29);
    expect(parsePriceInput("")).toBeNull();
    expect(parsePriceInput("four")).toBeUndefined();
    expect(parsePriceInput("4.755")).toBeUndefined();
    expect(parsePriceInput("-1")).toBeUndefined();
  });
});

describe("item ids", () => {
  it("slugify names, accents included", () => {
    expect(slugify("Oat Latte")).toBe("oat-latte");
    expect(slugify("Café Bombón!")).toBe("cafe-bombon");
    expect(slugify("☕")).toBe("item");
  });

  it("stay unique within a menu", () => {
    expect(uniqueItemId("Latte", ["latte", "latte-2"])).toBe("latte-3");
    expect(uniqueItemId("Mocha", ["latte"])).toBe("mocha");
  });
});

describe("validateItem", () => {
  it("needs a name and sane prices", () => {
    expect(validateItem({ item: "", prices: [] })).toContain("Give the item a name.");
    expect(validateItem({ item: "Latte", prices: [{ size: null, usd: -5 }] })).toContain(
      "Enter a price like 4.75.",
    );
    expect(validateItem({ item: "Latte", prices: [] })).toEqual([]);
    expect(validateItem(latte)).toEqual([]);
  });

  it("won't take the same size twice, or two prices with no size", () => {
    const twice = [
      { size: "12 oz", usd: 3 },
      { size: "12 OZ", usd: 4 },
    ];
    expect(validateItem({ item: "Latte", prices: twice })).toContain('"12 OZ" is listed twice.');
    const unnamed = [
      { size: null, usd: 3 },
      { size: null, usd: 4 },
    ];
    expect(validateItem({ item: "Latte", prices: unnamed })).toContain(
      "Name each size, like 12 oz and 16 oz.",
    );
  });
});

describe("diffMenus", () => {
  it("finds added, repriced and removed items by id", () => {
    const oatLatte = make("oat-latte", "Oat Latte", "Coffee", "drink", [{ size: null, usd: 5 }]);
    expect(diffMenus([cortado, muffin], [priced(cortado, 4.75), oatLatte])).toEqual({
      added: ["Oat Latte"],
      price_changes: [{ item: "Cortado", size: null, old_usd: 4.5, new_usd: 4.75 }],
      changed: [],
      removed: ["Muffin"],
    });
  });

  it("reports price changes per size, in the reader's shape", () => {
    const after = {
      ...latte,
      prices: [
        { size: "small", usd: 3.75 },
        { size: "medium", usd: 4 },
      ],
    };
    expect(diffMenus([latte], [after]).price_changes).toEqual([
      { item: "Latte", size: "small", old_usd: 3.5, new_usd: 3.75 },
      { item: "Latte", size: "medium", old_usd: null, new_usd: 4 },
      { item: "Latte", size: "large", old_usd: 4.25, new_usd: null },
    ]);
  });

  it("treats renamed sizes at the same prices as one change, not four", () => {
    const after = {
      ...latte,
      prices: [
        { size: "12 oz", usd: 3.5 },
        { size: "16 oz", usd: 4.25 },
      ],
    };
    expect(diffMenus([latte], [after])).toEqual({
      added: [],
      price_changes: [],
      changed: [
        {
          itemId: "latte",
          item: "Latte",
          field: "sizes",
          from: "small / large",
          to: "12 oz / 16 oz",
        },
      ],
      removed: [],
    });
  });

  it("reports sold out, a rename and a checked item as changes", () => {
    expect(diffMenus([muffin], [{ ...muffin, available: false }]).changed).toEqual([
      { itemId: "muffin", item: "Muffin", field: "available", from: true, to: false },
    ]);
    expect(diffMenus([muffin], [{ ...muffin, item: "Blueberry Muffin" }]).changed).toEqual([
      { itemId: "muffin", item: "Muffin", field: "item", from: "Muffin", to: "Blueberry Muffin" },
    ]);
    const unsure = { ...muffin, confidence: 0.4 };
    expect(diffMenus([unsure], [{ ...unsure, confidence: 1 }]).changed).toEqual([
      { itemId: "muffin", item: "Muffin", field: "checked", from: false, to: true },
    ]);
  });
});

describe("buildNextVersion", () => {
  it("builds version N+1 with the whole menu and the diff", () => {
    const next = buildNextVersion({
      currentVersion: 3,
      currentItems: [cortado, muffin],
      nextItems: [priced(cortado, 4.75), muffin],
      uid: "u1",
      phone: "+19085551234",
    });
    expect(next).toMatchObject({
      version: 4,
      basedOn: 3,
      scope: "full",
      source: "app",
      createdBy: { uid: "u1", phone: "+19085551234" },
    });
    expect(next.items).toHaveLength(2);
    expect(next.changes.price_changes).toHaveLength(1);
    // createdAt is the store's job (a server timestamp the rules check).
    expect(next).not.toHaveProperty("createdAt");
  });

  it("refuses to save nothing, or an invalid item", () => {
    expect(() =>
      buildNextVersion({
        currentVersion: 1,
        currentItems: [cortado],
        nextItems: [cortado],
        uid: "u",
      }),
    ).toThrow(NothingToSaveError);
    expect(() =>
      buildNextVersion({
        currentVersion: 1,
        currentItems: [cortado],
        nextItems: [{ ...cortado, item: "  " }],
        uid: "u",
      }),
    ).toThrow(/name/);
  });

  it("fills the contract's fields and drops anything else", () => {
    const next = buildNextVersion({
      currentVersion: 0,
      currentItems: [],
      nextItems: [
        {
          id: "tea",
          item: " Tea ",
          section: "  ",
          category: "beverage",
          prices: [{ size: " ", usd: 2.5 }, { usd: "free" }],
          extra: "dropped",
        },
      ],
      uid: "u",
    });
    expect(next.items).toEqual([
      {
        id: "tea",
        section: null,
        item: "Tea",
        category: "drink",
        prices: [{ size: null, usd: 2.5 }],
        add_ons: [],
        variants: [],
        tags: [],
        confidence: 1,
        available: true,
      },
    ]);
  });
});

describe("reading what the menu reader returns", () => {
  it("takes a reader item as it is, adding only what's missing", () => {
    const fromReader = {
      section: "Espresso",
      item: "Cortado",
      category: "drink",
      prices: [{ size: "8 oz", usd: 4.5 }],
      add_ons: [],
      variants: [],
      tags: [],
      confidence: 0.7,
    };
    expect(normalizeItem({ ...fromReader, id: "cortado" })).toEqual({
      ...fromReader,
      id: "cortado",
      available: true,
    });
  });

  it("marks only the items nothing backed up", () => {
    expect(needsCheck({ confidence: 0.4 })).toBe(true);
    expect(needsCheck({ confidence: 0.5 })).toBe(false); // the second read was switched off
    expect(needsCheck({ confidence: 1 })).toBe(false);
    expect(needsCheck({})).toBe(false);
  });
});

describe("display helpers", () => {
  it("groups by section in menu order, Other last", () => {
    const groups = groupBySection([muffin, { ...cortado, section: null }, cortado, latte]);
    expect(groups.map((g) => g.section)).toEqual(["Bakery", "Coffee", "Other"]);
    expect(groups[1].items.map((i) => i.id)).toEqual(["cortado", "latte"]);
  });

  it("describes changes with the iMessage symbols, for app and agent diffs alike", () => {
    const lines = changeLines({
      added: ["Oat Latte", { item: "Matcha", prices: [{ size: null, usd: 5.25 }] }],
      price_changes: [
        { item: "Cortado", size: null, old_usd: 4.5, new_usd: 4.75 },
        { item: "Latte", size: "16 oz", old_usd: 4.25, new_usd: 4.5 },
        { item: "Latte", size: "20 oz", old_usd: null, new_usd: 5 },
        { item: "Latte", size: "8 oz", old_usd: 3, new_usd: null },
      ],
      changed: [
        { item: "Muffin", field: "available", from: true, to: false },
        { item: "Latte", field: "sizes", from: "small / large", to: "12 oz / 16 oz" },
        { item: "Fresh Daily", field: "checked", from: false, to: true },
      ],
      removed: ["Croissant"],
    }).map((line) => line.text);
    expect(lines).toEqual([
      "+ Oat Latte",
      "+ Matcha",
      "• Cortado $4.50 → $4.75",
      "• Latte (16 oz) $4.25 → $4.50",
      "• Latte (20 oz) new at $5.00",
      "• Latte (8 oz) $3.00 → no longer listed",
      "• Muffin: availability available → sold out",
      "• Latte: sizes small / large → 12 oz / 16 oz",
      "• Fresh Daily: checked",
      "– Croissant (removed)",
    ]);
  });

  it("reads a version saved before price_changes existed", () => {
    expect(changeLines({ added: ["Tea"], changed: [], removed: [] })).toHaveLength(1);
    expect(changeLines(undefined)).toEqual([]);
  });
});
