import { describe, it, expect } from 'vitest';
import {
  applyDocumentWorkspace,
  buildIndexProjection,
  DOCUMENT_WORKSPACE_BLOCK,
  DOCUMENT_WORKSPACE_SKILLS,
  extractSectionContent,
  formatLogEntry,
  formatWorkspaceManifestBlock,
  grepDocuments,
  indexPathForDirectory,
  logPathForDocument,
  resolveWorkspacePrefixFromTaskContent,
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
