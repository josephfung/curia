// rate-limiter.ts — In-memory fixed-window rate limiter for the dispatch layer.
//
// Enforces two independent limits:
//   1. Global — total messages per window across all senders.
//   2. Per-sender — messages per sender per window.
//
// Both use a fixed-window counter: the window resets once `windowMs` elapses
// since the first message in that window. This is intentionally simple — Curia
// runs as a single process on a single VPS, so in-memory state is sufficient.
// A sliding-window or Redis-backed approach can be layered on if multi-process
// deployment becomes a requirement.
//
// Spec: docs/specs/06-audit-and-security.md — Security Checklist → Rate limiting

export interface RateLimiterConfig {
  /** Duration of each rate-limit window in milliseconds. Default: 60000 (1 minute). */
  windowMs: number;
  /** Maximum messages allowed per sender per window. Default: 15. */
  maxPerSender: number;
  /** Maximum total messages allowed per window across all senders. Default: 100. */
  maxGlobal: number;
}

interface WindowEntry {
  count: number;
  windowStart: number;   // ms timestamp of the first message in this window
}

export class RateLimiter {
  private readonly windowMs: number;
  private readonly maxPerSender: number;
  private readonly maxGlobal: number;

  /** Per-sender counters — keyed by senderId. */
  private readonly senderWindows = new Map<string, WindowEntry>();

  /** Single global counter — tracks aggregate message rate across all senders. */
  private globalWindow: WindowEntry = { count: 0, windowStart: 0 };

  constructor(config: RateLimiterConfig) {
    this.windowMs = config.windowMs;
    this.maxPerSender = config.maxPerSender;
    this.maxGlobal = config.maxGlobal;
  }

  /**
   * Check the global rate limit and increment the counter if allowed.
   *
   * Returns true if the message is within the global limit (caller should proceed).
   * Returns false if the global limit is exceeded (caller should drop the message).
   *
   * The counter is NOT incremented on false — a rejected message does not consume quota.
   */
  checkGlobal(): boolean {
    return this.check(this.globalWindow, this.maxGlobal);
  }

  /**
   * Check the per-sender rate limit for the given senderId and increment if allowed.
   *
   * Returns true if the sender is within their limit (caller should proceed).
   * Returns false if the sender's limit is exceeded (caller should drop the message).
   *
   * The counter is NOT incremented on false — a rejected message does not consume quota.
   */
  checkSender(senderId: string): boolean {
    let entry = this.senderWindows.get(senderId);
    if (!entry) {
      entry = { count: 0, windowStart: 0 };
      this.senderWindows.set(senderId, entry);
    }
    return this.check(entry, this.maxPerSender);
  }

  /**
   * Core fixed-window check+increment logic, shared by both global and per-sender checks.
   *
   * Mutates `entry` in place — both methods above hold references to the same object
   * stored in the Map (or the global field), so no re-assignment is needed.
   */
  private check(entry: WindowEntry, limit: number): boolean {
    const now = Date.now();

    // Reset the window if the current window period has elapsed.
    if (now - entry.windowStart >= this.windowMs) {
      entry.count = 0;
      entry.windowStart = now;
    }

    if (entry.count >= limit) {
      // Limit exceeded — do not increment, return false.
      return false;
    }

    entry.count++;
    return true;
  }
}
