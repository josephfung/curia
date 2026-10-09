import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import { CeoNylasClient, type NylasDraftSummary, type NylasMessageSummary } from '../../../_shared/ceo-nylas-client.js';
import { isSpamOrTrash } from '../../../_shared/mail-folders.js';

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 10;

// Folder names that mean "search the principal's unsent drafts" (issue #1000).
const DRAFTS_FOLDER_NAMES = new Set(['DRAFT', 'DRAFTS']);

// Drafts have no native server-side search in Nylas v3, so we list-then-filter
// client-side. listAllDrafts paginates through the mailbox up to this ceiling so
// matches aren't missed beyond the first page; beyond it we warn rather than
// silently return an incomplete result.
const DRAFT_SCAN_LIMIT = 500;
const DRAFT_PAGE_SIZE = 100;

// Pages to walk when hidden or Curia-self mail would otherwise shrink a full
// page to nothing and hide a later real message. Bounded like the list handler.
const SEARCH_PAGE_CAP = 25;

/**
 * Case-insensitive substring match of `query` against a draft's subject and
 * each recipient's email + display name. This is the searchable surface for
 * drafts: by subject and by recipient (issue #1000 acceptance criteria).
 */
function draftMatchesQuery(draft: NylasDraftSummary, query: string): boolean {
  const needle = query.toLowerCase();
  if (draft.subject.toLowerCase().includes(needle)) return true;
  const recipients = [...draft.to, ...draft.cc];
  return recipients.some(
    (p) =>
      p.email.toLowerCase().includes(needle) ||
      (p.name?.toLowerCase().includes(needle) ?? false),
  );
}

export class CeoInboxSearchHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const apiKey = ctx.secret('nylas_api_key');
    const grantId = ctx.secret('ceo_nylas_grant_id');
    const client = new CeoNylasClient(apiKey, grantId, ctx.log, ctx);

    // Curia's own email — filter out messages from this address so the agent
    // can't operate on its own outbound emails even via search.
    let curiaEmail: string | undefined;
    try {
      curiaEmail = ctx.secret('nylas_self_email').toLowerCase();
    } catch {
      ctx.log.warn({}, 'ceo-inbox-search: NYLAS_SELF_EMAIL not set — skipping Curia email filter');
    }

    const input =
      ctx.input && typeof ctx.input === 'object' ? (ctx.input as Record<string, unknown>) : {};

    const query =
      typeof input.query === 'string' ? input.query.trim() : '';

    if (!query) {
      return { success: false, error: 'query is required' };
    }

    const rawLimit =
      typeof input.limit === 'number' && Number.isFinite(input.limit)
        ? Math.floor(input.limit)
        : DEFAULT_LIMIT;
    const limit = Math.max(1, Math.min(rawLimit, MAX_LIMIT));

    const folder = typeof input.folder === 'string' ? input.folder.trim() : '';
    const includeSpamAndTrash = input.include_spam_and_trash === true;

    // ── Drafts branch (issue #1000) ──────────────────────────────────────────
    //
    // Drafts live in the `/drafts` resource and have no native search, so we
    // list them and filter client-side by subject/recipient. Routed here when
    // the caller scopes the search to the drafts folder.
    if (folder && DRAFTS_FOLDER_NAMES.has(folder.toUpperCase())) {
      ctx.log.info(
        { queryLength: query.length, limit },
        'ceo-inbox-search: searching drafts via /drafts (client-side filter)',
      );
      try {
        // Paginate the full drafts collection (bounded by DRAFT_SCAN_LIMIT) so a
        // match isn't missed on a mailbox with more than one page of drafts.
        const { drafts: allDrafts, truncated } = await client.listAllDrafts({
          maxScan: DRAFT_SCAN_LIMIT,
          pageSize: DRAFT_PAGE_SIZE,
        });
        // Only when there are genuinely more drafts than the ceiling do we warn —
        // the result is then knowingly incomplete rather than silently so.
        if (truncated) {
          ctx.log.warn(
            { scanned: allDrafts.length, cap: DRAFT_SCAN_LIMIT },
            'ceo-inbox-search: draft scan hit the cap — some drafts beyond the limit were not searched',
          );
        }
        const drafts = allDrafts.filter((d) => draftMatchesQuery(d, query)).slice(0, limit);
        return {
          success: true,
          data: { drafts, count: drafts.length, folder: 'DRAFTS' },
        };
      } catch (err) {
        ctx.log.error({ err }, 'ceo-inbox-search: draft search failed');
        return { success: false, error: 'Failed to search principal inbox drafts' };
      }
    }

    ctx.log.info(
      { queryLength: query.length, limit },
      'ceo-inbox-search: searching messages',
    );

    try {
      // Page until `limit` visible messages are collected. Dropping Spam, Trash,
      // or Curia-self mail from a full page must not look like an empty mailbox
      // when a later page still has something to triage.
      const collected: NylasMessageSummary[] = [];
      let pageToken: string | undefined;
      let omittedHidden = 0;

      for (let page = 0; page < SEARCH_PAGE_CAP && collected.length < limit; page++) {
        const { messages: raw, nextCursor } = await client.listMessagesPage({
          query,
          limit,
          ...(pageToken ? { pageToken } : {}),
        });

        for (const msg of raw) {
          if (curiaEmail && msg.from.some((p) => p.email.toLowerCase() === curiaEmail)) {
            continue;
          }
          if (!includeSpamAndTrash && isSpamOrTrash(msg.folders)) {
            omittedHidden++;
            continue;
          }
          collected.push(msg);
          if (collected.length >= limit) break;
        }

        if (collected.length >= limit || !nextCursor || raw.length === 0) break;
        if (page === SEARCH_PAGE_CAP - 1) {
          ctx.log.warn(
            { pages: SEARCH_PAGE_CAP, kept: collected.length },
            'ceo-inbox-search: paging cap reached before the result was filled',
          );
          break;
        }
        pageToken = nextCursor;
      }

      if (omittedHidden > 0) {
        ctx.log.info(
          { omitted: omittedHidden },
          'ceo-inbox-search: omitted Spam and Trash',
        );
      }

      const messages = collected.slice(0, limit);
      return {
        success: true,
        data: { messages, count: messages.length },
      };
    } catch (err) {
      ctx.log.error({ err }, 'ceo-inbox-search: search failed');
      return { success: false, error: 'Failed to search principal inbox' };
    }
  }
}
