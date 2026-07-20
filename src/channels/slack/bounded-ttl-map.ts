// bounded-ttl-map.ts — process-local Map with TTL + max size (LRU-ish eviction).
// Used by the Slack adapter for DM peer and active-thread state so long-lived
// processes do not grow unbounded maps.

export class BoundedTtlMap<V> {
  private readonly entries = new Map<string, { value: V; seenAt: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxSize: number,
  ) {
    if (ttlMs <= 0) throw new Error('BoundedTtlMap ttlMs must be > 0');
    if (maxSize <= 0) throw new Error('BoundedTtlMap maxSize must be > 0');
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }

  /** True if key is present and not expired (refreshes seenAt on hit). */
  has(key: string, now = Date.now()): boolean {
    return this.get(key, now) !== undefined;
  }

  get(key: string, now = Date.now()): V | undefined {
    this.prune(now);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (now - entry.seenAt >= this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    // Refresh for LRU + keep-alive on use.
    entry.seenAt = now;
    // Re-insert to push to Map insertion-order end (evict oldest first).
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V, now = Date.now()): void {
    this.prune(now);
    this.entries.delete(key);
    this.entries.set(key, { value, seenAt: now });
    this.evictOverflow();
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if (now - entry.seenAt >= this.ttlMs) this.entries.delete(key);
    }
  }

  private evictOverflow(): void {
    while (this.entries.size > this.maxSize) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
