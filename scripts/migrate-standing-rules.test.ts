import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import type { WorkingDocRow } from '../src/db/working-docs-repo.js';
import { splitSections } from '../src/memory/okf.js';
import {
  RULE_SETS,
  formatMigrationReport,
  headingFor,
  parseRules,
  runMigration,
  type MigrationDeps,
} from './migrate-standing-rules.js';

const INBOX = RULE_SETS[0]!;
const CALENDAR = RULE_SETS[1]!;

const INBOX_RULES = JSON.stringify([
  { condition: 'From the board (anyone @board.example.test)', instruction: 'Label BOARD and classify as 🚨 Urgent', active: true },
  { condition: 'Newsletters from Substack', instruction: 'Archive (✔️ Cleared)', active: false },
  { condition: 'Newsletters from Substack', instruction: 'Label READING', active: true },
]);
const CALENDAR_RULES = JSON.stringify([
  { applies_to: 'drinks', instruction: 'after work only:\n start at 5:30 PM or later, 90 minutes', active: true },
]);

/** An in-memory workspace: live rows by path, plus paths that only hold an archived row. */
function fakeDeps(config: Record<string, string>, opts: { archived?: string[] } = {}) {
  const rows = new Map<string, WorkingDocRow>();
  const archived = new Set(opts.archived ?? []);
  const row = (params: { path: string; type: string; body?: string; frontmatter?: Record<string, unknown>; taskId?: string | null; agentId?: string }): WorkingDocRow => ({
    id: params.path,
    path: params.path,
    type: params.type,
    frontmatter: params.frontmatter ?? {},
    body: params.body ?? '',
    version: 1,
    sectionVersions: {},
    byteSize: 0,
    taskId: params.taskId ?? null,
    conversationId: null,
    agentId: params.agentId ?? null,
    createdAt: '2026-10-29T00:00:00.000Z',
    updatedAt: '2026-10-29T00:00:00.000Z',
    archivedAt: null,
  });
  const docs = {
    existsAtPath: vi.fn(async (path: string) => rows.has(path) || archived.has(path)),
    read: vi.fn(async (path: string) => rows.get(path) ?? null),
    create: vi.fn(async (params: Parameters<MigrationDeps['docs']['create']>[0]) => {
      const created = row(params);
      rows.set(params.path, created);
      return created;
    }),
    append: vi.fn(async (path: string, params: { content: string }) => {
      const current = rows.get(path)!;
      const next = { ...current, body: `${current.body}\n${params.content}`, version: current.version + 1 };
      rows.set(path, next);
      return { ok: true as const, document: next };
    }),
  };
  const deps: MigrationDeps = {
    readConfig: vi.fn(async (namespace: string, key: string) => config[`${namespace}/${key}`] ?? null),
    docs: docs as unknown as MigrationDeps['docs'],
    logger: pino({ level: 'silent' }),
  };
  return { deps, rows, docs };
}

describe('parseRules', () => {
  it('keeps every rule in order, paused ones included, folded onto one line', () => {
    expect(parseRules(CALENDAR_RULES, CALENDAR)).toEqual([
      { scope: 'drinks', instruction: 'after work only: start at 5:30 PM or later, 90 minutes', active: true },
    ]);
    expect(parseRules(INBOX_RULES, INBOX).map(r => r.active)).toEqual([true, false, true]);
  });

  it('treats a rule without `active` as live, as the agents did', () => {
    expect(parseRules('[{"condition":"a","instruction":"b"}]', INBOX)[0]!.active).toBe(true);
  });

  it.each([
    ['', /not valid JSON/],
    ['{"condition":"a"}', /not a JSON array/],
    ['["a"]', /rule 1 is not an object/],
    ['[{"instruction":"b"}]', /rule 1 has no 'condition'/],
    ['[{"condition":"a","instruction":" "}]', /rule 1 has no 'instruction'/],
    ['[{"condition":"a","instruction":"b","active":"no"}]', /non-boolean 'active'/],
  ])('refuses %j', (raw, error) => {
    expect(() => parseRules(raw, INBOX)).toThrow(error);
  });

  it('reads calendar rules by applies_to, not condition', () => {
    expect(() => parseRules('[{"condition":"a","instruction":"b"}]', CALENDAR)).toThrow(/'applies_to'/);
  });
});

describe('headingFor', () => {
  it('cuts a long scope at a word and strips heading markup', () => {
    const heading = headingFor('## Anything from the board or the audit committee about the quarterly numbers, any year', 0);
    expect(heading).not.toContain('#');
    expect(heading.length).toBeLessThanOrEqual(61);
    expect(heading.endsWith('…')).toBe(true);
  });

  it('falls back to a numbered heading for a scope with no text left', () => {
    expect(headingFor('###', 2)).toBe('Rule 3');
  });
});

describe('runMigration', () => {
  it('dry-runs by default: reports what it would write and writes nothing', async () => {
    const { deps, docs } = fakeDeps({ 'ceo_inbox/rules': INBOX_RULES, 'calendar/rules': CALENDAR_RULES });
    const result = await runMigration(deps, { apply: false });
    expect(result.dryRun).toBe(true);
    expect(result.outcomes.map(o => o.status)).toEqual(['ready', 'ready']);
    expect(docs.create).not.toHaveBeenCalled();
    expect(formatMigrationReport(result)).toContain('would write, 3 rules (1 paused)');
  });

  it('writes one section per rule, in order, with paused rules kept and unique headings', async () => {
    const { deps, rows } = fakeDeps({ 'ceo_inbox/rules': INBOX_RULES, 'calendar/rules': CALENDAR_RULES });
    const result = await runMigration(deps, { apply: true });
    expect(result.outcomes.map(o => o.status)).toEqual(['written', 'written']);

    const inbox = rows.get('/shared/inbox/rules.md')!;
    expect(inbox).toMatchObject({ type: 'agent-settings', frontmatter: { title: 'Inbox standing rules' }, taskId: null, agentId: 'ceo-inbox' });
    const { preamble, sections } = splitSections(inbox.body);
    expect(preamble).toContain('When / Do / Status');
    expect(sections.map(s => s.heading)).toEqual([
      'From the board (anyone @board.example.test)',
      'Newsletters from Substack',
      'Newsletters from Substack (2)',
    ]);
    expect(sections[1]!.content).toContain('- When: Newsletters from Substack\n- Do: Archive (✔️ Cleared)\n- Status: paused');
    expect(sections[2]!.content).toContain('- Status: active');

    const calendar = rows.get('/shared/calendar/rules.md')!;
    expect(calendar.body).toContain('- Applies to: drinks\n- Do: after work only: start at 5:30 PM or later, 90 minutes\n- Status: active');
    // Each folder's log.md records the migration.
    expect(rows.get('/shared/inbox/log.md')?.body).toContain('Migrated 3 rules from config-store ceo_inbox/rules');
  });

  it('is idempotent: a second run skips both documents and writes nothing', async () => {
    const { deps, docs } = fakeDeps({ 'ceo_inbox/rules': INBOX_RULES, 'calendar/rules': CALENDAR_RULES });
    await runMigration(deps, { apply: true });
    docs.create.mockClear();

    const again = await runMigration(deps, { apply: true });
    expect(again.outcomes.map(o => o.status)).toEqual(['exists', 'exists']);
    expect(docs.create).not.toHaveBeenCalled();
    expect(formatMigrationReport(again)).toContain('skipped, the document already exists');
  });

  it('skips a path that holds only an archived document, so the principal can still restore it', async () => {
    const { deps, docs } = fakeDeps({ 'ceo_inbox/rules': INBOX_RULES }, { archived: ['/shared/inbox/rules.md'] });
    const result = await runMigration(deps, { apply: true, specs: [INBOX] });
    expect(result.outcomes[0]!.status).toBe('exists');
    expect(docs.create).not.toHaveBeenCalled();
  });

  it('skips a key that was never set', async () => {
    const { deps, docs } = fakeDeps({ 'calendar/rules': CALENDAR_RULES });
    const result = await runMigration(deps, { apply: true });
    expect(result.outcomes.map(o => o.status)).toEqual(['not_set', 'written']);
    expect(docs.create.mock.calls.map(([params]) => params.path)).toEqual(['/shared/calendar/rules.md', '/shared/calendar/log.md']);
  });

  it('refuses an invalid value and writes nothing at all, not even the valid document', async () => {
    const { deps, docs } = fakeDeps({ 'ceo_inbox/rules': INBOX_RULES, 'calendar/rules': '{"applies_to":"drinks"}' });
    const result = await runMigration(deps, { apply: true });
    expect(result.failed).toBe(true);
    expect(result.outcomes.map(o => o.status)).toEqual(['ready', 'invalid']);
    expect(docs.create).not.toHaveBeenCalled();
    const report = formatMigrationReport(result);
    expect(report).toContain('INVALID, not a JSON array');
    expect(report).toContain('Nothing was written');
  });

  it('migrates a rule set longer than config-store\'s 2000-character cap whole', async () => {
    const many = JSON.stringify(Array.from({ length: 40 }, (_, i) => ({
      applies_to: `meetings of kind ${i + 1}`,
      instruction: `prefer slots between 9 AM and 12 PM, ${30 + i} minutes`,
      active: i % 3 !== 0,
    })));
    expect(many.length).toBeGreaterThan(2000);
    const { deps, rows } = fakeDeps({ 'calendar/rules': many });
    await runMigration(deps, { apply: true, specs: [CALENDAR] });
    const { sections } = splitSections(rows.get('/shared/calendar/rules.md')!.body);
    expect(sections).toHaveLength(40);
    expect(sections[39]!.content).toContain('- Applies to: meetings of kind 40');
  });
});
