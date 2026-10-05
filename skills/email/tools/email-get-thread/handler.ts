// handler.ts — email-get-thread skill implementation.
//
// Fetches every message in an email thread (full bodies) by thread ID, in one
// Nylas call: list messages filtered by thread_id. Without it, reading a thread
// meant email-list (snippets only, no thread filter) followed by an email-get per
// message, which is why the coordinator reached for the Google Workspace Gmail
// thread tool instead (#1957). Account resolution is handled by the gateway's
// named-client map, as for email-get.

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import { emailAccountIdFromInput } from '../../../../src/channels/email/account-id.js';
import { UnknownEmailAccountError } from '../../../../src/skills/outbound-gateway.js';

// Nylas allows up to 200 per page, but each message carries its full body, and
// execution truncates oversized output anyway. 50 matches email-list's cap and
// covers any realistic thread; a longer one is reported via `truncated`.
export const THREAD_MESSAGE_LIMIT = 50;

export class EmailGetThreadHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.outboundGateway) {
      return { success: false, error: 'email-get-thread requires outboundGateway (capabilities: ["outboundGateway"])' };
    }

    // Handlers must never throw — destructuring a non-object ctx.input would.
    const input =
      ctx.input && typeof ctx.input === 'object' ? (ctx.input as Record<string, unknown>) : {};
    const rawThreadId = input['thread_id'];
    const threadId = typeof rawThreadId === 'string' ? rawThreadId.trim() : '';
    if (!threadId) {
      return { success: false, error: 'Missing required input: thread_id (string)' };
    }

    const accountId = emailAccountIdFromInput(input);

    ctx.log.info({ threadId, accountId }, 'email-get-thread: fetching thread');

    let messages: Awaited<ReturnType<typeof ctx.outboundGateway.listEmailMessages>>;
    try {
      // Only threadId + limit: a folder or unread filter would silently hide part
      // of the thread (e.g. our own replies live in SENT, not INBOX).
      messages = await ctx.outboundGateway.listEmailMessages(
        { threadId, limit: THREAD_MESSAGE_LIMIT },
        accountId,
      );
    } catch (err) {
      ctx.log.error({ err, threadId, accountId }, 'email-get-thread: failed to fetch thread');
      // A misspelled mailbox name is actionable: say which accounts exist.
      if (err instanceof UnknownEmailAccountError) {
        return { success: false, error: err.message };
      }
      return { success: false, error: 'Failed to fetch thread' };
    }

    // Nylas returns no error for an unknown thread id, just an empty page. An
    // empty success would read as "nothing in this thread" and invite retries,
    // so name the likely causes instead.
    if (messages.length === 0) {
      ctx.log.warn({ threadId, accountId }, 'email-get-thread: no messages found for thread');
      return {
        success: false,
        error:
          `No messages found for thread_id '${threadId}'. Check the id (use the threadId ` +
          'from email-list or email-get) and that account names the mailbox the thread is in.',
      };
    }

    // Nylas lists newest-first; a thread reads oldest-first. Sort rather than
    // reverse so the order holds even if the API's ordering ever changes.
    const ordered = [...messages].sort((a, b) => a.date - b.date);

    return {
      success: true,
      data: {
        threadId,
        messages: ordered.map((m) => ({
          id: m.id,
          threadId: m.threadId,
          subject: m.subject,
          from: m.from,
          to: m.to,
          cc: m.cc,
          body: m.body,
          date: m.date,
          unread: m.unread,
          folders: m.folders,
          attachments: m.attachments,
        })),
        count: ordered.length,
        // A full page means the thread may be longer. Because Nylas pages
        // newest-first, the messages left out are the oldest ones.
        truncated: messages.length >= THREAD_MESSAGE_LIMIT,
      },
    };
  }
}
