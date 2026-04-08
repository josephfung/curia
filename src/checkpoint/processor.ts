import type { EventBus } from '../bus/bus.js';
import type { ExecutionLayer } from '../skills/execution.js';
import type { DbPool } from '../db/connection.js';
import type { Logger } from '../logger.js';
import type { ConversationCheckpointEvent } from '../bus/events.js';
import type { SkillResult } from '../skills/types.js';

// Skills invoked at every checkpoint, in addition to any future skills.
// Add new checkpoint skills here — no changes to Dispatch or the runtime required.
const CHECKPOINT_SKILLS: Array<{ name: string }> = [
  { name: 'extract-relationships' },
  { name: 'extract-facts' },
];

export class ConversationCheckpointProcessor {
  constructor(
    private bus: EventBus,
    private executionLayer: ExecutionLayer,
    private pool: DbPool,
    private logger: Logger,
  ) {}

  register(): void {
    this.bus.subscribe('conversation.checkpoint', 'system', async (event) => {
      await this.handleCheckpoint(event as ConversationCheckpointEvent);
    });
  }

  private async handleCheckpoint(event: ConversationCheckpointEvent): Promise<void> {
    const { conversationId, agentId, channelId, turns } = event.payload;

    if (turns.length === 0) return;

    const transcript = turns
      .map(t => `${t.role === 'user' ? 'User' : 'Curia'}: ${t.content}`)
      .join('\n\n');

    const source = `system:checkpoint/conversation:${conversationId}/agent:${agentId}/channel:${channelId}`;

    // CallerContext for system-layer invocations — no human contact involved.
    // Use 'system' as a sentinel contactId; channel carries the originating channel.
    const callerContext = {
      contactId: 'system',
      role: null,
      channel: channelId,
    };

    // Run all checkpoint skills concurrently. A failure in one must not block the
    // others or prevent the watermark from advancing — hence Promise.allSettled.
    // Check both rejected promises (thrown errors) and resolved { success: false }
    // results — ExecutionLayer never throws, so the latter is the normal failure path.
    const results = await Promise.allSettled(
      CHECKPOINT_SKILLS.map(skill =>
        this.executionLayer.invoke(skill.name, { text: transcript, source }, callerContext),
      ),
    );

    results.forEach((result, index) => {
      const skillName = CHECKPOINT_SKILLS[index]!.name;
      if (result.status === 'rejected') {
        this.logger.error(
          { err: result.reason as Error, skill: skillName, conversationId },
          'checkpoint skill threw unexpectedly — watermark will still advance',
        );
        return;
      }
      const skillResult = result.value as SkillResult;
      if (!skillResult.success) {
        this.logger.error(
          { skill: skillName, conversationId, error: skillResult.error },
          'checkpoint skill returned failure — watermark will still advance',
        );
      }
    });

    // Advance the watermark to the batch's upper-bound timestamp (not now()).
    // Using now() would advance the watermark past any turns that arrived between
    // the Dispatcher's DB read and this upsert, causing those turns to be silently
    // skipped on the next checkpoint. `through` is set by Dispatcher to the
    // created_at of the newest turn in the batch, so the boundary is exact.
    // Upsert so the first checkpoint creates the row.
    // Wrapped in its own try/catch so that a transient DB error is logged with
    // full context (conversationId/agentId) rather than surfacing to the bus's
    // generic catch-all which would lose those fields. Consequence of failure:
    // the same turns will be re-processed on the next checkpoint (idempotent).
    try {
      await this.pool.query(
        `INSERT INTO conversation_checkpoints (conversation_id, agent_id, last_checkpoint_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (conversation_id, agent_id)
         DO UPDATE SET last_checkpoint_at = EXCLUDED.last_checkpoint_at`,
        [conversationId, agentId, event.payload.through],
      );
    } catch (err) {
      this.logger.error(
        { err, conversationId, agentId },
        'Failed to advance checkpoint watermark — skills ran but watermark not saved; turns will re-process on next checkpoint',
      );
      return;
    }

    this.logger.info(
      { conversationId, agentId, turnCount: turns.length },
      'Conversation checkpoint complete',
    );
  }
}
