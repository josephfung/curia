// Shared parsers for the email-reply fetch cache key.
//
// The per-invoke cache key is `${accountId ?? ''}\0${messageId}`. Gate C and
// the email-reply handler must both use these functions: a second parser
// (one side trims, the other does not) misses the cache and reopens the
// TOCTOU window #1815 closed (#1832).

/**
 * Account id the skill input names, or undefined for the primary mailbox.
 * Blank or non-string is the primary mailbox, matching email-get / email-draft-save.
 */
export function emailAccountIdFromInput(input: Record<string, unknown>): string | undefined {
  const account = input['account'];
  if (typeof account !== 'string') return undefined;
  const trimmed = account.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Nylas message id from `reply_to_message_id`, trimmed.
 * Empty or non-string is undefined.
 */
export function replyToMessageIdFromInput(input: Record<string, unknown>): string | undefined {
  const raw = input['reply_to_message_id'];
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
