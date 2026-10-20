// verification-service.test.ts — the verifications table and VerificationService against
// real Postgres (#2017). Runs only against curia_test: the suite inserts and deletes rows
// in a table whose unique partial index a live instance relies on.
//
// Each test uses its own random site so rows from other tests (or leftovers) never collide.

import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import pino from 'pino';
import { VerificationService } from '../../../src/verification/verification-service.js';
import type { VerificationConfig } from '../../../src/verification/types.js';
import { requireCuriaTestDatabase } from '../require-test-db.js';
import { renderCoordinatorVerificationBlock } from '../../../src/agents/prompts/verification-block.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

const logger = pino({ level: 'silent' });
const CONFIG: VerificationConfig = {
  askChannelOrder: ['signal', 'sms', 'slack', 'email'],
  defaultExpiryMinutes: 10,
  recentWindowMinutes: 120,
  codeTtlMinutesAfterClose: 120,
  emailWaitSeconds: 180,
  identityProviderDomains: ['b2clogin.com'],
};

describeIf('VerificationService (#2017)', () => {
  let pool: pg.Pool;
  let service: VerificationService;
  let dbVerified = false;
  const sites: string[] = [];

  /** A unique registrable domain for one test; recorded for cleanup. */
  function newSite(): string {
    const site = `vtest-${randomUUID().slice(0, 8)}.com`;
    sites.push(site);
    return site;
  }

  function openInput(site: string, extra: Record<string, unknown> = {}) {
    return {
      purpose: 'sign_in' as const,
      kind: 'code' as const,
      delivery: 'email' as const,
      site,
      pageDomain: `login.${site}`,
      browserSessionId: `session-${randomUUID()}`,
      ...extra,
    };
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await requireCuriaTestDatabase(pool);
    dbVerified = true;
    service = new VerificationService(pool, logger as never, CONFIG);
  });

  afterAll(async () => {
    if (dbVerified) {
      await pool.query(`DELETE FROM verifications WHERE site = ANY($1::text[])`, [sites]);
    }
    await pool.end();
  });

  it('exposes its config', () => {
    expect(service.config).toBe(CONFIG);
  });

  it('open creates a pending row with normalized domains and the default expiry', async () => {
    const site = newSite();
    const before = Date.now();
    const { verification, reused } = await service.open(
      openInput(site, { site: `https://www.${site}/signin`, metadata: { masked: '•••• 1234' } }),
    );
    expect(reused).toBe(false);
    expect(verification.status).toBe('pending');
    expect(verification.site).toBe(site);
    expect(verification.pageDomain).toBe(site);
    expect(verification.taskId).toBeNull();
    expect(verification.conversationId).toBeNull();
    expect(verification.resolvedAt).toBeNull();
    expect(verification.metadata).toEqual({ masked: '•••• 1234' });
    const ttl = verification.expiresAt.getTime() - verification.requestedAt.getTime();
    expect(ttl).toBe(10 * 60 * 1000);
    expect(verification.requestedAt.getTime()).toBeGreaterThanOrEqual(before - 5000);
  });

  it('open honours an explicit expiresAt and a task / conversation link', async () => {
    const site = newSite();
    const taskId = randomUUID();
    const expiresAt = new Date(Date.now() + 3 * 60 * 1000);
    const { verification } = await service.open(
      openInput(site, { taskId, conversationId: 'conv-1', expiresAt }),
    );
    expect(verification.taskId).toBe(taskId);
    expect(verification.conversationId).toBe('conv-1');
    expect(verification.expiresAt.getTime()).toBe(expiresAt.getTime());
  });

  it('open rejects a site or page domain with no registrable domain', async () => {
    await expect(service.open(openInput('localhost'))).rejects.toThrow(/registrable domain/);
    await expect(service.open(openInput(newSite(), { pageDomain: '192.168.0.1' }))).rejects.toThrow(
      /registrable domain/,
    );
  });

  it('open twice for the same site returns the existing row with reused=true', async () => {
    const site = newSite();
    const first = await service.open(openInput(site));
    const second = await service.open(openInput(site, { browserSessionId: 'another-session' }));
    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.verification.id).toBe(first.verification.id);
    const { rows } = await pool.query(`SELECT 1 FROM verifications WHERE site = $1`, [site]);
    expect(rows).toHaveLength(1);
  });

  it('reuse after a restart refreshes the session id, so the block shows the live session', async () => {
    const site = newSite();
    const first = await service.open(openInput(site, { browserSessionId: 'session-before-restart' }));
    const second = await service.open(openInput(site, { browserSessionId: 'session-after-restart' }));
    expect(second.reused).toBe(true);
    expect(second.verification.id).toBe(first.verification.id);
    expect(second.verification.browserSessionId).toBe('session-after-restart');
    expect((await service.get(first.verification.id))?.browserSessionId).toBe('session-after-restart');

    // The injected block reads the row from listActive; only the new session is alive.
    const row = (await service.listActive()).find((v) => v.id === first.verification.id)!;
    const block = renderCoordinatorVerificationBlock(
      [{ ...row, sessionAlive: row.browserSessionId === 'session-after-restart' }],
      { askChannel: 'signal', timezone: 'UTC' },
    );
    expect(block).toContain('session session-after-restart alive');
  });

  it('reuse refreshes page_domain when the code-entry page moved to another registrable domain', async () => {
    const site = newSite();
    const first = await service.open(openInput(site));
    expect(first.verification.pageDomain).toBe(site);
    const second = await service.open(openInput(site, { pageDomain: 'https://acme.b2clogin.com/mfa' }));
    expect(second.reused).toBe(true);
    expect(second.verification.pageDomain).toBe('b2clogin.com');
    expect((await service.get(first.verification.id))?.pageDomain).toBe('b2clogin.com');
  });

  it('reuse switches delivery and refreshes expires_at (email never came, the principal is offered SMS)', async () => {
    const site = newSite();
    const first = await service.open(openInput(site, { expiresAt: new Date(Date.now() + 60 * 1000) }));
    expect(first.verification.delivery).toBe('email');
    const before = Date.now();
    const second = await service.open(openInput(site, { delivery: 'sms' }));
    expect(second.reused).toBe(true);
    expect(second.verification.id).toBe(first.verification.id);
    expect(second.verification.delivery).toBe('sms');
    // No expiresAt given: the default window, counted from this open.
    expect(second.verification.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 10 * 60 * 1000 - 5000);
    const stored = await service.get(first.verification.id);
    expect(stored?.delivery).toBe('sms');
    expect(stored?.expiresAt.getTime()).toBe(second.verification.expiresAt.getTime());

    // An explicit expiresAt on the reopen is honoured too.
    const expiresAt = new Date(Date.now() + 4 * 60 * 1000);
    const third = await service.open(openInput(site, { delivery: 'sms', expiresAt }));
    expect(third.verification.expiresAt.getTime()).toBe(expiresAt.getTime());
  });

  it('reuse fills a missing task / conversation link but never overwrites one', async () => {
    const site = newSite();
    const taskId = randomUUID();
    const first = await service.open(openInput(site));
    expect(first.verification.taskId).toBeNull();
    const second = await service.open(openInput(site, { taskId, conversationId: 'conv-a' }));
    expect(second.verification.taskId).toBe(taskId);
    expect(second.verification.conversationId).toBe('conv-a');
    const third = await service.open(openInput(site, { taskId: randomUUID(), conversationId: 'conv-b' }));
    expect(third.verification.taskId).toBe(taskId);
    expect(third.verification.conversationId).toBe('conv-a');
  });

  it('concurrent opens for one site produce a single pending row', async () => {
    const site = newSite();
    const results = await Promise.all([
      service.open(openInput(site)),
      service.open(openInput(site)),
      service.open(openInput(site)),
    ]);
    expect(new Set(results.map((r) => r.verification.id)).size).toBe(1);
    expect(results.filter((r) => !r.reused)).toHaveLength(1);
  });

  it('open expires a stale pending row for the site instead of reusing it', async () => {
    const site = newSite();
    const stale = await service.open(openInput(site, { expiresAt: new Date(Date.now() - 1000) }));
    const fresh = await service.open(openInput(site));
    expect(fresh.reused).toBe(false);
    expect(fresh.verification.id).not.toBe(stale.verification.id);
    expect((await service.get(stale.verification.id))?.status).toBe('expired');
  });

  it('open for a different site creates a second pending row', async () => {
    const a = await service.open(openInput(newSite()));
    const b = await service.open(openInput(newSite()));
    expect(b.reused).toBe(false);
    expect(b.verification.id).not.toBe(a.verification.id);
  });

  it('get returns the row, or null for an unknown id', async () => {
    const { verification } = await service.open(openInput(newSite()));
    expect(await service.get(verification.id)).toEqual(verification);
    expect(await service.get(randomUUID())).toBeNull();
  });

  it('close(satisfied) sets resolved_at; a new open for that site then creates a fresh row', async () => {
    const site = newSite();
    const first = await service.open(openInput(site));
    const closed = await service.close(first.verification.id, 'satisfied');
    expect(closed?.status).toBe('satisfied');
    expect(closed?.resolvedAt).toBeInstanceOf(Date);

    const second = await service.open(openInput(site));
    expect(second.reused).toBe(false);
    expect(second.verification.id).not.toBe(first.verification.id);
  });

  it('close does not reopen or overwrite an already-closed row', async () => {
    const { verification } = await service.open(openInput(newSite()));
    const satisfied = await service.close(verification.id, 'satisfied');
    const again = await service.close(verification.id, 'abandoned');
    expect(again?.status).toBe('satisfied');
    expect(again?.resolvedAt?.getTime()).toBe(satisfied?.resolvedAt?.getTime());
  });

  it('close returns null for an unknown id', async () => {
    expect(await service.close(randomUUID(), 'abandoned')).toBeNull();
  });

  it('close(satisfied) still lands on a pending row past its expiry', async () => {
    const site = newSite();
    const { verification } = await service.open(openInput(site, { expiresAt: new Date(Date.now() - 1000) }));
    const closed = await service.close(verification.id, 'satisfied');
    expect(closed?.status).toBe('satisfied');
  });

  it('listActive persists a past-expiry pending row as expired and still returns it', async () => {
    const site = newSite();
    const { verification } = await service.open(openInput(site, { expiresAt: new Date(Date.now() - 1000) }));
    const active = await service.listActive();
    const found = active.find((v) => v.id === verification.id);
    expect(found?.status).toBe('expired');
    expect(found?.resolvedAt).toBeInstanceOf(Date);
    const { rows } = await pool.query<{ status: string }>(`SELECT status FROM verifications WHERE id = $1`, [
      verification.id,
    ]);
    expect(rows[0]?.status).toBe('expired');
    // The expired row freed the site, so a fresh sign-in can open.
    const fresh = await service.open(openInput(site));
    expect(fresh.reused).toBe(false);
  });

  it('listActive returns pending rows and recently closed rows, newest first', async () => {
    const pending = await service.open(openInput(newSite()));
    const closedRow = await service.open(openInput(newSite()));
    await service.close(closedRow.verification.id, 'abandoned');
    const active = await service.listActive();
    const ids = active.map((v) => v.id);
    expect(ids).toContain(pending.verification.id);
    expect(ids).toContain(closedRow.verification.id);
    const times = active.map((v) => v.requestedAt.getTime());
    expect(times).toEqual([...times].sort((x, y) => y - x));
  });

  it('listActive drops rows closed more than recentWindowMinutes ago', async () => {
    const site = newSite();
    const { verification } = await service.open(openInput(site));
    await service.close(verification.id, 'satisfied');
    const insideWindow = new Date(Date.now() + 119 * 60 * 1000);
    const outsideWindow = new Date(Date.now() + 121 * 60 * 1000);
    expect((await service.listActive(insideWindow)).map((v) => v.id)).toContain(verification.id);
    expect((await service.listActive(outsideWindow)).map((v) => v.id)).not.toContain(verification.id);
  });

  it('pendingForTask returns the pending row for the task, null after close', async () => {
    const taskId = randomUUID();
    const { verification } = await service.open(openInput(newSite(), { taskId }));
    expect((await service.pendingForTask(taskId))?.id).toBe(verification.id);
    await service.close(verification.id, 'satisfied');
    expect(await service.pendingForTask(taskId)).toBeNull();
    expect(await service.pendingForTask(randomUUID())).toBeNull();
  });
});
