// Every word JOLO says over iMessage. Conversation design lives here and in
// docs/conversation-design.md — change both together.
//
// Plain text only: iMessage shows asterisks literally, so emphasis uses quotes.
import type { MenuChanges, MenuItem, Price, PriceChange, Role } from "./types.ts";

export const copy = {
  // Onboarding
  greeting: "Hi! I'm JOLO ☕ I keep café menus up to date. What's your name?",
  askNameAgain: "Sorry, what should I call you? Just your first name is fine.",
  askRole: (name: string) => `Nice to meet you, ${name}! Are you a café owner or a customer?`,
  askRoleAgain: 'Just reply "owner" if you run a café, or "customer" if you\'re looking for one.',
  welcome: (role: Role) =>
    role === "owner"
      ? 'Great! I\'ll match you to your café by this phone number. Whenever your menu changes, text me a photo of it and say "update the menu".'
      : 'Great! Ask me about any café\'s menu, like "What\'s on the menu at Barbara\'s?"',
  resendPhoto: "Send that photo again and I'll read it.",

  // Owner menu update
  reading: "Reading your menu… this can take a minute.",
  readingMore: "Got it, reading that one too…",
  askScope: "Is this your full menu, or just part of it?",
  askScopeAgain: 'Sorry, I didn\'t catch that. Is the photo your "full" menu, or just "part" of it?',
  confirmPrompt: 'Reply "yes" to save or "no" to cancel. If something is off, tell me what to fix.',
  confirmAgain:
    'Reply "yes" to save these changes, or "no" to leave your menu as it is. Or tell me what to fix, like "the cortado is 4.50".',
  noChanges: "That looks the same as your current menu, so there's nothing to save.",
  menuUpdated: "Your menu is updated ✅",
  cancelled: "Okay, nothing changed. Send another photo whenever you're ready.",
  notOwner:
    "I couldn't find a café linked to this phone number. Ask the JOLO team to link it, then send the photo again.",

  // Problems
  unreadablePhoto: "I couldn't read that photo. Can you send a clearer one?",
  readerDown: "I can't read menus right now. Try again in a minute.",
  agentDown: "I couldn't reach the menu service just now. Please try again in a minute.",
  tooManyPhotos: (max: number) => `I can read up to ${max} photos at a time. I'll use the first ${max}.`,
  unsupported: "I can only read photos and text for now.",
  photoTooLarge: "That photo is too large for me to read. Could you send a smaller one?",
};

export function formatPrice(usd: unknown): string {
  if (typeof usd !== "number" || !Number.isFinite(usd)) return "no price";
  return `$${usd.toFixed(2)}`;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

function joinParts(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/** "$4.50", "12 oz $4.50 / 16 oz $5.25", or "no price". */
export function formatPrices(prices: Price[] | undefined): string {
  if (!prices || prices.length === 0) return "no price";
  return prices.map((price) => (price.size ? `${price.size} ${formatPrice(price.usd)}` : formatPrice(price.usd))).join(" / ");
}

const itemLine = (item: MenuItem) => `${item.item} ${formatPrices(item.prices)}`;
const sized = (change: PriceChange) => (change.size ? `${change.item} (${change.size})` : change.item);

function priceChangeLine(change: PriceChange): string {
  const has = (usd: unknown) => typeof usd === "number";
  if (!has(change.old_usd)) return `• ${sized(change)} new at ${formatPrice(change.new_usd)}`;
  if (!has(change.new_usd)) return `• ${sized(change)} ${formatPrice(change.old_usd)} → no longer listed`;
  return `• ${sized(change)} ${formatPrice(change.old_usd)} → ${formatPrice(change.new_usd)}`;
}

/** Least confident first: those are the ones the owner should look at. Unscored items go last. */
const byConfidence = (a: MenuItem, b: MenuItem) => (a.confidence ?? 1) - (b.confidence ?? 1);

const MAX_DETAIL_LINES = 6;

/**
 * "Found 2 new items and 3 price changes. Cortado now $4.75?" plus up to six
 * detail lines and the prompt. New items are listed least confident first.
 * Null when nothing changed.
 */
export function confirmSummary(changes: MenuChanges): string | null {
  const added = [...changes.added].sort(byConfidence);
  const prices = changes.price_changes;

  const parts: string[] = [];
  if (added.length > 0) parts.push(plural(added.length, "new item", "new items"));
  if (prices.length > 0) parts.push(plural(prices.length, "price change", "price changes"));
  if (changes.removed.length > 0) parts.push(plural(changes.removed.length, "removed item", "removed items"));
  if (parts.length === 0) return null;

  let headline = `Found ${joinParts(parts)}.`;
  const example = prices.find((change) => typeof change.new_usd === "number");
  if (example) headline += ` ${sized(example)} now ${formatPrice(example.new_usd)}?`;
  else if (added[0]) headline += ` ${itemLine(added[0])}?`;

  const lines = [
    ...added.map((item) => `+ ${itemLine(item)}`),
    ...prices.map(priceChangeLine),
    ...changes.removed.map((name) => `– ${name} (removed)`),
  ];
  const shown = lines.slice(0, MAX_DETAIL_LINES);
  if (lines.length > shown.length) shown.push(`…and ${lines.length - shown.length} more`);

  return [headline, ...shown, "", copy.confirmPrompt].join("\n");
}
