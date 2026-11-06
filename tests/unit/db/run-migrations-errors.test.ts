// The reconciliation's error paths with a scripted pg client: the original error must survive a
// failed ROLLBACK and a failed close, and a connection error event must not crash the process.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const script = vi.hoisted(() => ({
  failOn: '' as string,
  rollbackFails: false,
  endFails: false,
  emitErrorOnConnect: false,
  queries: [] as string[],
}));

vi.mock('pg', () => {
  class FakeClient {
    private listeners: Array<(err: Error) => void> = [];
    on(event: string, listener: (err: Error) => void): this {
      if (event === 'error') this.listeners.push(listener);
      return this;
    }
    async connect(): Promise<void> {
      // A connection error reported as an event, as pg does when the backend goes away
      // between queries. With no listener this would throw from the emitter.
      if (script.emitErrorOnConnect) {
        if (this.listeners.length === 0) throw new Error('no error listener: this would crash the process');
        for (const l of this.listeners) l(new Error('Connection terminated unexpectedly'));
      }
    }
    async query(sql: string): Promise<{ rows: unknown[] }> {
      script.queries.push(sql);
      if (sql === 'ROLLBACK' && script.rollbackFails) throw new Error('Client was closed and is not queryable');
      if (script.failOn && sql.includes(script.failOn)) throw new Error(`boom: ${script.failOn}`);
      if (sql.includes('pg_try_advisory_xact_lock')) return { rows: [{ locked: true }] };
      if (sql.includes('to_regclass')) return { rows: [{ exists: false }] };
      return { rows: [] };
    }
    async end(): Promise<void> {
      if (script.endFails) throw new Error('end failed');
    }
  }
  return { default: { Client: FakeClient } };
});

const { runMigrations } = await import('../../../src/db/run-migrations.js');

describe('reconciliation error handling', () => {
  let root: string;
  let dirs: { upstream: string; local: string };

  beforeEach(() => {
    Object.assign(script, { failOn: '', rollbackFails: false, endFails: false, emitErrorOnConnect: false, queries: [] });
    root = mkdtempSync(path.join(tmpdir(), 'curia-reconcile-errors-'));
    dirs = { upstream: path.join(root, 'migrations'), local: path.join(root, 'migrations-local') };
    mkdirSync(dirs.upstream);
    mkdirSync(dirs.local);
    writeFileSync(path.join(dirs.upstream, '001_core.sql'), 'SELECT 1;');
    writeFileSync(path.join(dirs.local, '002_fork.sql'), 'SELECT 1;');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function run(): Promise<unknown> {
    return runMigrations({ databaseUrl: 'postgres://fake', dirs, log: () => {} });
  }

  it('rolls back and rethrows the original error', async () => {
    script.failOn = 'CREATE TABLE';
    await expect(run()).rejects.toThrow('boom: CREATE TABLE');
    expect(script.queries).toContain('ROLLBACK');
  });

  it('keeps the original error when ROLLBACK and close fail too, attaching theirs', async () => {
    Object.assign(script, { failOn: 'CREATE TABLE', rollbackFails: true, endFails: true });
    const err = await run().catch((e: unknown) => e) as Error & { suppressed?: Error[] };
    expect(err.message).toBe('boom: CREATE TABLE');
    expect(err.suppressed?.map(e => e.message)).toEqual(['Client was closed and is not queryable', 'end failed']);
  });

  it('listens for connection error events and attaches them to the failure they cause', async () => {
    Object.assign(script, { emitErrorOnConnect: true, failOn: 'pg_try_advisory_xact_lock' });
    const err = await run().catch((e: unknown) => e) as Error & { suppressed?: Error[] };
    expect(err.message).toBe('boom: pg_try_advisory_xact_lock');
    expect(err.suppressed?.map(e => e.message)).toEqual(['Connection terminated unexpectedly']);
  });
});
