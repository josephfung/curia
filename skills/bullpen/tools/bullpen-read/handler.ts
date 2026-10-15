// handler.ts — bullpen-read: read a Bullpen thread's full message history.

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import {
  isToolResult, requireBullpenContext, requiredString, runBullpenTool, threadMissResult,
} from '../../../_shared/bullpen.js';

export class BullpenReadHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const bp = requireBullpenContext(ctx);
    if (isToolResult(bp)) return bp;

    return runBullpenTool(ctx, 'bullpen-read', async () => {
      const threadId = requiredString(ctx, 'thread_id');
      if (typeof threadId !== 'string') return threadId;

      const result = await bp.service.getThread(threadId);
      if (!result) {
        return threadMissResult(ctx, threadId, 'bullpen-read');
      }

      // Return the BullpenThread under 'thread' and messages array separately.
      // Together they represent the "full thread + messages" output.
      return { success: true, data: { thread_id: threadId, thread: result.thread, messages: result.messages } };
    });
  }
}

export default new BullpenReadHandler();
