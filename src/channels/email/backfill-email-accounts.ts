import type { Logger } from '../../logger.js';
import type { Config } from '../../config.js';
import type { EmailAccountsRepo } from './email-accounts-repo.js';
import { emailAccountGrantSecretName } from './email-account-secrets.js';

/** The account name the legacy single-account deployment is migrated to. */
const LEGACY_ACCOUNT_NAME = 'curia';

export interface BackfillDeps {
  repo: Pick<EmailAccountsRepo, 'count' | 'create'>;
  secrets: { set(name: string, value: string): Promise<void> };
  config: Pick<Config, 'nylasGrantId' | 'nylasSelfEmail'>;
  /**
   * The raw channel_accounts.email block, if any, from YAML — read ONLY to warn about
   * accounts this single-account backfill cannot migrate. Detection-only (#1101).
   */
  channelAccountsBlock: Record<string, unknown> | undefined;
  logger: Logger;
}

/**
 * One-time, idempotent migration from the legacy single-account email config to the
 * email_accounts table. Seeds the existing account (name preserved as "curia" so the poll
 * high-water mark and reply routing survive) and copies its grant to the per-account vault
 * key. Reads vault-overlaid config, never process.env.
 *
 * @TODO Remove this backfill once every deployment has run it (a release or two out, #1101).
 */
export async function backfillEmailAccounts(deps: BackfillDeps): Promise<void> {
  const { repo, secrets, config, channelAccountsBlock, logger } = deps;

  // Idempotent: once the table has any rows, the console is the source of truth.
  if ((await repo.count()) > 0) return;

  // No-silent-miss: a residual multi-account YAML block had grants that were never vaulted
  // and cannot be reconstructed here. Name the ones we cannot migrate.
  if (channelAccountsBlock) {
    const names = Object.keys(channelAccountsBlock);
    const unmigratable = names.filter(n => n !== LEGACY_ACCOUNT_NAME);
    if (unmigratable.length > 0) {
      logger.warn(
        { accounts: unmigratable },
        `channel_accounts.email had ${names.length} accounts; only the legacy single-account ` +
          `creds can be auto-migrated. Re-add these in the console: ${unmigratable.join(', ')}`,
      );
    }
  }

  const grant = config.nylasGrantId;
  const selfEmail = config.nylasSelfEmail;
  if (!grant || !selfEmail) {
    // No legacy email account configured — nothing to migrate (fresh install).
    return;
  }

  await secrets.set(emailAccountGrantSecretName(LEGACY_ACCOUNT_NAME), grant);
  await repo.create({ name: LEGACY_ACCOUNT_NAME, selfEmail });
  logger.info({ account: LEGACY_ACCOUNT_NAME }, 'Backfilled legacy email account into email_accounts');
}
