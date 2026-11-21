import { describe, expect, it } from 'vitest';
import { decideNext } from '../../../src/onboarding/followup-policy.js';
import type { OnboardingState } from '../../../src/onboarding/state.js';
import {
  CHAT_IDLE_NUDGE_HOURS,
  GREETING_FOLLOWUPS,
  GREETING_FOLLOWUP_GAP_HOURS,
} from '../../../src/onboarding/constants.js';

const T0 = new Date('2026-11-20T12:00:00Z');
const after = (hours: number, from = T0) => new Date(from.getTime() + hours * 3_600_000);

function state(over: Partial<OnboardingState> = {}): OnboardingState {
  return {
    taskId: 't1',
    startedAt: T0.toISOString(),
    route: 'app',
    greetingSentAt: T0.toISOString(),
    followUpsSent: 0,
    lastFollowUpAt: null,
    lastPrincipalTurnAt: null,
    idleNudgeSentAt: null,
    operatorNotified: [],
    ...over,
  };
}

describe('decideNext', () => {
  it('notifies once when the invitation expired unredeemed', () => {
    const inv = { expiresAt: T0, redeemed: false };
    expect(decideNext(state({ greetingSentAt: null }), after(1), inv)).toBe('notify_invitation_expired');
    expect(decideNext(state({ greetingSentAt: null, operatorNotified: ['invitation_expired'] }), after(1), inv)).toBe('wait');
  });

  it('ignores a redeemed or unexpired invitation', () => {
    expect(decideNext(state({ greetingSentAt: null }), after(1), { expiresAt: T0, redeemed: true })).toBe('wait');
    expect(decideNext(state({ greetingSentAt: null }), after(1), { expiresAt: after(5), redeemed: false })).toBe('wait');
  });

  it('waits before the gap, then sends a follow-up', () => {
    expect(decideNext(state(), after(GREETING_FOLLOWUP_GAP_HOURS - 1), null)).toBe('wait');
    expect(decideNext(state(), after(GREETING_FOLLOWUP_GAP_HOURS), null)).toBe('send_followup');
  });

  it('measures the gap from the last follow-up', () => {
    const s = state({ followUpsSent: 1, lastFollowUpAt: after(GREETING_FOLLOWUP_GAP_HOURS).toISOString() });
    expect(decideNext(s, after(GREETING_FOLLOWUP_GAP_HOURS + 1), null)).toBe('wait');
    expect(decideNext(s, after(GREETING_FOLLOWUP_GAP_HOURS * 2), null)).toBe('send_followup');
  });

  it('never sends more than GREETING_FOLLOWUPS; notifies once instead', () => {
    const s = state({ followUpsSent: GREETING_FOLLOWUPS, lastFollowUpAt: T0.toISOString() });
    const later = after(GREETING_FOLLOWUP_GAP_HOURS);
    expect(decideNext(s, later, null)).toBe('notify_greeting_unanswered');
    expect(decideNext({ ...s, operatorNotified: ['greeting_unanswered'] }, later, null)).toBe('wait');
  });

  it('never follows up after the principal replied', () => {
    const s = state({ lastPrincipalTurnAt: after(1).toISOString() });
    expect(decideNext(s, after(GREETING_FOLLOWUP_GAP_HOURS * 5), null, false)).toBe('wait');
  });

  it('treats a reply from before the greeting as no reply', () => {
    const s = state({ lastPrincipalTurnAt: after(-3).toISOString() });
    expect(decideNext(s, after(GREETING_FOLLOWUP_GAP_HOURS), null)).toBe('send_followup');
  });

  it('nudges once when the principal goes quiet with topics open', () => {
    const replied = after(1);
    const s = state({ lastPrincipalTurnAt: replied.toISOString() });
    expect(decideNext(s, after(CHAT_IDLE_NUDGE_HOURS - 1, replied), null, true)).toBe('wait');
    expect(decideNext(s, after(CHAT_IDLE_NUDGE_HOURS, replied), null, true)).toBe('idle_nudge');
    expect(decideNext(s, after(CHAT_IDLE_NUDGE_HOURS, replied), null, false)).toBe('wait');
    const nudged = { ...s, idleNudgeSentAt: after(CHAT_IDLE_NUDGE_HOURS, replied).toISOString() };
    expect(decideNext(nudged, after(CHAT_IDLE_NUDGE_HOURS * 3, replied), null, true)).toBe('wait');
  });

  it('nudges again after a newer principal turn', () => {
    const replied = after(10);
    const s = state({ lastPrincipalTurnAt: replied.toISOString(), idleNudgeSentAt: after(5).toISOString() });
    expect(decideNext(s, after(CHAT_IDLE_NUDGE_HOURS, replied), null, true)).toBe('idle_nudge');
  });

  it('waits before the greeting is sent', () => {
    expect(decideNext(state({ greetingSentAt: null }), after(500), null, true)).toBe('wait');
  });
});
