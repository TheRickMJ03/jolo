// Menu logic with no Firebase in it, so it's unit-tested. The shapes follow
// docs/contracts.md: MenuItem is the menu reader's item (section, item,
// category, prices[{size, usd}], confidence) plus `id` and `available`.
// Prices are dollars, as the reader returns them; anything that compares or
// parses a price goes through whole cents so floats never drift.

export const MAX_ITEMS = 300;
export const CATEGORIES = ["drink", "food", "modifier"];
export const CATEGORY_LABELS = { drink: "Drink", food: "Food", modifier: "Extra" };
export const MAX_SIZES = 6;

/**
 * Items the reader scored below this get a "check this" marker. Its scores
 * are a ranking aid, not a probability: 0.4 means nothing backed the item,
 * and 0.5 means the second read was switched off, which says nothing either way.
 */
export const CHECK_BELOW = 0.5;

const toCents = (usd) => Math.round(usd * 100);
const isAmount = (value) => typeof value === "number" && Number.isFinite(value);

/** 4.75 → "$4.75"; null → "No price". */
export function formatPrice(usd) {
  if (!isAmount(usd)) return "No price";
  return `$${(toCents(usd) / 100).toFixed(2)}`;
}

/** "$4.50", "12 oz $3.50 · 16 oz $4.25", or "No price". */
export function formatPrices(prices) {
  if (!Array.isArray(prices) || prices.length === 0) return "No price";
  return prices
    .map((price) =>
      price.size ? `${price.size} ${formatPrice(price.usd)}` : formatPrice(price.usd),
    )
    .join(" · ");
}

/**
 * What an owner types → dollars. "4.75", "$4.75", "4", "4.5" → 4.75, 4.75, 4, 4.5.
 * "" → null (no price). Anything else → undefined (invalid).
 */
export function parsePriceInput(text) {
  const trimmed = String(text ?? "")
    .trim()
    .replace(/^\$/, "");
  if (trimmed === "") return null;
  if (!/^\d{1,4}(\.\d{1,2})?$/.test(trimmed)) return undefined;
  const [whole, fraction = ""] = trimmed.split(".");
  return (Number(whole) * 100 + Number(fraction.padEnd(2, "0"))) / 100;
}

export function slugify(name) {
  const slug = String(name)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "item";
}

/** A slug of the name, made unique within `takenIds` ("latte", "latte-2", …). */
export function uniqueItemId(name, takenIds) {
  const base = slugify(name);
  const taken = new Set(takenIds);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

const text = (value) => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed === "" ? null : trimmed;
};
const list = (value) => (Array.isArray(value) ? value : []);

/** Fills defaults so items written by the app match the contract exactly. */
export function normalizeItem(item) {
  return {
    id: item.id,
    section: text(item.section),
    item: String(item.item ?? "").trim(),
    category: CATEGORIES.includes(item.category) ? item.category : "drink",
    prices: list(item.prices)
      .filter((price) => isAmount(price?.usd))
      .map((price) => ({ size: text(price.size), usd: toCents(price.usd) / 100 })),
    add_ons: list(item.add_ons),
    variants: list(item.variants),
    tags: list(item.tags),
    confidence: isAmount(item.confidence) ? item.confidence : 1,
    available: item.available !== false,
  };
}

/** True when the reader wasn't sure about this item and the owner hasn't edited it since. */
export const needsCheck = (item) => isAmount(item?.confidence) && item.confidence < CHECK_BELOW;

/** Human-readable problems with one item; empty when it's fine. */
export function validateItem(item) {
  const errors = [];
  if (!item.item || !String(item.item).trim()) errors.push("Give the item a name.");
  else if (String(item.item).trim().length > 80) errors.push("Keep the name under 80 characters.");
  if (item.section && String(item.section).length > 60) {
    errors.push("Keep the section under 60 characters.");
  }

  const prices = list(item.prices);
  if (prices.length > MAX_SIZES) errors.push(`An item can have at most ${MAX_SIZES} sizes.`);
  const sizes = new Set();
  for (const price of prices) {
    if (!isAmount(price.usd) || price.usd < 0 || price.usd > 9999.99) {
      errors.push("Enter a price like 4.75.");
      break;
    }
    const size = (text(price.size) ?? "").toLowerCase();
    if (size.length > 24) errors.push("Keep size names short, like 12 oz.");
    if (sizes.has(size)) {
      errors.push(
        size ? `"${text(price.size)}" is listed twice.` : "Name each size, like 12 oz and 16 oz.",
      );
      break;
    }
    sizes.add(size);
  }
  return errors;
}

const sizeKey = (price) => (price.size ?? "").toLowerCase();
const sizeNames = (prices) => prices.map((price) => price.size ?? "no size").join(" / ");

/**
 * How one item's prices changed. Renaming sizes without touching a price (the
 * reader's "small / large" corrected to "12 oz / 16 oz") is one "sizes" change;
 * anything else is reported per size, in the reader's PriceChange shape.
 */
function diffPrices(previous, next) {
  const before = previous.prices;
  const after = next.prices;
  const samePrices =
    before.length === after.length &&
    before.every((price, i) => toCents(price.usd) === toCents(after[i].usd));
  if (samePrices) {
    const renamed = before.some((price, i) => sizeKey(price) !== sizeKey(after[i]));
    return {
      prices: [],
      fields: renamed
        ? [
            {
              itemId: next.id,
              item: previous.item,
              field: "sizes",
              from: sizeNames(before),
              to: sizeNames(after),
            },
          ]
        : [],
    };
  }

  const prices = [];
  const old = new Map(before.map((price) => [sizeKey(price), price]));
  for (const price of after) {
    const was = old.get(sizeKey(price));
    if (!was || toCents(was.usd) !== toCents(price.usd)) {
      prices.push({
        item: previous.item,
        size: price.size,
        old_usd: was ? was.usd : null,
        new_usd: price.usd,
      });
    }
  }
  const kept = new Set(after.map(sizeKey));
  for (const price of before) {
    if (!kept.has(sizeKey(price))) {
      prices.push({ item: previous.item, size: price.size, old_usd: price.usd, new_usd: null });
    }
  }
  return { prices, fields: [] };
}

const COMPARED_FIELDS = ["item", "section", "category", "available"];

/**
 * What changed from `before` to `after`, matched by item id. Same shape the
 * agent writes (docs/contracts.md §1), so the history screen reads both alike.
 */
export function diffMenus(before, after) {
  const beforeById = new Map(before.map((item) => [item.id, item]));
  const afterIds = new Set(after.map((item) => item.id));

  const added = after.filter((item) => !beforeById.has(item.id)).map((item) => item.item);
  const removed = before.filter((item) => !afterIds.has(item.id)).map((item) => item.item);
  const priceChanges = [];
  const changed = [];
  for (const item of after) {
    const previous = beforeById.get(item.id);
    if (!previous) continue;
    for (const field of COMPARED_FIELDS) {
      const from = previous[field] ?? null;
      const to = item[field] ?? null;
      if (from !== to) changed.push({ itemId: item.id, item: previous.item, field, from, to });
    }
    const { prices, fields } = diffPrices(previous, item);
    priceChanges.push(...prices);
    changed.push(...fields);
    // The owner looked at an item the reader was unsure of and kept it as it is.
    if (needsCheck(previous) && !needsCheck(item)) {
      changed.push({
        itemId: item.id,
        item: previous.item,
        field: "checked",
        from: false,
        to: true,
      });
    }
  }
  return { added, price_changes: priceChanges, changed, removed };
}

export const hasChanges = (changes) =>
  changes.added.length +
    changes.price_changes.length +
    changes.changed.length +
    changes.removed.length >
  0;

export class NothingToSaveError extends Error {}

/**
 * The menuVersions document an app edit creates: version current + 1, the
 * whole menu in `items`. `createdAt` is added by the store as a server
 * timestamp. Throws NothingToSaveError when nothing differs.
 */
export function buildNextVersion({ currentVersion, currentItems, nextItems, uid, phone }) {
  const items = nextItems.map(normalizeItem);
  if (items.length > MAX_ITEMS) throw new Error(`A menu can have at most ${MAX_ITEMS} items.`);
  for (const item of items) {
    const errors = validateItem(item);
    if (errors.length > 0) throw new Error(`${item.item || "An item"}: ${errors[0]}`);
  }
  const changes = diffMenus(currentItems.map(normalizeItem), items);
  if (!hasChanges(changes)) throw new NothingToSaveError("Nothing has changed.");

  return {
    version: currentVersion + 1,
    basedOn: currentVersion,
    scope: "full",
    source: "app",
    createdBy: { uid, phone: phone ?? null },
    items,
    changes,
  };
}

/**
 * Items grouped under the heading they were printed under, in the order the
 * menu lists them. Items with no section go last, under "Other".
 */
export function groupBySection(items) {
  const groups = new Map();
  for (const item of items) {
    const key = item.section ?? "Other";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === "Other") - (b === "Other"))
    .map(([section, group]) => ({ section, items: group }));
}

const FIELD_LABELS = {
  item: "name",
  section: "section",
  category: "type",
  available: "availability",
  sizes: "sizes",
};

function describe(field, value) {
  if (field === "available") return value ? "available" : "sold out";
  if (field === "category") return CATEGORY_LABELS[value]?.toLowerCase() ?? String(value);
  if (field === "sizes") return String(value);
  return value === null || value === undefined ? "none" : `"${value}"`;
}

function priceChangeLine(change) {
  const name = change.size ? `${change.item} (${change.size})` : change.item;
  if (!isAmount(change.old_usd)) return `• ${name} new at ${formatPrice(change.new_usd)}`;
  if (!isAmount(change.new_usd))
    return `• ${name} ${formatPrice(change.old_usd)} → no longer listed`;
  return `• ${name} ${formatPrice(change.old_usd)} → ${formatPrice(change.new_usd)}`;
}

/**
 * One line per change, using the same + • – symbols as the iMessage summary.
 * Accepts the app's diff and the agent's (names or whole items).
 */
export function changeLines(changes) {
  const name = (entry) => (typeof entry === "string" ? entry : (entry?.item ?? "Item"));
  return [
    ...(changes?.added ?? []).map((entry) => ({ kind: "added", text: `+ ${name(entry)}` })),
    ...(changes?.price_changes ?? []).map((change) => ({
      kind: "changed",
      text: priceChangeLine(change),
    })),
    ...(changes?.changed ?? []).map((change) => ({
      kind: "changed",
      text:
        change.field === "checked"
          ? `• ${change.item}: checked`
          : `• ${change.item}: ${FIELD_LABELS[change.field] ?? change.field} ${describe(change.field, change.from)} → ${describe(change.field, change.to)}`,
    })),
    ...(changes?.removed ?? []).map((entry) => ({
      kind: "removed",
      text: `– ${name(entry)} (removed)`,
    })),
  ];
}
