import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import { encodePageToken, pageScope } from '../../../_shared/composite-page-token.js';
import { allFailedMessage, collectAcross, listAcrossMailboxes, mergeNewestFirst, readPageToken, resolveTargets } from '../../../_shared/cross-mailbox-listing.js';
import { curiaOwnAddresses } from '../../../_shared/curia-own-addresses.js';
import { type NylasDraftSummary, type NylasMessageSummary } from '../../../_shared/ceo-nylas-client.js';
import { isSpamOrTrash } from '../../../_shared/mail-folders.js';
import { annotateDrafts, filterModifiedSince, parseModifiedSince } from '../../../_shared/draft-listing.js';

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
    const resolved = await resolveTargets(ctx, ctx.input, 'ceo-inbox-search');
    if (!resolved.ok) return { success: false, error: resolved.error };
    const { targets } = resolved;

    // Curia's own addresses (its email accounts, read live) — filter out messages from
    // them so the agent can't operate on its own outbound emails even via search.
    const curiaEmails = await curiaOwnAddresses(ctx, 'ceo-inbox-search');

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
      const since = parseModifiedSince(input.modified_since, ctx.timezone);
      if (!since.ok) return { success: false, error: since.error };
      try {
        // Paginate the full drafts collection (bounded by DRAFT_SCAN_LIMIT) so a
        // match isn't missed on a mailbox with more than one page of drafts. Every
        // mailbox is searched and the matches merged newest first (#2475).
        const { ok, errors } = await collectAcross(targets, async (client) => {
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
          // Date filter before the slice so the limit counts matching drafts (#2474).
          return filterModifiedSince(allDrafts.filter((d) => draftMatchesQuery(d, query)), since.seconds);
        }, { log: ctx.log, tool: 'ceo-inbox-search' });
        if (ok.length === 0) {
          ctx.log.error({ errors }, 'ceo-inbox-search: draft search failed on every mailbox');
          return { success: false, error: allFailedMessage('Failed to search principal inbox drafts', errors) };
        }
        const merged = mergeNewestFirst(ok.map((o) => ({ mailbox: o.mailbox, items: o.value })), limit);
        const annotated = await annotateDrafts(ctx, merged, 'ceo-inbox-search');
        const drafts = annotated.drafts.map((d, i) => ({ ...d, mailbox: merged[i]!.mailbox, mailbox_label: merged[i]!.mailbox_label }));
        return {
          success: true,
          data: {
            drafts, count: drafts.length, folder: 'DRAFTS', displayTimezone: annotated.displayTimezone,
            ...(errors.length > 0 ? { mailbox_errors: errors } : {}),
          },
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

    // A follow-up page sends only the Nylas cursor, which continues the original search: a token
    // is bound to its query, Spam/Trash choice and mailbox selection (one named mailbox, or every
    // one), so a changed request is refused, not ignored.
    const scope = pageScope({ tool: 'ceo-inbox-search', query, includeSpamAndTrash, mailbox: typeof input.mailbox === 'string' ? input.mailbox : null });
    const token = readPageToken(input, limit, scope, { log: ctx.log, tool: 'ceo-inbox-search' });
    if (!token.ok) return { success: false, error: token.error };

    try {
      // Every mailbox pages until `limit` visible messages are collected from it. Dropping Spam,
      // Trash, or Curia-self mail from a full page must not look like an empty mailbox when a
      // later page still has something to triage. A follow-up page stays token-only (the client
      // does not re-send filters beside a search query).
      let omittedHidden = 0;
      const cross = await listAcrossMailboxes<NylasMessageSummary>(targets, token.cursors, {
        failures: { log: ctx.log, tool: 'ceo-inbox-search' },
        limit,
        need: limit,
        pageCap: SEARCH_PAGE_CAP,
        fetchPage: (client, cursor) => client.listMessagesPage({
          query,
          limit,
          ...(cursor ? { pageToken: cursor } : {}),
        }),
        keep: (msg) => {
          if (msg.from.some((p) => curiaEmails.has(p.email.toLowerCase()))) return false;
          if (!includeSpamAndTrash && isSpamOrTrash(msg.folders)) {
            omittedHidden++;
            return false;
          }
          return true;
        },
      });

      if (cross.capped) {
        ctx.log.warn(
          { pages: SEARCH_PAGE_CAP, kept: cross.items.length },
          'ceo-inbox-search: paging cap reached before the result was filled',
        );
      }
      if (omittedHidden > 0) {
        ctx.log.info(
          { omitted: omittedHidden },
          'ceo-inbox-search: omitted Spam and Trash',
        );
      }
      if (cross.allFailed) {
        ctx.log.error({ errors: cross.errors }, 'ceo-inbox-search: every mailbox failed');
        return { success: false, error: allFailedMessage('Failed to search principal inbox', cross.errors) };
      }

      return {
        success: true,
        data: {
          messages: cross.items,
          count: cross.items.length,
          ...(cross.anyOpen ? { next_page_token: encodePageToken(cross.positions, limit, scope) } : {}),
          ...(cross.errors.length > 0 ? { mailbox_errors: cross.errors } : {}),
          // A live mailbox the token marks finished is named, not silently left out (S2).
          ...(cross.skipped.length > 0 ? { skipped_mailboxes: cross.skipped } : {}),
        },
      };
    } catch (err) {
      ctx.log.error({ err }, 'ceo-inbox-search: search failed');
      return { success: false, error: 'Failed to search principal inbox' };
    }
  }
}
