import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { DocListHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';
import type { WorkingDocsRepo, WorkingDocRow } from '../../src/db/working-docs-repo.js';

const silentLog = pino({ level: 'silent' });

function makeCtx(docs: WorkingDocRow[], input: Record<string, unknown> = { path: '/projects/x/' }): SkillContext {
  const repo = {
    listByPrefix: vi.fn().mockResolvedValue(docs),
  } as unknown as WorkingDocsRepo;
  return {
    input,
    log: silentLog,
    timezone: 'America/Toronto',
    workingDocs: repo,
  } as unknown as SkillContext;
}

describe('DocListHandler', () => {
  it('rejects document file paths', async () => {
    const result = await new DocListHandler().execute(makeCtx([], { path: '/projects/x/brief.md' }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/directory prefix/i);
  });

  it('returns index projection for direct children', async () => {
    const docs: WorkingDocRow[] = [
      {
        id: '1', path: '/projects/x/brief.md', type: 'project-brief', frontmatter: { title: 'Brief' },
        body: '', version: 1, sectionVersions: {}, byteSize: 0, taskId: null, conversationId: null,
        agentId: null, createdAt: '2026-06-28T10:00:00.000Z', updatedAt: '2026-06-28T10:00:00.000Z', archivedAt: null,
      },
    ];
    const result = await new DocListHandler().execute(makeCtx(docs));
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { directory: string; index_path: string; manifest: string; document_count: number };
      expect(data.directory).toBe('/projects/x/');
      expect(data.index_path).toBe('/projects/x/index.md');
      expect(data.manifest).toContain('[Brief](/projects/x/brief.md)');
      expect(data.document_count).toBe(1);
    }
  });
});
