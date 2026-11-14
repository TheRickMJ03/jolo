// Reading short, casual replies. Each parser returns null when the reply is
// unclear — empty, matching neither side, or matching both — so the bridge
// asks again instead of guessing.
import type { Role, Scope } from "./types.ts";

/** Lowercased words; apostrophes kept so "don't" stays one word. */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKC")
    .split(/[^\p{L}\p{N}']+/u)
    .filter(Boolean);
}

function classify<T>(text: string, sides: [T, ReadonlySet<string>, string[]][]): T | null {
  const tokens = new Set(words(text));
  const hits = sides.filter(
    ([, set, emoji]) => [...tokens].some((token) => set.has(token)) || emoji.some((e) => text.includes(e)),
  );
  return hits.length === 1 ? hits[0]![0] : null;
}

const YES = new Set(["yes", "y", "yep", "yeah", "yup", "ya", "correct", "right", "ok", "okay", "sure", "confirm", "save", "good", "perfect"]);
const NO = new Set(["no", "n", "nope", "nah", "wrong", "cancel", "stop", "incorrect"]);
const NEGATORS = new Set(["not", "dont", "don't", "isnt", "isn't", "never"]);
const EXPLICIT_YES = new Set(["yes", "y", "yep", "yeah", "yup", "ya"]);

export function parseConfirm(text: string): boolean | null {
  // "not correct" / "don't save" is a no — unless it also says "yes", as in
  // "yes, but not the croissant", which is ambiguous and gets asked again.
  const tokens = words(text);
  if (tokens.some((token) => NEGATORS.has(token))) {
    return tokens.some((token) => EXPLICIT_YES.has(token)) || text.includes("👍") ? null : false;
  }
  return classify(text, [
    [true, YES, ["👍", "✅"]],
    [false, NO, ["👎", "❌"]],
  ]);
}

const FIX_WORDS = new Set([
  "should", "change", "rename", "remove", "delete", "add", "called", "except", "but", "instead",
  "actually", "size", "sizes", "spelled", "price", "prices", "oz",
]);

/**
 * The answer to the change summary: a clean yes or no, a correction to pass to
 * the agent ("no, the cortado is 4.50", "yes but the small is 12 oz"), or null
 * when it's unclear. Anything with a number or a fixing word is a correction,
 * even when it starts with yes or no, so a fix is never saved or thrown away.
 */
export function parseConfirmReply(text: string): boolean | "correction" | null {
  const tokens = words(text);
  if (/\d/.test(text) || tokens.some((token) => FIX_WORDS.has(token))) return "correction";
  return parseConfirm(text);
}

const FULL = new Set(["full", "whole", "entire", "entirety", "all", "everything", "complete"]);
const PARTIAL = new Set(["part", "partial", "partly", "some", "section", "only", "half", "portion", "piece"]);

export function parseScope(text: string): Scope | null {
  return classify<Scope>(text, [
    ["full", FULL, []],
    ["partial", PARTIAL, []],
  ]);
}

const OWNER = new Set(["owner", "own", "owns", "owning", "run", "manage", "manager", "1"]);
const CUSTOMER = new Set(["customer", "guest", "looking", "visitor", "patron", "buyer", "2"]);

export function parseRole(text: string): Role | null {
  return classify<Role>(text, [
    ["owner", OWNER, []],
    ["customer", CUSTOMER, []],
  ]);
}

const NAME_PREFIX =
  /^(?:(?:hi|hey|hello|yo)[,!.\s]+)?(?:i'm|im|i am|my name is|my name's|name's|names|it's|its|this is|call me)\s+/i;

/** "I'm Barbara!" → "Barbara". Null for empty, overlong or sentence-like replies. */
export function parseName(text: string): string | null {
  const stripped = text
    .trim()
    .replace(NAME_PREFIX, "")
    .replace(/[.!?,;:]+$/u, "")
    .trim();
  if (!stripped || stripped.length > 40 || !/\p{L}/u.test(stripped)) return null;
  if (stripped.split(/\s+/).length > 4) return null;
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}
