// handler.ts — email-reply skill implementation.
//
// Replies to an existing email thread via the OutboundGateway. The gateway
// enforces contact blocked checks and content filtering before dispatch.
// This handler focuses on thread resolution (fetching the original message
// to extract the sender address and subject line).
//
// CC behaviour (three modes):
//   - cc absent (undefined): reply-all — auto-populate from original.to[] + original.cc[],
//     excluding the primary To recipient and ctx.selfEmail (Curia's own address).
//   - cc === "": reply to sender only — no CC recipients.
//   - cc is a non-empty string: parse comma-separated addresses explicitly.
//
// sensitivity: "elevated" — enforced by the gateway's security pipeline.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { registerOutboundContext } from '../../src/dispatch/context-bridge-parse.js';
import { buildReplyQuote } from '../../src/skills/_shared/reply-quote.js';
import { parseAttachmentInputs } from '../_shared/parse-attachments.js';

const MAX_BODY_LENGTH = 50000;

export class EmailReplyHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const { reply_to_message_id: replyToMessageId, body, cc: ccInput, attachments: attachmentsRaw, context_bridge: contextBridgeRaw } = ctx.input as {
      reply_to_message_id?: string;
      body?: string;
      cc?: string;
      attachments?: unknown;
      context_bridge?: string;
    };

    const attachmentsParsed = parseAttachmentInputs(attachmentsRaw);
    if (typeof attachmentsParsed === 'string') {
      return { success: false, error: attachmentsParsed };
    }

    if (!replyToMessageId || typeof replyToMessageId !== 'string') {
      return { success: false, error: 'Missing required input: reply_to_message_id (string)' };
    }
    if (!body || typeof body !== 'string') {
      return { success: false, error: 'Missing required input: body (string)' };
    }

    if (body.length > MAX_BODY_LENGTH) {
      return { success: false, error: `body must be ${MAX_BODY_LENGTH} characters or fewer` };
    }

    if (!ctx.outboundGateway) {
      return {
        success: false,
        error: 'email-reply skill requires outboundGateway access. Declare "outboundGateway" in capabilities.',
      };
    }

    ctx.log.info({ replyToMessageId }, 'Replying to email via gateway');

    try {
      const original = await ctx.outboundGateway.getEmailMessage(replyToMessageId);

      const originalFrom = original.from[0]?.email;
      if (!originalFrom) {
        return {
          success: false,
          error: `Original message ${replyToMessageId} has no sender address — cannot reply`,
        };
      }

      const baseSubject = original.subject.replace(/^Re:\s*/i, '');
      const replySubject = `Re: ${baseSubject}`;

      // Resolve CC addresses based on the three input modes.
      let ccAddresses: string[] | undefined;

      if (ccInput === undefined) {
        // Reply-all mode: collect all addresses from the original To and CC fields,
        // excluding the primary To recipient (already in To) and Curia's own address
        // (must never CC itself). Use a lowercase Set for case-insensitive deduplication.
        const excluded = new Set<string>();
        excluded.add(originalFrom.toLowerCase());
        if (ctx.selfEmail) {
          excluded.add(ctx.selfEmail.toLowerCase());
        } else {
          ctx.log.warn({ replyToMessageId }, 'email-reply: selfEmail not configured — Curia may CC itself in reply-all');
        }

        const candidates = [
          ...(original.to ?? []),
          ...(original.cc ?? []),
        ];

        const resolved = candidates
          .map((p) => p.email)
          .filter((addr): addr is string => !!addr)
          .filter((addr) => !excluded.has(addr.toLowerCase()));

        // Deduplicate while preserving first-seen order.
        const seen = new Set<string>();
        ccAddresses = resolved.filter((addr) => {
          const key = addr.toLowerCase();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });

        // Treat an empty resolved list the same as no CC (don't pass an empty array).
        if (ccAddresses.length === 0) ccAddresses = undefined;
      } else if (ccInput === '') {
        // Explicit reply-to-sender-only: omit CC entirely.
        ccAddresses = undefined;
      } else {
        // Explicit CC list: parse comma-separated addresses, trim, and drop empties.
        ccAddresses = ccInput
          .split(',')
          .map((addr) => addr.trim())
          .filter((addr) => addr.length > 0);

        if (ccAddresses.length === 0) ccAddresses = undefined;
      }

      // Append the quoted original message below the reply body. Formatting is
      // non-fatal — a quote failure must not block the reply from being sent.
      // htmlQuote is passed separately so it is appended after markdownToHtml(body)
      // in the gateway, preventing the HTML from being re-escaped.
      let htmlQuote: string | undefined;
      try {
        const candidate = buildReplyQuote(original, ctx.timezone, { format: 'html' });
        // Skip the quote silently if it would push the body past the size limit
        // (the agent-authored body already passed the guard above; a long thread
        // could tip the combined total over). The reply still goes out unquoted.
        htmlQuote = body.length + candidate.length <= MAX_BODY_LENGTH ? candidate : undefined;
      } catch (err) {
        ctx.log.warn(
          { err, replyToMessageId },
          'email-reply: buildReplyQuote failed (HTML stripping or date formatting) — sending without quote',
        );
      }

      const result = await ctx.outboundGateway.send({
        channel: 'email',
        to: originalFrom,
        subject: replySubject,
        body,
        replyToMessageId,
        htmlQuote,
        ...(ccAddresses ? { cc: ccAddresses } : {}),
        ...(attachmentsParsed.length > 0 ? { attachments: attachmentsParsed } : {}),
      }, {
        taskEventId: ctx.taskEventId,
        conversationId: ctx.conversationId,
      });

      if (!result.success) {
        return { success: false, error: result.blockedReason ?? 'Email reply failed' };
      }

      // Register outbound context entry (best-effort, always fires).
      // Pass the agent-authored body only — not quotedBody — so outbound context stores
      // the meaningful reply content without the formatting-only quote block.
      await registerOutboundContext(ctx.outboundContext, contextBridgeRaw, {
        channelId: 'email',
        content: body,
        agentId: ctx.agentId ?? 'coordinator',
        log: ctx.log,
      });

      ctx.log.info(
        { messageId: result.messageId, to: originalFrom, subject: replySubject, cc: ccAddresses },
        'Email reply sent successfully',
      );

      return {
        success: true,
        data: {
          message_id: result.messageId,
          to: originalFrom,
          subject: replySubject,
          // Return the CC list that was used; empty string when none.
          cc: ccAddresses?.join(', ') ?? '',
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, replyToMessageId }, 'Failed to reply to email');
      return { success: false, error: `Failed to reply to email: ${message}` };
    }
  }
}
