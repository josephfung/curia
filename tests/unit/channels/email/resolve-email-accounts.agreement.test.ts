import { describe, it, expect, vi } from 'vitest';
import { resolveEmailAccounts } from '../../../../src/channels/email/resolve-email-accounts.js';
import type { EmailAccountsRepo, EmailAccountRow } from '../../../../src/channels/email/email-accounts-repo.js';
import { channelCredentialStatus } from '../../../../src/channels/credential-resolver.js';
import { getChannelDescriptor } from '../../../../src/channels/catalog.js';

/**
 * Gate/adapter agreement (#1101 Task 7).
 *
 * Replaces the AC1 coverage deleted from apply-channel-vault-secrets.test.ts when the legacy
 * YAML resolver (resolveChannelAccounts) was removed. Under the per-account table+vault model,
 * the channel-registry credential gate (channelCredentialStatus) and the email adapter
 * (resolveEmailAccounts) must AGREE on whether email is on:
 *
 *   - resolveEmailAccounts yielding ≥1 account is what makes the adapter construct; the gate
 *     needs the shared channel.email.nylas_api_key, which index.ts additionally pairs with a
 *     live resolveEmailAccounts check.
 *   - With an empty table, the adapter yields nothing AND (no vault api key) the gate reports
 *     email unresolvable. Both sides say "off".
 *
 * index.ts passes no configResolvedKeys: since #2522 the API key resolves only from
 * channel.email.nylas_api_key or NYLAS_API_KEY, both of which the gate reads itself.
 */

const emailDescriptor = getChannelDescriptor('email')!;
const logger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } as never;

function row(over: Partial<EmailAccountRow>): EmailAccountRow {
  return {
    name: 'curia', selfEmail: 'curia@example.com', provider: 'nylas', enabled: true,
    createdAt: new Date(0), createdBy: 'web-console', updatedAt: new Date(0), ...over,
  };
}

function fakeRepo(rows: EmailAccountRow[]): EmailAccountsRepo {
  return { list: async () => rows } as unknown as EmailAccountsRepo;
}

describe('email gate/adapter agreement (per-account table+vault model)', () => {
  it('positive: one enabled account + shared api key — adapter constructs AND gate reports resolvable', async () => {
    const repo = fakeRepo([row({ name: 'curia', selfEmail: 'c@x.com' })]);
    // Vault answers both the resolver's per-account grant lookup and the gate's shared
    // channel.email.* lookups.
    const secrets = {
      get: async (n: string): Promise<string | null> => {
        if (n === 'channel.email.curia.nylas_grant_id') return 'grant-c';
        if (n === 'channel.email.nylas_api_key') return 'api-key';
        return null;
      },
    };

    // Adapter side: resolver yields exactly the one account, so the adapter WOULD construct.
    const resolved = await resolveEmailAccounts(repo, secrets, logger);
    expect(resolved).toEqual([{ name: 'curia', nylasGrantId: 'grant-c', selfEmail: 'c@x.com' }]);

    // Gate side: called the way index.ts calls it, with no config-resolved keys.
    const status = await channelCredentialStatus({ secrets, env: {} }, emailDescriptor);
    expect(status.requiredResolvable).toBe(true);
  });

  it('negative: empty table, no vault api key — adapter yields none AND gate reports unresolvable', async () => {
    const repo = fakeRepo([]);
    const secrets = { get: async (): Promise<string | null> => null };

    // Adapter side: no accounts, so no adapter constructs.
    const resolved = await resolveEmailAccounts(repo, secrets, logger);
    expect(resolved).toEqual([]);

    // Gate side: with nothing in the vault, the gate must report email unresolvable —
    // agreeing with the adapter that email is off.
    const status = await channelCredentialStatus({ secrets, env: {} }, emailDescriptor);
    expect(status.requiredResolvable).toBe(false);
  });
});
