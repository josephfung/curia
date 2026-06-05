// handler.test.ts — unit tests for ceo-inbox-mark-starred skill.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { CeoInboxMarkStarredHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';
import { createSilentLogger } from '../../src/logger.js';

function makeCtx(overrides?: Partial<SkillContext> & { input?: Record<string, unknown> }): SkillContext {
  return {
    input: { message_id: 'msg-123' },
    secret: (_name: string) => 'test-secret',
    log: createSilentLogger(),
    taskMetadata: {},
    taskEventId: undefined,
    ...overrides,
  } as unknown as SkillContext;
}

describe('CeoInboxMarkStarredHandler', () => {
  // Guarantees spy cleanup even when a test assertion throws before mockRestore()
  afterEach(() => vi.restoreAllMocks());

  it('returns error when message_id is missing', async () => {
    const handler = new CeoInboxMarkStarredHandler();
    const result = await handler.execute(makeCtx({ input: {} }));
    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('message_id');
  });

  it('calls markAsStarred with starred=true by default and returns success', async () => {
    const handler = new CeoInboxMarkStarredHandler();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { id: 'msg-123', unread: false, starred: true } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const result = await handler.execute(makeCtx());
    expect(result.success).toBe(true);
    expect((result as { data: Record<string, unknown> }).data).toEqual({
      message_id: 'msg-123',
      starred: true,
    });

    fetchSpy.mockRestore();
  });

  it('returns error when the Nylas API call fails', async () => {
    const handler = new CeoInboxMarkStarredHandler();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(
      new Error('Network failure'),
    );

    const result = await handler.execute(makeCtx());
    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('Failed to mark message as starred');

    fetchSpy.mockRestore();
  });

  it('passes starred=false when explicitly set to false', async () => {
    const handler = new CeoInboxMarkStarredHandler();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { id: 'msg-123', starred: false } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const result = await handler.execute(makeCtx({ input: { message_id: 'msg-123', starred: false } }));
    expect(result.success).toBe(true);
    expect((result as { data: Record<string, unknown> }).data).toEqual({
      message_id: 'msg-123',
      starred: false,
    });

    // Verify the PUT body contained starred: false
    const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
    expect(body.starred).toBe(false);

    fetchSpy.mockRestore();
  });

  it('accepts starred="false" (string) and unstarred the message', async () => {
    const handler = new CeoInboxMarkStarredHandler();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { id: 'msg-123', starred: false } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const result = await handler.execute(makeCtx({ input: { message_id: 'msg-123', starred: 'false' } }));
    expect(result.success).toBe(true);
    expect((result as { data: Record<string, unknown> }).data).toEqual({
      message_id: 'msg-123',
      starred: false,
    });

    const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
    expect(body.starred).toBe(false);
  });

  it('accepts starred="true" (string) and stars the message', async () => {
    const handler = new CeoInboxMarkStarredHandler();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { id: 'msg-123', starred: true } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const result = await handler.execute(makeCtx({ input: { message_id: 'msg-123', starred: 'true' } }));
    expect(result.success).toBe(true);
    expect((result as { data: Record<string, unknown> }).data).toEqual({
      message_id: 'msg-123',
      starred: true,
    });
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('returns error for non-boolean starred value', async () => {
    const handler = new CeoInboxMarkStarredHandler();
    const result = await handler.execute(makeCtx({ input: { message_id: 'msg-123', starred: 42 } }));
    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('starred must be a boolean');
  });
});
