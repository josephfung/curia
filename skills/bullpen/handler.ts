// handler.ts — bullpen skill implementation.
//
// This skill allows agents to open, reply to, read,
// and close inter-agent Bullpen discussion threads. It persists thread state
// via BullpenService and publishes agent.discuss events so the BullpenDispatcher
// can route reply tasks to mentioned agents.
//
// Actions:
//   post       — open a new thread with an initial message
//   reply      — post a follow-up message to an existing thread
//   get_thread — read the full message history for a thread
//   close      — close a thread (creator or coordinator only)

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { createAgentDiscuss } from '../../src/bus/events.js';
import type { TaskOriginator } from '../../src/contacts/types.js';

export class BullpenHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const { input } = ctx;
    const action = input['action'];

    // Guard: infrastructure context must be present
    if (!ctx.bullpenService) {
      return { success: false, error: 'BullpenService not available in context' };
    }
    if (!ctx.bus) {
      return { success: false, error: 'Bus not available in context (requires "bus" capability)' };
    }
    if (!ctx.agentId) {
      return { success: false, error: 'agentId not available in context' };
    }
    if (!ctx.taskEventId) {
      return { success: false, error: 'taskEventId not available in context' };
    }

    try {
      switch (action) {
        case 'post': {
          const topic = input['topic'];
          const participants = input['participants'];
          const content = input['content'];

          if (typeof topic !== 'string' || !topic) {
            return { success: false, error: "Missing required field: 'topic'" };
          }
          if (!Array.isArray(participants) || participants.length === 0 || !participants.every(p => typeof p === 'string')) {
            return { success: false, error: "Missing required field: 'participants' (non-empty string array)" };
          }
          if (typeof content !== 'string' || !content) {
            return { success: false, error: "Missing required field: 'content'" };
          }

          // Trim and reject blank/whitespace-only participant IDs
          const cleanParticipants = (participants as string[]).map(p => p.trim()).filter(p => p.length > 0);
          if (cleanParticipants.length === 0) {
            return { success: false, error: "Field 'participants' must contain at least one non-empty agent ID" };
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

          const { thread, message, deduplicated } = await ctx.bullpenService.openThread(
            topic, ctx.agentId, cleanParticipants, content, mentionedAgentIds, originator, sourceMessageId,
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
          void ctx.bus.publish('agent', createAgentDiscuss({
            threadId: thread.id,
            messageId: message.id,
            topic: thread.topic,
            senderAgentId: ctx.agentId,
            participants: thread.participants,
            mentionedAgentIds,
            content,
            // Forward the parent task's originator so BullpenDispatcher can stamp it
            // on the reply tasks it creates for each participant. This ensures
            // isPrincipalOriginated() returns correctly for CEO-authorized bullpen work.
            originator,
            parentEventId: ctx.taskEventId,
          })).catch((publishErr: unknown) => {
            ctx.log.error(
              { err: publishErr, threadId: thread.id, originatorRole: originator?.systemRole ?? 'none' },
              'Bullpen: thread created but discuss event publish failed — agents will see it on next poll (originator preserved in thread row)',
            );
          });

          return { success: true, data: { thread_id: thread.id, message_id: message.id, deduplicated: false } };
        }

        case 'reply': {
          const threadId = input['thread_id'];
          const content = input['content'];

          if (typeof threadId !== 'string' || !threadId) {
            return { success: false, error: "Missing required field: 'thread_id'" };
          }
          if (typeof content !== 'string' || !content) {
            return { success: false, error: "Missing required field: 'content'" };
          }

          // Fetch thread before posting to get participants for the event payload and to
          // constrain mentions to actual thread members. postMessage validates the thread too,
          // but we need participants here for mention filtering.
          const existing = await ctx.bullpenService.getThread(threadId);
          if (!existing) return { success: false, error: `Thread ${threadId} not found` };

          const rawMentioned = input['mentioned_agent_ids'];
          // Trim/filter mentions, then constrain to actual thread participants to prevent out-of-thread fan-out.
          // Default: empty (broadcast reply — no specific response expected).
          const mentionedAgentIds: string[] = Array.isArray(rawMentioned) && rawMentioned.every(m => typeof m === 'string')
            ? (rawMentioned as string[]).map(m => m.trim()).filter(m => m.length > 0 && existing.thread.participants.includes(m))
            : [];

          const message = await ctx.bullpenService.postMessage(threadId, ctx.agentId, content, mentionedAgentIds);

          // Publish is fire-and-forget — reply is already persisted. Same
          // rationale as `post`: bus.publish dispatches subscribers sequentially,
          // so awaiting here would re-introduce the timeout hazard from #721.
          // Agents will still see the message via pending-thread context injection.
          void ctx.bus.publish('agent', createAgentDiscuss({
            threadId,
            messageId: message.id,
            topic: existing.thread.topic,
            senderAgentId: ctx.agentId,
            participants: existing.thread.participants,
            mentionedAgentIds,
            content,
            // Forward the parent task's originator so BullpenDispatcher can stamp it
            // on the reply tasks it creates for each participant.
            originator: ctx.taskMetadata?.originator as TaskOriginator | undefined,
            parentEventId: ctx.taskEventId,
          })).catch((publishErr: unknown) => {
            ctx.log.error(
              { err: publishErr, threadId },
              'Bullpen: reply posted but discuss event publish failed — agents will see it on next poll',
            );
          });

          return { success: true, data: { thread_id: threadId, message_id: message.id } };
        }

        case 'get_thread': {
          const threadId = input['thread_id'];

          if (typeof threadId !== 'string' || !threadId) {
            return { success: false, error: "Missing required field: 'thread_id'" };
          }

          const result = await ctx.bullpenService.getThread(threadId);
          if (!result) {
            return { success: false, error: `Thread ${threadId} not found` };
          }

          // Return the BullpenThread under 'thread' and messages array separately.
          // Together they represent the "full thread + messages" output.
          return { success: true, data: { thread_id: threadId, thread: result.thread, messages: result.messages } };
        }

        case 'close': {
          const threadId = input['thread_id'];

          if (typeof threadId !== 'string' || !threadId) {
            return { success: false, error: "Missing required field: 'thread_id'" };
          }

          // closeThread throws if the requesting agent is not the creator or coordinator
          await ctx.bullpenService.closeThread(threadId, ctx.agentId);
          return { success: true, data: { thread_id: threadId, status: 'closed' } };
        }

        default:
          return {
            success: false,
            error: `Unknown action: '${String(action)}'. Valid actions: post, reply, get_thread, close`,
          };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, action, agentId: ctx.agentId }, 'Bullpen skill error');
      return { success: false, error: message };
    }
  }
}

export default new BullpenHandler();
