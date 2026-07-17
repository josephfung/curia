import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  captureDraftSnapshot,
  draftSnapshotPath,
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
};

describe('captureDraftSnapshot', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-16T12:00:00.000Z'));
  });

  // Restore real timers so the mocked clock can't leak into later suites in the same worker.
  afterEach(() => {
    vi.useRealTimers();
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

  it('preserves created_at from the first write on a body-only edit', async () => {
    const update = vi.fn().mockResolvedValue({ ok: true, document: {} });
    const read = vi.fn().mockResolvedValue({
      version: 3,
      frontmatter: { created_at: '2026-07-01T00:00:00.000Z', draft_id: 'draft-abc' },
      body: 'old',
    });
    const ctx = buildCtx({ read, create: vi.fn(), update });

    const ok = await captureDraftSnapshot(ctx, { ...SNAPSHOT, body: 'edited body' });
    expect(ok).toBe(true);
    expect(update).toHaveBeenCalledWith(
      '/scratch/voice-learning/draft-abc.md',
      expect.objectContaining({
        frontmatter: expect.objectContaining({
          created_at: '2026-07-01T00:00:00.000Z',
          updated_at: '2026-07-16T12:00:00.000Z',
        }),
      }),
    );
  });

  it('drops the snapshot on a version conflict without retrying (best-effort)', async () => {
    const update = vi
      .fn()
      .mockResolvedValue({ ok: false, conflict: true, document: { version: 9, frontmatter: {} } });
    const read = vi.fn().mockResolvedValue({
      version: 2,
      frontmatter: { created_at: '2026-07-01T00:00:00.000Z', draft_id: 'draft-abc' },
      body: 'old',
    });
    const ctx = buildCtx({ read, create: vi.fn(), update });

    const ok = await captureDraftSnapshot(ctx, { ...SNAPSHOT, body: 'revised' });
    expect(ok).toBe(false);
    expect(update).toHaveBeenCalledTimes(1); // no retry on conflict
    expect(ctx.log.warn).toHaveBeenCalled();
  });
});
