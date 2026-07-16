import { describe, it, expect, vi } from 'vitest';
import { ListLearningDigestHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';
import { PENDING_PROPOSALS_PATH } from '../voice-learn/handler.js';
import { COMPLETION_DIGEST_PATH } from '../task-completion-from-sent/handler.js';

describe('ListLearningDigestHandler', () => {
  it('returns empty message when no items', async () => {
    const ctx = {
      workingDocs: {
        read: vi.fn().mockResolvedValue(null),
      },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    } as unknown as SkillContext;
    const result = await new ListLearningDigestHandler().execute(ctx);
    expect(result.success).toBe(true);
    const data = (result as { data: { sections_markdown: string; message?: string } }).data;
    expect(data.sections_markdown).toBe('');
    expect(data.message).toContain('No pending');
  });

  it('renders both sections when items exist', async () => {
    const ctx = {
      workingDocs: {
        read: vi.fn(async (path: string) => {
          if (path === PENDING_PROPOSALS_PATH) {
            return {
              body: `## Proposal — signOff\n- status: pending\n- description: Prefer Thanks\n- sample_count: 3\n- consistency: 1.00\n- patch: {"sign_off":"Thanks"}\n---\n`,
              version: 1,
            };
          }
          if (path === COMPLETION_DIGEST_PATH) {
            return {
              body: `## Undo — task t1\n- status: undo_available\n- task_title: Follow up\n- note: Marked done. Undo?\n---\n`,
              version: 1,
            };
          }
          return null;
        }),
      },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    } as unknown as SkillContext;
    const result = await new ListLearningDigestHandler().execute(ctx);
    expect(result.success).toBe(true);
    const data = (result as { data: { sections_markdown: string } }).data;
    expect(data.sections_markdown).toContain('### Proposed voice diffs');
    expect(data.sections_markdown).toContain('### Task completion from sent mail');
  });
});
