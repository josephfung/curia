import { describe, it, expect, vi } from 'vitest';
import { BullpenReplyHandler } from './handler.js';
import type { ToolContext } from '../../../../src/skills/types.js';
import {
  dataOf, errorOf, JOB_ID, makeCtx, makeCtxWithWarn, openThread, publishCalls, RUN_CONV,
} from '../../../_shared/bullpen-test-helpers.js';

const handler = new BullpenReplyHandler();

type DiscussCall = [string, { payload: Record<string, unknown> }];

describe('bullpen-reply', () => {
  it('posts a message to an existing thread', async () => {
    const { threadId, ctx: openCtx } = await openThread({
      topic: 'Reply test',
      participants: ['coordinator', 'agent-b'],
      content: 'Start',
      mentioned_agent_ids: ['agent-b'],
    });

    const replyCtx = makeCtx({
      thread_id: threadId,
      content: 'Here is my reply',
      mentioned_agent_ids: ['coordinator'],
    }, { bullpenService: openCtx.bullpenService, bus: openCtx.bus, agentId: 'agent-b' });
    const data = dataOf(await handler.execute(replyCtx));
    expect(data.thread_id).toBe(threadId);
    expect(typeof data.message_id).toBe('string');
    // bus.publish called twice total (open + reply)
    expect(publishCalls(openCtx)).toHaveLength(2);
    expect((publishCalls(openCtx)[1] as DiscussCall)[1].payload.mentionedAgentIds).toEqual(['coordinator']);
  });

  it('close_after=true posts the reply and closes the thread', async () => {
    const { threadId, ctx: openCtx } = await openThread({
      topic: 'Close-after test',
      participants: ['coordinator', 'agent-b'],
      content: 'Start',
      mentioned_agent_ids: ['agent-b'],
    });

    const replyCtx = makeCtx(
      { thread_id: threadId, content: 'Concluding reply', close_after: true },
      { bullpenService: openCtx.bullpenService, bus: openCtx.bus, agentId: 'agent-b' },
    );
    const data = dataOf(await handler.execute(replyCtx));
    expect(typeof data.message_id).toBe('string');
    expect(data.status).toBe('closed');

    const publishCall = publishCalls(openCtx)[1]! as DiscussCall;
    expect(publishCall[1].payload.threadClosed).toBe(true);
    expect(publishCall[1].payload.mentionedAgentIds).toEqual(['coordinator']);

    // Thread is actually closed: a follow-up reply must now fail.
    const followUp = makeCtx(
      { thread_id: threadId, content: 'Too late' },
      { bullpenService: openCtx.bullpenService, bus: openCtx.bus, agentId: 'coordinator' },
    );
    expect(errorOf(await handler.execute(followUp))).toMatch(/closed/);
  });

  it('close_after with no mentions auto-mentions the thread opener', async () => {
    const { threadId, ctx: openCtx } = await openThread({
      topic: 'Consult hand-off',
      participants: ['calendar'],
      content: 'CONSULT REQUEST',
      mentioned_agent_ids: ['calendar'],
    }, { agentId: 'ceo-inbox' });

    const replyCtx = makeCtx(
      { thread_id: threadId, content: 'CONSULT REPLY\nResult: ok', close_after: true },
      { bullpenService: openCtx.bullpenService, bus: openCtx.bus, agentId: 'calendar' },
    );
    await handler.execute(replyCtx);

    const publishCall = publishCalls(openCtx)[1]! as DiscussCall;
    expect(publishCall[1].payload.mentionedAgentIds).toEqual(['ceo-inbox']);
    expect(publishCall[1].payload.threadClosed).toBe(true);
  });

  it('close_after=false (default) leaves the thread open', async () => {
    const { threadId, ctx: openCtx } = await openThread({
      topic: 'Stay-open test',
      participants: ['coordinator', 'agent-b'],
      content: 'Start',
      mentioned_agent_ids: ['agent-b'],
    });

    const replyCtx = makeCtx(
      { thread_id: threadId, content: 'Still going' },
      { bullpenService: openCtx.bullpenService, bus: openCtx.bus, agentId: 'agent-b' },
    );
    const data = dataOf(await handler.execute(replyCtx));
    expect(data.status).toBeUndefined();

    const get = await openCtx.bullpenService!.getThread(threadId);
    expect(get!.thread.status).toBe('open');
  });

  // The #2126 loop: a reply with no content, carrying fields of other tools. The
  // refusal names the missing field and nothing is posted.
  it.each([
    [{ thread_id: 'x', source_message_id: 'x', close_after: true }, "Missing required field: 'content'"],
    [{ thread_id: 'x', content: '' }, "Missing required field: 'content'"],
    [{ thread_id: '', content: 'Got it' }, "Missing required field: 'thread_id'"],
    [{ content: 'Got it' }, "Missing required field: 'thread_id'"],
    [{}, "Missing required field: 'thread_id'"],
  ])('refuses %j with the missing field named', async (input, expected) => {
    const ctx = makeCtx(input);
    expect(errorOf(await handler.execute(ctx))).toBe(expected);
    expect(ctx.bus!.publish).not.toHaveBeenCalled();
  });

  it('returns immediately even when bus.publish is slow', async () => {
    const { threadId, ctx: openCtx } = await openThread({
      topic: 'slow reply',
      participants: ['coordinator', 'agent-b'],
      content: 'Start',
    });

    let publishResolve: (() => void) | undefined;
    const slowPublish = vi.fn().mockImplementation(
      () => new Promise<void>((resolve) => { publishResolve = resolve; }),
    );
    const replyCtx = makeCtx(
      { thread_id: threadId, content: 'reply body' },
      {
        bullpenService: openCtx.bullpenService,
        agentId: 'agent-b',
        bus: { publish: slowPublish, subscribe: vi.fn() } as unknown as ToolContext['bus'],
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

  describe('thread not-found errors (#1828)', () => {
    it('names scheduler-report when thread_id is the caller job UUID', async () => {
      const { ctx, warn } = makeCtxWithWarn(
        { thread_id: JOB_ID, content: 'status update' },
        { conversationId: RUN_CONV },
      );
      const error = errorOf(await handler.execute(ctx));
      expect(error).toContain('scheduled-job ID');
      expect(error).toContain('scheduler-report');
      expect(error).toContain('bullpen-post');
      expect(error).not.toMatch(/not found/i);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0]![1]).toMatch(/scheduled-job UUID as thread_id/);
    });

    it('an unrelated missing UUID under a scheduler conversation gets a soft scheduler-report hint', async () => {
      const { ctx, warn } = makeCtxWithWarn(
        { thread_id: '00000000-0000-4000-8000-000000000099', content: 'hello' },
        { conversationId: RUN_CONV },
      );
      const error = errorOf(await handler.execute(ctx));
      expect(error).toContain('No bullpen thread with ID 00000000-0000-4000-8000-000000000099 exists');
      expect(error).toContain('scheduler-report');
      expect(error).not.toContain('is your scheduled-job ID');
      // Soft hint is not the exact-match recurrence signal — no warn.
      expect(warn).not.toHaveBeenCalled();
    });
  });
});
