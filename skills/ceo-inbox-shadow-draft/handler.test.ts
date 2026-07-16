import { describe, it, expect, vi } from 'vitest';
import { CeoInboxShadowDraftHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';
import { shadowDraftPath } from '../_shared/shadow-draft.js';

describe('CeoInboxShadowDraftHandler', () => {
  it('skips high-sensitivity threads without writing', async () => {
    const create = vi.fn();
    const ctx = {
      input: {
        source_message_id: 'm1',
        subject: 'Board materials',
        body: 'Here is the pack',
      },
      workingDocs: { read: vi.fn().mockResolvedValue(null), create },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    } as unknown as SkillContext;
    const result = await new CeoInboxShadowDraftHandler().execute(ctx);
    expect(result.success).toBe(true);
    expect((result as { data: { captured: boolean } }).data.captured).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it('writes a non-surfaced shadow draft for ordinary punts', async () => {
    const create = vi.fn().mockResolvedValue({});
    const ctx = {
      input: {
        source_message_id: 'm2',
        thread_id: 't2',
        subject: 'Quick question',
        body: 'Happy to chat Thursday.',
        disposition: 'Seen',
        recipients: ['a@example.com'],
      },
      agentId: 'ceo-inbox',
      workingDocs: { read: vi.fn().mockResolvedValue(null), create },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    } as unknown as SkillContext;
    const result = await new CeoInboxShadowDraftHandler().execute(ctx);
    expect(result.success).toBe(true);
    expect((result as { data: { captured: boolean; path: string } }).data.captured).toBe(true);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        path: shadowDraftPath('m2'),
        frontmatter: expect.objectContaining({ shadow: true, disposition: 'Seen' }),
        body: 'Happy to chat Thursday.',
      }),
    );
  });
});
