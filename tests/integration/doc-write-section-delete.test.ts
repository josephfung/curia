// Integration: doc-write `section-delete` and the standing-rules documents it serves (#2339).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WorkingDocsRepo } from '../../src/db/working-docs-repo.js';
import { createSilentLogger } from '../../src/logger.js';
import { createIsolatedWorkingDocsStore, type IsolatedWorkingDocsStore } from '../helpers/isolated-working-docs.js';
import { AgentRegistry } from '../../src/agents/agent-registry.js';
import type { ToolContext } from '../../src/skills/types.js';
import { DocWriteHandler } from '../../skills/documents/tools/doc-write/handler.js';
import { createPinnedContextReader, renderPinnedContextBlock } from '../../src/agents/pinned-context.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

const RULES = `Each rule is a \`##\` section with When / Do / Status lines.

## Board mail

- When: from anyone at the board's domain
- Do: label BOARD, classify as 🚨 Urgent
- Status: active

## Newsletters

- When: newsletters from Substack
- Do: archive (✔️ Cleared)
- Status: paused
`;

describeIf('doc-write section-delete (#2339)', () => {
  let store: IsolatedWorkingDocsStore;
  let repo: WorkingDocsRepo;

  beforeAll(async () => {
    store = await createIsolatedWorkingDocsStore(DATABASE_URL!);
    repo = new WorkingDocsRepo(store.pool, createSilentLogger());
  });

  afterAll(async () => {
    await store?.drop();
  });

  it('removes the heading and body, drops the section version, and bumps the document version', async () => {
    const path = '/projects/rules-a/rules.md';
    await repo.create({ path, type: 'agent-settings', body: RULES });
    // Two spellings of one heading, as section-edit keys them by the caller's text.
    expect((await repo.editSection(path, { section: 'Board mail', content: '- Status: active' })).ok).toBe(true);
    expect((await repo.editSection(path, { section: 'board MAIL', content: '- Status: paused' })).ok).toBe(true);
    expect((await repo.editSection(path, { section: 'Newsletters', content: '- Status: paused' })).ok).toBe(true);
    const before = (await repo.read(path))!;
    expect(before.sectionVersions).toEqual({ 'Board mail': 1, 'board MAIL': 1, Newsletters: 1 });

    const result = await repo.deleteSection(path, { section: 'Board mail', expectedSectionVersion: 1 });

    expect(result.ok).toBe(true);
    const after = (await repo.read(path))!;
    expect(after.version).toBe(before.version + 1);
    expect(after.body).not.toMatch(/board mail/i);
    expect(after.body).toContain('Each rule is a `##` section');
    expect(after.body).toContain('## Newsletters');
    expect(after.sectionVersions).toEqual({ Newsletters: 1 });
  });

  it('refuses a stale expected_section_version and changes nothing', async () => {
    const path = '/projects/rules-b/rules.md';
    await repo.create({ path, type: 'agent-settings', body: RULES });
    await repo.editSection(path, { section: 'Board mail', content: '- Status: paused' });
    const before = (await repo.read(path))!;

    const result = await repo.deleteSection(path, { section: 'Board mail', expectedSectionVersion: 0 });

    expect(result.ok).toBe(false);
    expect('conflict' in result && result.conflict).toBe(true);
    const after = (await repo.read(path))!;
    expect(after.version).toBe(before.version);
    expect(after.body).toBe(before.body);
    expect(after.sectionVersions).toEqual(before.sectionVersions);
  });

  it('reports a missing section and changes nothing', async () => {
    const path = '/projects/rules-c/rules.md';
    const created = await repo.create({ path, type: 'agent-settings', body: RULES });

    const result = await repo.deleteSection(path, { section: 'Coffee' });

    expect(result).toMatchObject({ ok: false, missingSection: true });
    const after = (await repo.read(path))!;
    expect(after.version).toBe(created.version);
    expect(after.body).toBe(RULES);
  });

  describe('through doc-write on a /shared/ rules document', () => {
    const path = '/shared/inbox/rules.md';
    let registry: AgentRegistry;

    const ctx = (input: Record<string, unknown>) => ({
      input,
      log: createSilentLogger(),
      timezone: 'UTC',
      agentId: 'ceo-inbox',
      agentRegistry: registry,
      workingDocs: repo,
    } as unknown as ToolContext);

    beforeAll(() => {
      registry = new AgentRegistry();
      registry.register('ceo-inbox', { role: 'specialist', description: 'inbox', pinnedDocPaths: [path] });
    });

    it('deletes a rule, logs it to the folder log.md, and errors on a rule that is not there', async () => {
      expect((await new DocWriteHandler().execute(ctx({ path, mode: 'create', type: 'agent-settings', body: RULES })))
        .success).toBe(true);

      const removed = await new DocWriteHandler().execute(ctx({
        path, mode: 'section-delete', section: 'Newsletters', summary: 'Removed the Substack rule',
      }));
      expect(removed.success).toBe(true);
      expect((await repo.read(path))!.body).not.toContain('Newsletters');
      const log = (await repo.read('/shared/inbox/log.md'))!;
      expect(log.body).toContain('section-delete');
      expect(log.body).toContain('Removed the Substack rule (Newsletters)');

      const versionBefore = (await repo.read(path))!.version;
      const missing = await new DocWriteHandler().execute(ctx({ path, mode: 'section-delete', section: 'Newsletters' }));
      expect(missing.success).toBe(false);
      expect((await repo.read(path))!.version).toBe(versionBefore);
    });

    it('stores and injects a rule set longer than config-store\'s 2000-character cap', async () => {
      const bigPath = '/shared/calendar/rules.md';
      registry.register('calendar', { role: 'specialist', description: 'calendar', pinnedDocPaths: [bigPath] });
      const rules = Array.from({ length: 30 }, (_, i) => [
        `## Rule ${i + 1}`,
        '',
        `- Applies to: meetings of kind ${i + 1}`,
        `- Do: prefer slots between 9 AM and 12 PM, ${30 + i} minutes, never on Fridays`,
        '- Status: active',
      ].join('\n')).join('\n\n');
      expect(rules.length).toBeGreaterThan(2000);
      const calendarCtx = { ...ctx({ path: bigPath, mode: 'create', type: 'agent-settings', body: rules }), agentId: 'calendar' };
      expect((await new DocWriteHandler().execute(calendarCtx as ToolContext)).success).toBe(true);

      const reader = createPinnedContextReader({ workingDocsRepo: repo, logger: createSilentLogger() });
      const block = await renderPinnedContextBlock([{ kind: 'doc', path: bigPath }], reader, {
        agentId: 'calendar',
        logger: createSilentLogger(),
      });
      expect(block).toContain('## Rule 1\n');
      expect(block).toContain('## Rule 30\n');
      expect(block).toContain('never on Fridays');
    });
  });
});
