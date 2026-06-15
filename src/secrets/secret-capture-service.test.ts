// secret-capture-service.test.ts — unit tests for the secret-capture token service.
// All DB interaction is intercepted via a mock pool; no real Postgres required.

import { describe, it, expect, vi } from 'vitest';
import type { Pool, QueryResult } from 'pg';
import {
  SecretCaptureService,
  resolveUserSecretName,
  resolveSystemSecretName,
  type CaptureSecretsPort,
} from './secret-capture-service.js';
import { hashToken } from '../channels/http/session-auth.js';
import type { Logger } from '../logger.js';

/** A mock pool whose response is computed per-query from a handler, so a test can
 *  branch on the SQL (peek vs claim vs clear) and simulate races/empty results. */
function makePool(
  handler: (sql: string, params: unknown[]) => { rows: Record<string, unknown>[]; rowCount?: number },
): { pool: Pool; queries: Array<{ sql: string; params: unknown[] }> } {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      const p = params ?? [];
      queries.push({ sql, params: p });
      const { rows, rowCount } = handler(sql, p);
      return { rows, rowCount: rowCount ?? rows.length } as unknown as QueryResult;
    }),
  } as unknown as Pool;
  return { pool, queries };
}

/** A fake vault port that records writes so tests can assert what was stored. */
function makeSecretsPort(): CaptureSecretsPort & {
  setCalls: Array<{ name: string; value: string }>;
  setJSONCalls: Array<{ name: string; obj: unknown }>;
  failNextWrite: () => void;
} {
  const setCalls: Array<{ name: string; value: string }> = [];
  const setJSONCalls: Array<{ name: string; obj: unknown }> = [];
  let fail = false;
  return {
    setCalls,
    setJSONCalls,
    failNextWrite() { fail = true; },
    async set(name: string, value: string) {
      if (fail) { fail = false; throw new Error('vault write failed'); }
      setCalls.push({ name, value });
    },
    async setJSON(name: string, obj: unknown) {
      if (fail) { fail = false; throw new Error('vault write failed'); }
      setJSONCalls.push({ name, obj });
    },
  };
}

const SYSTEM_ALLOWED = new Set(['anthropic_api_key', 'channel.email.nylas_api_key']);

// Default handler: the mint INSERT now uses RETURNING expires_at (DB-clock TTL), so echo a
// row back for it; everything else returns no rows unless a test overrides the handler.
function makeService(
  poolHandler: (sql: string, params: unknown[]) => { rows: Record<string, unknown>[]; rowCount?: number } =
    (sql) => sql.includes('INSERT INTO secret_capture_tokens')
      ? { rows: [{ expires_at: new Date(Date.now() + 30 * 60_000) }] }
      : { rows: [] },
) {
  const { pool, queries } = makePool(poolHandler);
  const secrets = makeSecretsPort();
  const svc = new SecretCaptureService(pool, secrets, {
    getAllowedSystemNames: () => SYSTEM_ALLOWED,
  });
  return { svc, secrets, queries };
}

describe('resolveUserSecretName', () => {
  it('slugifies and prefixes with user.', () => {
    expect(resolveUserSecretName('My Flight Site Password')).toBe('user.my_flight_site_password');
  });

  it('collapses non-alphanumeric runs and trims edge underscores', () => {
    expect(resolveUserSecretName('  Foo--Bar!! ')).toBe('user.foo_bar');
  });

  it('rejects empty / whitespace input', () => {
    expect(() => resolveUserSecretName('   ')).toThrow();
  });

  it('rejects input with no usable alphanumeric characters', () => {
    expect(() => resolveUserSecretName('!!!')).toThrow();
  });

  it('rejects over-long input', () => {
    expect(() => resolveUserSecretName('x'.repeat(200))).toThrow();
  });

  it('structurally cannot produce a protected system or channel name', () => {
    // A user trying to overwrite a system key still lands inside the user. namespace.
    expect(resolveUserSecretName('anthropic_api_key')).toBe('user.anthropic_api_key');
    expect(resolveUserSecretName('channel.email.nylas_api_key')).toBe('user.channel_email_nylas_api_key');
  });
});

describe('resolveSystemSecretName', () => {
  it('accepts a declared / channel credential key verbatim', () => {
    expect(resolveSystemSecretName('anthropic_api_key', SYSTEM_ALLOWED)).toBe('anthropic_api_key');
    expect(resolveSystemSecretName('channel.email.nylas_api_key', SYSTEM_ALLOWED)).toBe('channel.email.nylas_api_key');
  });

  it('rejects a name not in the allowlist', () => {
    expect(() => resolveSystemSecretName('made_up_key', SYSTEM_ALLOWED)).toThrow();
  });

  it('rejects empty input', () => {
    expect(() => resolveSystemSecretName('  ', SYSTEM_ALLOWED)).toThrow();
  });
});

describe('SecretCaptureService minting (via the public name-policy entry points)', () => {
  it('stores the SHA-256 hash, never the raw token', async () => {
    const { svc, queries } = makeService();
    const { rawToken } = await svc.mintUserSecret({ rawName: 'x' });

    const insert = queries.find(q => q.sql.includes('INSERT INTO secret_capture_tokens'));
    expect(insert).toBeDefined();
    const storedHash = insert!.params[0];
    expect(storedHash).toBe(hashToken(rawToken));
    // The raw token must never be a stored parameter.
    expect(insert!.params).not.toContain(rawToken);
    // Short base64url slug (~22 chars from 16 bytes) — not a long hex hash, and it matches
    // none of the secret-scrub regexes (no 32+ hex run, no sk-/AKIA/Bearer).
    expect(rawToken).toMatch(/^[A-Za-z0-9_-]{20,24}$/);
    expect(rawToken).not.toMatch(/[a-f0-9]{32,}/);
  });

  it('sets a fixed 30-minute expiry (TTL is not caller-controlled)', async () => {
    const { svc } = makeService();
    const before = Date.now();
    const { expiresAt } = await svc.mintUserSecret({ rawName: 'x' });
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + 29 * 60_000);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 31 * 60_000);
  });

  it('persists the origin routing context on the token at mint time (#972)', async () => {
    const { svc, queries } = makeService();
    const originator = { contactId: 'ceo', systemRole: 'principal', channel: 'email', initiatedAt: 't' };
    await svc.mintUserSecret({
      rawName: 'Aeroplan password',
      label: 'Aeroplan password',
      origin: {
        conversationId: 'conv-1',
        channelId: 'email',
        agentId: 'coordinator',
        taskEventId: 'task-evt-9',
        originator,
        resumeIntent: 'check my Aeroplan balance',
      },
    });
    const insert = queries.find(q => q.sql.includes('INSERT INTO secret_capture_tokens'));
    expect(insert).toBeDefined();
    // The INSERT must name the routing columns and carry their values as parameters.
    expect(insert!.sql).toContain('conversation_id');
    expect(insert!.sql).toContain('resume_intent');
    expect(insert!.params).toContain('conv-1');
    expect(insert!.params).toContain('email');
    expect(insert!.params).toContain('coordinator');
    expect(insert!.params).toContain('task-evt-9');
    expect(insert!.params).toContain('check my Aeroplan balance');
    expect(insert!.params).toContainEqual(originator);
  });

  it('mints with NULL routing when no origin is supplied (backward compatible with #971)', async () => {
    const { svc, queries } = makeService();
    await svc.mintUserSecret({ rawName: 'x' });
    const insert = queries.find(q => q.sql.includes('INSERT INTO secret_capture_tokens'));
    // The four routing params after the fixed columns + TTL should all be null when no origin.
    expect(insert!.params.filter(p => p === null).length).toBeGreaterThanOrEqual(5);
  });
});

describe('SecretCaptureService.mintUserSecret / mintSystemSecret', () => {
  it('mintUserSecret namespaces the resolved key under user.', async () => {
    const { svc } = makeService();
    const res = await svc.mintUserSecret({ rawName: 'Flight Site Password' });
    expect(res.secretName).toBe('user.flight_site_password');
    expect(res.rawToken).toMatch(/^[A-Za-z0-9_-]{20,24}$/);
  });

  it('mintSystemSecret accepts an allowed key and rejects an unknown one', async () => {
    const { svc } = makeService();
    const ok = await svc.mintSystemSecret({ rawName: 'anthropic_api_key' });
    expect(ok.secretName).toBe('anthropic_api_key');
    await expect(svc.mintSystemSecret({ rawName: 'not_a_real_key' })).rejects.toThrow();
  });
});

describe('SecretCaptureService.getMetadata', () => {
  it('returns not_found for an unknown token', async () => {
    const { svc } = makeService(() => ({ rows: [] }));
    expect(await svc.getMetadata('deadbeef')).toBe('not_found');
  });

  it('returns expired for a spent token (consumed or past — computed in SQL)', async () => {
    const { svc } = makeService(() => ({
      rows: [{ label: 'x', value_format: 'string', spent: true }],
    }));
    expect(await svc.getMetadata('deadbeef')).toBe('expired');
  });

  it('returns label + valueFormat for a live token, never the vault key', async () => {
    const { svc } = makeService(() => ({
      rows: [{ label: 'Flight password', value_format: 'string', spent: false, secret_name: 'user.secret' }],
    }));
    const meta = await svc.getMetadata('deadbeef');
    expect(meta).toEqual({ label: 'Flight password', valueFormat: 'string' });
    expect(JSON.stringify(meta)).not.toContain('user.secret');
  });
});

describe('SecretCaptureService.redeem', () => {
  // The service issues: (1) a peek SELECT, (2) an atomic claim UPDATE, (3) optional clear UPDATE.
  function router(opts: {
    peek?: Record<string, unknown>[];
    claim?: Record<string, unknown>[];
  }) {
    return (sql: string) => {
      if (sql.includes('SELECT') && sql.includes('secret_capture_tokens')) return { rows: opts.peek ?? [] };
      if (sql.includes('consumed_at = now()')) return { rows: opts.claim ?? [] };
      // clear consumed_at on vault failure (consumed_at = NULL)
      return { rows: [] };
    };
  }

  it('returns not_found for an unknown token', async () => {
    const { svc } = makeService(router({ peek: [] }));
    expect(await svc.redeem('deadbeef', 'val')).toEqual({ status: 'not_found' });
  });

  it('returns expired for a consumed token', async () => {
    const { svc } = makeService(router({
      peek: [{ value_format: 'string', spent: true }],
    }));
    expect(await svc.redeem('deadbeef', 'val')).toEqual({ status: 'expired' });
  });

  it('writes a string value into the vault and consumes the token', async () => {
    const { svc, secrets, queries } = makeService(router({
      peek: [{ value_format: 'string', spent: false }],
      claim: [{ secret_name: 'user.flight', value_format: 'string', label: 'Flight password' }],
    }));
    const result = await svc.redeem('deadbeef', 'hunter2');
    expect(result.status).toBe('ok');
    expect(secrets.setCalls).toEqual([{ name: 'user.flight', value: 'hunter2' }]);
    // The atomic claim guards consumed_at IS NULL AND expires_at > now() — single use.
    const claim = queries.find(q => q.sql.includes('SET consumed_at = now()'));
    expect(claim!.sql).toContain('consumed_at IS NULL');
    expect(claim!.sql).toContain('expires_at > now()');
  });

  it('returns the captured routing context on ok — never the value (#972)', async () => {
    const { svc } = makeService(router({
      peek: [{ value_format: 'string', spent: false }],
      claim: [{
        secret_name: 'user.aeroplan_password',
        value_format: 'string',
        label: 'Aeroplan password',
        conversation_id: 'conv-1',
        channel_id: 'email',
        agent_id: 'coordinator',
        task_event_id: 'task-evt-9',
        originator: { contactId: 'ceo', systemRole: 'principal', channel: 'email', initiatedAt: 't' },
        resume_intent: 'check my Aeroplan balance',
      }],
    }));
    const result = await svc.redeem('deadbeef', 'hunter2');
    expect(result).toEqual({
      status: 'ok',
      captured: {
        secretName: 'user.aeroplan_password',
        label: 'Aeroplan password',
        conversationId: 'conv-1',
        channelId: 'email',
        agentId: 'coordinator',
        taskEventId: 'task-evt-9',
        originator: { contactId: 'ceo', systemRole: 'principal', channel: 'email', initiatedAt: 't' },
        resumeIntent: 'check my Aeroplan balance',
      },
    });
    // Privacy invariant: the submitted value must not appear anywhere in the captured context.
    expect(JSON.stringify(result)).not.toContain('hunter2');
  });

  it('writes JSON via setJSON when value_format is json', async () => {
    const { svc, secrets } = makeService(router({
      peek: [{ value_format: 'json', spent: false }],
      claim: [{ secret_name: 'user.creds', value_format: 'json', label: null }],
    }));
    const result = await svc.redeem('deadbeef', '{"a":1}');
    expect(result.status).toBe('ok');
    expect(secrets.setJSONCalls).toEqual([{ name: 'user.creds', obj: { a: 1 } }]);
  });

  it('rejects invalid JSON without burning the token', async () => {
    const { svc, secrets, queries } = makeService(router({
      peek: [{ value_format: 'json', spent: false }],
    }));
    const result = await svc.redeem('deadbeef', 'not json');
    expect(result).toEqual({ status: 'invalid_json' });
    expect(secrets.setJSONCalls).toHaveLength(0);
    // No claim UPDATE should have fired — the token is still usable for a retry.
    expect(queries.find(q => q.sql.includes('SET consumed_at = now()'))).toBeUndefined();
  });

  it('treats a lost claim race as expired (single-use) — replay yields no captured context', async () => {
    const { svc } = makeService(router({
      peek: [{ value_format: 'string', spent: false }],
      claim: [], // someone else consumed it between peek and claim
    }));
    // A replayed (already-consumed) redeem returns expired with no captured context, so the
    // route publishes nothing — exactly one secret.captured event per real capture (#972).
    expect(await svc.redeem('deadbeef', 'val')).toEqual({ status: 'expired' });
  });

  it('clears consumed_at and rethrows when the vault write fails', async () => {
    const { svc, secrets, queries } = makeService(router({
      peek: [{ value_format: 'string', spent: false }],
      claim: [{ secret_name: 'user.flight', value_format: 'string' }],
    }));
    secrets.failNextWrite();
    await expect(svc.redeem('deadbeef', 'hunter2')).rejects.toThrow('vault write failed');
    const clear = queries.find(q => q.sql.includes('SET consumed_at = NULL'));
    expect(clear).toBeDefined();
    // The rollback must only un-consume a still-live token (never resurrect a dead row).
    expect(clear!.sql).toContain('expires_at > now()');
  });

  it('propagates the ORIGINAL vault error (not the rollback error) when the rollback also fails', async () => {
    // Simulate the correlated-DB-outage case: the vault write fails AND the rollback UPDATE
    // rejects. The user must see the real vault error, and the token-stranded event is logged.
    const errors: unknown[] = [];
    const { pool } = makePool((sql) => {
      if (sql.includes('SELECT')) {
        return { rows: [{ value_format: 'string', spent: false }] };
      }
      if (sql.includes('consumed_at = now()')) return { rows: [{ secret_name: 'user.flight', value_format: 'string' }] };
      throw new Error('rollback UPDATE failed (db down)');
    });
    const secrets = makeSecretsPort();
    secrets.failNextWrite();
    const logger = { error: (obj: unknown) => { errors.push(obj); } } as unknown as Logger;
    const svc = new SecretCaptureService(pool, secrets, {
      getAllowedSystemNames: () => SYSTEM_ALLOWED,
      logger,
    });
    await expect(svc.redeem('deadbeef', 'hunter2')).rejects.toThrow('vault write failed');
    // The stranded-token event was logged for an operator.
    expect(errors).toHaveLength(1);
  });
});
