// followup-policy.ts — what the onboarding watcher does next (#2360). Pure: no I/O, no clock.

import {
  CHAT_IDLE_NUDGE_HOURS,
  GREETING_FOLLOWUPS,
  GREETING_FOLLOWUP_GAP_HOURS,
} from './constants.js';
import type { OnboardingState } from './state.js';

export type WatcherAction =
  | 'wait'
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

/**
 * `openTopicsRemain` is whether open first-conversation topic subtasks remain; the caller counts
 * them so this stays pure.
 */
export function decideNext(
  s: OnboardingState,
  now: Date,
  invitation: { expiresAt: Date; redeemed: boolean } | null,
  openTopicsRemain = false,
): WatcherAction {
  const nowMs = now.getTime();

  if (
    invitation !== null &&
    !invitation.redeemed &&
    invitation.expiresAt.getTime() <= nowMs &&
    !s.operatorNotified.includes('invitation_expired')
  ) {
    return 'notify_invitation_expired';
  }

  const greetingAt = ms(s.greetingSentAt);
  if (greetingAt === null) return 'wait';
  const repliedAt = ms(s.lastPrincipalTurnAt);
  const replied = repliedAt !== null && repliedAt >= greetingAt;

  if (!replied) {
    const lastSent = ms(s.lastFollowUpAt) ?? greetingAt;
    if (nowMs - lastSent < GREETING_FOLLOWUP_GAP_HOURS * HOUR_MS) return 'wait';
    if (s.followUpsSent < GREETING_FOLLOWUPS) return 'send_followup';
    return s.operatorNotified.includes('greeting_unanswered') ? 'wait' : 'notify_greeting_unanswered';
  }

  const nudgedAt = ms(s.idleNudgeSentAt);
  if (
    openTopicsRemain &&
    nowMs - repliedAt >= CHAT_IDLE_NUDGE_HOURS * HOUR_MS &&
    (nudgedAt === null || nudgedAt < repliedAt)
  ) {
    return 'idle_nudge';
  }
  return 'wait';
}
