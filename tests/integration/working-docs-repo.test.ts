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

  it('purgeExpiredScratch hard-deletes only expired /scratch/ documents', async () => {
    await repo.create({ path: '/scratch/expired/note.md', type: 'note', body: 'old' });
    await repo.create({ path: '/scratch/fresh/note.md', type: 'note', body: 'new' });
    await repo.create({ path: '/projects/durable/brief.md', type: 'brief', body: 'keep' });

    await pool.query(
      `UPDATE working_documents
       SET updated_at = now() - INTERVAL '10 days'
       WHERE path = '/scratch/expired/note.md'`,
    );

    const deleted = await repo.purgeExpiredScratch(7);
    expect(deleted).toBe(1);

    expect(await repo.read('/scratch/expired/note.md')).toBeNull();
    expect(await repo.read('/scratch/fresh/note.md')).not.toBeNull();
    expect(await repo.read('/projects/durable/brief.md')).not.toBeNull();
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
});
