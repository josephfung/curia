// nylas-message-id.ts — shape helpers for email-reply's reply_to_message_id.
//
// Nylas v3 message IDs are provider-native (Google hex, Microsoft base64,
// IMAP UID) and never match RFC UUID form. outbound_context entry ids are
// UUIDs rendered in [ACTIVE OUTBOUND CONTEXT]. Rejecting the UUID shape
// catches the #1817 confusion before any Nylas call (Gate C or handler).

import { isUuid } from '../../util/uuid.js';

/**
 * True when value is shaped like an outbound_context entry_id, not a Nylas
 * message id. Nylas message IDs are provider-native and never UUID-shaped, so
 * the shared (shape-only) matcher is sufficient to tell the two apart.
 */
export function looksLikeOutboundContextEntryId(value: string): boolean {
  return isUuid(value.trim());
}

/** Actionable error when reply_to_message_id is an outbound_context entry UUID. */
export function replyToMessageIdLooksLikeEntryIdError(): string {
  return (
    'reply_to_message_id looks like an outbound_context entry_id (UUID), not a Nylas message ID. ' +
    'Pass the Nylas Message ID from the inbound email preamble (e.g. "Message ID: …"), not the ' +
    'entry_id from [ACTIVE OUTBOUND CONTEXT]. Use that entry_id only with context-bridge-release.'
  );
}
