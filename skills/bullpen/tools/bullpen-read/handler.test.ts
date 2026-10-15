import { describe, it, expect } from 'vitest';
import { BullpenReadHandler } from './handler.js';
import {
  dataOf, errorOf, JOB_ID, makeCtx, makeCtxWithWarn, openThread, publishCalls, RUN_CONV,
} from '../../../_shared/bullpen-test-helpers.js';

const handler = new BullpenReadHandler();

describe('bullpen-read', () => {
  it('returns the full thread without publishing', async () => {
    const { threadId, ctx } = await openThread({
      topic: 'Get test',
      participants: ['coordinator'],
      content: 'Only message',
    });

    const getCtx = makeCtx({ thread_id: threadId }, { bullpenService: ctx.bullpenService, bus: ctx.bus });
    const data = dataOf(await handler.execute(getCtx));
    expect((data.thread as { topic: string }).topic).toBe('Get test');
    expect(data.messages).toHaveLength(1);
    // No additional publish after the open
    expect(publishCalls(ctx)).toHaveLength(1);
  });

  it('refuses a missing thread_id', async () => {
    expect(errorOf(await handler.execute(makeCtx({})))).toBe("Missing required field: 'thread_id'");
  });

  describe('thread not-found errors (#1828)', () => {
    it('names scheduler-report when thread_id is the caller job UUID', async () => {
      const { ctx, warn } = makeCtxWithWarn({ thread_id: JOB_ID }, { conversationId: RUN_CONV });
      const error = errorOf(await handler.execute(ctx));
      expect(error).toContain('scheduled-job ID');
      expect(error).toContain('scheduler-report');
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0]![1]).toMatch(/scheduled-job UUID as thread_id/);
    });

    it('a generic miss does not imply the thread previously existed', async () => {
      const { ctx, warn } = makeCtxWithWarn({ thread_id: '00000000-0000-4000-8000-000000000099' });
      expect(errorOf(await handler.execute(ctx))).toBe(
        'No bullpen thread with ID 00000000-0000-4000-8000-000000000099 exists',
      );
      expect(warn).not.toHaveBeenCalled();
    });
  });
});
