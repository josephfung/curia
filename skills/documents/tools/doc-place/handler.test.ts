import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { DocPlaceHandler } from './handler.js';
import type { ToolContext } from '../../../../src/skills/types.js';
import type { WorkingDocsRepo, WorkingDocRow } from '../../../../src/db/working-docs-repo.js';

const silentLog = pino({ level: 'silent' });

function makeDoc(path: string, overrides: Partial<WorkingDocRow> = {}): WorkingDocRow {
  return {
    id: 'doc-1',
    path,
    type: 'note',
    frontmatter: { title: 'T' },
    body: '',
    version: 1,
    sectionVersions: {},
    byteSize: 0,
    taskId: null,
    conversationId: null,
    agentId: null,
    createdAt: '2026-06-28T10:00:00.000Z',
    updatedAt: '2026-06-28T10:00:00.000Z',
    archivedAt: null,
    ...overrides,
  };
}

describe('DocPlaceHandler', () => {
  it('recommends add_to_folder when a matching project exists', async () => {
    const repo = {
      listByPrefix: vi.fn(async (prefix: string) => {
        if (prefix === '/projects/') {
          return [makeDoc('/projects/social-media/queue.md')];
        }
        return [makeDoc('/projects/social-media/queue.md')];
      }),
    } as unknown as WorkingDocsRepo;

    const ctx = {
      input: { title: 'Social media daily', leaf: 'plan.md' },
      log: silentLog,
      timezone: 'UTC',
      workingDocs: repo,
    } as unknown as ToolContext;

    const result = await new DocPlaceHandler().execute(ctx);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const data = result.data as { action: string; directory_prefix: string };
    expect(data.action).toBe('add_to_folder');
    expect(data.directory_prefix).toBe('/projects/social-media/');
  });

  it('recommends create_folder for net-new work', async () => {
    const repo = {
      listByPrefix: vi.fn(async () => []),
    } as unknown as WorkingDocsRepo;

    const ctx = {
      input: { title: 'Evan neurology prep' },
      log: silentLog,
      timezone: 'UTC',
      workingDocs: repo,
    } as unknown as ToolContext;

    const result = await new DocPlaceHandler().execute(ctx);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const data = result.data as { action: string; slug: string };
    expect(data.action).toBe('create_folder');
    expect(data.slug).toBe('evan-neurology-prep');
  });
});
