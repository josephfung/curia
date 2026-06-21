import { describe, it, expect, vi } from 'vitest';
import { backfillEmailAccounts } from './backfill-email-accounts.js';

const baseLogger = () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() });

function deps(over: Record<string, unknown> = {}) {
  const created: unknown[] = [];
  const setCalls: Array<[string, string]> = [];
  const logger = baseLogger();
  return {
    created, setCalls, logger,
    arg: {
      repo: {
        count: async () => 0,
        create: async (input: unknown) => { created.push(input); return input; },
      },
      secrets: { set: async (n: string, v: string) => { setCalls.push([n, v]); } },
      config: { nylasGrantId: 'grant-x', nylasSelfEmail: 'curia@example.com' },
      channelAccountsBlock: undefined,
      logger,
      ...over,
    } as never,
  };
}

describe('backfillEmailAccounts', () => {
  it('seeds the curia account + per-account vault grant from config when the table is empty', async () => {
    const d = deps();
    await backfillEmailAccounts(d.arg);
    expect(d.created).toEqual([{ name: 'curia', selfEmail: 'curia@example.com' }]);
    expect(d.setCalls).toEqual([['channel.email.curia.nylas_grant_id', 'grant-x']]);
  });

  it('is a no-op when the table is already populated', async () => {
    const d = deps({ repo: { count: async () => 2, create: vi.fn() } });
    await backfillEmailAccounts(d.arg);
    expect(d.created).toEqual([]);
    expect(d.setCalls).toEqual([]);
  });

  it('does nothing (no row) when there are no legacy single-account creds', async () => {
    const d = deps({ config: { nylasGrantId: undefined, nylasSelfEmail: '' } });
    await backfillEmailAccounts(d.arg);
    expect(d.created).toEqual([]);
  });

  it('warns loudly about residual multi-account YAML it cannot migrate', async () => {
    const d = deps({ channelAccountsBlock: { curia: {}, sales: {}, eu: {} } });
    await backfillEmailAccounts(d.arg);
    // still seeds the single curia account from config
    expect(d.created).toEqual([{ name: 'curia', selfEmail: 'curia@example.com' }]);
    // warns and names the accounts beyond the auto-migrated one
    expect(d.logger.warn).toHaveBeenCalled();
    const msg = JSON.stringify(d.logger.warn.mock.calls);
    expect(msg).toContain('sales');
    expect(msg).toContain('eu');
  });
});
