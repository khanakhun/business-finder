/**
 * Nonces of signed requests seen while their timestamp is still accepted: a replay inside that window is refused.
 * Bounded (a flood of valid signatures needs the secret).
 */
export class NonceCache {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 10_000,
  ) {}

  /** Records the nonce; false when it was already used. */
  use(nonce: string, now: number): boolean {
    // Expired first, then the oldest while full (room for this one: at most `maxEntries`).
    for (const [key, until] of this.seen) {
      if (until > now && this.seen.size < this.maxEntries) break;
      this.seen.delete(key);
    }
    if ((this.seen.get(nonce) ?? 0) > now) return false;
    this.seen.set(nonce, now + this.ttlMs);
    return true;
  }
}
