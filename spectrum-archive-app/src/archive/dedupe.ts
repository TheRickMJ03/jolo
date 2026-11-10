// Deliveries are at-least-once (guide Stage 9): the webhook can redeliver, and
// the stream and webhook can both carry the same message. respond() checks
// here before archiving or replying, so a redelivery has no side effects.

export class TtlSet {
  private readonly seen = new Map<string, number>();
  private lastSweep = 0;

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** True if `key` was already seen within the TTL; otherwise records it. */
  seenBefore(key: string): boolean {
    const now = this.now();
    this.sweep(now);

    const expiresAt = this.seen.get(key);
    if (expiresAt !== undefined && expiresAt > now) return true;

    this.seen.set(key, now + this.ttlMs);
    return false;
  }

  get size(): number {
    return this.seen.size;
  }

  // Bounded memory without a timer: drop expired keys at most ~10× per TTL.
  private sweep(now: number): void {
    if (now - this.lastSweep < this.ttlMs / 10) return;
    this.lastSweep = now;
    for (const [key, expiresAt] of this.seen) {
      if (expiresAt <= now) this.seen.delete(key);
    }
  }
}

const DEDUPE_TTL_MS = 10 * 60_000;
const recentMessages = new TtlSet(DEDUPE_TTL_MS);

/** Message ids are only unique per platform, so the key carries both. */
export function isDuplicate(platform: string, messageId: string): boolean {
  if (!messageId) return false; // nothing to dedupe on; let it through
  return recentMessages.seenBefore(`${platform}:${messageId}`);
}
