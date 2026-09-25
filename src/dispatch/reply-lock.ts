// Which successful sends count as "the principal already got the message" (#847, #1860).
//
// Email skills return `{ to }`. Signal, SMS, and Slack return `{ delivered_to }`.
// A delegated specialist runs in its own conversation id; `originConversationId`
// on tool.result is the principal conversation the coordinator is replying in.

export const REPLY_LOCK_SKILLS = new Set([
  'email-reply',
  'email-send',
  'signal-send',
  'sms-send',
  'slack-send',
]);

/**
 * Recipients of a successful human-facing send, lowercased.
 * Call only for {@link REPLY_LOCK_SKILLS}. `null` when the success payload
 * omitted the recipient field (caller logs and fails open).
 */
export function replyLockRecipients(toolName: string, data: unknown): string[] | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  if (toolName === 'email-reply' || toolName === 'email-send') {
    const toRaw = typeof record['to'] === 'string' ? record['to'] : undefined;
    if (toRaw === undefined) return null;
    const recipients = toRaw.split(',').map((part) => part.trim().toLowerCase()).filter((part) => part.length > 0);
    return recipients.length > 0 ? recipients : null;
  }
  if (typeof record['delivered_to'] !== 'string') return null;
  const delivered = record['delivered_to'].trim().toLowerCase();
  if (delivered.length === 0) return null;
  return [delivered];
}

/** Email addresses only — correspondence elevation resolves channel `email`. */
export function replyLockEmailRecipients(toolName: string, recipients: readonly string[]): string[] {
  if (toolName !== 'email-reply' && toolName !== 'email-send') return [];
  return [...recipients];
}

/**
 * True when a send reached the inbound party.
 *
 * `senderId` covers the same channel. `verifiedIdentifiers` covers the
 * contact's other verified channels, so a Signal send can lock an email task
 * for the same person. An identifier that is neither does not lock.
 */
export function replyLockRecipientMatches(
  senderId: string,
  recipients: readonly string[],
  verifiedIdentifiers: readonly string[] = [],
): boolean {
  const sender = senderId.trim().toLowerCase();
  if (sender.length > 0 && recipients.includes(sender)) return true;
  if (verifiedIdentifiers.length === 0) return false;
  const verified = new Set(
    verifiedIdentifiers.map((id) => id.trim().toLowerCase()).filter((id) => id.length > 0),
  );
  return recipients.some((recipient) => verified.has(recipient));
}

/**
 * A send locks the routing entry for the conversation it happened in, and for
 * the originating principal conversation when a specialist sent it.
 */
export function replyLockConversationMatch(
  routingConversationId: string,
  eventConversationId: string,
  originConversationId: string | undefined,
): boolean {
  if (routingConversationId === eventConversationId) return true;
  return originConversationId !== undefined && originConversationId.length > 0
    && routingConversationId === originConversationId;
}
