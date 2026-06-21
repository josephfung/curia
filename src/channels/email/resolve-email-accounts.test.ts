import { describe, it, expect, vi } from 'vitest';
import { resolveEmailAccounts } from './resolve-email-accounts.js';
import type { EmailAccountsRepo, EmailAccountRow } from './email-accounts-repo.js';

function row(over: Partial<EmailAccountRow>): EmailAccountRow {
  return {
    name: 'curia', selfEmail: 'curia@example.com', provider: 'nylas', enabled: true,
    createdAt: new Date(0), createdBy: 'web-console', updatedAt: new Date(0), ...over,
  };
}

const logger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } as never;

function fakeRepo(rows: EmailAccountRow[]): EmailAccountsRepo {
  return { list: async () => rows } as unknown as EmailAccountsRepo;
}

describe('resolveEmailAccounts', () => {
  it('resolves each enabled account from the table + per-account vault grant', async () => {
    const repo = fakeRepo([row({ name: 'curia', selfEmail: 'c@x.com' }), row({ name: 'sales', selfEmail: 's@x.com' })]);
    const secrets = { get: async (n: string) =>
      n === 'channel.email.curia.nylas_grant_id' ? 'grant-c'
      : n === 'channel.email.sales.nylas_grant_id' ? 'grant-s' : null };
    const result = await resolveEmailAccounts(repo, secrets, logger);
    expect(result).toEqual([
      { name: 'curia', nylasGrantId: 'grant-c', selfEmail: 'c@x.com' },
      { name: 'sales', nylasGrantId: 'grant-s', selfEmail: 's@x.com' },
    ]);
  });

  it('excludes disabled accounts', async () => {
    const repo = fakeRepo([row({ name: 'curia' }), row({ name: 'off', enabled: false })]);
    const secrets = { get: async () => 'grant' };
    const result = await resolveEmailAccounts(repo, secrets, logger);
    expect(result.map(a => a.name)).toEqual(['curia']);
  });

  it('skips an account whose grant is missing, with a warning, and continues', async () => {
    const repo = fakeRepo([row({ name: 'curia', selfEmail: 'c@x.com' }), row({ name: 'sales' })]);
    const secrets = { get: async (n: string) =>
      n === 'channel.email.curia.nylas_grant_id' ? 'grant-c' : null };
    const warn = vi.fn();
    // Cast logger through unknown so we can spread it — logger is typed as never for brevity above,
    // but spreading `never` fails the TS checker; the runtime value is a plain object.
    const result = await resolveEmailAccounts(repo, { get: secrets.get }, { ...(logger as unknown as object), warn } as never);
    expect(result.map(a => a.name)).toEqual(['curia']);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('skips an account whose vault read throws, without aborting the others', async () => {
    const repo = fakeRepo([row({ name: 'curia', selfEmail: 'c@x.com' }), row({ name: 'sales', selfEmail: 's@x.com' })]);
    const secrets = { get: async (n: string) => {
      if (n === 'channel.email.curia.nylas_grant_id') throw new Error('vault blip');
      return 'grant-s';
    } };
    const warn = vi.fn();
    const result = await resolveEmailAccounts(repo, { get: secrets.get }, { ...(logger as unknown as object), warn } as never);
    // curia is skipped (its read threw); sales still resolves — boot is not aborted.
    expect(result.map(a => a.name)).toEqual(['sales']);
    expect(warn).toHaveBeenCalledOnce();
  });
});
