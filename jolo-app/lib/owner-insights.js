// The owner Insights hub. Three kinds of input, one screen:
//   - the live menu and its versions (Firestore, no scraper)
//   - weekly insights the agent's backend writes (what customers asked)
//   - analytics signals the recommend job writes (other shops, asks nearby,
//     web trends from café blogs and Reddit)
// Suggestions are joined here, against the live menu, so an item the owner
// just added stops being suggested at once. Pure functions: no Firebase.

import { formatPrice, needsCheck } from "@/lib/menu";
import { relativeDay } from "@/lib/insights";

export const SUGGESTION_LIMIT = 5;
const DAY = 86_400_000;

const DRINK_WORDS = [
  "cold brew",
  "latte",
  "cortado",
  "espresso",
  "americano",
  "cappuccino",
  "mocha",
  "matcha",
  "chai",
  "tea",
  "tonic",
  "spritz",
  "macchiato",
  "flat white",
];

export const SOURCE_LABELS = {
  blogs: "Café blogs",
  reddit: "Reddit",
  tiktok: "TikTok",
  demo: "Sample data",
};

const key = (name) =>
  String(name ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

const tokens = (text) =>
  key(text)
    .split(/[^a-z0-9]+/)
    .filter((word) => word && !["a", "the", "and", "with", "of"].includes(word));

/** Share of the phrase's words that appear in the item name, 0 to 1. */
export function nameOverlap(phrase, itemName) {
  const wanted = tokens(phrase);
  const have = new Set(tokens(itemName));
  if (wanted.length === 0 || have.size === 0) return 0;
  return wanted.filter((word) => have.has(word)).length / wanted.length;
}

export const isDrinkPhrase = (text) =>
  DRINK_WORDS.some((word) => new RegExp(`\\b${word}\\b`).test(key(text)));

/** The menu item a trend or ask refers to, or null. Either name may be the longer one. */
export function findOnMenu(name, items) {
  let best = null;
  let bestScore = 0;
  for (const item of items ?? []) {
    if (item?.category !== "drink" || !item.item) continue;
    if (key(item.item) === key(name)) return item;
    // "Iced matcha" is the menu's "Iced Matcha Latte", and the reverse. But a
    // one-word "Latte" must not swallow "Lavender oat latte".
    const reverse = tokens(item.item).length >= 2 ? nameOverlap(item.item, name) : 0;
    const score = Math.max(nameOverlap(name, item.item), reverse);
    if (score > bestScore) {
      best = item;
      bestScore = score;
    }
  }
  return bestScore >= 0.75 ? best : null;
}

const firstPrice = (item) => item?.prices?.find((price) => typeof price?.usd === "number")?.usd;

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Counts and prices from the live menu, plus price changes in the last 30 days. */
export function menuStats(items, versions = [], now = new Date()) {
  const list = Array.isArray(items) ? items : [];
  const drinks = list.filter((item) => item?.category === "drink");
  const drinkPrices = drinks.map(firstPrice).filter((usd) => typeof usd === "number");
  const since = now.getTime() - 30 * DAY;
  const priceChanges = (versions ?? [])
    .filter((version) => version?.createdAt instanceof Date && version.createdAt.getTime() >= since)
    .reduce((sum, version) => sum + (version.changes?.price_changes?.length ?? 0), 0);
  return {
    items: list.length,
    drinks: drinks.length,
    food: list.filter((item) => item?.category === "food").length,
    toCheck: list.filter(needsCheck).length,
    soldOut: list.filter((item) => item?.available === false).length,
    noPrice: list.filter((item) => !item?.prices?.length).length,
    drinkPrices: drinkPrices.length
      ? {
          min: Math.min(...drinkPrices),
          median: median(drinkPrices),
          max: Math.max(...drinkPrices),
        }
      : null,
    priceChanges,
  };
}

/** The tiles for "Your menu". */
export function menuTiles(stats) {
  const range = stats.drinkPrices
    ? stats.drinkPrices.min === stats.drinkPrices.max
      ? formatPrice(stats.drinkPrices.min)
      : `${formatPrice(stats.drinkPrices.min)}–${formatPrice(stats.drinkPrices.max)}`
    : "–";
  return [
    { key: "items", label: "Items", value: String(stats.items) },
    { key: "drinks", label: "Drinks", value: String(stats.drinks) },
    { key: "range", label: "Drink prices", value: range },
    { key: "toCheck", label: "To check", value: String(stats.toCheck), warn: stats.toCheck > 0 },
    { key: "soldOut", label: "Sold out", value: String(stats.soldOut) },
    { key: "priceChanges", label: "Price changes, 30 days", value: String(stats.priceChanges) },
  ];
}

/** The latest week, and how its questions compare with the week before. */
export function askSummary(weeks) {
  const [latest, previous] = weeks ?? [];
  if (!latest) return null;
  const questions = latest.counts?.customerQuestions;
  const before = previous?.counts?.customerQuestions;
  let change = null;
  if (typeof questions === "number" && typeof before === "number" && before > 0) {
    const ratio = questions / before;
    change =
      ratio >= 1.95
        ? `${Math.round(ratio)}× last week`
        : `${ratio >= 1 ? "+" : "−"}${Math.round(Math.abs(ratio - 1) * 100)}% on last week`;
  }
  return { ...latest, questions: questions ?? null, change };
}

// Mid-sentence forms: "Rising on café blogs and Reddit".
const SOURCE_IN_SENTENCE = {
  blogs: "café blogs",
  reddit: "Reddit",
  tiktok: "TikTok",
  demo: "sample data",
};

const sourceList = (sources) =>
  (sources ?? []).map((source) => SOURCE_IN_SENTENCE[source] ?? source).join(" and ");

/** Two names for the same drink, like "Iced matcha" and "Iced Matcha Latte". */
const sameDrink = (a, b) =>
  key(a) === key(b) ||
  (tokens(a).length >= 2 && nameOverlap(a, b) >= 0.75) ||
  (tokens(b).length >= 2 && nameOverlap(b, a) >= 0.75);

/**
 * What to do next, best first. Each suggestion names its evidence so the
 * owner can judge it:
 *   add      a drink trending or added elsewhere that isn't on this menu
 *   feature  a drink on this menu that is trending or asked about
 *   restock  a sold-out drink people still want
 *   check    reads the menu reader wasn't sure of (no scraper needed)
 */
export function buildSuggestions({ items, analytics, weeks, limit = SUGGESTION_LIMIT }) {
  const menu = Array.isArray(items) ? items : [];
  const candidates = new Map();
  const bump = (name, reason, score, { onlyIfNew = false } = {}) => {
    const onMenu = findOnMenu(name, menu);
    if (onMenu && onlyIfNew) return;
    let id = onMenu ? `menu:${onMenu.id ?? key(onMenu.item)}` : `new:${key(name)}`;
    if (!onMenu) {
      // One suggestion per drink, under its longest name.
      const twin = [...candidates.values()].find((row) => !row.item && sameDrink(row.name, name));
      if (twin) {
        id = twin.id;
        if (tokens(name).length > tokens(twin.name).length) twin.name = name;
      }
    }
    const row = candidates.get(id) ?? {
      id,
      name: onMenu ? onMenu.item : name,
      item: onMenu,
      reasons: [],
      score: 0,
    };
    if (!row.reasons.includes(reason)) row.reasons.push(reason);
    row.score += score;
    candidates.set(id, row);
  };

  for (const drink of analytics?.web ?? []) {
    const rising = drink.momentum === "rising";
    bump(
      drink.name,
      `${rising ? "Rising" : "Talked about"} on ${sourceList(drink.sources) || "the web"}`,
      rising ? 2 : 1,
    );
  }
  for (const row of analytics?.otherShops ?? []) {
    if (row.addedAt > 0) {
      bump(
        row.name,
        `Added at ${row.addedAt} other ${row.addedAt === 1 ? "shop" : "shops"} this month`,
        1.5 * row.addedAt,
      );
    } else if (row.servedAt >= 2) {
      // Evidence for adding a drink, not for featuring one you already have.
      bump(row.name, `Served at ${row.servedAt} other shops`, 0.5 * row.servedAt, {
        onlyIfNew: true,
      });
    }
  }
  for (const term of analytics?.nearby?.terms ?? []) {
    if (!isDrinkPhrase(term.term)) continue;
    bump(
      term.term,
      `${term.count} ${term.count === 1 ? "search" : "searches"} in ${analytics.nearby.scope}`,
      term.count,
    );
  }
  for (const top of askSummary(weeks)?.topItems?.slice(0, 3) ?? []) {
    if (findOnMenu(top.name, menu)) bump(top.name, `Most asked about this week`, 1);
  }

  const out = [];
  for (const row of candidates.values()) {
    if (!row.item) {
      out.push({ ...row, kind: "add", title: `Consider adding ${row.name}` });
    } else if (row.item.available === false) {
      out.push({
        ...row,
        kind: "restock",
        title: `Bring back your ${row.item.item}`,
        score: row.score + 1,
      });
    } else {
      out.push({ ...row, kind: "feature", title: `Feature your ${row.item.item}` });
    }
  }
  out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  const toCheck = menu.filter(needsCheck);
  const check = toCheck.length
    ? [
        {
          id: "check",
          kind: "check",
          title: `Check ${toCheck.length} ${toCheck.length === 1 ? "item" : "items"} on your menu`,
          reasons: [
            `The menu reader wasn't sure about ${toCheck
              .slice(0, 2)
              .map((item) => item.item)
              .join(" and ")}${toCheck.length > 2 ? " and more" : ""}`,
          ],
          score: 0,
        },
      ]
    : [];
  return [...out.slice(0, limit - check.length), ...check];
}

/** Rows for "Other shops", each marked on or off this menu. */
export const OTHER_SHOP_ROWS = 5;

/**
 * Rows for "Other shops": drinks added elsewhere this month, then drinks other
 * shops serve that this menu lacks. A staple every café pours and this one
 * already has says nothing, so it is left out. Cafés are named for new drinks.
 */
export function otherShopRows(analytics, items, limit = OTHER_SHOP_ROWS) {
  return (analytics?.otherShops ?? [])
    .map((row) => ({ ...row, onMenu: Boolean(findOnMenu(row.name, items)) }))
    .filter((row) => row.addedAt > 0 || !row.onMenu)
    .slice(0, limit)
    .map((row) => ({
      ...row,
      detail:
        row.addedAt > 0
          ? `Added at ${row.addedAt} this month: ${(row.cafes ?? []).slice(0, 2).join(", ")}${
              row.addedAt > 2 ? " and more" : ""
            }`
          : `Served at ${row.servedAt} other shops`,
    }));
}

/** Rows for "On the web", each marked on or off this menu. */
export function webRows(analytics, items) {
  return (analytics?.web ?? []).map((drink) => ({
    ...drink,
    onMenu: Boolean(findOnMenu(drink.name, items)),
    sourceLabels: (drink.sources ?? []).map((source) => SOURCE_LABELS[source] ?? source),
  }));
}

/** "Updated today · Café blogs · Reddit · TikTok off" */
export function sourcesLine(analytics, now = new Date()) {
  if (!analytics) return "";
  const parts = [];
  const when = relativeDay(analytics.generatedAt, now);
  if (when) parts.push(`Updated ${when}`);
  for (const [source, info] of Object.entries(analytics.sources ?? {})) {
    const label = SOURCE_LABELS[source] ?? source;
    // A blocked page can still "succeed" with nothing on it; say so.
    if (!info?.ok) parts.push(`${label} off`);
    else if (info.posts === 0) parts.push(`${label}: nothing found`);
    else parts.push(label);
  }
  return parts.join(" · ");
}
