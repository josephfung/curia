// The needs_mailbox answer for a new event or hold on the principal's calendar (#2475, D5).
//
// With several principal mailboxes, the account a meeting goes out from is a choice, never a
// default: a new event or hold on one of the principal's calendars without `mailbox` creates
// nothing and answers needs_mailbox, with the live mailboxes and per-account evidence for the
// attendees. It is a failure (R102, as R88 made the RSVP's): the runtime records a successful
// calendar-create-event with attendees as a sent invite and the activity feed as a booking.
//
// The execution layer runs the same check before its autonomy gates (calendarWritePregate), so a
// call that is going to answer needs_mailbox never raises an approval first: otherwise the
// principal approves the call, its replay answers needs_mailbox, and the retry with `mailbox`
// raises a second approval for the same booking. The handlers keep their own check for direct
// calls and for replays of a payload approved before the check existed.
//
// Logs carry mailbox ids, counts and error classes only, never grant ids, addresses or calendar ids.

import type { Logger } from '../../logger.js';
import type { ToolResult } from '../../skills/types.js';
import type { CountsOnlyEvidence } from '../../principal-mailboxes/evidence.js';
import { grantSafeErrorFields } from '../../principal-mailboxes/error-fields.js';
import type { PrincipalMailboxView } from '../../principal-mailboxes/service.js';
import type { CalendarRouter } from './calendar-router.js';

/** How long a calendar write waits for attendee evidence before leaving it out (R85). */
export const EVIDENCE_TIMEOUT_MS = 5_000;

/** The tools whose new events need a stated mailbox once several are live (D5). */
const MAILBOX_CHOICE_WRITES: Record<string, 'created' | 'placed'> = {
  'calendar-create-event': 'created',
  'calendar-create-hold': 'placed',
};

/** One line of evidence per account, for an error text: counts and domain match only (R81). */
export function summarizeEvidence(evidence: CountsOnlyEvidence[]): string {
  return evidence
    .map((e) => e.error !== undefined
      ? `${e.mailbox_label}: unreadable (${e.error})`
      : `${e.mailbox_label}: sent ${e.sent_count}, received ${e.received_count}${e.domain_match ? ', same domain' : ''}`)
    .join('; ');
}

/** Attendee addresses for mailbox evidence: lower-cased, de-duplicated, the principal's own mailboxes left out. */
export function evidenceRecipients(addresses: string[], live: PrincipalMailboxView[]): string[] {
  const own = new Set(live.map((m) => m.address.trim().toLowerCase()).filter((a) => a !== ''));
  return [...new Set(addresses.map((a) => a.trim().toLowerCase()))].filter((a) => a.includes('@') && !own.has(a));
}

/**
 * Per-mailbox evidence for these attendees, or null when it could not be computed in time.
 * Never throws: evidence informs the choice of account, it never blocks or fails a write.
 */
export async function evidenceWithin(
  router: Pick<CalendarRouter, 'evidence'>,
  log: Pick<Logger, 'warn'>,
  tool: string,
  recipients: string[],
  timeoutMs = EVIDENCE_TIMEOUT_MS,
): Promise<CountsOnlyEvidence[] | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // A short deadline (R85): evidence runs live mail searches.
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(`mailbox evidence timed out after ${timeoutMs}ms`);
        err.name = 'TimeoutError';
        reject(err);
      }, timeoutMs);
    });
    return await Promise.race([router.evidence(recipients), deadline]);
  } catch (err) {
    log.warn({ tool, ...grantSafeErrorFields(err) }, `${tool}: mailbox evidence failed or timed out; left out`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The needs_mailbox failure: nothing was created, the live mailboxes to choose from and, when
 * there are attendees, a line of evidence per account.
 */
export async function needsMailboxFailure(
  router: Pick<CalendarRouter, 'evidence'>,
  log: Pick<Logger, 'warn'>,
  tool: string,
  mailboxes: Array<{ id: string; label: string }>,
  recipients: string[],
  what: 'created' | 'placed' = 'created',
): Promise<ToolResult> {
  let evidenceLine = '';
  if (recipients.length > 0) {
    const evidence = await evidenceWithin(router, log, tool, recipients);
    evidenceLine = evidence
      ? ` Evidence for the attendees: ${summarizeEvidence(evidence)}.`
      : ' Evidence for the attendees is unavailable.';
  }
  const choices = mailboxes.map((m) => `${m.id} (${m.label})`).join(', ');
  return {
    success: false,
    error:
      `needs_mailbox: nothing was ${what}. Several accounts are connected; call again with mailbox set to the ` +
      `account this belongs to, one of: ${choices}.${evidenceLine}`,
  };
}

/** The attendee addresses of a create-event input (strings only; the handler validates the rest). */
function attendeeAddresses(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((a) => (typeof a === 'object' && a !== null ? (a as Record<string, unknown>)['email'] : undefined))
    .filter((e): e is string => typeof e === 'string');
}

/**
 * The execution layer's pre-gate (BR-m5): for a new event or hold on the principal's calendar
 * with several mailboxes live and no `mailbox`, the needs_mailbox failure, before any autonomy
 * gate can ask the principal to approve a call that would create nothing. Null otherwise, and
 * null when the check itself fails (logged): the handler checks again.
 */
export async function calendarWritePregate(
  router: Pick<CalendarRouter, 'liveMailboxes' | 'isPrincipalCalendar' | 'evidence'>,
  log: Pick<Logger, 'warn' | 'info'>,
  toolName: string,
  input: Record<string, unknown>,
): Promise<ToolResult | null> {
  const what = MAILBOX_CHOICE_WRITES[toolName];
  // null and '' count as absent here (N2): otherwise such a call is approval-gated first and the
  // handler then answers needs_mailbox (null) or an unknown mailbox (''), asking twice.
  const stated = input['mailbox'];
  if (what === undefined || (stated !== undefined && stated !== null && stated !== '')) return null;
  const calendarId = input['calendarId'];
  if (typeof calendarId !== 'string' || calendarId === '') return null;
  try {
    const live = await router.liveMailboxes();
    if (live.length < 2 || !(await router.isPrincipalCalendar(calendarId))) return null;
    const addresses = toolName === 'calendar-create-event'
      ? attendeeAddresses(input['attendees'])
      : typeof input['contactDomain'] === 'string' ? [input['contactDomain']] : [];
    log.info({ tool: toolName, code: 'needs_mailbox', liveCount: live.length }, `${toolName}: needs a mailbox; answered before the autonomy gates`);
    return await needsMailboxFailure(router, log, toolName, live.map(({ id, label }) => ({ id, label })), evidenceRecipients(addresses, live), what);
  } catch (err) {
    log.warn({ tool: toolName, ...grantSafeErrorFields(err) }, `${toolName}: mailbox pre-gate check failed; the handler checks again`);
    return null;
  }
}

/**
 * The input an approval stores for a calendar call (#2475): a call on one of the principal's
 * calendars with no `mailbox`, made while one mailbox is live, gets that mailbox bound in. The
 * replay then goes through the account the principal approved: a mailbox removed since is an
 * error, never a reroute through whichever account is live by then. Anything else (another tool,
 * a stated mailbox, several mailboxes) is stored as it was. A lookup failure throws
 * ApprovalMailboxUnboundError: no approval is created rather than one that could replay elsewhere.
 */
export async function bindApprovalMailbox(
  router: Pick<CalendarRouter, 'liveMailboxes' | 'isPrincipalCalendar'>,
  log: Pick<Logger, 'warn'>,
  toolName: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!toolName.startsWith('calendar-')) return input;
  const stated = input['mailbox'];
  if (stated !== undefined && stated !== null && stated !== '') return input;
  const calendarId = input['calendarId'];
  if (typeof calendarId !== 'string' || calendarId === '') return input;
  try {
    const live = await router.liveMailboxes();
    if (live.length !== 1 || !(await router.isPrincipalCalendar(calendarId))) return input;
    return { ...input, mailbox: live[0]!.id };
  } catch (err) {
    // Fail closed: an approval stored unbound could replay through whichever mailbox is live by
    // then. The caller creates no approval row; the call stays blocked and can be asked again.
    log.warn({ tool: toolName, ...grantSafeErrorFields(err) }, `${toolName}: could not bind the mailbox to the approval; no approval created`);
    throw new ApprovalMailboxUnboundError(toolName);
  }
}

/** The mailbox could not be bound to a calendar approval, so none is created (fail closed). */
export class ApprovalMailboxUnboundError extends Error {
  constructor(toolName: string) {
    super(`${toolName}: the account for this calendar call could not be confirmed, so no approval was created`);
    this.name = 'ApprovalMailboxUnboundError';
  }
}
