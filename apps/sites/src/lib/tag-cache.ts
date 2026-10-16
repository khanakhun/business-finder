interface Entry<T> {
  readonly value: T;
  readonly until: number;
  readonly tags: readonly string[];
}

/**
 * A small in-memory cache with lifetimes and tags (cache-aside): an entry lives until its expiry or until one of its
 * tags is invalidated (the API's revalidation calls). Bounded: the least recently used entries go first.
 */
export class TagCache<T> {
  private readonly entries = new Map<string, Entry<T>>();

  constructor(private readonly maxEntries = 1_000) {}

  get(key: string, now: number): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    if (entry.until <= now) return undefined;
    // Least recently used goes first: a read moves the entry to the end.
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, until: number, tags: readonly string[]): void {
    this.entries.delete(key);
    this.entries.set(key, { value, until, tags });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /** Drops every entry carrying one of the tags; returns how many. */
  invalidate(tags: readonly string[]): number {
    let dropped = 0;
    for (const [key, entry] of this.entries) {
      if (entry.tags.some((tag) => tags.includes(tag))) {
        this.entries.delete(key);
        dropped += 1;
      }
    }
    return dropped;
  }

  get size(): number {
    return this.entries.size;
  }
}
