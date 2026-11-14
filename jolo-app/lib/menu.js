// Menu logic with no Firebase in it, so it's unit-tested. The shapes follow
// docs/contracts.md: MenuItem, and menuVersions documents. Prices are integer
// cents throughout.

export const MAX_ITEMS = 300;
export const COMPARED_FIELDS = ["name", "category", "priceCents", "description", "available"];

/** 475 → "$4.75"; null → "No price". */
export function formatPrice(cents) {
  if (typeof cents !== "number" || !Number.isFinite(cents)) return "No price";
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * What an owner types → cents. "4.75", "$4.75", "4", "4.5" → 475, 475, 400, 450.
 * "" → null (no price). Anything else → undefined (invalid).
 */
export function parsePriceInput(text) {
  const trimmed = String(text ?? "")
    .trim()
    .replace(/^\$/, "");
  if (trimmed === "") return null;
  if (!/^\d{1,4}(\.\d{1,2})?$/.test(trimmed)) return undefined;
  const [whole, fraction = ""] = trimmed.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
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

/** Fills defaults so items written by the app match the contract exactly. */
export function normalizeItem(item) {
  const text = (value) => {
    const trimmed = typeof value === "string" ? value.trim() : "";
    return trimmed === "" ? null : trimmed;
  };
  return {
    id: item.id,
    name: String(item.name ?? "").trim(),
    category: text(item.category),
    priceCents: typeof item.priceCents === "number" ? item.priceCents : null,
    description: text(item.description),
    available: item.available !== false,
  };
}

/** Human-readable problems with one item; empty when it's fine. */
export function validateItem(item) {
  const errors = [];
  if (!item.name || !String(item.name).trim()) errors.push("Give the item a name.");
  else if (String(item.name).trim().length > 80) errors.push("Keep the name under 80 characters.");
  if (item.priceCents !== null && item.priceCents !== undefined) {
    if (!Number.isInteger(item.priceCents) || item.priceCents < 0 || item.priceCents > 999_999) {
      errors.push("Enter a price like 4.75.");
    }
  }
  if (item.description && String(item.description).length > 300) {
    errors.push("Keep the description under 300 characters.");
  }
  return errors;
}

/**
 * What changed from `before` to `after`, matched by item id. Same shape the
 * agent writes, so the history screen reads both alike.
 */
export function diffMenus(before, after) {
  const beforeById = new Map(before.map((item) => [item.id, item]));
  const afterIds = new Set(after.map((item) => item.id));

  const added = after.filter((item) => !beforeById.has(item.id)).map((item) => item.name);
  const removed = before.filter((item) => !afterIds.has(item.id)).map((item) => item.name);
  const changed = [];
  for (const item of after) {
    const previous = beforeById.get(item.id);
    if (!previous) continue;
    for (const field of COMPARED_FIELDS) {
      const from = previous[field] ?? null;
      const to = item[field] ?? null;
      if (from !== to) changed.push({ itemId: item.id, name: previous.name, field, from, to });
    }
  }
  return { added, changed, removed };
}

export const hasChanges = (changes) =>
  changes.added.length + changes.changed.length + changes.removed.length > 0;

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
    if (errors.length > 0) throw new Error(`${item.name || "An item"}: ${errors[0]}`);
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

/** Items grouped for display: categories alphabetically, uncategorised last. */
export function groupByCategory(items) {
  const groups = new Map();
  for (const item of items) {
    const key = item.category ?? "Other";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === "Other") - (b === "Other") || a.localeCompare(b))
    .map(([category, list]) => ({ category, items: list }));
}

const FIELD_LABELS = {
  name: "name",
  category: "category",
  priceCents: "price",
  description: "description",
  available: "availability",
};

function describe(field, value) {
  if (field === "priceCents") return formatPrice(value);
  if (field === "available") return value ? "available" : "sold out";
  return value === null || value === undefined ? "none" : `"${value}"`;
}

/**
 * One line per change, using the same + • – symbols as the iMessage summary.
 * Accepts the app's diff (names) and the agent's (MenuItems or names).
 */
export function changeLines(changes) {
  const name = (entry) => (typeof entry === "string" ? entry : (entry?.name ?? "Item"));
  return [
    ...(changes?.added ?? []).map((entry) => ({ kind: "added", text: `+ ${name(entry)}` })),
    ...(changes?.changed ?? []).map((change) => ({
      kind: "changed",
      text:
        change.field === "priceCents"
          ? `• ${change.name} ${formatPrice(change.from)} → ${formatPrice(change.to)}`
          : `• ${change.name}: ${FIELD_LABELS[change.field] ?? change.field} ${describe(change.field, change.from)} → ${describe(change.field, change.to)}`,
    })),
    ...(changes?.removed ?? []).map((entry) => ({
      kind: "removed",
      text: `– ${name(entry)} (removed)`,
    })),
  ];
}
