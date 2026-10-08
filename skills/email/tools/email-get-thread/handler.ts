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

// Most messages returned for one thread. 50 matches email-list's cap and covers
// any realistic thread; a longer one is reported via `truncated`.
export const THREAD_MESSAGE_LIMIT = 50;

// Total body characters returned. Execution truncates any tool output over
// skillOutput.maxLength (200k chars by default) by cutting the END of the
// serialized JSON. With messages in reading order, that would drop the newest
// messages, the ones an agent most needs. So trim here, from the oldest end,
// and leave headroom for JSON escaping (HTML bodies are quote-heavy) and the
// per-message metadata.
export const THREAD_BODY_BUDGET_CHARS = 120_000;

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

    let page: Awaited<ReturnType<typeof ctx.outboundGateway.listEmailMessages>>;
    try {
      // Only threadId + limit: a folder or unread filter would silently hide part
      // of the thread (e.g. our own replies live in SENT, not INBOX). Ask for one
      // more than the cap: NylasClient drops the page cursor, so a (cap+1)th
      // message is how we know the thread really is longer than the cap.
      page = await ctx.outboundGateway.listEmailMessages(
        { threadId, limit: THREAD_MESSAGE_LIMIT + 1 },
        accountId,
      );
    } catch (err) {
      ctx.log.error({ err, threadId, accountId }, 'email-get-thread: failed to fetch thread');
      // A misspelled mailbox name is actionable: say which accounts exist.
      if (err instanceof UnknownEmailAccountError) {
        return { success: false, error: err.message };
      }
      // Pass the provider's reason through (as email-reply does) so the model can
      // tell a rate limit worth retrying from a dead grant that is not.
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Failed to fetch thread: ${message}` };
    }

    // Guard the filter itself. If thread_id were ever dropped (an SDK rename, a
    // provider ignoring it) this would return unrelated mail as "the thread".
    const inThread = page.filter((m) => m.threadId === threadId);
    if (inThread.length < page.length) {
      ctx.log.warn(
        { threadId, accountId, dropped: page.length - inThread.length },
        'email-get-thread: provider returned messages from other threads; dropped them',
      );
    }

    // Nylas returns no error for an unknown thread id, just an empty page. An
    // empty success would read as "nothing in this thread" and invite retries,
    // so name the likely causes instead.
    if (inThread.length === 0) {
      ctx.log.warn({ threadId, accountId }, 'email-get-thread: no messages found for thread');
      return {
        success: false,
        error:
          `No messages found for thread_id '${threadId}'. Check the id (use the threadId ` +
          'from email-list or email-get) and that account names the mailbox the thread is in.',
      };
    }

    // Newest first, then keep messages until the cap or the body budget runs out,
    // so whatever is dropped is the oldest. The newest message is always kept,
    // even alone over budget: without it the thread read is pointless.
    const newestFirst = [...inThread].sort((a, b) => b.date - a.date);
    const kept: typeof newestFirst = [];
    let bodyChars = 0;
    for (const m of newestFirst) {
      if (kept.length >= THREAD_MESSAGE_LIMIT) break;
      if (kept.length > 0 && bodyChars + m.body.length > THREAD_BODY_BUDGET_CHARS) break;
      kept.push(m);
      bodyChars += m.body.length;
    }
    const omittedOldest = newestFirst.length - kept.length;
    if (omittedOldest > 0) {
      ctx.log.info(
        { threadId, accountId, kept: kept.length, omittedOldest, bodyChars },
        'email-get-thread: thread exceeds the message cap or body budget; omitted the oldest messages',
      );
    }

    // Threads read oldest-first.
    const ordered = kept.reverse();

    return {
      success: true,
      data: {
        // Summary fields come before `messages`: if execution still cuts the
        // output, it cuts from the end, and these must survive.
        threadId,
        count: ordered.length,
        truncated: omittedOldest > 0,
        omittedOldest,
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
      },
    };
  }
}
