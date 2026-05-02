// handler.ts — held-messages-list skill implementation.
//
// Lists pending held messages from unknown senders so the CEO can review them.
// Optionally filters by channel. Returns a summary with sender, subject,
// plaintext preview (500 chars), totalLength, and timestamp for each message.
//
// preview is stripped of HTML tags before slicing — a simple regex replacement
// (<[^>]+> → empty string), not a full DOM parser. Good enough for preview
// extraction; the coordinator LLM reads this to infer the nature of the request.
//
// totalLength is the character count of the full plaintext body. When preview
// is short relative to totalLength, the coordinator qualifies its assessment
// ("appears to be asking for..." rather than stating definitively).
//
// This skill requires heldMessages service access — declare "heldMessages" in capabilities.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

// Strip HTML tags for plaintext extraction.
// Not a full DOM parser — good enough for preview purposes.
function stripHtml(content: string): string {
  return content.replace(/<[^>]+>/g, '');
}

export class HeldMessagesListHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    if (!ctx.heldMessages) {
      return { success: false, error: 'Held messages service not available. Declare "heldMessages" in capabilities.' };
    }

    const { channel } = ctx.input as { channel?: string };
    const filterChannel = (channel && typeof channel === 'string') ? channel : undefined;

    try {
      const messages = await ctx.heldMessages.listPending(filterChannel);
      const summary = messages.map(m => {
        const plaintext = stripHtml(m.content);
        return {
          id: m.id,
          channel: m.channel,
          sender: m.senderId,
          subject: m.subject,
          preview: plaintext.slice(0, 500),
          totalLength: plaintext.length,
          receivedAt: m.createdAt.toISOString(),
        };
      });

      ctx.log.info({ count: messages.length, channel: filterChannel ?? 'all' }, 'Listed held messages');
      return { success: true, data: { messages: summary, count: messages.length } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Failed to list held messages: ${message}` };
    }
  }
}
