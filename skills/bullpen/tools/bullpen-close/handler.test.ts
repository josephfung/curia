import { describe, it, expect } from 'vitest';
import { BullpenCloseHandler } from './handler.js';
import {
  dataOf, errorOf, JOB_ID, makeCtx, makeCtxWithWarn, openThread, publishCalls, RUN_CONV,
} from '../../../_shared/bullpen-test-helpers.js';

const handler = new BullpenCloseHandler();

describe('bullpen-close', () => {
  it('closes the thread without posting or publishing', async () => {
    const { threadId, ctx } = await openThread({
      topic: 'Close test',
      participants: ['coordinator'],
      content: 'Will close',
    });

    const closeCtx = makeCtx({ thread_id: threadId }, { bullpenService: ctx.bullpenService, bus: ctx.bus });
    const data = dataOf(await handler.execute(closeCtx));
    expect(data).toEqual({ thread_id: threadId, status: 'closed' });

    const after = await ctx.bullpenService!.getThread(threadId);
    expect(after!.thread.status).toBe('closed');
    expect(after!.messages).toHaveLength(1);
    expect(publishCalls(ctx)).toHaveLength(1);
  });

  it('lets the opener close its own thread', async () => {
    const { threadId, ctx } = await openThread({
      topic: 'Peer request',
      participants: ['ceo-inbox'],
      content: 'PEER REQUEST',
    }, { agentId: 'social-media' });

    const closeCtx = makeCtx(
      { thread_id: threadId },
      { bullpenService: ctx.bullpenService, bus: ctx.bus, agentId: 'social-media' },
    );
    expect(dataOf(await handler.execute(closeCtx)).status).toBe('closed');
  });

  it('returns an error when an agent that is neither opener nor coordinator tries to close', async () => {
    const { threadId, ctx } = await openThread({
      topic: 'Auth test',
      participants: ['agent-b', 'agent-c'],
      content: 'Start',
    }, { agentId: 'agent-b' });

    const closeCtx = makeCtx(
      { thread_id: threadId },
      { bullpenService: ctx.bullpenService, bus: ctx.bus, agentId: 'agent-c' },
    );
    expect(errorOf(await handler.execute(closeCtx))).toMatch(/not authorized/);
  });

  it('refuses a missing thread_id', async () => {
    expect(errorOf(await handler.execute(makeCtx({})))).toBe("Missing required field: 'thread_id'");
  });

  it('remaps service not-found through the job-UUID helper without a pre-check (#1828)', async () => {
    const { ctx, warn } = makeCtxWithWarn({ thread_id: JOB_ID }, { conversationId: RUN_CONV });
    const error = errorOf(await handler.execute(ctx));
    expect(error).toContain('scheduled-job ID');
    expect(error).toContain('scheduler-report');
    expect(warn).toHaveBeenCalledOnce();
  });
});
