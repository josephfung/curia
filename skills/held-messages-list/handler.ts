// handler.ts — held-messages-list skill implementation.
//
// Lists pending held messages from unknown senders so the CEO can review them.
// Optionally filters by channel. Returns a summary with sender, subject, preview,
// and timestamp for each message.
//
// This is an infrastructure skill — it requires heldMessages service access.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

export class HeldMessagesListHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    if (!ctx.heldMessages) {
      return { success: false, error: 'Held messages service not available. Is infrastructure: true set?' };
    }

    const { channel } = ctx.input as { channel?: string };
    const filterChannel = (channel && typeof channel === 'string') ? channel : undefined;

    try {
      const messages = await ctx.heldMessages.listPending(filterChannel);
      const summary = messages.map(m => ({
        id: m.id,
        channel: m.channel,
        sender: m.senderId,
        subject: m.subject,
        preview: m.content.slice(0, 200),
        receivedAt: m.createdAt.toISOString(),
      }));

      ctx.log.info({ count: messages.length, channel: filterChannel ?? 'all' }, 'Listed held messages');
      return { success: true, data: { messages: summary, count: messages.length } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Failed to list held messages: ${message}` };
    }
  }
}
