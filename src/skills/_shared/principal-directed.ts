// principal-directed.ts — is this send one the principal directed? (#1870)
//
// Send skills pass the result to OutboundGateway.send() as `principalDirected`, which
// lifts the Stage 2.5 disclosure gate (and only that gate). Without it the gate would
// block a disclosure the principal explicitly asked for, e.g. telling a `known`
// contact a third party's surname.

import { isLivePrincipalTurn } from '../../contacts/principal.js';
import type { ToolContext } from '../types.js';

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
