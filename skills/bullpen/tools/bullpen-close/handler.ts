// handler.ts — bullpen-close: close a Bullpen thread without posting to it.
//
// An asker that collected its answers closes its own threads this way (the PEER
// REQUEST protocol in src/memory/bullpen.ts), as do agents tidying up a thread that
// already concluded. Concluding with a message is bullpen-reply with close_after.

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import { isToolResult, requireBullpenContext, requiredString, runBullpenTool } from '../../../_shared/bullpen.js';

export class BullpenCloseHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const bp = requireBullpenContext(ctx);
    if (isToolResult(bp)) return bp;

    return runBullpenTool(ctx, 'bullpen-close', async () => {
      const threadId = requiredString(ctx, 'thread_id');
      if (typeof threadId !== 'string') return threadId;

      // closeThread throws if missing or if the requesting agent is not the
      // creator/coordinator. Missing threads are remapped in runBullpenTool via
      // threadMissResult — avoids a double getThread round-trip that a pre-check
      // would add (#1828 review).
      await bp.service.closeThread(threadId, bp.agentId);
      return { success: true, data: { thread_id: threadId, status: 'closed' } };
    });
  }
}

export default new BullpenCloseHandler();
