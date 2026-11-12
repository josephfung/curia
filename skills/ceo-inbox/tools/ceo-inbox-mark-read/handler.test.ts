import { describe, it, expect, vi, afterEach } from 'vitest';
import { CeoInboxMarkReadHandler } from './handler.js';
import type { ToolContext } from '../../../../src/skills/types.js';
import { twoMailboxFixture } from '../../../_shared/principal-mailboxes-test-helpers.js';

describe('CeoInboxMarkReadHandler mailbox selection (#2475)', () => {
  afterEach(() => vi.restoreAllMocks());

  function run(holders: Array<'work' | 'personal'>, extra: Record<string, unknown> = {}) {
    const f = twoMailboxFixture(holders);
    vi.spyOn(globalThis, 'fetch').mockImplementation(f.fetchStub as typeof fetch);
    const ctx = {
      input: { message_id: 'x1', ...extra }, principalMailboxes: f.principalMailboxes,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    } as unknown as ToolContext;
    return { f, result: new CeoInboxMarkReadHandler().execute(ctx) };
  }

  it('acts in the mailbox holding the message', async () => {
    const { f, result } = run(['personal']);
    expect((await result).success).toBe(true);
    expect(f.calls.some((c) => c.grant === 'grant-personal')).toBe(true);
    expect(f.calls.filter((c) => c.method !== 'GET').every((c) => c.grant === 'grant-personal')).toBe(true);
  });

  it('returns mailbox and mailbox_label', async () => {
    const { result } = run(['personal']);
    const r = await result;
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toMatchObject({ mailbox: 'personal', mailbox_label: 'Personal' });
  });

  it('missing mailbox never defaults: the default mailbox does not hold it, so the other one acts', async () => {
    const { f, result } = run(['personal']);
    await result;
    expect(f.calls.filter((c) => c.method !== 'GET').every((c) => c.grant !== 'grant-work')).toBe(true);
  });

  it('an explicit mailbox that does not hold the message is a miss, not a fallback', async () => {
    const { f, result } = run(['personal'], { mailbox: 'work' });
    expect((await result).success).toBe(false);
    expect(f.calls.every((c) => c.grant === 'grant-work')).toBe(true);
  });

  it('an unknown mailbox id is an error and nothing is fetched', async () => {
    const { f, result } = run(['work'], { mailbox: 'nope' });
    const r = await result;
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toContain('nope');
    expect(f.calls).toHaveLength(0);
  });

  it('refuses a message found in more than one mailbox', async () => {
    const { f, result } = run(['work', 'personal']);
    const r = await result;
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toContain('more than one mailbox');
    expect(f.calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
  });
});
