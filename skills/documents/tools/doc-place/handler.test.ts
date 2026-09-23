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
      projectPrefixHasLiveDocs: vi.fn(async (slug: string) => slug === 'social-media'),
      livePathExists: vi.fn(async () => false),
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

  it('recommends extend when the leaf exists (even outside the catalog window)', async () => {
    const repo = {
      listProjectDirectorySummaries: vi.fn(async () => []),
      projectPrefixHasLiveDocs: vi.fn(async (slug: string) => slug === 'vendor-review'),
      livePathExists: vi.fn(async (path: string) => path === '/projects/vendor-review/brief.md'),
    } as unknown as WorkingDocsRepo;

    const ctx = {
      input: { proposed_slug: 'vendor-review', leaf: 'brief.md' },
      log: silentLog,
      timezone: 'UTC',
      workingDocs: repo,
    } as unknown as ToolContext;

    const result = await new DocPlaceHandler().execute(ctx);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const data = result.data as { action: string; path: string };
    expect(data.action).toBe('extend');
    expect(data.path).toBe('/projects/vendor-review/brief.md');
    expect(repo.projectPrefixHasLiveDocs).toHaveBeenCalledWith('vendor-review');
    expect(repo.livePathExists).toHaveBeenCalledWith('/projects/vendor-review/brief.md');
  });

  it('recommends create_folder for net-new work', async () => {
    const repo = {
      listProjectDirectorySummaries: vi.fn(async () => []),
      projectPrefixHasLiveDocs: vi.fn(async () => false),
      livePathExists: vi.fn(async () => false),
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
