import { describe, it, expect, vi } from 'vitest';
import { resolveEmailAccounts } from './resolve-email-accounts.js';
import type { EmailAccountsRepo, EmailAccountRow } from './email-accounts-repo.js';
import { channelCredentialStatus } from '../credential-resolver.js';
import { getChannelDescriptor } from '../catalog.js';

/**
 * Gate/adapter agreement (#1101 Task 7).
 *
 * Replaces the AC1 coverage deleted from apply-channel-vault-secrets.test.ts when the legacy
 * YAML resolver (resolveChannelAccounts) was removed. Under the per-account table+vault model,
 * the channel-registry credential gate (channelCredentialStatus) and the email adapter
 * (resolveEmailAccounts) must AGREE on whether email is on:
 *
 *   - resolveEmailAccounts yielding ≥1 account is what makes the adapter construct, AND it is
 *     also what makes index.ts mark nylas_grant_id/nylas_self_email config-resolved for the gate.
 *   - With an empty table, the adapter yields nothing AND (no vault api key, no config keys) the
 *     gate reports email unresolvable. Both sides say "off".
 *
 * This test builds `configResolvedKeys` the SAME way index.ts does when
 * resolvedEmailAccounts.length > 0: { nylas_grant_id, nylas_self_email, nylas_api_key }
 * (nylas_api_key only because config.nylasApiKey is present in that scenario).
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
    // channel.email.* lookups. The shared api key is set in the vault; the per-account grant is
    // the only nylas_grant_id the gate sees (it falls back to configResolvedKeys for that key).
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

    // Gate side: configResolvedKeys built the SAME way index.ts builds it when
    // resolvedEmailAccounts.length > 0 (grant_id + self_email always; api_key because present).
    const configResolvedKeys = new Set<string>(['nylas_grant_id', 'nylas_self_email', 'nylas_api_key']);
    const status = await channelCredentialStatus({ secrets, env: {}, configResolvedKeys }, emailDescriptor);
    expect(status.requiredResolvable).toBe(true);
  });

  it('negative: empty table, no vault api key, no config keys — adapter yields none AND gate reports unresolvable', async () => {
    const repo = fakeRepo([]);
    const secrets = { get: async (): Promise<string | null> => null };

    // Adapter side: no accounts, so no adapter constructs.
    const resolved = await resolveEmailAccounts(repo, secrets, logger);
    expect(resolved).toEqual([]);

    // Gate side: index.ts builds configResolvedKeys only when resolvedEmailAccounts.length > 0,
    // so with an empty result it passes an empty set. With nothing in the vault either, the gate
    // must report email unresolvable — agreeing with the adapter that email is off.
    const configResolvedKeys = new Set<string>();
    const status = await channelCredentialStatus({ secrets, env: {}, configResolvedKeys }, emailDescriptor);
    expect(status.requiredResolvable).toBe(false);
  });
});
