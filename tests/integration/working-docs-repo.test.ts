// Integration tests for WorkingDocsRepo — requires Postgres with migrations applied.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { WorkingDocsRepo } from '../../src/db/working-docs-repo.js';
import { parseOkfDocument } from '../../src/memory/okf.js';
import { createSilentLogger } from '../../src/logger.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

describeIf('WorkingDocsRepo (integration)', () => {
  let pool: pg.Pool;
  let repo: WorkingDocsRepo;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query('SELECT 1 FROM working_documents LIMIT 0');
    repo = new WorkingDocsRepo(pool, createSilentLogger());
  });

  afterAll(async () => { await pool.end(); });

  beforeEach(async () => {
    await pool.query('DELETE FROM working_document_links');
    await pool.query('DELETE FROM working_documents');
  });

  it('creates, reads, and round-trips OKF frontmatter', async () => {
    const created = await repo.create({
      path: '/projects/audit/brief.md',
      type: 'project-brief',
      frontmatter: {
        title: 'Audit brief',
        tags: ['audit'],
        timestamp: '2026-06-26T14:30:00Z',
      },
      body: '# Goal\n\nReview follows.\n',
    });
    expect(created.version).toBe(1);

    const loaded = await repo.read('/projects/audit/brief.md');
    expect(loaded).not.toBeNull();
    const okf = repo.toOkf(loaded!);
    const parsed = parseOkfDocument(okf);
    expect(parsed.type).toBe('project-brief');
    expect(parsed.frontmatter.title).toBe('Audit brief');
    expect(parsed.frontmatter.tags).toEqual(['audit']);
    expect(parsed.body).toContain('# Goal');
  });

  it('enforces unique live paths and allows reuse after soft-delete', async () => {
    await repo.create({ path: '/scratch/a/note.md', type: 'note', body: 'v1' });
    await expect(repo.create({ path: '/scratch/a/note.md', type: 'note', body: 'v2' }))
      .rejects.toThrow();
    await repo.softDelete('/scratch/a/note.md');
    const recreated = await repo.create({ path: '/scratch/a/note.md', type: 'note', body: 'v2' });
    expect(recreated.body).toBe('v2');
  });

  it('indexes backlinks and supports list-by-prefix', async () => {
    await repo.create({
      path: '/projects/x/brief.md',
      type: 'project-brief',
      body: 'See [[findings]] and [detail](/projects/x/detail.md).',
    });
    await repo.create({
      path: '/projects/x/findings.md',
      type: 'findings',
      body: 'Flagged accounts.',
    });
    await repo.create({
      path: '/projects/y/other.md',
      type: 'other',
      body: 'Unrelated.',
    });

    const backlinks = await repo.getBacklinks('/projects/x/findings.md');
    expect(backlinks.map(l => l.sourcePath)).toEqual(['/projects/x/brief.md']);

    const listed = await repo.listByPrefix('/projects/x/');
    expect(listed.map(d => d.path).sort()).toEqual([
      '/projects/x/brief.md',
      '/projects/x/findings.md',
    ]);
  });

  it('returns conflict on expected_version mismatch without throwing', async () => {
    const doc = await repo.create({ path: '/tmp/conflict.md', type: 'note', body: 'A' });
    const result = await repo.update('/tmp/conflict.md', {
      body: 'B',
      expectedVersion: doc.version + 99,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.conflict).toBe(true);
      expect(result.document.version).toBe(1);
    }
    const still = await repo.read('/tmp/conflict.md');
    expect(still!.body).toBe('A');
  });

  it('allows concurrent section edits on different sections', async () => {
    await repo.create({
      path: '/projects/parallel.md',
      type: 'project-brief',
      body: '## Alpha\n\none\n\n## Beta\n\ntwo\n',
    });

    const initial = await repo.read('/projects/parallel.md');
    const [editA, editB] = await Promise.all([
      repo.editSection('/projects/parallel.md', {
        section: 'Alpha',
        content: 'ONE',
        expectedSectionVersion: initial!.sectionVersions.Alpha ?? 0,
      }),
      repo.editSection('/projects/parallel.md', {
        section: 'Beta',
        content: 'TWO',
        expectedSectionVersion: initial!.sectionVersions.Beta ?? 0,
      }),
    ]);

    expect(editA.ok).toBe(true);
    expect(editB.ok).toBe(true);

    const finalDoc = await repo.read('/projects/parallel.md');
    expect(finalDoc!.body).toContain('ONE');
    expect(finalDoc!.body).toContain('TWO');
    expect(finalDoc!.sectionVersions.Alpha).toBe(1);
    expect(finalDoc!.sectionVersions.Beta).toBe(1);
  });

  it('clears nullable metadata fields when explicitly set to null', async () => {
    const doc = await repo.create({
      path: '/tmp/meta.md',
      type: 'note',
      body: 'x',
      conversationId: 'conv-1',
      agentId: 'agent-1',
    });
    expect(doc.conversationId).toBe('conv-1');
    expect(doc.agentId).toBe('agent-1');

    const updated = await repo.update('/tmp/meta.md', {
      conversationId: null,
      agentId: null,
      expectedVersion: doc.version,
    });
    expect(updated.ok).toBe(true);
    if (updated.ok) {
      expect(updated.document.conversationId).toBeNull();
      expect(updated.document.agentId).toBeNull();
    }
  });

  it('preserves inbound backlinks after soft-delete and recreate', async () => {
    await repo.create({
      path: '/projects/target.md',
      type: 'findings',
      body: 'Target doc.',
    });
    await repo.create({
      path: '/projects/source.md',
      type: 'brief',
      body: 'See [[target]].',
    });
    await repo.softDelete('/projects/target.md');
    await repo.create({
      path: '/projects/target.md',
      type: 'findings',
      body: 'Recreated target.',
    });

    const backlinks = await repo.getBacklinks('/projects/target.md');
    expect(backlinks.map(l => l.sourcePath)).toEqual(['/projects/source.md']);
  });

  it('listByPrefix treats underscore literally', async () => {
    await repo.create({ path: '/projects/a_b/note.md', type: 'note', body: 'underscore' });
    await repo.create({ path: '/projects/axb/note.md', type: 'note', body: 'no match' });

    const listed = await repo.listByPrefix('/projects/a_b');
    expect(listed.map(d => d.path)).toEqual(['/projects/a_b/note.md']);
  });

  it('append adds content with optimistic concurrency', async () => {
    const doc = await repo.create({ path: '/tmp/append.md', type: 'log', body: 'Line 1' });
    const appended = await repo.append('/tmp/append.md', {
      content: 'Line 2',
      expectedVersion: doc.version,
    });
    expect(appended.ok).toBe(true);
    if (appended.ok) {
      expect(appended.document.body).toContain('Line 1');
      expect(appended.document.body).toContain('Line 2');
      expect(appended.document.version).toBe(2);
    }
  });

  it('purgeExpiredScratch archives only expired /scratch/<conversation-id>/… documents', async () => {
    await repo.create({ path: '/scratch/expired/note.md', type: 'note', body: 'old' });
    await repo.create({ path: '/scratch/fresh/note.md', type: 'note', body: 'new' });
    await repo.create({ path: '/projects/durable/brief.md', type: 'brief', body: 'keep' });
    await repo.create({ path: '/scratch/index.md', type: 'index', body: 'root scratch' });

    await pool.query(
      `UPDATE working_documents
       SET updated_at = now() - INTERVAL '10 days'
       WHERE path IN ('/scratch/expired/note.md', '/scratch/index.md')`,
    );

    const archived = await repo.purgeExpiredScratch(7);
    expect(archived).toBe(1);

    expect(await repo.read('/scratch/expired/note.md')).toBeNull();
    expect(await repo.read('/scratch/fresh/note.md')).not.toBeNull();
    expect(await repo.read('/projects/durable/brief.md')).not.toBeNull();
    expect(await repo.read('/scratch/index.md')).not.toBeNull();

    const { rows } = await pool.query<{ archived_at: Date | null }>(
      `SELECT archived_at FROM working_documents WHERE path = '/scratch/expired/note.md'`,
    );
    expect(rows[0]?.archived_at).not.toBeNull();
  });

  it('purgeExpiredScratch respects ttl_days: 0 opt-out on scratch paths', async () => {
    await repo.create({
      path: '/scratch/permanent/note.md',
      type: 'note',
      body: 'stay',
      frontmatter: { ttl_days: 0 },
    });
    await pool.query(
      `UPDATE working_documents
       SET updated_at = now() - INTERVAL '30 days'
       WHERE path = '/scratch/permanent/note.md'`,
    );

    const deleted = await repo.purgeExpiredScratch(7);
    expect(deleted).toBe(0);
    expect(await repo.read('/scratch/permanent/note.md')).not.toBeNull();
  });

  it('purgeExpiredScratch is idempotent when nothing is expired', async () => {
    await repo.create({ path: '/scratch/active/note.md', type: 'note', body: 'fresh' });
    expect(await repo.purgeExpiredScratch(7)).toBe(0);
    expect(await repo.purgeExpiredScratch(7)).toBe(0);
    expect(await repo.read('/scratch/active/note.md')).not.toBeNull();
  });

  it('archiveProjectWorkspaceDocs does not archive a shared folder sibling owned by another task (#1819)', async () => {
    const { TaskRepo } = await import('../../src/db/task-repo.js');
    const { createSilentLogger: silent } = await import('../../src/logger.js');
    const noopBus = { publish: async () => {}, subscribe: () => {} };
    const taskRepo = new TaskRepo(pool, noopBus as never, silent());

    const taskA = await taskRepo.createTask({
      agentId: 'coordinator',
      title: 'Shared folder archive A',
      source: 'agent',
    });
    const taskB = await taskRepo.createTask({
      agentId: 'coordinator',
      title: 'Shared folder archive B',
      source: 'agent',
    });

    await repo.create({
      path: '/projects/shared-folder/a.md',
      type: 'note',
      body: 'owned by A',
      taskId: taskA.id,
    });
    await repo.create({
      path: '/projects/shared-folder/b.md',
      type: 'note',
      body: 'owned by B',
      taskId: taskB.id,
    });
    // Outbound link from B — must survive when A completes.
    await repo.create({
      path: '/projects/shared-folder/b-index.md',
      type: 'note',
      body: 'See [b](/projects/shared-folder/b.md).',
      taskId: taskB.id,
    });

    const archived = await repo.archiveProjectWorkspaceDocs(taskA.id);
    expect(archived).toBe(1);
    expect(await repo.read('/projects/shared-folder/a.md')).toBeNull();
    expect(await repo.read('/projects/shared-folder/b.md')).not.toBeNull();
    expect(await repo.read('/projects/shared-folder/b-index.md')).not.toBeNull();

    const backlinks = await repo.getBacklinks('/projects/shared-folder/b.md');
    expect(backlinks.map(l => l.sourcePath)).toContain('/projects/shared-folder/b-index.md');

    await pool.query('DELETE FROM tasks WHERE id = ANY($1::uuid[])', [[taskA.id, taskB.id]]);
  });

  it('subtask-owned docs stamped with root id archive with the project (#1819 review)', async () => {
    const { TaskRepo } = await import('../../src/db/task-repo.js');
    const { createSilentLogger: silent } = await import('../../src/logger.js');
    const noopBus = { publish: async () => {}, subscribe: () => {} };
    const taskRepo = new TaskRepo(pool, noopBus as never, silent());

    const parent = await taskRepo.createTask({
      agentId: 'coordinator',
      title: 'Root archival parent',
      source: 'agent',
    });
    const child = await taskRepo.createTask({
      agentId: 'coordinator',
      title: 'Root archival child',
      source: 'agent',
      parentTaskId: parent.id,
    });

    // Simulate doc-write resolving child → root before stamp.
    await repo.create({
      path: '/projects/root-archival/brief.md',
      type: 'brief',
      body: 'from subtask',
      taskId: parent.id,
    });

    expect(await taskRepo.resolveProjectRootTaskId(child.id)).toBe(parent.id);
    const archived = await repo.archiveProjectWorkspaceDocs(parent.id);
    expect(archived).toBe(1);
    expect(await repo.read('/projects/root-archival/brief.md')).toBeNull();

    await pool.query('DELETE FROM tasks WHERE id = ANY($1::uuid[])', [[parent.id, child.id]]);
  });

  describe('section versions across write paths (#2398)', () => {
    const RULES = '## Board mail\n\n- Status: active\n\n## Newsletters\n\n- Status: paused\n';

    it('keeps section_versions honest across a whole-body replace', async () => {
      const path = '/projects/sv-a/rules.md';
      await repo.create({ path, type: 'agent-settings', body: RULES });
      await repo.editSection(path, { section: 'Board mail', content: '- Status: active' });
      await repo.editSection(path, { section: 'Newsletters', content: '- Status: paused' });
      const before = (await repo.read(path))!;
      expect(before.sectionVersions).toEqual({ 'Board mail': 1, Newsletters: 1 });

      // Replace: Board mail changes, Newsletters is untouched, Decisions is new.
      const replaced = await repo.update(path, {
        body: '## Board mail\n\n- Status: paused\n\n## Newsletters\n\n- Status: paused\n\n## Decisions\n\n- Ship it\n',
        expectedVersion: before.version,
      });
      expect(replaced.ok).toBe(true);
      const after = (await repo.read(path))!;
      expect(after.sectionVersions).toEqual({ 'Board mail': 2, Newsletters: 1, Decisions: 1 });

      // A writer still holding Board mail's pre-replace counter now conflicts.
      const stale = await repo.editSection(path, {
        section: 'Board mail',
        content: '- Status: active',
        expectedSectionVersion: 1,
      });
      expect(stale.ok).toBe(false);
      if (!stale.ok) expect(stale.conflict).toBe(true);
      expect((await repo.read(path))!.body).toContain('- Status: paused');

      // Removing a section in a replace drops its counter.
      const removed = await repo.update(path, {
        body: '## Board mail\n\n- Status: paused\n\n## Decisions\n\n- Ship it\n',
        expectedVersion: after.version,
      });
      expect(removed.ok).toBe(true);
      expect((await repo.read(path))!.sectionVersions).toEqual({ 'Board mail': 2, Decisions: 1 });
    });

    it('bumps the appended-to section so a stale section edit conflicts after append', async () => {
      const path = '/projects/sv-b/notes.md';
      await repo.create({ path, type: 'note', body: '## Notes\n\nFirst.\n' });
      const created = (await repo.read(path))!;
      const appended = await repo.append(path, { content: 'Second.', expectedVersion: created.version });
      expect(appended.ok).toBe(true);
      expect((await repo.read(path))!.sectionVersions).toEqual({ Notes: 1 });

      const stale = await repo.editSection(path, {
        section: 'Notes',
        content: 'Replacement.',
        expectedSectionVersion: 0,
      });
      expect(stale.ok).toBe(false);
      if (!stale.ok) expect(stale.conflict).toBe(true);
    });

    it('keys editSection counters case-insensitively and merges duplicate keys', async () => {
      const path = '/projects/sv-c/rules.md';
      await repo.create({ path, type: 'agent-settings', body: RULES });
      expect((await repo.editSection(path, { section: 'Board mail', content: '- Status: active' })).ok).toBe(true);

      // A stale writer using another spelling of the same heading conflicts.
      const stale = await repo.editSection(path, {
        section: 'board mail',
        content: '- Status: paused',
        expectedSectionVersion: 0,
      });
      expect(stale.ok).toBe(false);
      if (!stale.ok) expect(stale.conflict).toBe(true);

      // The current counter works under any spelling and leaves a single key.
      const edited = await repo.editSection(path, {
        section: 'BOARD MAIL',
        content: '- Status: paused',
        expectedSectionVersion: 1,
      });
      expect(edited.ok).toBe(true);
      expect((await repo.read(path))!.sectionVersions).toEqual({ 'Board mail': 2 });
    });
  });
});
