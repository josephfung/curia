import { describe, expect, it, vi } from 'vitest';
import {
  capPairingWindow,
  choosePairOrigin,
  consumePairingCode,
  formatShortCode,
  installabilityWarning,
  mintPairingCode,
  normalizeShortCode,
  pairingUrl,
  randomShortCode,
  releasePairingCode,
  type PairingQueryable,
} from '../../../../src/channels/http/pairing.js';
import { PHONE_DOCS_URL } from '../../../../src/phone/phone-docs.js';
import { hashToken } from '../../../../src/channels/http/session-auth.js';

describe('installabilityWarning', () => {
  it('accepts a public https hostname', () => {
    expect(installabilityWarning('https://curia.example.com')).toBeNull();
    expect(installabilityWarning('https://curia.example.com/chat')).toBeNull();
  });

  it('warns for http, localhost, a bare IP, a single-label name, and private suffixes', () => {
    for (const origin of [
      'http://curia.example.com',
      'https://localhost:3000',
      'https://localhost.',
      'https://127.0.0.1',
      'https://192.168.1.20',
      'https://10.0.0.4',
      'https://curia.local',
      'https://curia.local.',
      'https://nas.lan',
      'https://nas.home',
      'https://nas.home.arpa',
      'https://nas.internal',
      'https://nas.intranet',
      'https://nas.corp',
      'https://nas.localdomain',
      'https://app.localhost',
      'https://my.test',
      'https://my.example',
      'https://my.invalid',
      'http://curia',
    ]) {
      expect(installabilityWarning(origin), origin).toMatch(/can't install/i);
      expect(installabilityWarning(origin), origin).toContain(PHONE_DOCS_URL);
    }
  });

  it('accepts one trailing dot on a hostname that can host the app', () => {
    expect(installabilityWarning('https://curia.example.com.')).toBeNull();
  });
});

describe('choosePairOrigin', () => {
  it('uses the desktop origin when that origin can host the app', () => {
    expect(choosePairOrigin({
      desktopOrigin: 'https://curia.example.com',
      appOrigin: 'https://other.example.com',
    })).toEqual({ origin: 'https://curia.example.com', warning: null, askForOrigin: false });
  });

  it('falls through to APP_ORIGIN when the desktop is on localhost', () => {
    expect(choosePairOrigin({
      desktopOrigin: 'http://localhost:5173',
      appOrigin: 'https://curia.example.com',
    })).toEqual({ origin: 'https://curia.example.com', warning: null, askForOrigin: false });
  });

  it('asks the operator when every candidate is a private address', () => {
    const choice = choosePairOrigin({
      desktopOrigin: 'http://192.168.1.8:3000',
      appOrigin: 'http://192.168.1.8:3000',
    });
    expect(choice.askForOrigin).toBe(true);
    expect(choice.warning).toMatch(/can't install/i);
  });

  it('keeps an origin the operator typed, and still warns', () => {
    const choice = choosePairOrigin({ requested: 'http://192.168.1.8:3000' });
    expect(choice.askForOrigin).toBe(false);
    expect(choice.origin).toBe('http://192.168.1.8:3000');
    expect(choice.warning).toMatch(/can't install/i);
  });
});

describe('pairingUrl', () => {
  it('puts the token in the fragment and nowhere else', () => {
    const url = pairingUrl('https://curia.example.com', 'abcDEF1234567890_-token');
    const parsed = new URL(url);
    expect(parsed.origin).toBe('https://curia.example.com');
    expect(parsed.pathname).toBe('/pair');
    expect(parsed.search).toBe('');
    expect(parsed.hash).toBe('#c=abcDEF1234567890_-token');
    expect(url).not.toContain('?');
  });
});

describe('short codes', () => {
  it('draws eight unambiguous characters', () => {
    const code = randomShortCode(() => Buffer.from([0, 31, 32, 255, 10, 11, 12, 13]));
    expect(code).toHaveLength(8);
    expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]+$/);
    expect(formatShortCode(code)).toBe(`${code.slice(0, 4)}-${code.slice(4)}`);
  });

  it('normalizes a typed code and rejects lookalikes', () => {
    expect(normalizeShortCode(' abcd-2345 ')).toBe('ABCD2345');
    expect(normalizeShortCode('ABCD-234O')).toBeNull();
    expect(normalizeShortCode('short')).toBeNull();
  });
});

describe('mintPairingCode', () => {
  it('stores hashes, not the token or the short code', async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const pool: PairingQueryable = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        if (sql.startsWith('INSERT')) return { rows: [{ id: 'code-1' }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }),
    };
    const minted = await mintPairingCode(pool, 'https://curia.example.com/', 1_700_000_000_000);
    expect(minted.pairUrl.startsWith('https://curia.example.com/pair#c=')).toBe(true);
    expect(minted.warning).toBeNull();
    const insert = calls.find((call) => call.sql.startsWith('INSERT'));
    const params = insert?.params ?? [];
    const token = new URL(minted.pairUrl).hash.slice('#c='.length);
    const short = minted.shortCode.replace('-', '');
    expect(params[0]).toBe(hashToken(decodeURIComponent(token)));
    expect(params[1]).toBe(hashToken(short));
    expect(JSON.stringify(params)).not.toContain(token);
    expect(JSON.stringify(params)).not.toContain(short);
  });
});

describe('consumePairingCode', () => {
  it('redeems the token without burning the short code', async () => {
    let sql = '';
    const pool: PairingQueryable = {
      query: vi.fn(async (statement: string) => {
        sql = statement;
        return { rows: [{ id: 'code-1', origin: 'https://curia.example.com' }], rowCount: 1 };
      }),
    };
    const consumed = await consumePairingCode(pool, { kind: 'token', token: 'a'.repeat(32) }, 'iPhone · Safari');
    expect(consumed).toEqual({ id: 'code-1', origin: 'https://curia.example.com', otherAlreadyRedeemed: false });
    expect(sql).toContain('token_redeemed_at = NOW()');
    expect(sql).toContain('token_device_name = $2');
    expect(sql).not.toContain('LEAST');
    expect(sql).not.toContain('short_redeemed_at = NOW()');
    expect(sql).not.toContain('${');
  });

  it('does not shorten the row when the short code is redeemed first', async () => {
    let sql = '';
    const pool: PairingQueryable = {
      query: vi.fn(async (statement: string) => {
        sql = statement;
        return { rows: [{ id: 'code-1', origin: 'https://curia.example.com', token_redeemed_at: null }], rowCount: 1 };
      }),
    };
    const consumed = await consumePairingCode(pool, { kind: 'short', code: 'ABCD2345' }, null);
    expect(consumed?.otherAlreadyRedeemed).toBe(false);
    expect(sql).toContain('short_redeemed_at = NOW()');
    expect(sql).toContain('short_device_name = $2');
    expect(sql).not.toContain('token_redeemed_at = NOW()');
    expect(sql).not.toContain('LEAST');
  });

  it('caps the window in its own statement, and release clears only that credential', async () => {
    const statements: string[] = [];
    const pool: PairingQueryable = {
      query: vi.fn(async (statement: string) => {
        statements.push(statement);
        return { rows: [], rowCount: 1 };
      }),
    };
    await capPairingWindow(pool, 'code-1');
    await releasePairingCode(pool, 'code-1', 'token');
    await releasePairingCode(pool, 'code-1', 'short');
    expect(statements[0]).toContain('LEAST');
    expect(statements[0]).toContain("interval '2 minutes'");
    expect(statements[1]).toContain('token_redeemed_at = NULL');
    expect(statements[1]).toContain('token_device_name = NULL');
    expect(statements[1]).not.toContain('expires_at');
    expect(statements[2]).toContain('short_redeemed_at = NULL');
    expect(statements[2]).toContain('short_device_name = NULL');
    expect(statements[2]).not.toContain('expires_at');
  });

  it('returns null when the code is already used', async () => {
    const pool: PairingQueryable = {
      query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    };
    await expect(consumePairingCode(pool, { kind: 'short', code: 'ABCD2345' }, null)).resolves.toBeNull();
  });
});
