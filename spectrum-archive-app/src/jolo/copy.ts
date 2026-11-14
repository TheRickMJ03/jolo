// Every word JOLO says over iMessage. Conversation design lives here and in
// docs/conversation-design.md — change both together.
//
// Plain text only: iMessage shows asterisks literally, so emphasis uses quotes.
import type { FieldChange, MenuChanges, MenuItem, Role } from "./types.ts";

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
  askScope: "Is this your full menu, or just part of it?",
  askScopeAgain: 'Sorry, I didn\'t catch that. Is the photo your "full" menu, or just "part" of it?',
  confirmPrompt: 'Reply "yes" to save, or "no" to cancel.',
  confirmAgain: 'Reply "yes" to save these changes, or "no" to leave your menu as it is.',
  noChanges: "That looks the same as your current menu, so there's nothing to save.",
  menuUpdated: "Your menu is updated ✅",
  cancelled: "Okay, nothing changed. Send another photo whenever you're ready.",
  notOwner:
    "I couldn't find a café linked to this phone number. Ask the JOLO team to link it, then send the photo again.",

  // Problems
  agentDown: "I couldn't reach the menu service just now. Please try again in a minute.",
  tooManyPhotos: (max: number) => `I can read up to ${max} photos at a time. I'll use the first ${max}.`,
  unsupported: "I can only read photos and text for now.",
  photoTooLarge: "That photo is too large for me to read. Could you send a smaller one?",
};

export function formatPrice(cents: unknown): string {
  if (typeof cents !== "number" || !Number.isFinite(cents)) return "no price";
  return `$${(cents / 100).toFixed(2)}`;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

function joinParts(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

const isPrice = (change: FieldChange) => change.field === "priceCents";

function describeValue(field: string, value: unknown): string {
  if (field === "priceCents") return formatPrice(value);
  if (typeof value === "string") return `"${value}"`;
  if (typeof value === "boolean") return field === "available" ? (value ? "available" : "sold out") : String(value);
  return value === null || value === undefined ? "none" : String(value);
}

function itemLine(item: MenuItem): string {
  return `${item.name} ${formatPrice(item.priceCents)}`;
}

const MAX_DETAIL_LINES = 6;

/**
 * "Found 2 new items and 3 price changes. Cortado now $4.75?" plus up to six
 * detail lines and the yes/no prompt. Null when nothing changed.
 */
export function confirmSummary(changes: MenuChanges): string | null {
  const prices = changes.changed.filter(isPrice);
  const others = changes.changed.filter((change) => !isPrice(change));

  const parts: string[] = [];
  if (changes.added.length > 0) parts.push(plural(changes.added.length, "new item", "new items"));
  if (prices.length > 0) parts.push(plural(prices.length, "price change", "price changes"));
  if (others.length > 0) parts.push(plural(others.length, "other change", "other changes"));
  if (changes.removed.length > 0) parts.push(plural(changes.removed.length, "removed item", "removed items"));
  if (parts.length === 0) return null;

  let headline = `Found ${joinParts(parts)}.`;
  const example = prices[0];
  if (example) headline += ` ${example.name} now ${formatPrice(example.to)}?`;

  const lines = [
    ...changes.added.map((item) => `+ ${itemLine(item)}`),
    ...prices.map((change) => `• ${change.name} ${formatPrice(change.from)} → ${formatPrice(change.to)}`),
    ...others.map(
      (change) =>
        `• ${change.name}: ${describeValue(change.field, change.from)} → ${describeValue(change.field, change.to)}`,
    ),
    ...changes.removed.map((item) => `– ${item.name} (removed)`),
  ];
  const shown = lines.slice(0, MAX_DETAIL_LINES);
  if (lines.length > shown.length) shown.push(`…and ${lines.length - shown.length} more`);

  return [headline, ...shown, "", copy.confirmPrompt].join("\n");
}
