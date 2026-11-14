// One row in users/{uid}/events. The log is append-only. Firebase lives in
// events-store.js so these tests never load it.

export const EVENT_TYPES = ["search", "save", "unsave", "purchase", "dismiss", "open"];
export const MAX_TEXT = 280;

const DRINK_TYPES = ["save", "unsave", "purchase", "dismiss", "open"];

function text(value, max) {
  if (value == null) return "";
  const trimmed = String(value).trim();
  if (!trimmed) return "";
  return max ? trimmed.slice(0, max) : trimmed;
}

/**
 * A valid event, or a throw. Search carries the words they typed. Every other
 * type points at one menu item. `createdAt` is kept when the caller has a
 * Date; the store replaces it with the server time on write.
 */
export function buildEvent(input) {
  const type = input?.type;
  if (!EVENT_TYPES.includes(type)) {
    throw new Error(`Unknown event: ${type}`);
  }

  const event = { type };
  const cafeId = text(input.cafeId);
  const itemId = text(input.itemId);
  const itemName = text(input.itemName, 80);
  const body = text(input.text, MAX_TEXT);
  if (cafeId) event.cafeId = cafeId;
  if (itemId) event.itemId = itemId;
  if (itemName) event.itemName = itemName;
  if (body) event.text = body;

  if (type === "search" && !event.text) throw new Error("A search needs text.");
  if (DRINK_TYPES.includes(type) && (!event.cafeId || !event.itemId || !event.itemName)) {
    throw new Error("That event needs a drink.");
  }

  if (input.createdAt instanceof Date && !Number.isNaN(input.createdAt.getTime())) {
    event.createdAt = input.createdAt;
  }
  return event;
}

/** Append-only. Returns a new log; the one passed in is left alone. */
export function appendEvent(log, input) {
  return [...(Array.isArray(log) ? log : []), buildEvent(input)];
}

function timeOf(event) {
  const at = event?.createdAt;
  if (at instanceof Date) return at.getTime();
  if (typeof at === "string") {
    const parsed = Date.parse(at);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

/** Oldest first, so a later unsave wins over an earlier save. */
export function byTime(events) {
  return [...(events ?? [])].sort((a, b) => timeOf(a) - timeOf(b));
}
