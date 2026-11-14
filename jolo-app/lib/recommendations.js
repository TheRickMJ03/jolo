// Cold start, card copy, and save state. A card's price is always a menu
// price. Nothing in here reads a scraped page.

import { byTime } from "@/lib/events";
import { relativeDay } from "@/lib/insights";
import { formatPrice, formatPrices, needsCheck } from "@/lib/menu";

export const CARD_LIMIT = 8;
export const FRESH_DAYS = 7;

const SEARCH_SKIP = new Set([
  "a",
  "an",
  "the",
  "with",
  "and",
  "or",
  "of",
  "milk",
  "drink",
  "drinks",
  "something",
  "less",
  "sweet",
  "more",
  "please",
]);

/** A drink the owner is actually selling. Low-confidence reads stay off this list. */
export function isRecommendable(item) {
  if (!item || item.category !== "drink" || item.available === false) return false;
  if (needsCheck(item)) return false;
  return Boolean(item.item && item.id);
}

export function menuAgeDays(date, now = new Date()) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  return (now.getTime() - date.getTime()) / 86_400_000;
}

export function isFreshMenu(date, now = new Date(), freshDays = FRESH_DAYS) {
  const age = menuAgeDays(date, now);
  return age != null && age >= -1 && age <= freshDays;
}

/** "updated today", from the café's menuUpdatedAt. */
export function updatedLine(date, now = new Date()) {
  const relative = relativeDay(date, now);
  return relative ? `updated ${relative}` : "";
}

/** The first printed price, for the sentence. The card itself lists every size. */
export function heroPriceLabel(prices) {
  if (!Array.isArray(prices)) return "No price";
  const first = prices.find((price) => typeof price?.usd === "number");
  if (!first) return "No price";
  return first.size ? `${first.size} ${formatPrice(first.usd)}` : formatPrice(first.usd);
}

export function pluralPhrase(phrase) {
  const text = String(phrase ?? "").trim();
  if (!text) return "These drinks";
  const titled = text.charAt(0).toUpperCase() + text.slice(1);
  if (/s$/i.test(titled)) return titled;
  return `${titled}s`;
}

/**
 * Personal card copy. The price is passed in from the menu, so a scrape
 * cannot put a number in the sentence.
 */
export function personalWhy({ tasteLead, phrase, cafeName, priceLabel }) {
  const lead = String(tasteLead || "This fits what you've been looking for").replace(/\.$/, "");
  const drinks = pluralPhrase(phrase || "This drink");
  const price = priceLabel && priceLabel !== "No price" ? ` for ${priceLabel}` : "";
  return `${lead}. ${drinks} are showing up in recent café writing, and ${cafeName} has one${price}.`;
}

/** Replace a price baked into an older sentence with the one on the menu now. */
export function withLivePrice(why, priceLabel) {
  if (!why) return why;
  if (!priceLabel || priceLabel === "No price") {
    return why.replace(/\s+for\s+\$\d+(?:\.\d{2})?/, "");
  }
  if (/\$\d/.test(why)) return why.replace(/\$\d+(?:\.\d{2})?/, priceLabel);
  return why.replace(/\.$/, ` for ${priceLabel}.`);
}

export function whyPopular({ itemName, cafeName, priceLabel, mentions, updatedLabel }) {
  const price = priceLabel && priceLabel !== "No price" ? ` for ${priceLabel}` : "";
  const fresh = updatedLabel ? `, ${updatedLabel}` : "";
  if (mentions > 0) {
    return `People have been asking about ${itemName}. ${cafeName} has one${price}${fresh}.`;
  }
  return `${cafeName} is serving ${itemName}${price}${fresh}.`;
}

function drinkKey(cafeId, itemId) {
  return `${cafeId}:${itemId}`;
}

export function savedKeySet(events) {
  const saved = new Set();
  for (const event of byTime(events)) {
    if (!event?.cafeId || !event?.itemId) continue;
    const key = drinkKey(event.cafeId, event.itemId);
    if (event.type === "save") saved.add(key);
    if (event.type === "unsave") saved.delete(key);
  }
  return saved;
}

export function orderedNameSet(events) {
  const names = new Set();
  for (const event of events ?? []) {
    if (event?.type === "purchase" && event.itemName) {
      names.add(String(event.itemName).trim().toLowerCase());
    }
  }
  return names;
}

export function dismissedKeySet(events) {
  const keys = new Set();
  for (const event of events ?? []) {
    if (event?.type === "dismiss" && event.cafeId && event.itemId) {
      keys.add(drinkKey(event.cafeId, event.itemId));
    }
  }
  return keys;
}

export function placeIdsFromEvents(events) {
  const ids = [];
  for (const event of events ?? []) {
    if (event?.cafeId && !ids.includes(event.cafeId)) ids.push(event.cafeId);
  }
  return ids;
}

/** Drop ordered and dismissed drinks, and mark whatever is still saved. */
export function visibleCards(cards, events) {
  const saved = savedKeySet(events);
  const ordered = orderedNameSet(events);
  const dismissed = dismissedKeySet(events);
  return (cards ?? [])
    .filter(
      (card) =>
        !ordered.has(
          String(card.itemName ?? "")
            .trim()
            .toLowerCase(),
        ),
    )
    .filter((card) => !dismissed.has(drinkKey(card.cafeId, card.itemId)))
    .map((card) => ({ ...card, saved: saved.has(drinkKey(card.cafeId, card.itemId)) }));
}

/**
 * Drinks on fresh menus. `topItems` (what customers ask about) outrank a drink
 * nobody has asked for. The caller passes them when it is allowed to read
 * insights; the phone usually cannot, and then every mention count is zero.
 */
export function coldStartCards({
  cafes,
  menusByCafe,
  topItemsByCafe = {},
  placeIds = [],
  now = new Date(),
  freshDays = FRESH_DAYS,
}) {
  const place = new Set(placeIds);
  const cards = [];
  for (const cafe of cafes ?? []) {
    if (!isFreshMenu(cafe.menuUpdatedAt, now, freshDays)) continue;
    const mentions = new Map(
      (topItemsByCafe[cafe.id] ?? []).map((row) => [
        String(row.name ?? "").toLowerCase(),
        row.mentions ?? 0,
      ]),
    );
    for (const item of menusByCafe?.[cafe.id] ?? []) {
      if (!isRecommendable(item)) continue;
      const priceLabel = formatPrices(item.prices);
      const count = mentions.get(String(item.item).toLowerCase()) ?? 0;
      const updated = updatedLine(cafe.menuUpdatedAt, now);
      cards.push({
        cafeId: cafe.id,
        itemId: item.id,
        itemName: item.item,
        cafeName: cafe.name,
        priceUsd: item.prices?.find((price) => typeof price?.usd === "number")?.usd ?? null,
        priceLabel,
        prices: item.prices ?? [],
        mentions: count,
        menuUpdatedAt: cafe.menuUpdatedAt,
        updatedLabel: updated,
        why: whyPopular({
          itemName: item.item,
          cafeName: cafe.name,
          priceLabel: heroPriceLabel(item.prices),
          mentions: count,
          updatedLabel: updated,
        }),
        score: count,
        saved: false,
        source: "popular",
      });
    }
  }

  cards.sort((a, b) => {
    if (b.mentions !== a.mentions) return b.mentions - a.mentions;
    const placeDelta = Number(place.has(b.cafeId)) - Number(place.has(a.cafeId));
    if (placeDelta) return placeDelta;
    const aTime = a.menuUpdatedAt instanceof Date ? a.menuUpdatedAt.getTime() : 0;
    const bTime = b.menuUpdatedAt instanceof Date ? b.menuUpdatedAt.getTime() : 0;
    if (bTime !== aTime) return bTime - aTime;
    return String(a.itemName).localeCompare(String(b.itemName));
  });
  return cards;
}

/** Overlay the live menu on cards the worker wrote. A drink no longer served is dropped. */
export function hydrateCards(cards, cafes, menusByCafe, now = new Date()) {
  const byId = new Map((cafes ?? []).map((cafe) => [cafe.id, cafe]));
  const out = [];
  for (const card of cards ?? []) {
    const cafe = byId.get(card.cafeId);
    const item = (menusByCafe?.[card.cafeId] ?? []).find((row) => row.id === card.itemId);
    if (!cafe || !isRecommendable(item)) continue;
    const sentencePrice = heroPriceLabel(item.prices);
    const why =
      card.tasteLead && card.phrase
        ? personalWhy({
            tasteLead: card.tasteLead,
            phrase: card.phrase,
            cafeName: cafe.name,
            priceLabel: sentencePrice,
          })
        : withLivePrice(card.why, sentencePrice);
    out.push({
      cafeId: cafe.id,
      itemId: item.id,
      itemName: item.item,
      cafeName: cafe.name,
      priceUsd: item.prices?.find((price) => typeof price?.usd === "number")?.usd ?? null,
      priceLabel: formatPrices(item.prices),
      prices: item.prices ?? [],
      menuUpdatedAt: cafe.menuUpdatedAt,
      updatedLabel: updatedLine(cafe.menuUpdatedAt, now),
      why,
      score: typeof card.score === "number" ? card.score : 0,
      saved: false,
      source: "personal",
    });
  }
  out.sort((a, b) => b.score - a.score || String(a.itemName).localeCompare(String(b.itemName)));
  return out;
}

/** Half of sessions. Personal cards only replace the popular list once some exist. */
export function pickVariant(random = Math.random()) {
  return random < 0.5 ? "personal" : "popular";
}

export function cardsForSession({ personal, popular, variant }) {
  if (variant === "personal" && personal?.length) {
    return { source: "personal", cards: personal };
  }
  return { source: "popular", cards: popular ?? [] };
}

export function savedCards(catalog, events) {
  const saved = savedKeySet(events);
  const ordered = orderedNameSet(events);
  return (catalog ?? [])
    .filter((card) => saved.has(drinkKey(card.cafeId, card.itemId)))
    .map((card) => ({
      ...card,
      saved: true,
      ordered: ordered.has(
        String(card.itemName ?? "")
          .trim()
          .toLowerCase(),
      ),
    }));
}

/** Tokens the person typed, matched against the drink and the café. */
export function searchDrinks(cards, text) {
  const tokens = String(text ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token && !SEARCH_SKIP.has(token));
  if (tokens.length === 0) return cards ?? [];
  return (cards ?? []).filter((card) => {
    const haystack = `${card.itemName} ${card.cafeName}`.toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
}

export function assembleForYou({
  cafes,
  menusByCafe,
  topItemsByCafe,
  personal,
  events,
  variant,
  now = new Date(),
}) {
  const catalog = coldStartCards({
    cafes,
    menusByCafe,
    topItemsByCafe,
    placeIds: placeIdsFromEvents(events),
    now,
  });
  const session = cardsForSession({
    personal: visibleCards(hydrateCards(personal, cafes, menusByCafe, now), events),
    popular: visibleCards(catalog, events),
    variant,
  });
  return {
    source: session.source,
    cards: session.cards.slice(0, CARD_LIMIT),
    catalog: visibleCards(catalog, events),
    saved: savedCards(catalog, events),
  };
}
