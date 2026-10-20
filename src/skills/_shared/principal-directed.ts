// principal-directed.ts — is this send one the principal directed? (#1870)
//
// Send skills pass the result to OutboundGateway.send() as `principalDirected`, which
// lifts the Stage 2.5 disclosure gate (and only that gate). Without it the gate would
// block a disclosure the principal explicitly asked for, e.g. telling a `known`
// contact a third party's surname.
//
// The relay-budget helpers (#1320) live here too: send skills pass the task's originator
// beside `principalDirected` and report a deferral the same way, and the digest tools refuse
// a task an outside contact started.

import { isLivePrincipalTurn, isOutsiderOriginated } from '../../contacts/principal.js';
import type { ToolContext } from '../types.js';
import type { TaskOriginator } from '../../contacts/types.js';

/**
 * True when the principal is directing this send right now (a live principal turn), or
 * approved this exact action (`humanApproved`, set only by approve-action and reaction
 * approvals).
 *
 * Principal *lineage* is deliberately not enough. A heartbeat-woken or scheduled
 * principal-lineage task can keep principal standing through the bypass ladder, but it
 * composes its message autonomously, long after the instruction. Lineage alone would let
 * that content skip the disclosure gate. This is the same distinction the `elevated`
 * gate draws: a live turn, not lineage. See isLivePrincipalTurn() and ADR-017.
 */
export function isPrincipalDirectedSend(
  ctx: Pick<ToolContext, 'taskMetadata' | 'humanApproved' | 'liveTurn'>,
): boolean {
  return ctx.humanApproved === true || isLivePrincipalTurn(ctx.liveTurn, ctx.taskMetadata);
}

/**
 * The task's originator as a send() option, for the relay budget (#1320): the gateway counts a
 * relay to the principal against the outside contact who started the work. Every send skill
 * reads it here so they all read it the same way. Empty when the task has none.
 */
export function originatorOption(ctx: Pick<ToolContext, 'taskMetadata'>): { originator?: TaskOriginator } {
  const raw: unknown = (ctx.taskMetadata as Record<string, unknown> | undefined)?.['originator'];
  // The budget is keyed by contactId: without a real one, every such send would share one
  // bucket and throttle unrelated contacts. The gateway then warns that the send can't be counted.
  if (typeof raw !== 'object' || raw === null) return {};
  const contactId = (raw as Record<string, unknown>)['contactId'];
  if (typeof contactId !== 'string' || contactId.trim() === '') return {};
  // Shape checked above (stamped by stamp-originator.ts); cast through unknown per repo policy.
  return { originator: raw as unknown as TaskOriginator };
}

/** What a send skill tells the agent when the relay budget held its message (#1320). */
export const RELAY_DEFERRED_NOTE =
  'Not sent now: this contact has reached the limit on messages to the principal for this hour, ' +
  'so the message is queued in the principal\'s digest. Do not re-send it on another channel.';

/** Result-data fields for a send the relay budget held; empty for a delivered send. */
export function relayDeferredData(result: { deferredToDigest?: boolean }): Record<string, unknown> {
  return result.deferredToDigest ? { deferred_to_digest: true, note: RELAY_DEFERRED_NOTE } : {};
}

/**
 * Why a digest tool refused (#1320): the task was started by an outside contact. The
 * principal's digest holds other contacts' held messages and Curia's notes for the principal,
 * so a contact who writes in must not be able to read it, or acknowledge it away.
 */
export const DIGEST_OUTSIDER_REFUSAL =
  'The principal\'s digest is only for the principal and Curia\'s own scheduled work, not for a task an outside contact started. Nothing was read or changed.';

/** The refusal result when an outside contact started this task; null when the tool may run. */
export function refuseOutsiderDigestAccess(ctx: Pick<ToolContext, 'taskMetadata'>): { success: false; error: string } | null {
  return isOutsiderOriginated(ctx.taskMetadata as Record<string, unknown> | undefined)
    ? { success: false, error: DIGEST_OUTSIDER_REFUSAL }
    : null;
}
