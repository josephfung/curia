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
});
