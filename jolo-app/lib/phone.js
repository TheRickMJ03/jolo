// Phone numbers are stored and matched in E.164 ("+19085551234"): that's what
// Firebase Phone Auth puts in the ID token, what the rules compare against
// cafes/{id}.ownerPhone, and what iMessage reports as the sender handle.

/**
 * "(908) 555-1234", "908.555.1234", "1 908 555 1234" → "+19085551234".
 * An international number must start with "+". Returns null when unreadable.
 */
export function toE164(input, defaultCountryCode = "1") {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  const digits = trimmed.replace(/\D/g, "");

  if (trimmed.startsWith("+")) {
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  }
  if (defaultCountryCode === "1") {
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
    return null;
  }
  return digits.length >= 6 ? `+${defaultCountryCode}${digits}` : null;
}

/** "+19085551234" → "(908) 555-1234"; other countries stay in E.164. */
export function formatPhone(e164) {
  if (typeof e164 !== "string") return "";
  const match = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return match ? `(${match[1]}) ${match[2]}-${match[3]}` : e164;
}
