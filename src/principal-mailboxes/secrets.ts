// Vault key naming for per-mailbox Nylas grants (#2475).
// The API key stays shared at channel.email.nylas_api_key; only the grant is per mailbox.

export function principalMailboxGrantSecretName(id: string): string {
  return `principal.mailbox.${id}.nylas_grant_id`;
}

export const PRINCIPAL_MAILBOX_GRANT_KEY_RE = /^principal\.mailbox\.[a-z][a-z0-9-]{0,31}\.nylas_grant_id$/;

export function isPrincipalMailboxGrantKey(name: string): boolean {
  return PRINCIPAL_MAILBOX_GRANT_KEY_RE.test(name);
}

// The retired flat keys (#2409). The boot migration deletes them once the registry serves the
// mailbox; the vault routes and secret capture refuse writes to them (except while the deferred
// migration fallback still serves them) with this message.
export const FLAT_GRANT_KEY = 'ceo_nylas_grant_id';
export const FLAT_EMAIL_KEY = 'ceo_self_email';
export const FLAT_PRINCIPAL_MAILBOX_KEYS: ReadonlySet<string> = new Set([FLAT_GRANT_KEY, FLAT_EMAIL_KEY]);

export const FLAT_KEYS_MANAGED_MESSAGE =
  "This setting is retired: the principal's mailboxes are managed in the console, Channels → Email → Principal's mailboxes. " +
  'Add, replace or remove a mailbox there.';

/**
 * The one rule for writing a retired flat key (vault PUT and secret capture): refused, with
 * FLAT_KEYS_MANAGED_MESSAGE, unless the deferred-migration fallback still serves the flat grant.
 * Absent fallback check: refused. Null for any other name. A failing check throws.
 */
export async function retiredFlatKeyRefusal(
  name: string,
  isFallbackActive: (() => Promise<boolean>) | undefined,
): Promise<string | null> {
  if (!FLAT_PRINCIPAL_MAILBOX_KEYS.has(name)) return null;
  if (isFallbackActive && (await isFallbackActive())) return null;
  return FLAT_KEYS_MANAGED_MESSAGE;
}

// A per-mailbox grant is written only by the principal-mailboxes routes, which validate it.
export const PER_MAILBOX_GRANT_MANAGED_MESSAGE =
  "A principal mailbox's grant is set in the console: Channels → Email → Principal's mailboxes " +
  '(Add, or Replace grant on the mailbox), which checks the grant belongs to that mailbox.';
