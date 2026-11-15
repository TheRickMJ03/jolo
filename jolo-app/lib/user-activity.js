// What you like, and the cafés on History, both come from users/{uid}/events.
// A typed request is a search with no café. Opening a café on Finder is a
// search that names that café.

import { byTime } from "@/lib/events";

export const REQUEST_LIMIT = 12;
export const HISTORY_LIMIT = 12;
const MATCHES_PER_SEARCH = 6;

function normalize(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function newestFirst(events) {
  return byTime(events).reverse();
}

/** Typed requests, newest first. "chai tea" stays ahead of an older search.
 * Opening a café, and the cafés an iMessage search found, are history only. */
export function recentRequests(events, limit = REQUEST_LIMIT) {
  const seen = new Set();
  const requests = [];
  for (const event of newestFirst(events)) {
    if (event?.type !== "search" || event.historyOnly) continue;
    if (event.cafeId && !(event.cafeIds?.length)) continue;
    const text = String(event.text ?? "").trim();
    if (text.length < 2) continue;
    const key = normalize(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    requests.push({
      id: event.id || key,
      text,
      createdAt: event.createdAt instanceof Date ? event.createdAt : null,
    });
    if (requests.length >= limit) break;
  }
  return requests;
}

function cafesForQuery(cafes, query) {
  const needle = normalize(query);
  if (needle.length < 3) return [];
  const matches = (cafes ?? []).filter((cafe) => {
    const name = normalize(cafe?.name);
    if (!name) return false;
    return name === needle || name.includes(needle);
  });
  matches.sort((a, b) => {
    const aName = normalize(a.name);
    const bName = normalize(b.name);
    const aStart = aName.startsWith(needle) ? 0 : 1;
    const bStart = bName.startsWith(needle) ? 0 : 1;
    if (aStart !== bStart) return aStart - bStart;
    return aName.length - bName.length;
  });
  return matches.slice(0, MATCHES_PER_SEARCH);
}

/**
 * Cafés from recent searches, newest search first.
 * A search that names a café ("Dunkin") matches those cafés. Opening a pin
 * records that one café. A drink request such as "chai tea" matches none.
 */
export function recentCafes(events, cafes, limit = HISTORY_LIMIT) {
  const byId = new Map((cafes ?? []).map((cafe) => [cafe.id, cafe]));
  const seen = new Set();
  const history = [];

  const add = (cafe) => {
    if (!cafe?.id || seen.has(cafe.id)) return;
    seen.add(cafe.id);
    history.push(cafe);
  };

  for (const event of newestFirst(events)) {
    if (event?.type !== "search") continue;
    if (Array.isArray(event.cafeIds) && event.cafeIds.length) {
      for (const cafeId of event.cafeIds) {
        add(byId.get(cafeId) ?? { id: cafeId, name: "Café" });
      }
    } else if (event.cafeId) {
      add(byId.get(event.cafeId) ?? { id: event.cafeId, name: event.text || "Café" });
    } else if (!event.historyOnly) {
      for (const cafe of cafesForQuery(cafes, event.text)) add(cafe);
    }
    if (history.length >= limit) break;
  }
  return history.slice(0, limit);
}
