// Named mailbox from an email skill's `account` input.
//
// Blank or non-string means the primary account (undefined), matching
// email-get / email-draft-save. Gate C's email-reply resolver and the
// email-reply handler must both use this function: the per-invoke
// getEmailMessage cache key is `${accountId ?? ''}\0${messageId}`, so a
// second parser would miss the cache and reopen the TOCTOU window (#1832).

/**
 * Account id the skill input names, or undefined for the primary mailbox.
 */
export function emailAccountIdFromInput(input: Record<string, unknown>): string | undefined {
  const account = input['account'];
  if (typeof account !== 'string') return undefined;
  const trimmed = account.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
