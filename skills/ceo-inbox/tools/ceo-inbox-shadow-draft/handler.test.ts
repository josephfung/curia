import { afterEach, describe, it, expect, vi } from 'vitest';
import { CeoInboxShadowDraftHandler } from './handler.js';
import type { ToolContext } from '../../../../src/skills/types.js';
import { stubPrincipalMailboxes, mailboxView } from '../../../_shared/principal-mailboxes-test-helpers.js';
import { shadowDraftPath } from '../../../_shared/shadow-draft.js';

describe('CeoInboxShadowDraftHandler', () => {
  it('captures a board-subject thread (no sensitivity exclusion)', async () => {
    const create = vi.fn().mockResolvedValue({});
    const ctx = { input: { source_message_id: 'm9', subject: 'Board pack for Friday', body: 'Draft reply.' },
      agentId: 'ceo-inbox', workingDocs: { read: vi.fn().mockResolvedValue(null), create },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } } as unknown as ToolContext;
    const result = await new CeoInboxShadowDraftHandler().execute(ctx);
    expect((result as { data: { captured: boolean } }).data.captured).toBe(true);
    expect(create).toHaveBeenCalled();
  });

  it('writes a non-surfaced shadow draft for ordinary punts', async () => {
    const create = vi.fn().mockResolvedValue({});
    const ctx = {
      input: {
        source_message_id: 'm2',
        thread_id: 't2',
        subject: 'Quick question',
        body: 'Happy to chat Thursday.',
        recipients: ['a@example.com'],
      },
      agentId: 'ceo-inbox',
      workingDocs: { read: vi.fn().mockResolvedValue(null), create },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    } as unknown as ToolContext;
    const result = await new CeoInboxShadowDraftHandler().execute(ctx);
    expect(result.success).toBe(true);
    expect((result as { data: { captured: boolean; path: string } }).data.captured).toBe(true);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        path: shadowDraftPath('m2'),
        frontmatter: expect.objectContaining({ shadow: true }),
        body: 'Happy to chat Thursday.',
      }),
    );
  });
});

describe('CeoInboxShadowDraftHandler — mailbox input (#2475)', () => {
  it('refuses an unknown mailbox id and stores nothing', async () => {
    const create = vi.fn().mockResolvedValue({});
    const ctx = { input: { source_message_id: 'm9', subject: 's', body: 'Draft.', mailbox: 'nope' },
      agentId: 'ceo-inbox', workingDocs: { read: vi.fn().mockResolvedValue(null), create },
      principalMailboxes: stubPrincipalMailboxes({}),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } } as unknown as ToolContext;
    const result = await new CeoInboxShadowDraftHandler().execute(ctx);
    expect(result.success).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('CeoInboxShadowDraftHandler — records the mailbox (#2475, D8)', () => {
  afterEach(() => vi.restoreAllMocks());
  /** The locate probe: a grant mapped to true holds the message; any other answers 404. */
  const holders = (byGrant: Record<string, boolean>) =>
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const grant = /\/grants\/([^/]+)/.exec(String(url))![1]!;
      if (byGrant[grant]) return new Response(JSON.stringify({ data: { id: 'm9', from: [], to: [], cc: [], folders: ['INBOX'] } }), { status: 200 });
      return new Response('{}', { status: 404 });
    });
  const run = async (input: Record<string, unknown>, withRegistry = true) => {
    const create = vi.fn().mockResolvedValue({});
    const warn = vi.fn();
    const ctx = { input: { source_message_id: 'm9', subject: 's', body: 'Draft.', ...input },
      agentId: 'ceo-inbox', workingDocs: { read: vi.fn().mockResolvedValue(null), create },
      ...(withRegistry ? { principalMailboxes: stubPrincipalMailboxes({ mailboxes: [mailboxView('work', 'Work', 'a@example.com', true), mailboxView('personal', 'Personal', 'b@example.com')], grantId: (id: string) => `grant-${id}` }) } : {}),
      log: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() } } as unknown as ToolContext;
    await new CeoInboxShadowDraftHandler().execute(ctx);
    return { ...(create.mock.calls[0]![0] as { frontmatter: Record<string, unknown> }), warn };
  };

  it('stores the named mailbox', async () => {
    expect((await run({ mailbox: 'personal' })).frontmatter.mailbox).toBe('personal');
  });
  it('finds the mailbox holding the source message when none is named (R69, SF-I8)', async () => {
    holders({ 'grant-personal': true });
    expect((await run({})).frontmatter.mailbox).toBe('personal');
  });
  it('falls back to the default mailbox, logged, only when the message is found nowhere (R69)', async () => {
    holders({});
    const r = await run({});
    expect(r.frontmatter.mailbox).toBe('work');
    expect(r.warn).toHaveBeenCalled();
  });
  it('stores none without a registry (reads as the migrated mailbox)', async () => {
    expect(await run({}, false)).toSatisfy((c: { frontmatter: Record<string, unknown> }) => !('mailbox' in c.frontmatter));
  });
});
