import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { DocReadHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';
import type { WorkingDocsRepo, WorkingDocRow } from '../../src/db/working-docs-repo.js';

const silentLog = pino({ level: 'silent' });

function makeDoc(overrides: Partial<WorkingDocRow> = {}): WorkingDocRow {
  return {
    id: 'doc-1',
    path: '/projects/x/brief.md',
    type: 'project-brief',
    frontmatter: { title: 'Brief' },
    body: '## Goal\n\nReview follows.\n',
    version: 2,
    sectionVersions: { Goal: 1 },
    byteSize: 100,
    taskId: null,
    conversationId: null,
    agentId: null,
    createdAt: '2026-06-28T10:00:00.000Z',
    updatedAt: '2026-06-28T11:00:00.000Z',
    archivedAt: null,
    ...overrides,
  };
}

function makeRepo(overrides: Partial<WorkingDocsRepo> = {}): WorkingDocsRepo {
  return {
    read: vi.fn().mockResolvedValue(makeDoc()),
    toOkf: vi.fn().mockReturnValue('---\ntype: project-brief\n---\nbody'),
    ...overrides,
  } as unknown as WorkingDocsRepo;
}

function makeCtx(input: Record<string, unknown>, workingDocs?: WorkingDocsRepo | null): SkillContext {
  return {
    input,
    log: silentLog,
    timezone: 'America/Toronto',
    workingDocs: workingDocs === null ? undefined : (workingDocs ?? makeRepo()),
  } as unknown as SkillContext;
}

describe('DocReadHandler', () => {
  it('requires path', async () => {
    const result = await new DocReadHandler().execute(makeCtx({}));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/path/i);
  });

  it('returns found:false when the document is missing', async () => {
    const repo = makeRepo({ read: vi.fn().mockResolvedValue(null) });
    const result = await new DocReadHandler().execute(makeCtx({ path: '/missing.md' }, repo));
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { found: boolean };
      expect(data.found).toBe(false);
    }
  });

  it('returns full body and okf when no section is requested', async () => {
    const result = await new DocReadHandler().execute(makeCtx({ path: '/projects/x/brief.md' }));
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { found: boolean; body?: string; okf?: string; displayTimezone?: string };
      expect(data.found).toBe(true);
      expect(data.body).toContain('Review follows');
      expect(data.okf).toBeTruthy();
      expect(data.displayTimezone).toBeTruthy();
    }
  });

  it('returns section content when section is requested', async () => {
    const result = await new DocReadHandler().execute(makeCtx({
      path: '/projects/x/brief.md',
      section: 'Goal',
    }));
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { section?: string; content?: string; section_found?: boolean };
      expect(data.section).toBe('Goal');
      expect(data.content).toContain('Review follows');
      expect(data.section_found).toBe(true);
    }
  });
});
