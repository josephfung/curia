import type { EventBus } from '../bus/bus.js';
import type { AgentDiscussEvent } from '../bus/events.js';
import { createAgentTask } from '../bus/events.js';
import type { Logger } from '../logger.js';
import type { BullpenService } from '../memory/bullpen.js';

export class BullpenDispatcher {
  constructor(
    private bus: EventBus,
    private logger: Logger,
    private bullpenService: BullpenService,
  ) {}

  register(): void {
    this.bus.subscribe('agent.discuss', 'dispatch', async (event) => {
      await this.handleDiscuss(event as AgentDiscussEvent);
    });
    this.logger.info('BullpenDispatcher registered');
  }

  private async handleDiscuss(event: AgentDiscussEvent): Promise<void> {
    const { threadId, senderAgentId, mentionedAgentIds } = event.payload;

    // Load the thread from DB to get authoritative participant list and topic.
    // This also serves as cap + existence check, and prevents forged event.payload
    // values (e.g. a rogue agent inflating participants or spoofing topic).
    let threadRecord: Awaited<ReturnType<BullpenService['getThread']>>;
    try {
      threadRecord = await this.bullpenService.getThread(threadId);
    } catch (err) {
      this.logger.error({ err, threadId }, 'BullpenDispatcher: failed to load thread — skipping');
      return;
    }

    if (!threadRecord) {
      this.logger.warn({ threadId }, 'BullpenDispatcher: thread not found for agent.discuss event — skipping');
      return;
    }

    // Validate that the event sender is actually a thread participant.
    if (!threadRecord.thread.participants.includes(senderAgentId)) {
      this.logger.warn({ threadId, senderAgentId }, 'BullpenDispatcher: senderAgentId not in thread participants — skipping');
      return;
    }

    if (threadRecord.thread.messageCount >= 100) {
      this.logger.warn(
        { threadId, messageCount: threadRecord.thread.messageCount },
        'BullpenDispatcher: thread has hit message cap (100) — skipping task creation',
      );
      return;
    }

    const { topic, participants } = threadRecord.thread;

    // Create one agent.task per participant, excluding the sender.
    // Mentioned agents get a reply-expected prompt; others get an FYI.
    const otherParticipants = participants.filter((id) => id !== senderAgentId);

    let dispatched = 0;
    for (const agentId of otherParticipants) {
      const isMentioned = mentionedAgentIds.includes(agentId);
      const content = isMentioned
        ? `You've been mentioned in Bullpen thread "${topic}" (thread_id: ${threadId}) by ${senderAgentId}. Review the injected thread context and reply using the bullpen skill.`
        : `FYI: New activity in Bullpen thread "${topic}" (thread_id: ${threadId}) from ${senderAgentId}. No response required, but reply if you have something to add.`;

      try {
        const task = createAgentTask({
          agentId,
          // threadId as conversationId scopes working memory to this thread,
          // so agents accumulate context across multiple activations in the same discussion.
          conversationId: threadId,
          channelId: 'bullpen',
          senderId: senderAgentId,
          content,
          metadata: {
            taskOrigin: 'bullpen',
            threadId,
            mentioned: isMentioned,
          },
          parentEventId: event.id,
        });
        await this.bus.publish('dispatch', task);
        dispatched++;
        this.logger.debug(
          { agentId, threadId, mentioned: isMentioned },
          'BullpenDispatcher: created agent.task for participant',
        );
      } catch (err) {
        this.logger.error(
          { err, agentId, threadId },
          'BullpenDispatcher: failed to publish agent.task for participant',
        );
      }
    }

    // If every dispatch failed, log an aggregated error — the thread will go unanswered.
    if (dispatched === 0 && otherParticipants.length > 0) {
      this.logger.error(
        { threadId, expected: otherParticipants.length },
        'BullpenDispatcher: all participant task dispatches failed — thread will receive no replies',
      );
    }
  }
}
