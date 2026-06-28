import { describe, it, expect } from 'vitest';
import {
  applyDocumentWorkspace,
  buildIndexProjection,
  DOCUMENT_WORKSPACE_BLOCK,
  DOCUMENT_WORKSPACE_SKILLS,
  documentPointerFromTaskContent,
  extractSectionContent,
  formatAccumulatorResumeBlock,
  formatLogEntry,
  formatWorkspaceManifestBlock,
  grepDocuments,
  indexPathForDirectory,
  isScratchDocumentPath,
  logPathForDocument,
  parseTaskWakePayload,
  parseTtlDaysFrontmatter,
  resolveScratchDocTtlDays,
  resolveWorkspaceDirectoryPrefix,
  resolveWorkspacePrefixFromTaskContent,
  ttlDaysFrontmatterWarning,
} from '../../../src/agents/document-workspace.js';
import type { AgentYamlConfig } from '../../../src/agents/loader.js';
import type { WorkingDocRow } from '../../../src/db/working-docs-repo.js';

function cfg(overrides: Partial<AgentYamlConfig> = {}): AgentYamlConfig {
  return {
    name: 'test-agent',
    model: { tier: 'standard' },
    system_prompt: 'BASE PROMPT',
    ...overrides,
  };
}

function doc(path: string, overrides: Partial<WorkingDocRow> = {}): WorkingDocRow {
  return {
    id: 'id',
    path,
    type: 'note',
    frontmatter: {},
    body: '',
    version: 1,
    sectionVersions: {},
    byteSize: 0,
    taskId: null,
    conversationId: null,
    agentId: null,
    createdAt: '2026-06-28T12:00:00.000Z',
    updatedAt: '2026-06-28T12:00:00.000Z',
    archivedAt: null,
    ...overrides,
  };
}

describe('applyDocumentWorkspace', () => {
  it('is a no-op when task management is disabled', () => {
    const r = applyDocumentWorkspace(cfg(), 'BASE PROMPT', ['a']);
    expect(r.systemPrompt).toBe('BASE PROMPT');
    expect(r.pinnedSkills).toEqual(['a']);
  });

  it('appends the block and pins doc skills when task management is enabled', () => {
    const r = applyDocumentWorkspace(cfg({ enable_task_management: true }), 'BASE PROMPT', ['x']);
    expect(r.systemPrompt).toBe(`BASE PROMPT\n\n${DOCUMENT_WORKSPACE_BLOCK}`);
    expect(r.pinnedSkills).toEqual(['x', ...DOCUMENT_WORKSPACE_SKILLS]);
  });

  it('does not duplicate already-pinned doc skills', () => {
    const r = applyDocumentWorkspace(
      cfg({ enable_task_management: true }),
      'P',
      ['doc-read', 'other'],
    );
    expect(r.pinnedSkills.filter(s => s === 'doc-read')).toHaveLength(1);
    expect(r.pinnedSkills).toEqual(['doc-read', 'other', 'doc-list', 'doc-write', 'doc-search']);
  });
});

describe('buildIndexProjection', () => {
  it('lists direct children with titles and types', () => {
    const manifest = buildIndexProjection('/projects/x/', [
      doc('/projects/x/brief.md', { type: 'project-brief', frontmatter: { title: 'Brief' } }),
      doc('/projects/x/findings.md', { type: 'findings' }),
      doc('/projects/x/nested/deep.md'),
    ]);
    expect(manifest).toContain('[Brief](/projects/x/brief.md)');
    expect(manifest).toContain('`project-brief`');
    expect(manifest).toContain('[findings](/projects/x/findings.md)');
    expect(manifest).not.toContain('nested/deep');
  });

  it('returns an empty-directory message when there are no children', () => {
    const manifest = buildIndexProjection('/scratch/empty/', []);
    expect(manifest).toContain('No documents');
  });
});

describe('extractSectionContent', () => {
  it('returns the full body when no section is requested', () => {
    const { content } = extractSectionContent('hello\n\n## One\n\nalpha', undefined);
    expect(content).toContain('hello');
    expect(content).toContain('## One');
  });

  it('returns a matching section body', () => {
    const result = extractSectionContent('## Alpha\n\none\n\n## Beta\n\ntwo', 'beta');
    expect(result.section).toBe('Beta');
    expect(result.found).toBe(true);
    expect(result.content.trim()).toBe('two');
  });

  it('marks missing sections with found:false and no section name', () => {
    const result = extractSectionContent('## Alpha\n\none', 'missing');
    expect(result.found).toBe(false);
    expect(result.section).toBeUndefined();
    expect(result.content).toBe('');
  });

  it('marks empty sections as found with empty content', () => {
    const result = extractSectionContent('## Empty\n\n## Next\n\nbody', 'Empty');
    expect(result.found).toBe(true);
    expect(result.section).toBe('Empty');
    expect(result.content).toBe('');
  });
});

describe('grepDocuments', () => {
  it('finds substring matches with line numbers', () => {
    const matches = grepDocuments([
      doc('/a.md', { body: 'line one\nneedle here\n' }),
      doc('/b.md', { body: 'nothing' }),
    ], 'needle');
    expect(matches).toEqual([{ path: '/a.md', lineNumber: 2, line: 'needle here' }]);
  });
});

describe('resolveWorkspacePrefixFromTaskContent', () => {
  it('reads a document pointer from progress.resumable.accumulator', () => {
    const prefix = resolveWorkspacePrefixFromTaskContent(JSON.stringify({
      progress: {
        resumable: {
          accumulator: { kind: 'document', path: '/projects/audit/findings.md', section: 'Flagged' },
        },
      },
    }));
    expect(prefix).toBe('/projects/audit/');
  });

  it('falls back to /projects/<task_id>/ when task_id is present', () => {
    const prefix = resolveWorkspacePrefixFromTaskContent(JSON.stringify({
      task_id: 'abc-123',
      title: 'Audit',
    }));
    expect(prefix).toBe('/projects/abc-123/');
  });

  it('returns null for non-JSON content', () => {
    expect(resolveWorkspacePrefixFromTaskContent('hello')).toBeNull();
  });
});

describe('reserved path helpers', () => {
  it('builds log and index paths', () => {
    expect(logPathForDocument('/projects/x/brief.md')).toBe('/projects/x/log.md');
    expect(indexPathForDirectory('/projects/x')).toBe('/projects/x/index.md');
  });

  it('formats log entries and manifest blocks', () => {
    expect(formatLogEntry('2026-06-28T12:00:00Z', 'append', 'Added findings')).toContain('append | Added findings');
    const block = formatWorkspaceManifestBlock('/projects/x/', '# Index\n');
    expect(block).toContain('Workspace Manifest');
    expect(block).toContain('# Index');
  });
});

describe('scratch document TTL helpers (#1212)', () => {
  it('identifies scratch paths', () => {
    expect(isScratchDocumentPath('/scratch/conv/outline.md')).toBe(true);
    expect(isScratchDocumentPath('/projects/x/brief.md')).toBe(false);
  });

  it('inherits default TTL when ttl_days is omitted on scratch paths', () => {
    expect(resolveScratchDocTtlDays('/scratch/c/note.md', {}, 7)).toBe(7);
  });

  it('honours positive ttl_days overrides on scratch paths', () => {
    expect(resolveScratchDocTtlDays('/scratch/c/note.md', { ttl_days: 14 }, 7)).toBe(14);
  });

  it('opts out when ttl_days is zero on scratch paths', () => {
    expect(resolveScratchDocTtlDays('/scratch/c/note.md', { ttl_days: 0 }, 7)).toBeNull();
  });

  it('ignores ttl_days on non-scratch paths', () => {
    expect(resolveScratchDocTtlDays('/projects/x/brief.md', { ttl_days: 3 }, 7)).toBeNull();
  });

  it('parses string ttl_days values', () => {
    expect(parseTtlDaysFrontmatter({ ttl_days: '5' })).toBe(5);
  });

  it('warns when ttl_days is set on a non-scratch path', () => {
    const warning = ttlDaysFrontmatterWarning('/projects/x/brief.md', { ttl_days: 3 });
    expect(warning).toMatch(/ignored|not auto-expire/i);
  });
});

describe('parseTaskWakePayload / resume helpers (#1210)', () => {
  it('parses JSON wake payloads and rejects non-JSON', () => {
    expect(parseTaskWakePayload(JSON.stringify({ task_id: 'abc' }))).toEqual({ task_id: 'abc' });
    expect(parseTaskWakePayload('hello')).toBeNull();
  });

  it('reads a document pointer from task wake content', () => {
    const pointer = documentPointerFromTaskContent(JSON.stringify({
      task_id: 'leaf',
      progress: {
        resumable: {
          accumulator: { kind: 'document', path: '/projects/root/accumulator.md' },
        },
      },
    }));
    expect(pointer?.path).toBe('/projects/root/accumulator.md');
  });

  it('walks to the project root for child task wakes', async () => {
    const prefix = await resolveWorkspaceDirectoryPrefix(
      JSON.stringify({ task_id: 'child-task' }),
      async () => 'root-task',
    );
    expect(prefix).toBe('/projects/root-task/');
  });

  it('formats spilled accumulator content for resume injection', () => {
    const block = formatAccumulatorResumeBlock(
      { kind: 'document', path: '/projects/x/accumulator.md' },
      '# Accumulator\n\n```json\n[]\n```',
    );
    expect(block).toContain('Resumable Accumulator');
    expect(block).toContain('`/projects/x/accumulator.md`');
  });

  it('uses a longer fence when spilled content already contains fences', () => {
    const block = formatAccumulatorResumeBlock(
      { kind: 'document', path: '/projects/x/accumulator.md' },
      '```markdown\nnested\n```',
    );
    expect(block).toContain('````markdown');
    expect(block.trimEnd()).toMatch(/````$/);
  });
});
