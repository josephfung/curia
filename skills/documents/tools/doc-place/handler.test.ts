import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { DocPlaceHandler } from './handler.js';
import type { ToolContext } from '../../../../src/skills/types.js';
import type { WorkingDocsRepo } from '../../../../src/db/working-docs-repo.js';

const silentLog = pino({ level: 'silent' });

describe('DocPlaceHandler', () => {
  it('recommends add_to_folder when a matching project exists', async () => {
    const repo = {
      listProjectDirectorySummaries: vi.fn(async () => [{
        slug: 'social-media',
        directoryPrefix: '/projects/social-media/',
        documentCount: 1,
        samplePaths: ['/projects/social-media/queue.md'],
        sampleTitles: ['Queue'],
      }]),
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
      listProjectDirectorySummaries: vi.fn(async () => []),
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
