import { createHash, timingSafeEqual } from "node:crypto";

// Constant-time comparison of the X-API-Key header. Hashing both sides first
// gives equal-length buffers, so neither the content nor the length of the
// real key leaks through timing.
export function checkApiKey(header: string | string[] | undefined, expected: string): boolean {
  if (typeof header !== "string" || header.length === 0) return false;
  const given = createHash("sha256").update(header, "utf8").digest();
  const wanted = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(given, wanted);
}
