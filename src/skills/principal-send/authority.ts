// authority.ts — who may send from the principal's own mailbox right now (#2474, design D6).

import { isLivePrincipalTurn } from '../../contacts/principal.js';
import type { TaskOriginator } from '../../contacts/types.js';

export interface SendAuthorityInput {
  liveTurn?: boolean;
  taskMetadata?: Record<string, unknown>;
  humanApproved?: boolean;
}

/**
 * Live principal turn, not an approval replay, and an email-originated turn only if its sender
 * was verified (TaskOriginator.authenticated). Voice/Signal/Slack/web/CLI count as today; SMS
 * spoofing is an accepted risk.
 *
 * Fail-closed: anything not proven (no metadata, no flag, an unverified email sender) is not
 * principal-directed, so the send is treated as autonomous and PR 1 refuses it.
 */
export function isPrincipalDirectedMailboxSend(a: SendAuthorityInput): boolean {
  // An approval replay is never principal-directed here (design D5): the queue is not a live turn.
  if (a.humanApproved === true) return false;
  if (!isLivePrincipalTurn(a.liveTurn, a.taskMetadata)) return false;
  const originator = a.taskMetadata?.['originator'] as TaskOriginator | undefined;
  // A forged From can start an email "principal" turn; only an adapter-verified sender counts.
  if (originator?.channel === 'email' && originator.authenticated !== true) return false;
  return true;
}
