import { describe, it, expect, vi } from 'vitest';
import {
  declarerLabel, forceRemoveConfirmation, removeSecretFlow, secretStatus, filterSecrets, filterCounts,
  sortSecrets, siteHost, duplicateSiteHints, readableLabel, lastUsedText,
  type SecretRowData, type SecretDeclarer, type SecretFilters,
} from './secrets-utils.js';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('secrets-utils', () => {
  it('labels declarers by kind', () => {
    expect(declarerLabel({ kind: 'tool', name: 'web-search', required: false, enabled: true })).toBe('Tool web-search');
    expect(declarerLabel({ kind: 'principal-mailbox', name: 'Calendar and principal inbox', required: true, enabled: true })).toBe('Calendar and principal inbox');
    expect(declarerLabel({ kind: 'email-account', name: 'work', required: true, enabled: true })).toBe('Email account work');
  });

  it('marks a disabled declarer so it reads as not needed yet', () => {
    expect(declarerLabel({ kind: 'channel', name: 'slack', required: true, enabled: false })).toBe('Channel slack (disabled)');
  });

  it('puts the server message in the force-remove confirmation', () => {
    expect(forceRemoveConfirmation("'k' is required by enabled tool 'x'.")).toBe("'k' is required by enabled tool 'x'.\n\nRemove it anyway?");
  });

  describe('removeSecretFlow', () => {
    it('sends an unforced DELETE first and stops there when it succeeds', async () => {
      const del = vi.fn().mockResolvedValue(json(200, { ok: true, removed: true }));
      const confirm = vi.fn().mockReturnValue(true);
      expect(await removeSecretFlow('k', { confirm, del })).toBe('removed');
      expect(del.mock.calls).toEqual([[false]]);
      expect(confirm).toHaveBeenCalledTimes(1);
    });

    it('after a 409, shows the server message and forces only on a second yes', async () => {
      const del = vi.fn()
        .mockResolvedValueOnce(json(409, { error: "'k' is required by enabled tool 'x'." }))
        .mockResolvedValueOnce(json(200, { ok: true, removed: true }));
      const confirm = vi.fn().mockReturnValue(true);
      expect(await removeSecretFlow('k', { confirm, del })).toBe('removed');
      expect(del.mock.calls).toEqual([[false], [true]]);
      expect(confirm).toHaveBeenLastCalledWith(forceRemoveConfirmation("'k' is required by enabled tool 'x'."));
    });

    it('sends no forced request when the second confirmation is declined', async () => {
      const del = vi.fn().mockResolvedValue(json(409, { error: 'needed' }));
      const confirm = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
      expect(await removeSecretFlow('k', { confirm, del })).toBe('cancelled');
      expect(del.mock.calls).toEqual([[false]]);
    });

    it('sends nothing when the first confirmation is declined', async () => {
      const del = vi.fn();
      expect(await removeSecretFlow('k', { confirm: () => false, del })).toBe('cancelled');
      expect(del).not.toHaveBeenCalled();
    });

    it('throws the server error on any other failure', async () => {
      const del = vi.fn().mockResolvedValue(json(500, { error: 'Failed to remove secret.' }));
      await expect(removeSecretFlow('k', { confirm: () => true, del })).rejects.toThrow('Failed to remove secret.');
    });
  });
});

const decl = (over: Partial<SecretDeclarer> = {}): SecretDeclarer =>
  ({ kind: 'tool', name: 'web-search', required: true, enabled: true, ...over });

const row = (over: Partial<SecretRowData> = {}): SecretRowData => ({
  name: 'k',
  kind: 'system',
  configured: false,
  required: false,
  envFallback: null,
  declaredBy: [decl()],
  valueFormat: null,
  createdAt: null,
  updatedAt: null,
  lastUsedAt: null,
  readAtStartup: false,
  ...over,
});

const noFilters: SecretFilters = { kind: 'all', status: 'all', required: 'all', search: '' };

describe('secretStatus', () => {
  it('flags a system secret nothing declares as not_declared, even when configured', () => {
    expect(secretStatus(row({ declaredBy: [] }))).toBe('not_declared');
    expect(secretStatus(row({ declaredBy: [], configured: true }))).toBe('not_declared');
  });
  it('reports configured, env, missing and not_set in that order', () => {
    expect(secretStatus(row({ configured: true, envFallback: 'X', required: true }))).toBe('configured');
    expect(secretStatus(row({ envFallback: 'X', required: true }))).toBe('env');
    expect(secretStatus(row({ required: true }))).toBe('missing');
    expect(secretStatus(row())).toBe('not_set');
  });
  it('does not call a personal or platform row not_declared', () => {
    expect(secretStatus(row({ kind: 'personal', declaredBy: [], configured: true }))).toBe('configured');
    expect(secretStatus(row({ kind: 'platform', declaredBy: [], required: true }))).toBe('missing');
  });
});

describe('filterSecrets', () => {
  const rows = [
    row({ name: 'user.a', kind: 'personal', declaredBy: [], configured: true, username: 'joseph@example.com' }),
    row({ name: 'user.b', kind: 'personal', declaredBy: [], configured: true, username: 'other' }),
    row({ name: 'sys.c', required: true }),
  ];
  it('combines kind with a search that matches only the username', () => {
    const out = filterSecrets(rows, { ...noFilters, kind: 'personal', search: 'JOSEPH@' });
    expect(out.map(r => r.name)).toEqual(['user.a']);
  });
  it('ANDs status and required groups', () => {
    expect(filterSecrets(rows, { ...noFilters, status: 'missing' }).map(r => r.name)).toEqual(['sys.c']);
    expect(filterSecrets(rows, { ...noFilters, required: 'optional' }).map(r => r.name)).toEqual(['user.a', 'user.b']);
    expect(filterSecrets(rows, { ...noFilters, required: 'required', kind: 'personal' })).toEqual([]);
  });
  it('searches declarer labels and the login URL host', () => {
    const r = [row({ name: 'x', declaredBy: [decl({ name: 'linear', kind: 'mcp' })] }), row({ name: 'y', kind: 'personal', declaredBy: [], loginUrl: 'https://www.Rogers.com/a' })];
    expect(filterSecrets(r, { ...noFilters, search: 'mcp server' }).map(x => x.name)).toEqual(['x']);
    expect(filterSecrets(r, { ...noFilters, search: 'rogers.com' }).map(x => x.name)).toEqual(['y']);
  });
});

describe('filterCounts', () => {
  it('counts every row per option', () => {
    const rows = [
      row({ kind: 'personal', declaredBy: [], configured: true }),
      row({ required: true }),
      row({ kind: 'platform', configured: true, required: true }),
    ];
    const c = filterCounts(rows);
    expect(c.kind).toEqual({ all: 3, personal: 1, system: 1, platform: 1 });
    expect(c.status).toEqual({ configured: 2, env: 0, missing: 1, not_set: 0, not_declared: 0 });
    expect(c.required).toEqual({ required: 2, optional: 1 });
  });
});

describe('sortSecrets', () => {
  it('defaults to missing first, then by name', () => {
    const rows = [
      row({ name: 'b', configured: true }),
      row({ name: 'z', required: true }),
      row({ name: 'a', configured: true }),
      row({ name: 'c', required: true }),
    ];
    expect(sortSecrets(rows, null).map(r => r.name)).toEqual(['c', 'z', 'a', 'b']);
  });
  it('puts null dates last in both directions', () => {
    const rows = [
      row({ name: 'n' }),
      row({ name: 'old', lastUsedAt: '2026-01-01T00:00:00Z' }),
      row({ name: 'new', lastUsedAt: '2026-03-01T00:00:00Z' }),
    ];
    expect(sortSecrets(rows, { key: 'lastUsedAt', dir: 'asc' }).map(r => r.name)).toEqual(['old', 'new', 'n']);
    expect(sortSecrets(rows, { key: 'lastUsedAt', dir: 'desc' }).map(r => r.name)).toEqual(['new', 'old', 'n']);
  });
  it('sorts by name and by kind, and does not mutate its input', () => {
    const rows = [row({ name: 'b', kind: 'system' }), row({ name: 'a', kind: 'personal', declaredBy: [] })];
    expect(sortSecrets(rows, { key: 'name', dir: 'asc' }).map(r => r.name)).toEqual(['a', 'b']);
    expect(sortSecrets(rows, { key: 'kind', dir: 'asc' }).map(r => r.name)).toEqual(['a', 'b']);
    expect(rows.map(r => r.name)).toEqual(['b', 'a']);
  });
});

describe('siteHost', () => {
  it('lower-cases and strips a leading www.', () => {
    expect(siteHost('https://WWW.Rogers.com/a')).toBe('rogers.com');
  });
  it('returns null for a missing or unparseable URL', () => {
    expect(siteHost('not a url')).toBeNull();
    expect(siteHost(undefined)).toBeNull();
  });
});

describe('duplicateSiteHints', () => {
  it('pairs personal rows on the same host and ignores rows without a URL', () => {
    const rows = [
      row({ name: 'user.rogers_password', kind: 'personal', declaredBy: [], loginUrl: 'https://www.rogers.com/a' }),
      row({ name: 'user.rogers_login', kind: 'personal', declaredBy: [], loginUrl: 'https://rogers.com/b' }),
      row({ name: 'user.nourl', kind: 'personal', declaredBy: [] }),
      row({ name: 'user.other', kind: 'personal', declaredBy: [], loginUrl: 'https://bell.ca' }),
    ];
    const hints = duplicateSiteHints(rows);
    expect(hints.get('user.rogers_password')).toEqual(['user.rogers_login']);
    expect(hints.get('user.rogers_login')).toEqual(['user.rogers_password']);
    expect(hints.has('user.nourl')).toBe(false);
    expect(hints.has('user.other')).toBe(false);
  });
});

describe('readableLabel', () => {
  it('strips user., spaces underscores and capitalizes', () => {
    expect(readableLabel('user.aircanada_password')).toBe('Aircanada password');
  });
  it('leaves other names unchanged', () => {
    expect(readableLabel('tavily_api_key')).toBe('tavily_api_key');
  });
});

describe('lastUsedText', () => {
  const now = new Date('2026-11-04T12:00:00Z');
  it('says At startup for startup reads', () => {
    expect(lastUsedText(row({ readAtStartup: true, configured: true }), now)).toBe('At startup');
  });
  it('says n/a when not configured and never used, Never when configured', () => {
    expect(lastUsedText(row(), now)).toBe('n/a');
    expect(lastUsedText(row({ configured: true }), now)).toBe('Never');
  });
  it('renders minutes, hours and days', () => {
    const at = (ms: number) => row({ configured: true, lastUsedAt: new Date(now.getTime() - ms).toISOString() });
    expect(lastUsedText(at(5 * 60_000), now)).toBe('5m ago');
    expect(lastUsedText(at(3 * 3_600_000), now)).toBe('3h ago');
    expect(lastUsedText(at(2 * 86_400_000), now)).toBe('2d ago');
  });
  it('falls back to a short date past 30 days', () => {
    const text = lastUsedText(row({ configured: true, lastUsedAt: '2026-09-01T12:00:00Z' }), now);
    expect(text).toBe('Sep 1');
  });
});
