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
 * True when this inbound's sender address is authenticated by its channel, so a match on
 * the contact's verified identity means the message is from that contact (#2261). A
 * verified contact identity says the address belongs to the contact, not that this message
 * came from it. Signal and Slack identities are authenticated by the protocol. Email counts
 * only when SPF, DKIM and DMARC passed (`senderVerified`, set by the email adapter, which
 * still publishes mail that fails them). SMS and voice caller IDs are spoofable (ADR-036),
 * and any other channel is refused until it is shown to be authenticated.
 */
export function inboundSenderAuthenticated(
  channelId: string,
  metadata: Record<string, unknown> | undefined,
): boolean {
  if (channelId === 'signal' || channelId === 'slack') return true;
  if (channelId === 'email') return metadata?.['senderVerified'] === true;
  return false;
}

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
