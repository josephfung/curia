import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RateLimiter } from '../../../src/dispatch/rate-limiter.js';

describe('RateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -- Global rate limit --

  describe('checkGlobal()', () => {
    it('allows messages up to the global limit', () => {
      const limiter = new RateLimiter({ windowMs: 60_000, maxPerSender: 15, maxGlobal: 3 });

      expect(limiter.checkGlobal()).toBe(true);
      expect(limiter.checkGlobal()).toBe(true);
      expect(limiter.checkGlobal()).toBe(true);
    });

    it('blocks messages once global limit is reached', () => {
      const limiter = new RateLimiter({ windowMs: 60_000, maxPerSender: 15, maxGlobal: 2 });

      expect(limiter.checkGlobal()).toBe(true);
      expect(limiter.checkGlobal()).toBe(true);
      // 3rd message exceeds limit of 2
      expect(limiter.checkGlobal()).toBe(false);
      expect(limiter.checkGlobal()).toBe(false);
    });

    it('does not increment the counter when the limit is exceeded', () => {
      // With a limit of 1, the second and third calls should both return false —
      // rejected messages must not consume quota (otherwise 1 bad message would
      // permanently block all future messages until the window resets).
      const limiter = new RateLimiter({ windowMs: 60_000, maxPerSender: 15, maxGlobal: 1 });

      expect(limiter.checkGlobal()).toBe(true);   // count: 1 (at limit)
      expect(limiter.checkGlobal()).toBe(false);  // rejected, count remains 1
      expect(limiter.checkGlobal()).toBe(false);  // still rejected
    });

    it('resets the window after windowMs elapses', async () => {
      const limiter = new RateLimiter({ windowMs: 60_000, maxPerSender: 15, maxGlobal: 2 });

      expect(limiter.checkGlobal()).toBe(true);
      expect(limiter.checkGlobal()).toBe(true);
      expect(limiter.checkGlobal()).toBe(false); // blocked

      // Advance time past the window boundary
      await vi.advanceTimersByTimeAsync(60_001);

      // Window has reset — new messages are allowed again
      expect(limiter.checkGlobal()).toBe(true);
      expect(limiter.checkGlobal()).toBe(true);
      expect(limiter.checkGlobal()).toBe(false); // blocked again in new window
    });
  });

  // -- Per-sender rate limit --

  describe('checkSender()', () => {
    it('allows messages up to the per-sender limit', () => {
      const limiter = new RateLimiter({ windowMs: 60_000, maxPerSender: 3, maxGlobal: 100 });

      expect(limiter.checkSender('alice')).toBe(true);
      expect(limiter.checkSender('alice')).toBe(true);
      expect(limiter.checkSender('alice')).toBe(true);
    });

    it('blocks messages once per-sender limit is reached', () => {
      const limiter = new RateLimiter({ windowMs: 60_000, maxPerSender: 2, maxGlobal: 100 });

      expect(limiter.checkSender('alice')).toBe(true);
      expect(limiter.checkSender('alice')).toBe(true);
      expect(limiter.checkSender('alice')).toBe(false); // 3rd exceeds limit of 2
    });

    it('tracks senders independently', () => {
      const limiter = new RateLimiter({ windowMs: 60_000, maxPerSender: 1, maxGlobal: 100 });

      // alice uses her one message
      expect(limiter.checkSender('alice')).toBe(true);
      expect(limiter.checkSender('alice')).toBe(false); // blocked

      // bob has his own independent window — not affected by alice
      expect(limiter.checkSender('bob')).toBe(true);
      expect(limiter.checkSender('bob')).toBe(false); // blocked
    });

    it('does not increment the counter when the sender limit is exceeded', () => {
      const limiter = new RateLimiter({ windowMs: 60_000, maxPerSender: 1, maxGlobal: 100 });

      expect(limiter.checkSender('alice')).toBe(true);
      expect(limiter.checkSender('alice')).toBe(false);
      expect(limiter.checkSender('alice')).toBe(false); // still false, not incrementing
    });

    it('resets per-sender window after windowMs elapses', async () => {
      const limiter = new RateLimiter({ windowMs: 60_000, maxPerSender: 1, maxGlobal: 100 });

      expect(limiter.checkSender('alice')).toBe(true);
      expect(limiter.checkSender('alice')).toBe(false); // blocked

      await vi.advanceTimersByTimeAsync(60_001);

      // Window reset — alice is allowed again
      expect(limiter.checkSender('alice')).toBe(true);
      expect(limiter.checkSender('alice')).toBe(false); // blocked again
    });
  });

  // -- Global and per-sender limits are independent --

  describe('global and per-sender limits are independent', () => {
    it('global limit can be hit while individual senders are below their limit', () => {
      // Global limit 2, sender limit 5
      // Two different senders send one message each — global fills up,
      // but neither sender has hit their personal limit.
      const limiter = new RateLimiter({ windowMs: 60_000, maxPerSender: 5, maxGlobal: 2 });

      expect(limiter.checkGlobal()).toBe(true);   // 1/2 global
      expect(limiter.checkSender('alice')).toBe(true);  // 1/5 alice

      expect(limiter.checkGlobal()).toBe(true);   // 2/2 global (at limit)
      expect(limiter.checkSender('bob')).toBe(true);    // 1/5 bob

      // Global is now exhausted — but per-sender checks are independent
      expect(limiter.checkGlobal()).toBe(false);
      // alice and bob can still pass their per-sender check (checked separately by dispatcher)
      expect(limiter.checkSender('alice')).toBe(true);
    });

    it('sender limit can be hit while global still has capacity', () => {
      const limiter = new RateLimiter({ windowMs: 60_000, maxPerSender: 1, maxGlobal: 100 });

      expect(limiter.checkGlobal()).toBe(true);  // global: 1/100
      expect(limiter.checkSender('alice')).toBe(true);  // alice: 1/1

      expect(limiter.checkGlobal()).toBe(true);  // global: 2/100
      expect(limiter.checkSender('alice')).toBe(false); // alice: blocked

      // bob is a different sender and is unaffected
      expect(limiter.checkSender('bob')).toBe(true);
    });
  });
});
