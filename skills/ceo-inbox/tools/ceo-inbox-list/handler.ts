import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import { CeoNylasClient, type NylasMessageSummary } from '../../../_shared/ceo-nylas-client.js';

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;

// Drafts live in a separate Nylas v3 resource (`/drafts`), not the `/messages`
// collection. Listing them via the message path returns a silent empty array
// (issue #1000), so we detect the drafts folder and route to listDrafts instead.
// Both the Gmail UI name ("DRAFTS") and the API label ("DRAFT") map here.
const DRAFTS_FOLDER_NAMES = new Set(['DRAFT', 'DRAFTS']);

// How many Nylas pages to walk when Curia-self mail empties a page. Each page
// is at most the client's list cap (20), so this bounds a scan at a few hundred
// messages — enough to skip a block of the agent's own mail without looping
// forever if a cursor never ends.
const LIST_PAGE_CAP = 25;

export class CeoInboxListHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const apiKey = ctx.secret('nylas_api_key');
    const grantId = ctx.secret('ceo_nylas_grant_id');
    const client = new CeoNylasClient(apiKey, grantId, ctx.log);

    // Curia's own email — messages from this address are filtered out so the
    // agent doesn't triage, archive, or draft replies to its own outbound emails.
    // Resolved inside try/catch: a missing NYLAS_SELF_EMAIL should degrade
    // gracefully (skip filter + warn) rather than crash the whole skill.
    let curiaEmail: string | undefined;
    try {
      curiaEmail = ctx.secret('nylas_self_email').toLowerCase();
    } catch {
      ctx.log.warn({}, 'ceo-inbox-list: NYLAS_SELF_EMAIL not set — skipping Curia email filter');
    }

    const input =
      ctx.input && typeof ctx.input === 'object' ? (ctx.input as Record<string, unknown>) : {};

    // Normalize inputs — LLMs may emit floats, strings, or missing values
    const rawLimit =
      typeof input.limit === 'number' && Number.isFinite(input.limit)
        ? Math.floor(input.limit)
        : DEFAULT_LIMIT;
    const limit = Math.max(1, Math.min(rawLimit, MAX_LIMIT));

    const folder =
      typeof input.folder === 'string' && input.folder.trim()
        ? input.folder.trim()
        : 'INBOX';

    // ── Drafts branch (issue #1000) ──────────────────────────────────────────
    //
    // Drafts are a distinct Nylas resource — query `/drafts`, not `/messages`.
    if (DRAFTS_FOLDER_NAMES.has(folder.toUpperCase())) {
      ctx.log.info({ folder, limit }, 'ceo-inbox-list: listing drafts via /drafts');
      try {
        const drafts = await client.listDrafts({ limit });
        return {
          success: true,
          // `drafts` (not `messages`) + an explicit `folder` make a genuine
          // empty result distinguishable from the old silent-zero failure where
          // the wrong endpoint was queried.
          data: { drafts, count: drafts.length, folder: 'DRAFTS' },
        };
      } catch (err) {
        ctx.log.error({ err }, 'ceo-inbox-list: failed to list drafts');
        return { success: false, error: 'Failed to list principal inbox drafts' };
      }
    }

    const unreadOnly = input.unread_only !== false; // default true

    ctx.log.info({ limit, folder, unreadOnly }, 'ceo-inbox-list: listing messages');

    try {
      // Fetch one extra so a single full page can report `has_more` without
      // another round-trip. The ceo-inbox agent triages in fixed-size batches
      // and uses `has_more` to decide whether to schedule a self-wake. There
      // is no server-side watermark: the unread set IS the not-yet-triaged
      // set, because every triaged message is either archived
      // (Cleared/Handled/Drafted) or marked read (Seen/Urgent/Stuck) and thus
      // drops out of the unread-INBOX query for the next batch.
      //
      // Curia-self mail is removed after the fetch. When that empties a page,
      // keep paging until a real message turns up or the mailbox is exhausted.
      // `has_more` is computed from the filtered results. An empty batch must
      // not report has_more: nothing gets archived, so the next run would see
      // the same page and reschedule forever (#2035).
      const collected: NylasMessageSummary[] = [];
      let droppedSelf = 0;
      let pageToken: string | undefined;
      let hasMore = false;

      for (let page = 0; page < LIST_PAGE_CAP; page++) {
        const { messages: raw, nextCursor } = await client.listMessagesPage({
          limit: limit + 1,
          folder,
          unread: unreadOnly || undefined,
          ...(pageToken ? { pageToken } : {}),
        });

        const pageFiltered = curiaEmail
          ? raw.filter(
              (msg) => !msg.from.some((p) => p.email.toLowerCase() === curiaEmail),
            )
          : raw;
        droppedSelf += raw.length - pageFiltered.length;
        collected.push(...pageFiltered);

        if (collected.length > limit) {
          hasMore = true;
          break;
        }
        if (!nextCursor || raw.length === 0) {
          break;
        }
        if (page === LIST_PAGE_CAP - 1) {
          ctx.log.error(
            { pages: LIST_PAGE_CAP, kept: collected.length },
            'ceo-inbox-list: paging cap reached before the mailbox was exhausted',
          );
          // count 0 + has_more true spins the agent: an empty page archives
          // nothing, so the next run repeats it. Stop instead.
          hasMore = collected.length > 0;
          break;
        }
        pageToken = nextCursor;
      }

      if (droppedSelf > 0) {
        ctx.log.info(
          { filtered: droppedSelf },
          'ceo-inbox-list: filtered out messages from Curia',
        );
      }

      const messages = collected.slice(0, limit);

      return {
        success: true,
        data: { messages, count: messages.length, has_more: hasMore },
      };
    } catch (err) {
      ctx.log.error({ err }, 'ceo-inbox-list: failed to list messages');
      return { success: false, error: 'Failed to list principal inbox messages' };
    }
  }
}
