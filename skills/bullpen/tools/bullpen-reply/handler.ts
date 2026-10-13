// handler.ts — bullpen-reply: post a message on an existing Bullpen thread,
// optionally closing it in the same call (close_after, #881).
//
// A reply requires content. The polymorphic `bullpen` tool could only say so in a
// field description, and a model looped on content-less replies (#2126); this
// tool's schema marks it required.

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import { createAgentDiscuss } from '../../../../src/bus/events.js';
import type { TaskOriginator } from '../../../../src/contacts/types.js';
import {
  isToolResult, requireBullpenContext, requiredString, runBullpenTool, threadMissResult,
} from '../../../_shared/bullpen.js';

export class BullpenReplyHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const bp = requireBullpenContext(ctx);
    if (isToolResult(bp)) return bp;

    return runBullpenTool(ctx, 'bullpen-reply', async () => {
      const threadId = requiredString(ctx, 'thread_id');
      if (typeof threadId !== 'string') return threadId;
      const content = requiredString(ctx, 'content');
      if (typeof content !== 'string') return content;

      // Fetch thread before posting to get participants for the event payload and to
      // constrain mentions to actual thread members. postMessage validates the thread too,
      // but we need participants here for mention filtering.
      const existing = await bp.service.getThread(threadId);
      if (!existing) {
        return threadMissResult(ctx, threadId, 'bullpen-reply');
      }

      const rawMentioned = ctx.input['mentioned_agent_ids'];
      // Trim/filter mentions, then constrain to actual thread participants to prevent out-of-thread fan-out.
      // Default: empty (broadcast reply — no specific response expected).
      let mentionedAgentIds: string[] = Array.isArray(rawMentioned) && rawMentioned.every(m => typeof m === 'string')
        ? (rawMentioned as string[]).map(m => m.trim()).filter(m => m.length > 0 && existing.thread.participants.includes(m))
        : [];

      // close_after lets an agent conclude a thread in the same call as its reply (#881).
      // The message is persisted first, then the thread is closed atomically — so a
      // successful postMessage means both happened. Only an explicit `true` closes.
      const closeAfter = ctx.input['close_after'] === true;

      // Closing without explicit mentions: wake the thread opener to act on the
      // conclusion (#1256). Other participants receive FYI only via the dispatcher.
      if (closeAfter && mentionedAgentIds.length === 0) {
        const opener = existing.thread.creatorAgentId;
        if (opener !== bp.agentId && existing.thread.participants.includes(opener)) {
          mentionedAgentIds = [opener];
        }
      }

      const message = await bp.service.postMessage(threadId, bp.agentId, content, mentionedAgentIds, closeAfter);

      // Publish is fire-and-forget — reply is already persisted. Same
      // rationale as bullpen-post: bus.publish dispatches subscribers sequentially,
      // so awaiting here would re-introduce the timeout hazard from #721.
      // Agents will still see the message via pending-thread context injection.
      void bp.bus.publish('agent', createAgentDiscuss({
        threadId,
        messageId: message.id,
        topic: existing.thread.topic,
        senderAgentId: bp.agentId,
        participants: existing.thread.participants,
        mentionedAgentIds,
        content,
        threadClosed: closeAfter,
        // Forward the parent task's originator so BullpenDispatcher can stamp it
        // on the reply tasks it creates for each participant.
        originator: ctx.taskMetadata?.originator as TaskOriginator | undefined,
        parentEventId: bp.taskEventId,
      })).catch((publishErr: unknown) => {
        ctx.log.error(
          { err: publishErr, threadId },
          'Bullpen: reply posted but discuss event publish failed — agents will see it on next poll',
        );
      });

      // Report the close in the result so the agent gets confirmation the thread is done.
      return {
        success: true,
        data: closeAfter
          ? { thread_id: threadId, message_id: message.id, status: 'closed' }
          : { thread_id: threadId, message_id: message.id },
      };
    });
  }
}

export default new BullpenReplyHandler();
