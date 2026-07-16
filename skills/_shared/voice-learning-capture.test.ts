import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  captureDraftSnapshot,
  draftSnapshotPath,
  parseLinkedTaskIds,
  VOICE_LEARNING_DOC_TYPE,
} from './voice-learning-capture.js';
import type { SkillContext } from '../../src/skills/types.js';

function buildCtx(workingDocs?: {
  read: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
}): SkillContext {
  return {
    agentId: 'ceo-inbox',
    conversationId: 'conv-1',
    workingDocs,
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  } as unknown as SkillContext;
}

const SNAPSHOT = {
  draftId: 'draft-abc',
  threadId: 'thread-1',
  subject: 'Re: Hello',
  to: [{ email: 'alice@example.com', name: 'Alice' }],
  cc: [{ email: 'bob@example.com' }],
  body: 'Thanks for the note.',
  agentVersion: '0.3.0',
  linkedTaskIds: ['task-1'],
};

describe('parseLinkedTaskIds', () => {
  it('returns trimmed string ids', () => {
    expect(parseLinkedTaskIds(['  a  ', 'b', '', 3, null])).toEqual(['a', 'b']);
  });

  it('returns [] for non-arrays', () => {
    expect(parseLinkedTaskIds(undefined)).toEqual([]);
    expect(parseLinkedTaskIds('task-1')).toEqual([]);
  });
});

describe('captureDraftSnapshot', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-16T12:00:00.000Z'));
  });

  it('writes a create snapshot with the expected frontmatter and body', async () => {
    const create = vi.fn().mockResolvedValue({ path: draftSnapshotPath('draft-abc') });
    const read = vi.fn().mockResolvedValue(null);
    const ctx = buildCtx({ read, create, update: vi.fn() });

    const ok = await captureDraftSnapshot(ctx, SNAPSHOT);
    expect(ok).toBe(true);
    expect(create).toHaveBeenCalledWith({
      path: '/scratch/voice-learning/draft-abc.md',
      type: VOICE_LEARNING_DOC_TYPE,
      frontmatter: {
        draft_id: 'draft-abc',
        thread_id: 'thread-1',
        recipients: {
          to: [{ email: 'alice@example.com', name: 'Alice' }],
          cc: [{ email: 'bob@example.com' }],
        },
        subject: 'Re: Hello',
        created_at: '2026-07-16T12:00:00.000Z',
        linked_task_ids: ['task-1'],
        agent_version: '0.3.0',
      },
      body: 'Thanks for the note.',
      agentId: 'ceo-inbox',
      conversationId: 'conv-1',
    });
  });

  it('updates an existing snapshot on edit without blocking', async () => {
    const update = vi.fn().mockResolvedValue({ ok: true, document: {} });
    const read = vi.fn().mockResolvedValue({
      version: 2,
      frontmatter: { created_at: '2026-07-01T00:00:00.000Z', draft_id: 'draft-abc' },
      body: 'old',
    });
    const ctx = buildCtx({ read, create: vi.fn(), update });

    const ok = await captureDraftSnapshot(ctx, { ...SNAPSHOT, body: 'revised body' });
    expect(ok).toBe(true);
    expect(update).toHaveBeenCalledWith(
      '/scratch/voice-learning/draft-abc.md',
      expect.objectContaining({
        body: 'revised body',
        expectedVersion: 2,
        frontmatter: expect.objectContaining({
          created_at: '2026-07-01T00:00:00.000Z',
          updated_at: '2026-07-16T12:00:00.000Z',
        }),
      }),
    );
  });

  it('logs and returns false when workingDocs is missing — non-blocking', async () => {
    const ctx = buildCtx(undefined);
    const ok = await captureDraftSnapshot(ctx, SNAPSHOT);
    expect(ok).toBe(false);
    expect(ctx.log.warn).toHaveBeenCalled();
  });

  it('logs and returns false when create throws — non-blocking', async () => {
    const create = vi.fn().mockRejectedValue(new Error('db down'));
    const read = vi.fn().mockResolvedValue(null);
    const ctx = buildCtx({ read, create, update: vi.fn() });

    const ok = await captureDraftSnapshot(ctx, SNAPSHOT);
    expect(ok).toBe(false);
    expect(ctx.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ draftId: 'draft-abc' }),
      expect.stringContaining('failed to write draft snapshot'),
    );
  });
});
