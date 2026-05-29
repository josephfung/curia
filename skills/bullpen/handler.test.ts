import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BullpenHandler } from './handler.js';
import { BullpenService } from '../../src/memory/bullpen.js';
import { createLogger } from '../../src/logger.js';
import type { SkillContext } from '../../src/skills/types.js';

function makeCtx(input: Record<string, unknown>, overrides?: Partial<SkillContext>): SkillContext {
  const bullpenService = BullpenService.createInMemory();
  return {
    input,
    secret: () => { throw new Error('no secrets'); },
    log: createLogger('error'),
    agentId: 'coordinator',
    taskEventId: 'task-123',
    bullpenService,
    // bus is needed to publish agent.discuss — use a spy
    bus: {
      publish: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn(),
    } as unknown as SkillContext['bus'],
    agentRegistry: { list: vi.fn().mockReturnValue([]) } as unknown as SkillContext['agentRegistry'],
    ...overrides,
  } as unknown as SkillContext;
}

describe('BullpenHandler', () => {
  let handler: BullpenHandler;

  beforeEach(() => {
    handler = new BullpenHandler();
  });

  it('post: opens a thread and publishes agent.discuss', async () => {
    const ctx = makeCtx({
      action: 'post',
      topic: 'Q2 budget',
      participants: ['coordinator', 'research-agent'],
      content: 'Can you look into Q2 costs?',
      mentioned_agent_ids: ['research-agent'],
    });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    const data = (result as { success: true; data: Record<string, unknown> }).data;
    expect(typeof data.thread_id).toBe('string');
    expect(typeof data.message_id).toBe('string');
    expect(ctx.bus!.publish).toHaveBeenCalledOnce();
    const publishCall = (ctx.bus!.publish as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(publishCall[0]).toBe('agent');
    expect(publishCall[1].type).toBe('agent.discuss');
  });

  it('post: defaults mentionedAgentIds to all participants when omitted', async () => {
    const ctx = makeCtx({
      action: 'post',
      topic: 'Broadcast',
      participants: ['coordinator', 'agent-b', 'agent-c'],
      content: 'Heads up',
    });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    const publishCall = (ctx.bus!.publish as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(publishCall[1].payload.mentionedAgentIds).toEqual(['coordinator', 'agent-b', 'agent-c']);
  });

  it('reply: posts a message to an existing thread', async () => {
    // First open a thread
    const openCtx = makeCtx({
      action: 'post',
      topic: 'Reply test',
      participants: ['coordinator', 'agent-b'],
      content: 'Start',
      mentioned_agent_ids: ['agent-b'],
    });
    const openResult = await handler.execute(openCtx);
    const threadId = ((openResult as { success: true; data: Record<string, unknown> }).data).thread_id as string;

    // Now reply
    const replyCtx = makeCtx({
      action: 'reply',
      thread_id: threadId,
      content: 'Here is my reply',
      mentioned_agent_ids: ['coordinator'],
    }, { bullpenService: openCtx.bullpenService, bus: openCtx.bus, agentId: 'agent-b' });
    const replyResult = await handler.execute(replyCtx);
    expect(replyResult.success).toBe(true);
    // bus.publish called twice total (open + reply)
    expect((openCtx.bus!.publish as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
  });

  it('get_thread: returns full thread without publishing', async () => {
    const ctx = makeCtx({
      action: 'post',
      topic: 'Get test',
      participants: ['coordinator'],
      content: 'Only message',
    });
    const openResult = await handler.execute(ctx);
    const threadId = ((openResult as { success: true; data: Record<string, unknown> }).data).thread_id as string;

    const getCtx = makeCtx({ action: 'get_thread', thread_id: threadId }, { bullpenService: ctx.bullpenService, bus: ctx.bus });
    const result = await handler.execute(getCtx);
    expect(result.success).toBe(true);
    const data = (result as { success: true; data: Record<string, unknown> }).data;
    expect(data.thread).toBeDefined();
    expect((data.thread as { topic: string }).topic).toBe('Get test');
    // No additional publish after the open
    expect((ctx.bus!.publish as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('close: closes the thread without publishing', async () => {
    const ctx = makeCtx({
      action: 'post',
      topic: 'Close test',
      participants: ['coordinator'],
      content: 'Will close',
    });
    const openResult = await handler.execute(ctx);
    const threadId = ((openResult as { success: true; data: Record<string, unknown> }).data).thread_id as string;

    const closeCtx = makeCtx({ action: 'close', thread_id: threadId }, { bullpenService: ctx.bullpenService, bus: ctx.bus });
    const closeResult = await handler.execute(closeCtx);
    expect(closeResult.success).toBe(true);
    const data = (closeResult as { success: true; data: Record<string, unknown> }).data;
    expect((data as { status: string }).status).toBe('closed');
  });

  it('close: returns error when unauthorized agent tries to close', async () => {
    const ctx = makeCtx({
      action: 'post',
      topic: 'Auth test',
      participants: ['agent-b', 'agent-c'],
      content: 'Start',
    }, { agentId: 'agent-b' });
    const openResult = await handler.execute(ctx);
    const threadId = ((openResult as { success: true; data: Record<string, unknown> }).data).thread_id as string;

    // agent-c tries to close — not authorized
    const closeCtx = makeCtx(
      { action: 'close', thread_id: threadId },
      { bullpenService: ctx.bullpenService, bus: ctx.bus, agentId: 'agent-c' },
    );
    const closeResult = await handler.execute(closeCtx);
    expect(closeResult.success).toBe(false);
    expect((closeResult as { success: false; error: string }).error).toMatch(/not authorized/);
  });

  it('returns error for missing required fields', async () => {
    const ctx = makeCtx({ action: 'post' }); // missing topic, participants, content
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
  });

  it('returns error for unknown action', async () => {
    const ctx = makeCtx({ action: 'fly' });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/unknown action/i);
  });

  // Regression test for #721: bus.publish awaits subscribers sequentially
  // (see src/bus/bus.ts), so a slow agent.discuss subscriber would block
  // bullpen.post past its 10s skill timeout — even though the thread row was
  // already committed. The handler must return as soon as openThread commits;
  // publish is fire-and-forget per the handler comments.
  it('post: returns immediately even when bus.publish is slow', async () => {
    let publishResolve: (() => void) | undefined;
    const slowPublish = vi.fn().mockImplementation(
      () => new Promise<void>((resolve) => { publishResolve = resolve; }),
    );
    const ctx = makeCtx(
      {
        action: 'post',
        topic: 'slow subscriber',
        participants: ['coordinator', 'agent-b'],
        content: 'Should not block',
      },
      {
        bus: {
          publish: slowPublish,
          subscribe: vi.fn(),
        } as unknown as SkillContext['bus'],
      },
    );

    const start = Date.now();
    const result = await handler.execute(ctx);
    const elapsed = Date.now() - start;

    expect(result.success).toBe(true);
    // Publish is still in-flight, but handler returned without awaiting it.
    expect(slowPublish).toHaveBeenCalledOnce();
    expect(publishResolve).toBeDefined();
    // Generous upper bound — openThread is in-memory, should be milliseconds.
    expect(elapsed).toBeLessThan(500);

    // Cleanup so the dangling promise doesn't keep vitest open.
    publishResolve!();
  });

  it('reply: returns immediately even when bus.publish is slow', async () => {
    // Open a thread normally first.
    const openCtx = makeCtx({
      action: 'post',
      topic: 'slow reply',
      participants: ['coordinator', 'agent-b'],
      content: 'Start',
    });
    const openResult = await handler.execute(openCtx);
    const threadId = ((openResult as { success: true; data: Record<string, unknown> }).data).thread_id as string;

    let publishResolve: (() => void) | undefined;
    const slowPublish = vi.fn().mockImplementation(
      () => new Promise<void>((resolve) => { publishResolve = resolve; }),
    );
    const replyCtx = makeCtx(
      { action: 'reply', thread_id: threadId, content: 'reply body' },
      {
        bullpenService: openCtx.bullpenService,
        agentId: 'agent-b',
        bus: { publish: slowPublish, subscribe: vi.fn() } as unknown as SkillContext['bus'],
      },
    );

    const start = Date.now();
    const result = await handler.execute(replyCtx);
    const elapsed = Date.now() - start;

    expect(result.success).toBe(true);
    expect(slowPublish).toHaveBeenCalledOnce();
    expect(publishResolve).toBeDefined();
    expect(elapsed).toBeLessThan(500);

    publishResolve!();
  });

  it('post: returns existing thread when source_message_id matches a prior post', async () => {
    const ctx = makeCtx({
      action: 'post',
      topic: 'expense receipt',
      participants: ['coordinator', 't2125-expense-tracker'],
      content: 'Please process this receipt',
      source_message_id: 'email-msg-abc123',
    });

    const first = await handler.execute(ctx);
    expect(first.success).toBe(true);
    const firstData = (first as { success: true; data: Record<string, unknown> }).data;

    // Second post with the same source_message_id — simulates a duplicate ceo-inbox run
    const ctx2 = makeCtx({
      action: 'post',
      topic: 'expense receipt',
      participants: ['coordinator', 't2125-expense-tracker'],
      content: 'Please process this receipt',
      source_message_id: 'email-msg-abc123',
    }, { bullpenService: ctx.bullpenService, bus: ctx.bus });

    const second = await handler.execute(ctx2);
    expect(second.success).toBe(true);
    const secondData = (second as { success: true; data: Record<string, unknown> }).data;

    // Must return the same thread — no new thread opened
    expect(secondData.thread_id).toBe(firstData.thread_id);
    // Dedup flag must be set
    expect(secondData.deduplicated).toBe(true);
    // Bus publish called exactly once — no duplicate agent.discuss event
    expect((ctx.bus!.publish as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('post: concurrent duplicate posts (23505 race) — one thread, one publish', async () => {
    // Two handler.execute calls race with the same source_message_id on a shared
    // bullpenService. The in-memory backend now mirrors Postgres by throwing code
    // '23505' when the duplicate insert arrives. BullpenService.openThread catches
    // that, re-fetches the winning thread, and returns deduplicated: true — so the
    // handler skips the second bus.publish.
    const bullpenService = BullpenService.createInMemory();
    const bus = {
      publish: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn(),
    } as unknown as SkillContext['bus'];

    const makeRaceCtx = () => makeCtx(
      {
        action: 'post',
        topic: 'concurrent topic',
        participants: ['coordinator', 'agent-b'],
        content: 'racing message',
        source_message_id: 'email-race-concurrent',
      },
      { bullpenService, bus },
    );

    const [r1, r2] = await Promise.all([
      handler.execute(makeRaceCtx()),
      handler.execute(makeRaceCtx()),
    ]);

    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    const d1 = (r1 as { success: true; data: Record<string, unknown> }).data;
    const d2 = (r2 as { success: true; data: Record<string, unknown> }).data;
    // Both must reference the same winning thread
    expect(d1.thread_id).toBe(d2.thread_id);
    // Exactly one call was marked as a dedup hit
    expect([d1.deduplicated, d2.deduplicated].filter(Boolean)).toHaveLength(1);
    // bus.publish fired exactly once — no duplicate agent.discuss
    expect((bus.publish as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('post: a publish rejection does not surface as a handler failure', async () => {
    const failingPublish = vi.fn().mockRejectedValue(new Error('bus exploded'));
    const ctx = makeCtx(
      {
        action: 'post',
        topic: 'publish fail',
        participants: ['coordinator'],
        content: 'still ok',
      },
      {
        bus: { publish: failingPublish, subscribe: vi.fn() } as unknown as SkillContext['bus'],
      },
    );

    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);

    // Let the rejected promise settle so the .catch() runs before the test
    // exits — otherwise vitest may flag an unhandled rejection.
    await new Promise((r) => setImmediate(r));
    expect(failingPublish).toHaveBeenCalledOnce();
  });
});
