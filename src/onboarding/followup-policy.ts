// followup-policy.ts — what the onboarding watcher does next (#2360). Pure: no I/O, no clock.

import {
  CHAT_IDLE_NUDGE_HOURS,
  GREETING_FOLLOWUPS,
  GREETING_FOLLOWUP_GAP_HOURS,
} from './constants.js';
import type { OnboardingState } from './state.js';

export type WatcherAction =
  | 'wait'
  | 'greeting_nudge'
  | 'send_followup'
  | 'notify_greeting_unanswered'
  | 'idle_nudge'
  | 'notify_invitation_expired';

const HOUR_MS = 60 * 60 * 1000;

function ms(iso: string | null): number | null {
  if (iso === null) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/** What the caller looked up, so this stays pure. */
export type WatcherFacts = {
  /** Open first-conversation topic subtasks remain. */
  openTopicsRemain?: boolean;
  /** The next session is booked (a pending wake ahead, or a pending agenda the task owns). */
  nextSessionBooked?: boolean;
};

/** This run's phone app invitation; `redeemedAt` dates the greeting's due time on the app route. */
export type WatcherInvitation = { expiresAt: Date; redeemed: boolean; redeemedAt?: Date | null };

const GAP_MS = GREETING_FOLLOWUP_GAP_HOURS * HOUR_MS;

/**
 * No greeting recorded. It is due from the start (Signal, SMS, Slack) or from the invitation's
 * redemption (the app). A gap after that, the task is woken once to send and record it; a gap
 * after that wake, the operator is told.
 */
function decideUnrecordedGreeting(s: OnboardingState, nowMs: number, invitation: WatcherInvitation | null): WatcherAction {
  if (s.route === null) return 'wait';
  const dueAt = s.route === 'app'
    ? (invitation?.redeemed ? invitation.redeemedAt?.getTime() ?? null : null)
    : ms(s.startedAt);
  if (dueAt === null) return 'wait';
  const nudgedAt = ms(s.greetingNudgedAt ?? null);
  if (nudgedAt === null) return nowMs - dueAt >= GAP_MS ? 'greeting_nudge' : 'wait';
  if (nowMs - nudgedAt < GAP_MS) return 'wait';
  return s.operatorNotified.includes('greeting_unanswered') ? 'wait' : 'notify_greeting_unanswered';
}

export function decideNext(
  s: OnboardingState,
  now: Date,
  invitation: WatcherInvitation | null,
  facts: WatcherFacts = {},
): WatcherAction {
  const nowMs = now.getTime();
  const { openTopicsRemain = false, nextSessionBooked = false } = facts;

  if (
    invitation !== null &&
    !invitation.redeemed &&
    invitation.expiresAt.getTime() <= nowMs &&
    !s.operatorNotified.includes('invitation_expired')
  ) {
    return 'notify_invitation_expired';
  }

  const greetingAt = ms(s.greetingSentAt);
  if (greetingAt === null) return decideUnrecordedGreeting(s, nowMs, invitation);
  const repliedAt = ms(s.lastPrincipalTurnAt);
  const replied = repliedAt !== null && repliedAt >= greetingAt;

  if (!replied) {
    const lastSent = ms(s.lastFollowUpAt) ?? greetingAt;
    if (nowMs - lastSent < GAP_MS) return 'wait';
    if (s.followUpsSent < GREETING_FOLLOWUPS) return 'send_followup';
    return s.operatorNotified.includes('greeting_unanswered') ? 'wait' : 'notify_greeting_unanswered';
  }

  // A deferral or a normally ended session books the next one: the quiet is agreed, not idle.
  const nudgedAt = ms(s.idleNudgeSentAt);
  if (
    openTopicsRemain &&
    !nextSessionBooked &&
    nowMs - repliedAt >= CHAT_IDLE_NUDGE_HOURS * HOUR_MS &&
    (nudgedAt === null || nudgedAt < repliedAt)
  ) {
    return 'idle_nudge';
  }
  return 'wait';
}
