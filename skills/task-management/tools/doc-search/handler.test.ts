import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { DocSearchHandler } from './handler.js';
import type { ToolContext } from '../../../../src/skills/types.js';
import type { WorkingDocsRepo, WorkingDocRow } from '../../../../src/db/working-docs-repo.js';

const silentLog = pino({ level: 'silent' });

describe('DocSearchHandler', () => {
  it('greps documents under a prefix', async () => {
    const docs: WorkingDocRow[] = [
      {
        id: '1', path: '/projects/x/a.md', type: 'note', frontmatter: {}, body: 'alpha\nneedle\n',
        version: 1, sectionVersions: {}, byteSize: 1, taskId: null, conversationId: null, agentId: null,
        createdAt: '2026-06-28T10:00:00.000Z', updatedAt: '2026-06-28T10:00:00.000Z', archivedAt: null,
      },
    ];
    const repo = {
      listByPrefix: vi.fn().mockResolvedValue(docs),
    } as unknown as WorkingDocsRepo;
    const ctx = {
      input: { query: 'needle', path_prefix: '/projects/x/' },
      log: silentLog,
      timezone: 'America/Toronto',
      workingDocs: repo,
    } as unknown as ToolContext;

    const result = await new DocSearchHandler().execute(ctx);
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { match_count: number; matches: Array<{ path: string }> };
      expect(data.match_count).toBe(1);
      expect(data.matches[0]!.path).toBe('/projects/x/a.md');
    }
  });
});
