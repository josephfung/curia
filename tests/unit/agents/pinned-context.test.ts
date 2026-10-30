// pinned_context (#2338): YAML validation, the per-turn `## Pinned context` block, and the
// agents that use it (#2339).
import { describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import pino from 'pino';
import { loadAgentConfig } from '../../../src/agents/loader.js';
import type { WorkingDocsRepo } from '../../../src/db/working-docs-repo.js';
import {
  createPinnedContextReader,
  DEFAULT_PINNED_CONTEXT_WARN_CHARS,
  parsePinnedContext,
  pinnedDocPaths,
  renderPinnedContextBlock,
  type PinnedContextReader,
} from '../../../src/agents/pinned-context.js';

const silent = pino({ level: 'silent' });

function reader(overrides: Partial<PinnedContextReader> = {}): PinnedContextReader {
  return {
    warnChars: 16_000,
    readDoc: vi.fn(async () => null),
    readConfig: vi.fn(async () => null),
    ...overrides,
  };
}

describe('parsePinnedContext', () => {
  it('returns [] when the field, or both lists, are absent or empty', () => {
    expect(parsePinnedContext(undefined, 'a')).toEqual([]);
    expect(parsePinnedContext(null, 'a')).toEqual([]);
    expect(parsePinnedContext({}, 'a')).toEqual([]);
    expect(parsePinnedContext({ docs: null, configs: [] }, 'a')).toEqual([]);
  });

  it('takes a single string for docs and configs', () => {
    expect(parsePinnedContext({ docs: 'shared/inbox/rules.md', configs: ' ceo_inbox/decision_tagging ' }, 'a')).toEqual([
      { kind: 'doc', path: '/shared/inbox/rules.md' },
      { kind: 'config', namespace: 'ceo_inbox', key: 'decision_tagging' },
    ]);
  });

  it('takes lists of many entries, mixing strings and described items, docs first in order', () => {
    expect(parsePinnedContext({
      configs: [
        'ceo_inbox/decision_tagging',
        { key: 'ceo_inbox/watermark', description: '  ID of the last message processed.\n  If missing, default to null. ' },
      ],
      docs: [
        '/shared/inbox/rules.md',
        { path: '/shared/priorities.md', description: "The principal's highest priorities." },
        { path: '/shared/calendar/rules.md' },
      ],
    }, 'a')).toEqual([
      { kind: 'doc', path: '/shared/inbox/rules.md' },
      { kind: 'doc', path: '/shared/priorities.md', description: "The principal's highest priorities." },
      { kind: 'doc', path: '/shared/calendar/rules.md' },
      { kind: 'config', namespace: 'ceo_inbox', key: 'decision_tagging' },
      {
        kind: 'config',
        namespace: 'ceo_inbox',
        key: 'watermark',
        description: 'ID of the last message processed. If missing, default to null.',
      },
    ]);
  });

  it.each([
    ['a list instead of a mapping', ['/shared/a.md'], /must be a mapping with `docs` and\/or `configs`/],
    ['a string instead of a mapping', '/shared/a.md', /must be a mapping/],
    ['the old singular keys', { doc: '/shared/a.md' }, /unknown key\(s\) `doc`/],
    ['a settings key', { settings: 'a/b' }, /unknown key\(s\) `settings`/],
    ['docs as a mapping', { docs: { path: '/shared/a.md' } }, /`docs` must be a string or a list/],
    ['an empty string', { docs: '  ' }, /non-empty string/],
    ['a blank list item', { docs: [null] }, /non-empty string/],
    ['an item missing its path', { docs: [{ description: 'x' }] }, /non-empty `path`/],
    ['a config item using path', { configs: [{ path: 'a/b' }] }, /only `key` and `description`/],
    ['an unknown item field', { docs: [{ path: '/shared/a.md', title: 'x' }] }, /only `path` and `description`/],
    ['a blank description', { docs: [{ path: '/shared/a.md', description: ' ' }] }, /`description` must be a non-empty string/],
    ['an over-long description', { configs: [{ key: 'a/b', description: 'x'.repeat(301) }] }, /300 characters or fewer/],
    ['a doc outside /shared/', { docs: '/projects/x/a.md' }, /under \/shared\//],
    ['a doc that climbs out of /shared/', { docs: '/shared/../projects/a.md' }, /under \/shared\//],
    ['the /shared/ folder itself', { docs: '/shared/' }, /under \/shared\//],
    ['a reserved leaf', { docs: '/shared/log.md' }, /reserved file log\.md/],
    ['a doc without .md', { docs: '/shared/inbox/rules' }, /must end in \.md/],
    ['a whole namespace', { configs: 'ceo_inbox' }, /exactly one `\/`/],
    ['two slashes', { configs: 'a/b/c' }, /exactly one `\/`/],
    ['an empty key', { configs: 'ceo_inbox/' }, /exactly one `\/`/],
    ['a duplicate doc', { docs: ['/shared/a.md', { path: 'shared/a.md' }] }, /duplicate entry doc:\/shared\/a\.md/],
    ['a duplicate config', { configs: ['n/k', 'n/k'] }, /duplicate entry config:n\/k/],
  ])('rejects %s, naming the agent', (_label, raw, pattern) => {
    expect(() => parsePinnedContext(raw, 'my-agent')).toThrow(/agent 'my-agent'/);
    expect(() => parsePinnedContext(raw, 'my-agent')).toThrow(pattern);
  });

  it('pinnedDocPaths lists only the documents', () => {
    expect(pinnedDocPaths(parsePinnedContext({ docs: ['/shared/a.md', '/shared/b.md'], configs: 'n/k' }, 'a')))
      .toEqual(['/shared/a.md', '/shared/b.md']);
  });
});

describe('renderPinnedContextBlock', () => {
  const entries = parsePinnedContext({ docs: '/shared/inbox/rules.md', configs: 'ceo_inbox/decision_tagging' }, 'a');

  it('returns null when nothing is declared', async () => {
    expect(await renderPinnedContextBlock([], reader(), { agentId: 'a', logger: silent })).toBeNull();
  });

  it('renders each doc with its path, version and full content, and each config value', async () => {
    const content = '---\ntype: agent-settings\n---\n## Board mail\n- Do: label BOARD';
    const block = await renderPinnedContextBlock(entries, reader({
      readDoc: vi.fn(async () => ({ status: 'live' as const, version: 7, content })),
      readConfig: vi.fn(async () => 'on'),
    }), { agentId: 'a', logger: silent });
    expect(block).toContain('## Pinned context');
    expect(block).toContain('### Document /shared/inbox/rules.md (version 7)');
    expect(block).toContain(content);
    expect(block).toContain('### Config ceo_inbox/decision_tagging\n```\non\n```');
  });

  it('reads fresh on every call', async () => {
    let version = 1;
    const r = reader({ readDoc: vi.fn(async () => ({ status: 'live' as const, version, content: `v${version}` })) });
    const opts = { agentId: 'a', logger: silent };
    expect(await renderPinnedContextBlock(entries, r, opts)).toContain('(version 1)');
    version = 2;
    expect(await renderPinnedContextBlock(entries, r, opts)).toContain('(version 2)');
  });

  it('renders a missing doc or key as not yet created', async () => {
    const block = await renderPinnedContextBlock(entries, reader(), { agentId: 'a', logger: silent });
    expect(block).toContain('### Document /shared/inbox/rules.md\n_Not yet created._');
    expect(block).toContain('### Config ceo_inbox/decision_tagging\n_Not set yet._');
  });

  it('renders an archived doc as archived, never as not yet created', async () => {
    const block = await renderPinnedContextBlock(entries.slice(0, 1), reader({
      readDoc: vi.fn(async () => ({ status: 'archived' as const })),
    }), { agentId: 'a', logger: silent });
    expect(block).toContain('### Document /shared/inbox/rules.md\n_Archived by the principal._ Do not recreate it');
    expect(block).not.toContain('Not yet created');
  });

  it('shows a description under its heading in every state, including missing', async () => {
    const described = parsePinnedContext({
      docs: [{ path: '/shared/priorities.md', description: "The principal's highest priorities." }],
      configs: [{ key: 'agent/watermark', description: 'ID of the last message processed. If missing, default to null.' }],
    }, 'a');
    const block = await renderPinnedContextBlock(described, reader(), { agentId: 'a', logger: silent });
    expect(block).toContain(
      "### Document /shared/priorities.md\nPurpose: The principal's highest priorities.\n_Not yet created._",
    );
    expect(block).toContain(
      '### Config agent/watermark\nPurpose: ID of the last message processed. If missing, default to null.\n_Not set yet._',
    );
  });

  it('renders an empty document and a blank config value explicitly, without fences', async () => {
    const block = await renderPinnedContextBlock(entries, reader({
      readDoc: vi.fn(async () => ({ status: 'live' as const, version: 2, content: '  \n' })),
      readConfig: vi.fn(async () => '   '),
    }), { agentId: 'a', logger: silent });
    expect(block).toContain('### Document /shared/inbox/rules.md (version 2)\n_Exists, but has no content yet._');
    expect(block).toContain('### Config ceo_inbox/decision_tagging\n_Set, but blank._');
    expect(block).not.toContain('```');
  });

  it('renders many entries when every one is missing, one block per entry', async () => {
    const many = parsePinnedContext({
      docs: ['/shared/a.md', '/shared/b.md', '/shared/c.md'],
      configs: ['n/one', 'n/two'],
    }, 'a');
    const block = await renderPinnedContextBlock(many, reader(), { agentId: 'a', logger: silent });
    expect(block!.match(/_Not yet created\._/g)).toHaveLength(3);
    expect(block!.match(/_Not set yet\._/g)).toHaveLength(2);
  });

  it('treats undefined from the reader as missing', async () => {
    const block = await renderPinnedContextBlock(entries, reader({
      readDoc: vi.fn(async () => undefined as unknown as null),
      readConfig: vi.fn(async () => undefined as unknown as null),
    }), { agentId: 'a', logger: silent });
    expect(block).toContain('_Not yet created._');
    expect(block).toContain('_Not set yet._');
  });

  it('renders a malformed read as unavailable without failing the other entries', async () => {
    const many = parsePinnedContext({ docs: ['/shared/bad.md', '/shared/good.md'], configs: 'n/k' }, 'a');
    const block = await renderPinnedContextBlock(many, reader({
      readDoc: vi.fn(async (path: string) => (path === '/shared/bad.md'
        ? ({ status: 'live', version: 1, content: 42 } as unknown as null)
        : { status: 'live' as const, version: 1, content: 'ok' })),
      readConfig: vi.fn(async () => ({ not: 'a string' }) as unknown as string),
    }), { agentId: 'a', logger: silent });
    expect(block).toContain('### Document /shared/bad.md\n_Unavailable this turn');
    expect(block).toContain('### Document /shared/good.md (version 1)\n```\nok\n```');
    expect(block).toContain('### Config n/k\n_Unavailable this turn');
  });

  it('a reader that throws synchronously still renders as unavailable', async () => {
    const block = await renderPinnedContextBlock(entries, reader({
      readDoc: vi.fn(() => { throw new Error('sync boom'); }) as unknown as PinnedContextReader['readDoc'],
      readConfig: vi.fn(() => { throw new Error('sync boom'); }) as unknown as PinnedContextReader['readConfig'],
    }), { agentId: 'a', logger: silent });
    expect(block!.match(/_Unavailable this turn/g)).toHaveLength(2);
  });

  it('renders a failed read as unavailable and logs a warning for each', async () => {
    const warn = vi.fn();
    const logger = { ...silent, warn } as unknown as typeof silent;
    const block = await renderPinnedContextBlock(entries, reader({
      readDoc: vi.fn(async () => { throw new Error('db down'); }),
      readConfig: vi.fn(async () => { throw new Error('kg down'); }),
    }), { agentId: 'ceo-inbox', logger });
    expect(block).toContain('### Document /shared/inbox/rules.md\n_Unavailable this turn');
    expect(block).toContain('### Config ceo_inbox/decision_tagging\n_Unavailable this turn');
    expect(block).not.toContain('Not yet created');
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]![0]).toMatchObject({ agentId: 'ceo-inbox', entry: 'doc:/shared/inbox/rules.md' });
  });

  it('warns above the size threshold and still injects in full', async () => {
    const warn = vi.fn();
    const logger = { ...silent, warn } as unknown as typeof silent;
    const content = 'x'.repeat(50);
    const block = await renderPinnedContextBlock(entries.slice(0, 1), reader({
      warnChars: 10,
      readDoc: vi.fn(async () => ({ status: 'live' as const, version: 1, content })),
    }), { agentId: 'a', logger });
    expect(block).toContain(content);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatchObject({ chars: 50, warnChars: 10 });
  });

  it('fences a document that contains its own code fence', async () => {
    const content = 'Rule\n```\ncode\n```';
    const block = await renderPinnedContextBlock(entries.slice(0, 1), reader({
      readDoc: vi.fn(async () => ({ status: 'live' as const, version: 1, content })),
    }), { agentId: 'a', logger: silent });
    expect(block).toContain(`\`\`\`\`\n${content}\n\`\`\`\``);
  });
});

describe('createPinnedContextReader', () => {
  it('serializes a live document as OKF with its version, and tells archived from never written', async () => {
    const row = { version: 4 };
    const repo = {
      read: vi.fn(async (path: string) => (path === '/shared/a.md' ? row : null)),
      existsAtPath: vi.fn(async (path: string) => path === '/shared/archived.md'),
      toOkf: vi.fn(() => '---\ntype: agent-settings\n---\nbody'),
    } as unknown as WorkingDocsRepo;
    const r = createPinnedContextReader({ workingDocsRepo: repo, logger: silent });
    expect(r.warnChars).toBe(DEFAULT_PINNED_CONTEXT_WARN_CHARS);
    expect(await r.readDoc('/shared/a.md'))
      .toEqual({ status: 'live', version: 4, content: '---\ntype: agent-settings\n---\nbody' });
    expect(await r.readDoc('/shared/archived.md')).toEqual({ status: 'archived' });
    expect(await r.readDoc('/shared/b.md')).toBeNull();
  });

  it('throws, rather than reporting not-yet-created, when a service is missing', async () => {
    const r = createPinnedContextReader({ logger: silent, warnChars: 5 });
    expect(r.warnChars).toBe(5);
    await expect(r.readDoc('/shared/a.md')).rejects.toThrow(/not configured/);
    await expect(r.readConfig('n', 'k')).rejects.toThrow(/not configured/);
  });
});

describe('shipped agents on pinned_context (#2339)', () => {
  const agentsDir = resolve(import.meta.dirname, '../../../agents');
  const load = (name: string) => loadAgentConfig(resolve(agentsDir, `${name}.yaml`));

  it.each([
    ['calendar', [{ kind: 'doc', path: '/shared/calendar/rules.md' }]],
    ['ceo-inbox', [
      { kind: 'doc', path: '/shared/inbox/rules.md' },
      { kind: 'config', namespace: 'ceo_inbox', key: 'decision_tagging' },
    ]],
    ['meeting-debrief', [{ kind: 'config', namespace: 'debrief', key: 'config' }]],
  ])('%s declares its standing state', (name, expected) => {
    const entries = parsePinnedContext(load(name).pinned_context, name);
    expect(entries).toEqual(expected.map(e => expect.objectContaining(e)));
    // Every entry carries a purpose line for the block.
    expect(entries.every(e => typeof e.description === 'string' && e.description.length > 0)).toBe(true);
  });

  it('no longer fetches pinned values with a tool call', () => {
    expect(load('calendar').system_prompt).not.toMatch(/key[:=] ?rules/);
    const inbox = load('ceo-inbox').system_prompt;
    expect(inbox).not.toMatch(/key[:=] ?rules/);
    expect(inbox).not.toMatch(/retrieve[\s\S]{0,80}decision_tagging/);
    expect(load('meeting-debrief').system_prompt).not.toMatch(/key `"config"`/);
  });

  it('pins doc-write wherever an agent declares a document it maintains', () => {
    for (const name of ['calendar', 'ceo-inbox']) {
      const pins = load(name).pinned_skills ?? [];
      expect(pins.includes('doc-write') || pins.includes('documents'), name).toBe(true);
    }
  });
});
