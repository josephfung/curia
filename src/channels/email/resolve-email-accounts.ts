import type { Logger } from '../../logger.js';
import type { ResolvedEmailAccount } from '../../config.js';
import type { EmailAccountsRepo } from './email-accounts-repo.js';
import { emailAccountGrantSecretName } from './email-account-secrets.js';

/**
 * Resolve the email accounts to bootstrap from the email_accounts table, reading each
 * enabled account's Nylas grant from the vault at channel.email.<name>.nylas_grant_id.
 * (#1101 — replaces the YAML channel_accounts + env path.)
 *
 * Fail-closed per account: an account whose grant is absent is skipped with a warning
 * (never booted grant-less), and the remaining accounts are unaffected. Boot does not abort.
 */
export async function resolveEmailAccounts(
  repo: EmailAccountsRepo,
  secrets: { get(name: string): Promise<string | null> },
  logger: Logger,
): Promise<ResolvedEmailAccount[]> {
  const rows = await repo.list();
  const resolved: ResolvedEmailAccount[] = [];
  for (const acct of rows) {
    if (!acct.enabled) continue;
    // Per-account isolation: a transient vault read failure for one account must skip only
    // that account (fail-closed) rather than throw and abort resolution for every account.
    let grant: string | null = null;
    try {
      grant = await secrets.get(emailAccountGrantSecretName(acct.name));
    } catch (err) {
      logger.warn(
        { err, account: acct.name },
        'Email account grant lookup failed — skipping this account',
      );
      continue;
    }
    // Trim before the truthiness check: a vault entry set to '   ' would pass !grant but
    // fail Nylas auth at bootstrap, causing a cryptic runtime error instead of a clean skip.
    const trimmedGrant = grant.trim();
    if (!trimmedGrant) {
      logger.warn(
        { account: acct.name },
        'Email account has no nylas_grant_id in the vault — skipping (re-add the grant in the console)',
      );
      continue;
    }
    resolved.push({ name: acct.name, nylasGrantId: trimmedGrant, selfEmail: acct.selfEmail });
  }
  return resolved;
}
