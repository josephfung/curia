import { describe, it, expect } from 'vitest';
import {
  parseOkfDocument,
  emitOkfDocument,
  extractLinks,
  splitSections,
  editSectionBody,
  joinSections,
  removeSection,
  normalizeDocPath,
} from '../../../src/memory/okf.js';

describe('parseOkfDocument / emitOkfDocument', () => {
  const sample = `---
type: project-brief
title: Bluesky follow audit
tags:
  - social-media
  - audit
timestamp: 2026-06-26T14:30:00Z
---

# Goal

Page through follows.
`;

  it('parses frontmatter and body', () => {
    const parsed = parseOkfDocument(sample);
    expect(parsed.type).toBe('project-brief');
    expect(parsed.frontmatter.title).toBe('Bluesky follow audit');
    expect(parsed.frontmatter.tags).toEqual(['social-media', 'audit']);
    expect(parsed.body).toContain('# Goal');
  });

  it('round-trips conventional frontmatter fields', () => {
    const parsed = parseOkfDocument(sample);
    const emitted = emitOkfDocument({
      type: parsed.type,
      frontmatter: parsed.frontmatter,
      body: parsed.body,
    });
    const reparsed = parseOkfDocument(emitted);
    expect(reparsed.type).toBe('project-brief');
    expect(reparsed.frontmatter.title).toBe('Bluesky follow audit');
    expect(reparsed.frontmatter.tags).toEqual(['social-media', 'audit']);
    expect(reparsed.frontmatter.timestamp).toBe('2026-06-26T14:30:00Z');
    expect(reparsed.body.trim()).toBe(parsed.body.trim());
  });

  it('requires type in frontmatter', () => {
    expect(() => parseOkfDocument('---\ntitle: x\n---\nbody')).toThrow(/type/i);
  });

  it('requires frontmatter delimiters', () => {
    expect(() => parseOkfDocument('# no frontmatter')).toThrow(/frontmatter/i);
  });
});

describe('extractLinks', () => {
  it('extracts markdown path links and wikilinks', () => {
    const body = `
See [findings](/projects/x/findings.md) and [[notes]].
Also [[/playbooks/sales.md]].
`;
    const links = extractLinks('/projects/x/brief.md', body);
    expect(links).toEqual([
      { targetPath: '/projects/x/findings.md', linkKind: 'markdown' },
      { targetPath: '/projects/x/notes.md', linkKind: 'wikilink' },
      { targetPath: '/playbooks/sales.md', linkKind: 'wikilink' },
    ]);
  });

  it('tolerates broken / external links', () => {
    const links = extractLinks('/a/b.md', 'Visit [site](https://example.com) and [frag](#section).');
    expect(links).toHaveLength(0);
  });

  it('deduplicates repeated links', () => {
    const body = '[[findings]] and again [[findings]]';
    const links = extractLinks('/projects/x/brief.md', body);
    expect(links).toHaveLength(1);
  });
});

describe('normalizeDocPath', () => {
  it('adds leading slash and normalizes separators', () => {
    expect(normalizeDocPath('projects/x/brief.md')).toBe('/projects/x/brief.md');
    expect(normalizeDocPath('/projects//x/brief.md')).toBe('/projects/x/brief.md');
  });

  it('resolves . and .. segments', () => {
    expect(normalizeDocPath('/notes/../brief.md')).toBe('/brief.md');
    expect(normalizeDocPath('/projects/x/./findings.md')).toBe('/projects/x/findings.md');
  });
});

describe('section helpers', () => {
  const body = `# Title

Intro text.

## Progress

312 / 1300 reviewed.

## Decisions

- Auto-unfollow stale accounts.
`;

  it('splits and joins sections', () => {
    const { preamble, sections } = splitSections(body);
    expect(preamble).toContain('Intro text');
    expect(sections.map((s: { heading: string }) => s.heading)).toEqual(['Progress', 'Decisions']);
    expect(joinSections(preamble, sections).trim()).toBe(body.trim());
  });

  it('replaces a section by heading', () => {
    const edited = editSectionBody(body, 'Progress', '500 / 1300 reviewed.\n');
    expect(edited).toContain('500 / 1300 reviewed');
    expect(edited).toContain('## Decisions');
    expect(edited).not.toContain('312 / 1300');
  });

  it('appends within a section', () => {
    const edited = editSectionBody(body, 'Decisions', '- New decision.', 'append');
    expect(edited).toContain('- Auto-unfollow stale accounts.');
    expect(edited).toContain('- New decision.');
  });

  it('creates a missing section', () => {
    const edited = editSectionBody(body, 'Risks', 'None yet.');
    expect(edited).toContain('## Risks');
    expect(edited).toContain('None yet.');
  });

  it('removes a section, heading and body, matching the heading case-insensitively (#2339)', () => {
    const removed = removeSection(body, ' progress ');
    expect(removed?.heading).toBe('Progress');
    expect(removed?.body).not.toContain('## Progress');
    expect(removed?.body).not.toContain('312 / 1300');
    expect(removed?.body).toContain('Intro text.');
    expect(removed?.body).toContain('## Decisions\n\n- Auto-unfollow stale accounts.');
  });

  it('removes the last section without leaving a trailing heading (#2339)', () => {
    const removed = removeSection(body, 'Decisions');
    expect(removed?.body).toBe('# Title\n\nIntro text.\n\n## Progress\n\n312 / 1300 reviewed.\n');
  });

  it('returns null for a missing section rather than changing the body (#2339)', () => {
    expect(removeSection(body, 'Risks')).toBeNull();
  });
});

describe('emitOkfDocument / parseOkfDocument are inverses (#1823)', () => {
  it.each([
    ['no trailing newline', 'last line'],
    ['empty', ''],
    ['leading frontmatter look-alike', '---\nnot: frontmatter\n---\nreal body\n'],
    ['blank-line start', '\n\nafter blanks'],
  ])('keeps a body with %s byte-for-byte', (_label, body) => {
    expect(parseOkfDocument(emitOkfDocument({ type: 'note', frontmatter: { title: 't' }, body })).body).toBe(body);
  });
});
