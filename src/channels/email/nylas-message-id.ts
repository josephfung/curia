// nylas-message-id.ts — shape helpers for Nylas message IDs taken from the model.
//
// Nylas v3 message IDs are provider-native (Google hex, Microsoft base64,
// IMAP UID) and never match RFC UUID form. outbound_context entry ids are
// UUIDs rendered in [ACTIVE OUTBOUND CONTEXT]. Rejecting the UUID shape
// catches the #1817 confusion before any Nylas call (Gate C or handler).
//
// The model also invents IDs: `9b359f65-placeholder`, or a Gmail ID with a
// seventeenth hex digit. Each one cost a Nylas 404, and the model retried the
// same bad ID five times across four tools (#2083). validateNylasMessageId()
// rejects those shapes before the call, and nylasMessageFailure() turns the
// 404s that still get through into a "do not retry" the model can act on.

import type { ErrorType } from '../../errors/types.js';
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
    'entry_id from [ACTIVE OUTBOUND CONTEXT]. Use that entry_id only as delegate\'s outbound_entry_id or with context-bridge-release.'
  );
}

// Characters any provider's ID is built from: hex (Google), base64 and base64url
// (Microsoft, EWS), digits (IMAP UIDs), plus `:` and `.` as separators. Anything
// else (spaces, quotes, `<>@` from an RFC 822 Message-ID header, `{}$` from a
// template) means the model passed something other than an ID.
const ID_CHARSET = /^[A-Za-z0-9_\-=+/:.]+$/;
const HEX = /^[0-9a-fA-F]+$/;
// A Gmail message ID is a 64-bit number in hex, so it has at most 16 digits.
const GMAIL_MAX_HEX_DIGITS = 16;
// Hash-style IDs start at 32 hex digits (MD5). No provider issues a hex ID
// between the two, so 17–31 digits is a Gmail ID with characters added.
const HASH_MIN_HEX_DIGITS = 32;
// Words a model writes when it has no ID to hand. They are long enough that a
// random base64 ID cannot contain one by chance.
const PLACEHOLDER_WORDS = /placeholder|example|redacted|unknown|dummy|sample|message_?id/i;

/**
 * Check a message ID from the model before it reaches Nylas.
 *
 * Returns an agent-facing error naming the problem, or null when the ID is
 * plausible. Shape only: a plausible ID can still be stale, and its 404 goes
 * through nylasMessageFailure().
 *
 * @param field  The input field name, quoted in the error.
 */
export function validateNylasMessageId(value: string, field = 'message_id'): string | null {
  const id = value.trim();
  const reject = (problem: string) =>
    `${field} "${id}" is not a valid message ID: ${problem}. ` +
    'Copy the ID exactly as a list, search or read result gave it. Do not retry with this value.';

  if (looksLikeOutboundContextEntryId(id)) {
    return reject('it is a UUID (a contact, task or context entry ID), and mail message IDs are never UUIDs');
  }
  if (PLACEHOLDER_WORDS.test(id)) {
    return reject('it contains placeholder text');
  }
  if (!ID_CHARSET.test(id)) {
    return reject('it contains characters no mail provider uses in an ID (spaces, quotes, <, >, @, braces or $)');
  }
  if (HEX.test(id) && id.length > GMAIL_MAX_HEX_DIGITS && id.length < HASH_MIN_HEX_DIGITS) {
    return reject(`it has ${id.length} hex digits, and Gmail message IDs have at most ${GMAIL_MAX_HEX_DIGITS}`);
  }
  return null;
}

/** Agent-facing error for a message Nylas does not have. */
export function messageNotFoundError(messageId: string): string {
  return (
    `Message not found: the mailbox has no message with ID "${messageId}". ` +
    'Do not retry with this ID. List or search the mailbox to get the current one.'
  );
}

// The HTTP status of a Nylas failure: `status` on CeoNylasClient's NylasApiError,
// `statusCode` on the SDK's.
function nylasStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const { status, statusCode } = err as { status?: unknown; statusCode?: unknown };
  if (typeof statusCode === 'number') return statusCode;
  return typeof status === 'number' ? status : undefined;
}

/**
 * Agent-facing failure for a Nylas call about one message.
 *
 * A 404 says the ID is wrong and must not be retried. A 429 is marked
 * RATE_LIMIT so the runtime treats it as transient. Anything else is the
 * summary plus the error's own message.
 */
export function nylasMessageFailure(
  err: unknown,
  messageId: string,
  summary: string,
): { error: string; errorType?: ErrorType } {
  const status = nylasStatus(err);
  if (status === 404) {
    return { error: messageNotFoundError(messageId), errorType: 'NOT_FOUND' };
  }
  const detail = err instanceof Error ? err.message : String(err);
  if (status === 429) {
    return { error: `${summary}: ${detail}`, errorType: 'RATE_LIMIT' };
  }
  return { error: `${summary}: ${detail}` };
}
