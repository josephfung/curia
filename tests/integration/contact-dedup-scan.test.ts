// tests/integration/contact-dedup-scan.test.ts
//
// The weekly dedup scan (contact-find-duplicates) against real Postgres (#2493):
//   - a pair Curia rules "not a duplicate" gets an exclusion row and the next scan skips it
//   - a deferred pair is not re-filed inside the cooldown, and is after it or after a change
//   - a structural pair is merged with no task, and the merge carries an audit reason
//   - an owner-ceo task for a pair the principal need not decide is handed back to Curia
//
// The integration DB is shared by parallel suites, and the scan reads every contact and
// every dedup task. Each test therefore hands the handler a contact service and task repo
// scoped to the contacts it created, so the scan can neither file for nor merge anyone
// else's rows.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import pino from 'pino';
import { ContactService } from '../../src/contacts/contact-service.js';
import { DedupService } from '../../src/contacts/dedup-service.js';
import { TaskRepo } from '../../src/db/task-repo.js';
import { canonicalPairKey, pairKeyFromDedupTask } from '../../src/contacts/dedup-pair-key.js';
import { ContactFindDuplicatesHandler } from '../../skills/contacts/tools/contact-find-duplicates/handler.js';
import { ContactDedupExcludeHandler } from '../../skills/contacts/tools/contact-dedup-exclude/handler.js';
import type { ContactKind, ContactMergedDetails, ContactTier } from '../../src/contacts/types.js';
import type { EventBus } from '../../src/bus/bus.js';
import type { ToolContext } from '../../src/skills/types.js';
import { requireCuriaTestDatabase } from './require-test-db.js';

const { Pool } = pg;
const DATABASE_URL = process.env['DATABASE_URL'];
const describeIf = DATABASE_URL ? describe : describe.skip;

const logger = pino({ level: 'silent' });
const noopBus = { publish: async () => {}, subscribe: () => {} } as unknown as EventBus;

describeIf('contact-find-duplicates scan (#2493)', () => {
  // A token in every display name, so cleanup can find this run's rows by text.
  const runId = `zq${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const createdContactIds = new Set<string>();
  const merges: Array<{ primaryId: string; secondaryId: string; details?: ContactMergedDetails }> = [];

  let pool: pg.Pool;
  let contactService: ContactService;
  let taskRepo: TaskRepo;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await requireCuriaTestDatabase(pool);
    contactService = ContactService.createWithPostgres(pool, undefined, logger, {
      dedupService: new DedupService(),
      onContactMerged: (primaryId, secondaryId, _mergedAt, details) => {
        merges.push({ primaryId, secondaryId, details });
      },
    });
    taskRepo = new TaskRepo(pool, noopBus, logger as never, 'UTC');
    await pool.query('SELECT 1 FROM contact_dedup_exclusions LIMIT 0');
  });

  afterAll(async () => {
    await pool.query(
      `DELETE FROM scheduled_jobs WHERE task_id IN (SELECT id FROM tasks WHERE title LIKE $1)`,
      [`%${runId}%`],
    );
    await pool.query(`DELETE FROM tasks WHERE title LIKE $1`, [`%${runId}%`]);
    const ids = [...createdContactIds];
    if (ids.length > 0) {
      // Exclusions and identities go with the contact (ON DELETE CASCADE / explicit here).
      await pool.query('DELETE FROM contact_channel_identities WHERE contact_id = ANY($1)', [ids]);
      await pool.query('DELETE FROM contacts WHERE id = ANY($1)', [ids]);
    }
    await pool.end();
  });

  async function makeContact(name: string, kind: ContactKind = 'person', tier: ContactTier = 'unknown') {
    const c = await contactService.createContact({ displayName: `${name} ${runId}`, source: 'ceo_stated', kind, tier });
    createdContactIds.add(c.id);
    return c;
  }

  /** The services, narrowed to `ids`. Everything not overridden passes straight through. */
  function scoped(ids: string[]) {
    const mine = new Set(ids);
    const scopedContacts = new Proxy(contactService, {
      get(target, prop, receiver) {
        if (prop === 'findDuplicates') {
          return async (...args: Parameters<ContactService['findDuplicates']>) =>
            (await target.findDuplicates(...args))
              .filter(p => mine.has(p.contactA.id) && mine.has(p.contactB.id));
        }
        if (prop === 'listContacts') {
          return async () => (await target.listContacts()).filter(c => mine.has(c.id));
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const scopedTasks = new Proxy(taskRepo, {
      get(target, prop, receiver) {
        if (prop === 'listTasks') {
          return async (...args: Parameters<TaskRepo['listTasks']>) =>
            (await target.listTasks(...args)).filter(t => {
              const key = pairKeyFromDedupTask(t);
              return key !== null && key.split(':').every(id => mine.has(id));
            });
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    return { contactService: scopedContacts, taskRepo: scopedTasks };
  }

  async function runScan(ids: string[], autonomyScore?: number) {
    const ctx = {
      toolName: 'contact-find-duplicates',
      toolVersion: 'test',
      input: {},
      secret: () => { throw new Error('no secrets'); },
      log: logger,
      ...scoped(ids),
      autonomyService: autonomyScore === undefined
        ? undefined
        : { getConfig: async () => ({ score: autonomyScore }) },
    } as unknown as ToolContext;
    const result = await new ContactFindDuplicatesHandler().execute(ctx);
    if (!result.success) throw new Error(result.error);
    return result.data as Record<string, number | boolean>;
  }

  async function reviewTasksFor(aId: string, bId: string, statuses = ['open', 'in_progress', 'waiting', 'blocked']) {
    const key = canonicalPairKey(aId, bId);
    const tasks = await taskRepo.listTasks({ statuses, tag: 'dedup', limit: 1000 });
    return tasks.filter(t => pairKeyFromDedupTask(t) === key);
  }

  it('records a Curia "not a duplicate" ruling as an exclusion, and the next scan skips the pair', async () => {
    const a = await makeContact('Brightwater Logistics Group', 'organization');
    const b = await makeContact('Brightwater Logistic Group', 'organization');

    const first = await runScan([a.id, b.id]);
    expect(first['filed']).toBe(1);
    const [task] = await reviewTasksFor(a.id, b.id);
    expect(task!.tags).toContain('dedup-route:curia');

    // The agent's decision, through the real tool.
    const exclude = await new ContactDedupExcludeHandler().execute({
      toolName: 'contact-dedup-exclude', toolVersion: 'test', secret: () => '', log: logger,
      input: { contact_a_id: a.id, contact_b_id: b.id, decided_by: 'curia' },
      contactService,
      memoryWriteSource: 'agent:contacts/task:test',
    } as unknown as ToolContext);
    expect(exclude.success).toBe(true);
    await taskRepo.completeTask(task!.id, 'Excluded — not a duplicate', 'contacts');

    const { rows } = await pool.query<{ decided_by: string }>(
      'SELECT decided_by FROM contact_dedup_exclusions WHERE contact_a_id = LEAST($1::uuid, $2::uuid) AND contact_b_id = GREATEST($1::uuid, $2::uuid)',
      [a.id, b.id],
    );
    expect(rows[0]?.decided_by).toMatch(/^curia:/);

    const second = await runScan([a.id, b.id]);
    expect(second['filed']).toBe(0);
    expect(second['skipped_excluded']).toBe(1);
  });

  it('holds a deferred pair for the cooldown, then re-files it after the cooldown or a change', async () => {
    const a = await makeContact('Rosalind Kettleworth');
    const b = await makeContact('Rosalyn Kettleworth');

    expect((await runScan([a.id, b.id]))['filed']).toBe(1);
    const [task] = await reviewTasksFor(a.id, b.id);
    // A deferral: the task closes with no exclusion.
    await taskRepo.completeTask(task!.id, 'Deferred', 'contacts');

    const held = await runScan([a.id, b.id]);
    expect(held['filed']).toBe(0);
    expect(held['skipped_recently_decided']).toBe(1);

    // Cooldown over: the closed review is older than the window.
    await pool.query(`UPDATE tasks SET updated_at = now() - interval '57 days' WHERE id = $1`, [task!.id]);
    expect((await runScan([a.id, b.id]))['filed']).toBe(1);
    const [refiled] = await reviewTasksFor(a.id, b.id);
    await taskRepo.completeTask(refiled!.id, 'Deferred again', 'contacts');
    expect((await runScan([a.id, b.id]))['filed']).toBe(0);

    // Inside the new cooldown, a new identity on one side re-files the pair at once.
    await contactService.linkIdentity({
      contactId: b.id, channel: 'email', channelIdentifier: `rosalyn-${runId}@example.com`, source: 'ceo_stated',
    });
    expect((await runScan([a.id, b.id]))['filed']).toBe(1);
  });

  it('merges a structural pair with no task and passes the classifier reason to the audit event', async () => {
    const a = await makeContact('Harbourline Billing', 'automated');
    const b = await makeContact('HARBOURLINE billing', 'organization');

    const summary = await runScan([a.id, b.id], 80);
    expect(summary['auto_merged']).toBe(1);
    expect(summary['filed']).toBe(0);

    const survivors = await Promise.all([contactService.getContact(a.id), contactService.getContact(b.id)]);
    expect(survivors.filter(Boolean)).toHaveLength(1);
    const merge = merges.find(m => [a.id, b.id].includes(m.secondaryId));
    expect(merge?.details).toEqual({
      reason: expect.stringContaining('Exact normalized name match'),
      mergedBy: 'dedup-scan',
    });
  });

  it('files the structural pair for review instead when the autonomy score is too low', async () => {
    const a = await makeContact('Cobaltstream Notifications', 'automated');
    const b = await makeContact('cobaltstream notifications', 'automated');

    const summary = await runScan([a.id, b.id], 50);
    expect(summary['auto_merged']).toBe(0);
    expect(summary['filed']).toBe(1);
    expect(await contactService.getContact(b.id)).not.toBeNull();
  });

  it('hands an owner-ceo review of two companies back to Curia', async () => {
    const a = await makeContact('Pinegrove Dental Clinic', 'organization');
    const b = await makeContact('Pinegrove Dental Clinics', 'organization');
    expect((await runScan([a.id, b.id]))['filed']).toBe(1);
    const [task] = await reviewTasksFor(a.id, b.id);
    // Before #2493 the agent handed every pair to the principal like this.
    await taskRepo.updateTask(task!.id, { owner: 'ceo', status: 'waiting', tags: ['dedup', 'contacts', ...task!.tags.filter(t => t.startsWith('dedup-pair:'))] });

    // The same pair filed a second time (the pre-#2493 re-filing), so the scan's queue
    // sweep sorts real rows: pg returns created_at as a Date, not the typed string.
    const dup = await taskRepo.createTask({
      agentId: 'contacts', title: `Review possible duplicate (again) ${runId}`,
      owner: 'curia', source: 'agent', sourceAgentId: 'contacts',
      tags: ['dedup', 'contacts', ...task!.tags.filter(t => t.startsWith('dedup-pair:'))],
    });

    const summary = await runScan([a.id, b.id]);
    expect(summary['tasks_handed_back']).toBe(1);
    expect(summary['tasks_closed']).toBe(1);
    expect((await taskRepo.getTask(dup.id))?.status).toBe('done');
    const after = await taskRepo.getTask(task!.id);
    expect(after).toMatchObject({ owner: 'curia', status: 'open' });
    expect(after!.tags).toContain('dedup-route:curia');
    // Still exactly one open task for the pair.
    expect(await reviewTasksFor(a.id, b.id)).toHaveLength(1);
  });
});
