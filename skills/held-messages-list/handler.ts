// handler.ts — held-messages-list skill implementation.
//
// Lists pending held messages from unknown senders so the CEO can review them.
// Optionally filters by channel. Returns a summary with sender, subject,
// plaintext preview (500 chars), totalLength, and timestamp for each message.
//
// preview is stripped of HTML tags before slicing — loop-based regex (complete tags
// then incomplete tag fragments, repeated until stable), not a full DOM parser.
// Good enough for preview extraction; the coordinator LLM reads this to infer the
// nature of the request.
//
// totalLength is the character count of the full plaintext body. When preview
// is short relative to totalLength, the coordinator qualifies its assessment
// ("appears to be asking for..." rather than stating definitively).
//
// This skill requires heldMessages service access — declare "heldMessages" in capabilities.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { toLocalIso, formatDisplayTimezone } from '../../src/time/timestamp.js';

// Strip HTML tags and script/style block content for plaintext extraction.
// Not a full DOM parser — good enough for preview purposes.
function stripHtml(content: string): string {
  let result = content;

  // Strip <script> and <style> blocks including their content. Loop until
  // stable to prevent nested-substitution bypass.
  // [^>]* before the closing > handles padded tags like </script > and also
  // closing tags with unexpected attributes like </script foo> that \s* misses.
  for (let prev = ''; prev !== result; ) {
    prev = result;
    result = result.replace(/<script[^>]*>[\s\S]*?<\/script[^>]*>/gi, '');
    result = result.replace(/<style[^>]*>[\s\S]*?<\/style[^>]*>/gi, '');
  }

  // Strip all remaining HTML tags. Loop until stable — stripping a complete tag
  // can expose an incomplete <tagname fragment, and stripping an incomplete
  // fragment can expose a new complete tag. {0,500} caps the incomplete-tag
  // pattern to prevent consuming large bodies on inputs with a lone <.
  for (let prev = ''; prev !== result; ) {
    prev = result;
    result = result.replace(/<[^>]+>/g, ''); // complete tags
    result = result.replace(/<[a-zA-Z][^>]{0,500}/g, ''); // incomplete tags
  }
  return result;
}

export class HeldMessagesListHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    if (!ctx.heldMessages) {
      return { success: false, error: 'Held messages service not available. Declare "heldMessages" in capabilities.' };
    }

    const { channel } = ctx.input as { channel?: string };
    const filterChannel = (channel && typeof channel === 'string') ? channel : undefined;

    const tz = ctx.timezone;

    try {
      const messages = await ctx.heldMessages.listPending(filterChannel);
      const summary = messages.map(m => {
        const plaintext = stripHtml(m.content ?? '');
        const unixSeconds = Math.floor(m.createdAt.getTime() / 1000);
        return {
          id: m.id,
          channel: m.channel,
          sender: m.senderId,
          subject: m.subject,
          preview: plaintext.slice(0, 500),
          totalLength: plaintext.length,
          receivedAt: toLocalIso(unixSeconds, tz),
        };
      });

      ctx.log.info({ count: messages.length, channel: filterChannel ?? 'all' }, 'Listed held messages');
      return { success: true, data: { messages: summary, count: messages.length, displayTimezone: tz ? formatDisplayTimezone(tz, new Date()) : null } };
    } catch (err) {
      ctx.log.error({ err, channel: filterChannel ?? 'all' }, 'held-messages-list: failed to list pending messages');
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Failed to list held messages: ${message}` };
    }
  }
}
