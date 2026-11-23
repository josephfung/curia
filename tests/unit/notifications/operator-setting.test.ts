// The operator address the gateway routes notices with (#2710).
//
// It is cached because the notice that most needs it — database_unavailable — is raised while
// the settings read is failing. The risk the cache carries is staleness: an EA who has been
// replaced must not keep receiving that notice, so every write calls remember().
import { describe, it, expect, vi } from 'vitest';
import { createOperatorEmailLookup } from '../../../src/notifications/operator-setting.js';

function dbReturning(value: { name: string; email: string } | undefined) {
  return {
    query: vi.fn(async (sql: string) => (
      sql.includes('FROM settings') && value ? { rows: [{ key: 'operator', value, updated_by: 'console' }] } : { rows: [] }
    )),
  };
}

function logger() {
  return { warn: vi.fn(), error: vi.fn() };
}

describe('createOperatorEmailLookup', () => {
  it('reads the stored operator', async () => {
    const lookup = createOperatorEmailLookup(dbReturning({ name: 'Sam', email: 'sam@example.com' }) as never, logger());
    expect(await lookup.read()).toBe('sam@example.com');
  });

  it('does not let a read that started before a clear restore the cleared operator (#2710 review)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const db = {
      query: vi.fn(async () => {
        await gate;
        return { rows: [{ key: 'operator', value: { name: 'Sam', email: 'sam@example.com' }, updated_by: 'console' }] };
      }),
    };
    const lookup = createOperatorEmailLookup(db as never, logger());
    const pending = lookup.read();
    lookup.remember(null);
    release();
    expect(await pending).toBeUndefined();

    // A later failing read answers with the cleared value, not the former operator.
    db.query.mockRejectedValue(new Error('down'));
    expect(await lookup.read()).toBeUndefined();
  });

  it('answers with the last address read when the database fails', async () => {
    const db = dbReturning({ name: 'Sam', email: 'sam@example.com' });
    const log = logger();
    const lookup = createOperatorEmailLookup(db as never, log);
    await lookup.read();

    db.query.mockRejectedValue(new Error('down'));
    expect(await lookup.read()).toBe('sam@example.com');
    expect(log.warn).toHaveBeenCalled();
    // Read once before, so this is a degraded-but-known state, not an unknown one.
    expect(log.error).not.toHaveBeenCalled();
  });

  it('logs at error when no read has ever succeeded, since the fallback may be the wrong person', async () => {
    const db = dbReturning(undefined);
    db.query.mockRejectedValue(new Error('down'));
    const log = logger();
    const lookup = createOperatorEmailLookup(db as never, log);

    expect(await lookup.read()).toBeUndefined();
    const [context, message] = log.error.mock.calls[0]!;
    expect(context).toHaveProperty('err');
    expect(String(message)).toContain('fall back to the principal');
  });

  it('remember() closes the stale-cache hole: a cleared operator is not the one dialled later', async () => {
    // The EA has left: the setting is cleared, no notice has been routed since, and then
    // Postgres fails. The cache must answer "no operator", not the former EA.
    const db = dbReturning({ name: 'Former EA', email: 'former-ea@example.com' });
    const lookup = createOperatorEmailLookup(db as never, logger());
    await lookup.read();
    lookup.remember(null);

    db.query.mockRejectedValue(new Error('down'));
    expect(await lookup.read()).toBeUndefined();
  });

  it('remember() applies a saved address, so a failing read still dials the new one', async () => {
    const db = dbReturning(undefined);
    const lookup = createOperatorEmailLookup(db as never, logger());
    lookup.remember({ name: 'New EA', email: 'new-ea@example.com' });

    db.query.mockRejectedValue(new Error('down'));
    expect(await lookup.read()).toBe('new-ea@example.com');
  });
});
