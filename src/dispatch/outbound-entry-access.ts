// outbound-entry-access.ts — which outbound-context entries a turn may act on (#2261).
//
// A principal, system or agent turn sees every active entry and may act on any of them.
// A turn someone else started sees only the entries sent to that person (the dispatcher's
// recipient-matched block), so the tools that take an entry_id (context-bridge-release,
// delegate's outbound_entry_id) refuse any other id on such a turn. Code, not prompt: a
// third party's message must not be able to steer the coordinator into closing or
// answering someone else's exchange.

import { isOutsiderOriginated } from '../contacts/principal.js';

/**
 * The contact ID of the outside sender a task was started by, or null when the principal,
 * the system or an agent started it. An outsider originator without a usable contact ID
 * (an unresolved sender) returns an empty string, which matches no entry.
 */
export function outsiderOriginatorContactId(taskMetadata: unknown): string | null {
  const metadata = taskMetadata as Record<string, unknown> | undefined;
  if (!isOutsiderOriginated(metadata)) return null;
  const originator = metadata?.['originator'];
  if (typeof originator !== 'object' || originator === null) return '';
  const contactId = (originator as Record<string, unknown>)['contactId'];
  return typeof contactId === 'string' ? contactId : '';
}
