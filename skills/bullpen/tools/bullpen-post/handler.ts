// handler.ts — bullpen-post: open a new Bullpen thread with an initial message.
//
// Persists the thread via BullpenService and publishes agent.discuss so the
// BullpenDispatcher can wake the mentioned participants.

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import { createAgentDiscuss } from '../../../../src/bus/events.js';
import type { TaskOriginator } from '../../../../src/contacts/types.js';
import { isToolResult, requirePublishContext, requiredString, runBullpenTool } from '../../../_shared/bullpen.js';

export class BullpenPostHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const bp = requirePublishContext(ctx);
    if (isToolResult(bp)) return bp;

    return runBullpenTool(ctx, 'bullpen-post', async () => {
      const { input } = ctx;
      const topic = requiredString(ctx, 'topic');
      if (typeof topic !== 'string') return topic;
      const participants = input['participants'];
      if (!Array.isArray(participants) || participants.length === 0 || !participants.every(p => typeof p === 'string')) {
        return { success: false, error: "Missing required field: 'participants' (non-empty string array)" };
      }
      const content = requiredString(ctx, 'content');
      if (typeof content !== 'string') return content;

      // Trim and reject blank/whitespace-only participant IDs
      const cleanParticipants = (participants as string[]).map(p => p.trim()).filter(p => p.length > 0);
      if (cleanParticipants.length === 0) {
        return { success: false, error: "Field 'participants' must contain at least one non-empty agent ID" };
      }

      // Reject names that are not loaded agents before they are persisted.
      // A drifted casing in the participants array never wakes that agent,
      // and the wake query cannot tell "nothing pending" from "id mismatch". (#1898)
      const registry = ctx.agentRegistry;
      if (!registry) {
        return { success: false, error: 'agentRegistry not available in context (requires "agentRegistry" capability)' };
      }
      const unknownParticipants = cleanParticipants.filter((id) => !registry.has(id));
      if (unknownParticipants.length > 0) {
        const valid = registry.list().map((a) => a.name).join(', ');
        return {
          success: false,
          error: `Unknown participant(s): ${unknownParticipants.join(', ')}. Valid agents: ${valid || 'none'}`,
        };
      }

      const rawMentioned = input['mentioned_agent_ids'];
      // Trim/filter mentions, then constrain to thread participants to prevent out-of-thread fan-out.
      // Default: mention all participants when not specified (caller wants replies when opening a thread).
      const mentionedAgentIds: string[] = Array.isArray(rawMentioned) && rawMentioned.every(m => typeof m === 'string')
        ? (rawMentioned as string[]).map(m => m.trim()).filter(m => m.length > 0 && cleanParticipants.includes(m))
        : cleanParticipants;

      // Optional dedup key — when provided, openThread returns the existing thread
      // if one was already created for this source message. (issue #708)
      const rawSourceMessageId = input['source_message_id'];
      const sourceMessageId = typeof rawSourceMessageId === 'string' && rawSourceMessageId.trim()
        ? rawSourceMessageId.trim()
        : undefined;

      // Capture originator before openThread so we can pass it both to the thread
      // record (for poll-fallback rehydration) and to the agent.discuss event payload.
      const originator = ctx.taskMetadata?.originator as TaskOriginator | undefined;

      const { thread, message, deduplicated } = await bp.service.openThread(
        topic, bp.agentId, cleanParticipants, content, mentionedAgentIds, originator, sourceMessageId,
      );

      // Skip publish entirely on dedup hit — the existing thread's participants were
      // already notified when the original thread was opened. Re-publishing would
      // cause duplicate agent.discuss events and therefore duplicate task dispatches.
      if (deduplicated) {
        ctx.log.info(
          { threadId: thread.id, sourceMessageId },
          'Bullpen: dedup hit — returning existing thread, skipping agent.discuss publish',
        );
        return { success: true, data: { thread_id: thread.id, message_id: message.id, deduplicated: true } };
      }

      // Publish is fire-and-forget — thread is already persisted. We do NOT
      // await here because bus.publish dispatches subscribers sequentially
      // (see src/bus/bus.ts) and a slow agent.discuss subscriber would push
      // the handler past its skill timeout, causing the caller to retry
      // and create duplicate threads even though the side-effects are
      // already committed (issue #721). If publish fails, agents will still
      // see the thread via pending-thread context injection, and the
      // originator is stored on the thread row so BullpenDispatcher can
      // rehydrate it when processing poll-fallback replies.
      void bp.bus.publish('agent', createAgentDiscuss({
        threadId: thread.id,
        messageId: message.id,
        topic: thread.topic,
        senderAgentId: bp.agentId,
        participants: thread.participants,
        mentionedAgentIds,
        content,
        // Forward the parent task's originator so BullpenDispatcher can stamp it
        // on the reply tasks it creates for each participant. This ensures
        // isPrincipalOriginated() returns correctly for principal-authorized bullpen work.
        originator,
        parentEventId: bp.taskEventId,
      })).catch((publishErr: unknown) => {
        ctx.log.error(
          { err: publishErr, threadId: thread.id, originatorRole: originator?.systemRole ?? 'none' },
          'Bullpen: thread created but discuss event publish failed — agents will see it on next poll (originator preserved in thread row)',
        );
      });

      return { success: true, data: { thread_id: thread.id, message_id: message.id, deduplicated: false } };
    });
  }
}

export default new BullpenPostHandler();
