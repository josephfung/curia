// handler.ts — email-list skill implementation.
//
// Lists messages from any configured email account via OutboundGateway.
// Returns lightweight summaries (no body — use email-get for full content).
// Account resolution is handled by the gateway's named-client map.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import type { ListMessagesOptions } from '../../src/channels/email/nylas-client.js';

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;

export class EmailListHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    if (!ctx.outboundGateway) {
      return { success: false, error: 'email-list requires outboundGateway (infrastructure: true)' };
    }

    // Handlers must never throw — destructuring a non-object ctx.input would.
    const input =
      ctx.input && typeof ctx.input === 'object' ? (ctx.input as Record<string, unknown>) : {};
    const { account, folder, unread_only, from, subject, search, limit } = input as {
      account?: string;
      folder?: string;
      unread_only?: boolean;
      from?: string;
      subject?: string;
      search?: string;
      limit?: number;
    };

    const accountId = typeof account === 'string' && account.trim() ? account.trim() : undefined;

    const options: ListMessagesOptions = {};
    if (typeof folder === 'string' && folder.trim()) options.folders = [folder.trim()];
    if (unread_only === true) options.unread = true;
    if (typeof from === 'string' && from.trim()) options.from = from.trim();
    if (typeof subject === 'string' && subject.trim()) options.subject = subject.trim();
    if (typeof search === 'string' && search.trim()) options.searchQueryNative = search.trim();
    // Coerce to a positive integer before forwarding — LLMs occasionally emit floats
    // (e.g. 12.7) and Nylas expects an int. Non-finite or non-positive values fall back
    // to DEFAULT_LIMIT.
    const normalizedLimit =
      typeof limit === 'number' && Number.isFinite(limit) ? Math.floor(limit) : undefined;
    options.limit =
      normalizedLimit !== undefined && normalizedLimit > 0
        ? Math.min(normalizedLimit, MAX_LIMIT)
        : DEFAULT_LIMIT;

    // Avoid logging raw filter values — sender addresses, subject text, and
    // provider-native search terms can carry PII. Log presence/shape only.
    ctx.log.info(
      {
        accountId,
        unread: options.unread,
        limit: options.limit,
        folderCount: options.folders?.length ?? 0,
        hasFrom: options.from !== undefined,
        hasSubject: options.subject !== undefined,
        hasSearchQueryNative: options.searchQueryNative !== undefined,
      },
      'email-list: listing messages',
    );

    let messages: Awaited<ReturnType<typeof ctx.outboundGateway.listEmailMessages>>;
    try {
      messages = await ctx.outboundGateway.listEmailMessages(options, accountId);
    } catch (err) {
      ctx.log.error({ err, accountId }, 'email-list: failed to list messages');
      return { success: false, error: 'Failed to list messages' };
    }

    return {
      success: true,
      data: {
        messages: messages.map((m) => ({
          id: m.id,
          threadId: m.threadId,
          subject: m.subject,
          from: m.from,
          snippet: m.snippet,
          date: m.date,
          unread: m.unread,
          folders: m.folders,
        })),
        count: messages.length,
      },
    };
  }
}
