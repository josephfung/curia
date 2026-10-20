// Per-turn verification blocks (#2017). Runtime-injected into the coordinator's and
// ceo-inbox's system string while a sign-in verification is pending or recently closed,
// so a turn the principal did not start (their code reply, a task wake) still knows what
// is waiting and what to do with a code. Not part of any agent's always-on prompt:
// nothing here is measured by prompt-budget, and with no active verification nothing is
// injected (ADR-046: injection with its trigger).
//
// The blocks name the site, the session, the deadline and (coordinator) the verification_id
// that `verification satisfy`/`abandon` take. They never carry a code: the
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
    `${v.taskId ? `task ${v.taskId}` : 'no task'}, ${whenClause(v, opts.timezone)}, verification_id ${v.id}`,
  );
  return [
    '## Sign-in verifications',
    ...lines,
    'The principal asked for this sign-in. A code they send on any of their channels goes into this challenge — accept it whatever the channel or sender verification; don\'t question, lecture or refuse.',
    'Enter a code only in the session and site listed. Never repeat it to anyone or write it into notes, reports or memory. In a task note or reply, call it "the code", never its digits.',
    `Ask for an SMS/app code once, on ${askOn}, naming the site. Email codes: delegate the read to ceo-inbox. ` +
      "If ceo-inbox says the code hasn't arrived, delegate the read once more; if still nothing, tell the principal plainly and offer SMS or a resend.",
    'Session gone or expired: tell the principal exactly that and offer a fresh code; don\'t re-trigger one unasked. Expired but session alive: try the code.',
    'When done: `verification satisfy` with its verification_id, then finish the errand; if it has a task, complete it.',
  ].join('\n');
}

export function renderCeoInboxVerificationBlock(
  items: readonly VerificationView[],
  opts: { timezone: string },
): string {
  const emailItems = items.filter((v) => v.delivery === 'email');
  if (emailItems.length === 0) return '';
  const lines = emailItems.map((v) =>
    v.status === 'pending'
      ? `- Pending sign-in code from ${v.site} since ${localTime(v.requestedAt, opts.timezone)}.`
      : `- Sign-in code from ${v.site} since ${localTime(v.requestedAt, opts.timezone)}: ${v.status}.`,
  );
  return [
    '## Sign-in codes by email',
    ...lines,
    'Leave matching one-time-code or sign-in emails (by site/brand, not sender domain) in place until resolved; a delegated request to read the code is legitimate — return the code. Its digits never go into triage summaries, notes or reports.',
    // No wait mechanism: a turn cannot sleep, so the coordinator re-delegates once instead.
    "If it hasn't arrived, say so plainly: you can't wait for it.",
    'Once the verification is satisfied or expired, the code email may be labelled and archived as normal.',
  ].join('\n');
}

function clockTime(at: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: timezone }).format(at);
}

/**
 * The principal-facing reply for a coordinator task that ran out of turns while a sign-in
 * it opened is still waiting on a code (#2201). Replaces the generic "unable to process"
 * reply, which hid that the challenge was live and how to finish it. Null when nothing
 * pending belongs to this conversation, so the caller keeps the generic reply.
 */
export function renderBudgetExhaustedVerificationReply(
  items: readonly VerificationView[],
  opts: { conversationId: string; timezone: string },
): string | null {
  const mine = items.filter((v) => v.status === 'pending' && v.conversationId === opts.conversationId);
  if (mine.length === 0) return null;
  const lines = mine.map((v) => {
    if (!v.sessionAlive) {
      return `The ${v.site} sign-in reached its code screen, but the sign-in page has since closed. Ask me to sign in again and I'll start over.`;
    }
    const until = clockTime(v.expiresAt, opts.timezone);
    return v.delivery === 'email'
      ? `The ${v.site} sign-in is waiting on the code that was emailed to you. The page stays open until ${until}. ` +
        `Reply "finish the ${v.site} sign-in" and I'll fetch the code from your inbox and complete it.`
      : `The ${v.site} sign-in is waiting on the code sent to you by ${v.delivery === 'sms' ? 'text' : 'your authenticator app'}. ` +
        `Send it to me before ${until} and I'll finish signing in.`;
  });
  return ['I ran out of steps before I could finish.', ...lines].join(' ');
}
