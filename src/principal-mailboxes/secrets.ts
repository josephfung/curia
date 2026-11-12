// Vault key naming for per-mailbox Nylas grants (#2475).
// The API key stays shared at channel.email.nylas_api_key; only the grant is per mailbox.

export function principalMailboxGrantSecretName(id: string): string {
  return `principal.mailbox.${id}.nylas_grant_id`;
}

export const PRINCIPAL_MAILBOX_GRANT_KEY_RE = /^principal\.mailbox\.[a-z][a-z0-9-]{0,31}\.nylas_grant_id$/;

export function isPrincipalMailboxGrantKey(name: string): boolean {
  return PRINCIPAL_MAILBOX_GRANT_KEY_RE.test(name);
}

// The flat keys (#2409) ceo-inbox still reads. Once the registry has rows the console
// mirrors the default mailbox into them (R28), so the vault routes and secret capture refuse
// direct writes with this message (R33).
export const FLAT_PRINCIPAL_MAILBOX_KEYS: ReadonlySet<string> = new Set(['ceo_nylas_grant_id', 'ceo_self_email']);

export const FLAT_KEYS_MANAGED_MESSAGE =
  "The principal's mailbox is managed in the console: Channels → Email → Principal's mailboxes. " +
  'Change, replace or remove the mailbox there.';

// A per-mailbox grant is written only by the principal-mailboxes routes, which validate it.
export const PER_MAILBOX_GRANT_MANAGED_MESSAGE =
  "A principal mailbox's grant is set in the console: Channels → Email → Principal's mailboxes " +
  '(Add, or Replace grant on the mailbox), which checks the grant belongs to that mailbox.';
