import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { reconcileFlatMailboxKeys } from '../../../src/principal-mailboxes/flat-mirror.js';
import type { PrincipalMailboxRecord } from '../../../src/principal-mailboxes/types.js';
import { principalMailboxGrantSecretName } from '../../../src/principal-mailboxes/secrets.js';

const logger = pino({ level: 'silent' });

const rec = (over: Partial<PrincipalMailboxRecord> = {}): PrincipalMailboxRecord => ({
  id: 'work', label: 'Work', address: 'pat@work.example.com', provider: 'google',
  isDefault: true, triageStartAt: null, removedAt: null, addedIdentityId: null, ...over,
});

function setup(records: PrincipalMailboxRecord[], initial: Record<string, string>) {
  const secrets: Record<string, string> = { ...initial };
  const store = {
    hasAnyRow: vi.fn(async () => records.length > 0),
    listLive: vi.fn(async () => records.filter((r) => !r.removedAt)),
  };
  const vault = {
    get: vi.fn(async (n: string) => secrets[n] ?? null),
    set: vi.fn(async (n: string, v: string) => { secrets[n] = v; }),
    delete: vi.fn(async (n: string) => { delete secrets[n]; }),
  };
  return { run: () => reconcileFlatMailboxKeys({ store, secrets: vault, logger }), secrets, vault };
}

const WORK_KEY = principalMailboxGrantSecretName('work');

describe('reconcileFlatMailboxKeys', () => {
  it('leaves the flat keys alone while the registry is empty (they are the source)', async () => {
    const s = setup([], { ceo_nylas_grant_id: 'g-flat', ceo_self_email: 'pat@example.com' });
    expect(await s.run()).toBe('unmanaged');
    expect(s.vault.set).not.toHaveBeenCalled();
    expect(s.vault.delete).not.toHaveBeenCalled();
  });

  it('copies the default mailbox over a stale flat grant (a mirror that failed, or a .env seed)', async () => {
    const s = setup([rec()], { [WORK_KEY]: 'g-new', ceo_nylas_grant_id: 'g-old', ceo_self_email: 'pat@work.example.com' });
    expect(await s.run()).toBe('mirrored');
    expect(s.secrets['ceo_nylas_grant_id']).toBe('g-new');
    expect(s.secrets['ceo_self_email']).toBe('pat@work.example.com');
  });

  it('copies a new default whose mirror never ran', async () => {
    const s = setup(
      [rec({ isDefault: false }), rec({ id: 'personal', address: 'pat@gmail.com', isDefault: true })],
      { [WORK_KEY]: 'g-work', [principalMailboxGrantSecretName('personal')]: 'g-personal', ceo_nylas_grant_id: 'g-work', ceo_self_email: 'pat@work.example.com' },
    );
    expect(await s.run()).toBe('mirrored');
    expect(s.secrets['ceo_nylas_grant_id']).toBe('g-personal');
    expect(s.secrets['ceo_self_email']).toBe('pat@gmail.com');
  });

  it('writes nothing when the flat keys already match', async () => {
    const s = setup([rec()], { [WORK_KEY]: 'g', ceo_nylas_grant_id: 'g', ceo_self_email: 'pat@work.example.com' });
    expect(await s.run()).toBe('in_sync');
    expect(s.vault.set).not.toHaveBeenCalled();
  });

  it('clears the flat keys once no live default is left (the default was removed, the clear failed)', async () => {
    const s = setup([rec({ removedAt: new Date(), isDefault: false })], { ceo_nylas_grant_id: 'g-gone', ceo_self_email: 'pat@work.example.com' });
    expect(await s.run()).toBe('cleared');
    expect(s.secrets['ceo_nylas_grant_id']).toBeUndefined();
    expect(s.secrets['ceo_self_email']).toBeUndefined();
    expect(await s.run()).toBe('in_sync');
  });

  it('leaves the flat keys as they are when the default has no grant to copy', async () => {
    const s = setup([rec()], { ceo_nylas_grant_id: 'g-old' });
    expect(await s.run()).toBe('no_grant');
    expect(s.secrets['ceo_nylas_grant_id']).toBe('g-old');
  });
});
