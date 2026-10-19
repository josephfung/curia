// band-policy.test.ts — band gating helpers (#2159).

import { describe, expect, it } from 'vitest';
import { FailOpenLimiter, HUMAN_SEND_SKILLS, isSpotCheckOrAbove } from '../../../src/autonomy/band-policy.js';

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

  it('still trips when judge successes come between the failures', () => {
    // A judge that fails on long messages and succeeds on short ones must not reset the
    // count each time, or the long ones fail open forever.
    const t = 0;
    const limiter = new FailOpenLimiter({ now: () => t });
    for (let i = 0; i < 5; i++) {
      expect(limiter.tryAcquire().allowed).toBe(true);
      limiter.recordJudgeSuccess();
    }
    expect(limiter.tryAcquire()).toEqual({ allowed: false, justTripped: true });
  });

  it('starts a fresh window after recovering from a trip', () => {
    const t = 0;
    const limiter = new FailOpenLimiter({ now: () => t });
    for (let i = 0; i < 6; i++) limiter.tryAcquire();
    limiter.recordJudgeSuccess();
    for (let i = 0; i < 5; i++) expect(limiter.tryAcquire().allowed).toBe(true);
    expect(limiter.tryAcquire().justTripped).toBe(true);
  });

  it('forgets fail-opens older than the window', () => {
    let t = 0;
    const limiter = new FailOpenLimiter({ now: () => t });
    for (let i = 0; i < 5; i++) limiter.tryAcquire();
    t = 3_600_001;
    expect(limiter.tryAcquire().allowed).toBe(true);
  });
});
