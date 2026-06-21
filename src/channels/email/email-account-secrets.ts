// Single source of truth for the per-account email-grant vault-key convention.
// The grant for account <name> is stored encrypted at channel.email.<name>.nylas_grant_id.
// Imported by the resolver, the backfill, the console route, and the vault scope-guard so
// the convention is defined exactly once.

/**
 * Account names are embedded in the dotted vault key channel.email.<name>.nylas_grant_id,
 * so they must not contain dots (which would make the key ambiguous) and are kept to a
 * conservative lowercase slug charset.
 */
export const EMAIL_ACCOUNT_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

export function isValidEmailAccountName(name: string): boolean {
  return EMAIL_ACCOUNT_NAME_RE.test(name);
}

export function emailAccountGrantSecretName(name: string): string {
  return `channel.email.${name}.nylas_grant_id`;
}

const PER_ACCOUNT_GRANT_KEY_RE = /^channel\.email\.[^.]+\.nylas_grant_id$/;

export function isPerAccountEmailGrantKey(name: string): boolean {
  return PER_ACCOUNT_GRANT_KEY_RE.test(name);
}
