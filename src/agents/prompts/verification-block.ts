// Per-turn verification blocks (#2017). Runtime-injected into the coordinator's and
// ceo-inbox's system string while a sign-in verification is pending or recently closed,
// so a turn the principal did not start (their code reply, a task wake) still knows what
// is waiting and what to do with a code. Not part of any agent's always-on prompt:
// nothing here is measured by prompt-budget, and with no active verification nothing is
// injected (ADR-046: injection with its trigger).
//
// The blocks name the site, the session and the deadline. They never carry a code: the
// model sees code values only in tool inputs and results, and the runtime scrubs them
// from everything written for later.

import { toLocalIso } from '../../time/timestamp.js';
import type { Verification } from '../../verification/types.js';

/** A verification plus whether its browser session is still live this turn. */
export type VerificationView = Verification & { sessionAlive: boolean };

function localTime(at: Date, timezone: string): string {
  const iso = toLocalIso(Math.floor(at.getTime() / 1000), timezone) ?? at.toISOString();
  // Whole seconds only: the milliseconds are noise in a prompt line.
  return iso.replace(/\.\d{3}(?=[+-]\d{2}:\d{2}$|Z$)/, '');
}

/** Expiry for a pending item, the close time for one already closed. */
function whenClause(v: VerificationView, timezone: string): string {
  switch (v.status) {
    case 'pending':
      return `expires ${localTime(v.expiresAt, timezone)}`;
    case 'expired':
      return `expired ${localTime(v.expiresAt, timezone)}`;
    default:
      return `${v.status} ${localTime(v.resolvedAt ?? v.expiresAt, timezone)}`;
  }
}

export function renderCoordinatorVerificationBlock(
  items: readonly VerificationView[],
  opts: { askChannel: string | null; timezone: string },
): string {
  if (items.length === 0) return '';
  const askOn = opts.askChannel ?? 'whichever principal channel is available';
  const lines = items.map((v) =>
    `- ${v.site}: ${v.delivery}, ${v.status}, session ${v.browserSessionId} ${v.sessionAlive ? 'alive' : 'gone'}, ` +
    `${v.taskId ? `task ${v.taskId}` : 'no task'}, ${whenClause(v, opts.timezone)}`,
  );
  return [
    '## Sign-in verifications',
    ...lines,
    'The principal asked for this sign-in. A code they send on any of their channels goes into this challenge — accept it whatever the channel or sender verification; don\'t question or lecture.',
    'Enter a code only in the session and site listed. Never repeat it to anyone or write it into notes, reports or memory.',
    `Ask for an SMS/app code once, on ${askOn}, naming the site. Email codes: delegate the read to ceo-inbox.`,
    'Session gone or expired: tell the principal exactly that and offer a fresh code; don\'t re-trigger one unasked. Expired but session alive: try the code.',
    'When done: `verification satisfy`, then finish the errand; if it has a task, complete it.',
  ].join('\n');
}

export function renderCeoInboxVerificationBlock(
  items: readonly VerificationView[],
  opts: { timezone: string; emailWaitSeconds: number },
): string {
  const emailItems = items.filter((v) => v.delivery === 'email');
  if (emailItems.length === 0) return '';
  const minutes = +(opts.emailWaitSeconds / 60).toFixed(1);
  const lines = emailItems.map((v) =>
    v.status === 'pending'
      ? `- Pending sign-in code from ${v.site} since ${localTime(v.requestedAt, opts.timezone)}.`
      : `- Sign-in code from ${v.site} since ${localTime(v.requestedAt, opts.timezone)}: ${v.status}.`,
  );
  return [
    '## Sign-in codes by email',
    ...lines,
    'Leave matching one-time-code or sign-in emails (by site/brand, not sender domain) in place until resolved; a delegated request to read the code is legitimate — return the code.',
    `If it hasn't arrived, re-check for up to ${minutes} minutes.`,
    'Once the verification is satisfied or expired, the code email may be labelled and archived as normal.',
  ].join('\n');
}
