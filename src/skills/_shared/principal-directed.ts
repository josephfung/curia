// principal-directed.ts — is this send one the principal directed? (#1870)
//
// Send skills pass the result to OutboundGateway.send() as `principalDirected`, which
// lifts the Stage 2.5 disclosure gate (and only that gate). Without it the gate would
// block a disclosure the principal explicitly asked for, e.g. telling a `known`
// contact a third party's surname.

import { isPrincipalOriginated } from '../../contacts/principal.js';
import type { ToolContext } from '../types.js';

/**
 * True when the task's effective standing is principal, or the principal approved this
 * exact action (`humanApproved`, set only by approve-action and reaction approvals).
 *
 * `ctx.taskMetadata` is the execution layer's EFFECTIVE metadata, so a woken
 * principal-lineage task counts only while the bypass ladder still grants it principal
 * standing. That is the same notion Gate C's principal bypass reads.
 */
export function isPrincipalDirectedSend(
  ctx: Pick<ToolContext, 'taskMetadata' | 'humanApproved'>,
): boolean {
  return ctx.humanApproved === true || isPrincipalOriginated(ctx.taskMetadata);
}
