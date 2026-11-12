// Vault key naming for per-mailbox Nylas grants (#2475).
// The API key stays shared at channel.email.nylas_api_key; only the grant is per mailbox.

export function principalMailboxGrantSecretName(id: string): string {
  return `principal.mailbox.${id}.nylas_grant_id`;
}

export const PRINCIPAL_MAILBOX_GRANT_KEY_RE = /^principal\.mailbox\.[a-z][a-z0-9-]{0,31}\.nylas_grant_id$/;

export function isPrincipalMailboxGrantKey(name: string): boolean {
  return PRINCIPAL_MAILBOX_GRANT_KEY_RE.test(name);
}
