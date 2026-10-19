// band-policy.test.ts — band gating helpers (#2159).

import { describe, expect, it } from 'vitest';
import { FailOpenLimiter, GateCReviews, HUMAN_SEND_SKILLS, isSpotCheckOrAbove } from '../../../src/autonomy/band-policy.js';

describe('isSpotCheckOrAbove', () => {
  it('is true from 80', () => {
    expect(isSpotCheckOrAbove(79)).toBe(false);
    expect(isSpotCheckOrAbove(80)).toBe(true);
    expect(isSpotCheckOrAbove(95)).toBe(true);
  });
});

describe('HUMAN_SEND_SKILLS', () => {
  it('lists the human-channel send skills', () => {
    for (const s of ['email-send', 'email-reply', 'send-draft', 'signal-send', 'sms-send', 'slack-send']) {
      expect(HUMAN_SEND_SKILLS.has(s)).toBe(true);
    }
    expect(HUMAN_SEND_SKILLS.has('calendar-create-event')).toBe(false);
  });
});

describe('GateCReviews', () => {
  it('remembers a marked task until the TTL passes', () => {
    let t = 0;
    const reviews = new GateCReviews({ ttlMs: 1000, now: () => t });
    reviews.mark('task-1');
    expect(reviews.wasReviewed('task-1')).toBe(true);
    expect(reviews.wasReviewed('task-2')).toBe(false);
    expect(reviews.wasReviewed(undefined)).toBe(false);
    t = 1001;
    expect(reviews.wasReviewed('task-1')).toBe(false);
  });

  it('drops the oldest entry past maxEntries', () => {
    const reviews = new GateCReviews({ maxEntries: 2 });
    reviews.mark('a');
    reviews.mark('b');
    reviews.mark('c');
    expect(reviews.wasReviewed('a')).toBe(false);
    expect(reviews.wasReviewed('c')).toBe(true);
  });
});

describe('FailOpenLimiter', () => {
  it('allows five in an hour, trips on the sixth, and reports the trip once', () => {
    const t = 0;
    const limiter = new FailOpenLimiter({ now: () => t });
    for (let i = 0; i < 5; i++) expect(limiter.tryAcquire()).toEqual({ allowed: true, justTripped: false });
    expect(limiter.tryAcquire()).toEqual({ allowed: false, justTripped: true });
    expect(limiter.tryAcquire()).toEqual({ allowed: false, justTripped: false });
  });

  it('stays tripped after the window passes, until a judge call succeeds', () => {
    let t = 0;
    const limiter = new FailOpenLimiter({ now: () => t });
    for (let i = 0; i < 6; i++) limiter.tryAcquire();
    t = 2 * 3_600_000;
    expect(limiter.tryAcquire().allowed).toBe(false);
    limiter.recordJudgeSuccess();
    expect(limiter.tryAcquire()).toEqual({ allowed: true, justTripped: false });
  });

  it('forgets fail-opens older than the window', () => {
    let t = 0;
    const limiter = new FailOpenLimiter({ now: () => t });
    for (let i = 0; i < 5; i++) limiter.tryAcquire();
    t = 3_600_001;
    expect(limiter.tryAcquire().allowed).toBe(true);
  });
});
