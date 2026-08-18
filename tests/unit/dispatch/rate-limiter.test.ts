import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RateLimiter } from '../../../src/dispatch/rate-limiter.js';

/** Read the private per-sender Map's size to assert eviction bounds memory.
 *  TypeScript `private` is not enforced at runtime, so a cast is the standard
 *  way to inspect internal bookkeeping from a unit test. */
function senderCount(limiter: RateLimiter): number {
  return (limiter as unknown as { senderWindows: Map<string, unknown> }).senderWindows.size;
}

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

  // -- Idle-sender eviction (#1665) --

  describe('idle-sender eviction', () => {
    it('evicts an idle sender window once its window has fully elapsed', async () => {
      const limiter = new RateLimiter({ windowMs: 60_000, maxPerSender: 5, maxGlobal: 100 });

      expect(limiter.checkSender('alice')).toBe(true);
      expect(senderCount(limiter)).toBe(1); // alice tracked

      // Alice goes idle for longer than a full window, then bob sends. Bob's call
      // triggers the once-per-window sweep, which drops alice's fully-elapsed window.
      await vi.advanceTimersByTimeAsync(60_001);
      expect(limiter.checkSender('bob')).toBe(true);

      expect(senderCount(limiter)).toBe(1); // only bob remains — alice evicted
    });

    it('bounds memory under many one-shot senders', async () => {
      const limiter = new RateLimiter({ windowMs: 60_000, maxPerSender: 5, maxGlobal: 10_000 });

      // 50 distinct senders each send one message inside the first window.
      for (let i = 0; i < 50; i++) {
        expect(limiter.checkSender(`sender-${i}`)).toBe(true);
      }
      expect(senderCount(limiter)).toBe(50);

      // A full window passes with no activity from any of them; one new sender
      // arrives and triggers the sweep. All 50 idle windows are reclaimed.
      await vi.advanceTimersByTimeAsync(60_001);
      expect(limiter.checkSender('newcomer')).toBe(true);

      expect(senderCount(limiter)).toBe(1);
    });

    it('spares a sender whose window is still active when the sweep runs', async () => {
      const limiter = new RateLimiter({ windowMs: 60_000, maxPerSender: 1, maxGlobal: 100 });

      // NOTE: t below is relative — vitest's fake clock starts at real wall-clock
      // time, which is far larger than windowMs. That is load-bearing here: it makes
      // the first checkSender stamp lastSweepAt and reset each sender's windowStart to
      // "now" so the t=60_001 sweep sees bob's window as still active. Pinning the
      // clock to a small base (e.g. vi.setSystemTime(0)) would break this test.

      // alice sends at t≈0 (window [t, t+60_000)).
      expect(limiter.checkSender('alice')).toBe(true);

      // bob sends at t=30_000 (window [30_000, 90_000)) — no sweep yet this window.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(limiter.checkSender('bob')).toBe(true);

      // carol sends at t=60_001. Her call triggers the sweep: alice's window has
      // fully elapsed (idle 60_001ms) → evicted; bob's window is still active
      // (idle 30_001ms) → spared.
      await vi.advanceTimersByTimeAsync(30_001);
      expect(limiter.checkSender('carol')).toBe(true);

      expect(senderCount(limiter)).toBe(2); // bob + carol; alice evicted

      // bob survived the sweep with his window intact: still inside it and already
      // used his single message, so he stays blocked.
      expect(limiter.checkSender('bob')).toBe(false);
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
