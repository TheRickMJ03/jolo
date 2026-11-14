import {
  buildNextVersion,
  changeLines,
  diffMenus,
  formatPrice,
  groupByCategory,
  NothingToSaveError,
  parsePriceInput,
  slugify,
  uniqueItemId,
  validateItem,
} from "@/lib/menu";

const cortado = {
  id: "cortado",
  name: "Cortado",
  category: "Coffee",
  priceCents: 450,
  description: null,
  available: true,
};
const muffin = {
  id: "muffin",
  name: "Muffin",
  category: "Bakery",
  priceCents: 325,
  description: null,
  available: true,
};

describe("prices", () => {
  it("formats cents", () => {
    expect(formatPrice(475)).toBe("$4.75");
    expect(formatPrice(0)).toBe("$0.00");
    expect(formatPrice(null)).toBe("No price");
  });

  it("parses what an owner types, without floating-point drift", () => {
    expect(parsePriceInput("4.75")).toBe(475);
    expect(parsePriceInput("$4.75")).toBe(475);
    expect(parsePriceInput("4.5")).toBe(450);
    expect(parsePriceInput("4")).toBe(400);
    expect(parsePriceInput("0.29")).toBe(29); // 0.29 * 100 is 28.999… in floats
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
  it("needs a name and a sane price", () => {
    expect(validateItem({ name: "", priceCents: 100 })).toContain("Give the item a name.");
    expect(validateItem({ name: "Latte", priceCents: -5 })).toContain("Enter a price like 4.75.");
    expect(validateItem({ name: "Latte", priceCents: 4.5 })).toContain("Enter a price like 4.75.");
    expect(validateItem({ name: "Latte", priceCents: null })).toEqual([]);
  });
});

describe("diffMenus", () => {
  it("finds added, changed and removed items by id", () => {
    const after = [
      { ...cortado, priceCents: 475 },
      {
        id: "oat-latte",
        name: "Oat Latte",
        category: "Coffee",
        priceCents: 500,
        description: null,
        available: true,
      },
    ];
    expect(diffMenus([cortado, muffin], after)).toEqual({
      added: ["Oat Latte"],
      changed: [{ itemId: "cortado", name: "Cortado", field: "priceCents", from: 450, to: 475 }],
      removed: ["Muffin"],
    });
  });

  it("reports sold out as a change", () => {
    expect(diffMenus([muffin], [{ ...muffin, available: false }]).changed).toEqual([
      { itemId: "muffin", name: "Muffin", field: "available", from: true, to: false },
    ]);
  });
});

describe("buildNextVersion", () => {
  it("builds version N+1 with the whole menu and the diff", () => {
    const next = buildNextVersion({
      currentVersion: 3,
      currentItems: [cortado, muffin],
      nextItems: [{ ...cortado, priceCents: 475 }, muffin],
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
    expect(next.changes.changed).toHaveLength(1);
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
        nextItems: [{ ...cortado, name: "  " }],
        uid: "u",
      }),
    ).toThrow(/name/);
  });

  it("normalises blank text to null and keeps the contract's fields only", () => {
    const next = buildNextVersion({
      currentVersion: 0,
      currentItems: [],
      nextItems: [{ id: "tea", name: " Tea ", category: "  ", priceCents: 250, extra: "dropped" }],
      uid: "u",
    });
    expect(next.items).toEqual([
      {
        id: "tea",
        name: "Tea",
        category: null,
        priceCents: 250,
        description: null,
        available: true,
      },
    ]);
  });
});

describe("display helpers", () => {
  it("groups by category, Other last", () => {
    const groups = groupByCategory([muffin, { ...cortado, category: null }, cortado]);
    expect(groups.map((g) => g.category)).toEqual(["Bakery", "Coffee", "Other"]);
  });

  it("describes changes with the iMessage symbols, for app and agent diffs alike", () => {
    const lines = changeLines({
      added: ["Oat Latte", { name: "Matcha", priceCents: 525 }],
      changed: [
        { name: "Cortado", field: "priceCents", from: 450, to: 475 },
        { name: "Muffin", field: "available", from: true, to: false },
      ],
      removed: [{ name: "Croissant" }],
    }).map((line) => line.text);
    expect(lines).toEqual([
      "+ Oat Latte",
      "+ Matcha",
      "• Cortado $4.50 → $4.75",
      "• Muffin: availability available → sold out",
      "– Croissant (removed)",
    ]);
  });
});
