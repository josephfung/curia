import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import { ceoNylasApiKey } from '../../../_shared/ceo-nylas-api-key.js';
import { curiaOwnAddresses } from '../../../_shared/curia-own-addresses.js';
import { CeoNylasClient, NYLAS_MAX_LIST_LIMIT, type NylasDraftSummary, type NylasMessageSummary } from '../../../_shared/ceo-nylas-client.js';
import { annotateDrafts, filterModifiedSince, parseModifiedSince } from '../../../_shared/draft-listing.js';

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;
// With modified_since the whole drafts collection is scanned, as ceo-inbox-search does, up to
// this ceiling (#2474 final review C1): "this morning's drafts" must not stop at one page.
const DRAFT_SCAN_LIMIT = 500;

// Drafts live in a separate Nylas v3 resource (`/drafts`), not the `/messages`
// collection. Listing them via the message path returns a silent empty array
// (issue #1000), so we detect the drafts folder and route to listDrafts instead.
// Both the Gmail UI name ("DRAFTS") and the API label ("DRAFT") map here.
const DRAFTS_FOLDER_NAMES = new Set(['DRAFT', 'DRAFTS']);

// How many Nylas pages to walk when Curia-self mail empties a page. The first
// page asks for limit+1 so has_more can be decided in one round-trip. Later
// pages ask for the Nylas list cap. 25 pages therefore cover about 500
// messages, and a cursor that never ends cannot loop forever.
const LIST_PAGE_CAP = 25;

// Gmail system labels whose Nylas folder ID is the label name itself, so a
// result can be checked against the requested folder. A user label's ID is
// opaque (`Label_123`) and may not match the name the caller passed, so the
// folder check is skipped for those rather than dropping every result.
const SYSTEM_FOLDER_IDS = new Set(['INBOX', 'SENT', 'SPAM', 'TRASH', 'STARRED', 'IMPORTANT']);

function isSystemFolder(folder: string): boolean {
  const upper = folder.toUpperCase();
  return SYSTEM_FOLDER_IDS.has(upper) || upper.startsWith('CATEGORY_');
}

export class CeoInboxListHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const apiKey = ceoNylasApiKey(ctx);
    const grantId = ctx.secret('ceo_nylas_grant_id');
    const client = new CeoNylasClient(apiKey, grantId, ctx.log, ctx);

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
      const since = parseModifiedSince(input.modified_since, ctx.timezone);
      if (!since.ok) return { success: false, error: since.error };
      try {
        // Nylas /drafts has no date parameter (#2474): with a cutoff, scan every page and
        // filter here, so the limit counts matching drafts and none past the first page is
        // missed (final review C1). A scan stopped at its cap says so (scan_incomplete).
        let fetched: NylasDraftSummary[];
        let scanIncomplete = false;
        if (since.seconds === null) {
          fetched = await client.listDrafts({ limit });
        } else {
          const all = await client.listAllDrafts({ maxScan: DRAFT_SCAN_LIMIT, pageSize: NYLAS_MAX_LIST_LIMIT });
          fetched = all.drafts;
          scanIncomplete = all.truncated;
          if (scanIncomplete) {
            ctx.log.warn({ scanned: fetched.length, cap: DRAFT_SCAN_LIMIT }, 'ceo-inbox-list: draft scan hit the cap — older drafts were not checked against modified_since');
          }
        }
        const kept = filterModifiedSince(fetched, since.seconds).slice(0, limit);
        const { drafts, displayTimezone } = await annotateDrafts(ctx, kept, 'ceo-inbox-list');
        return {
          success: true,
          // `drafts` (not `messages`) + an explicit `folder` make a genuine
          // empty result distinguishable from the old silent-zero failure where
          // the wrong endpoint was queried.
          data: {
            drafts, count: drafts.length, folder: 'DRAFTS', displayTimezone,
            ...(scanIncomplete ? { scan_incomplete: true } : {}),
          },
        };
      } catch (err) {
        ctx.log.error({ err }, 'ceo-inbox-list: failed to list drafts');
        return { success: false, error: 'Failed to list principal inbox drafts' };
      }
    }

    // Curia's own addresses — messages from them are filtered out so the agent doesn't
    // triage or act on its own outbound emails. Read after the drafts branch, which has
    // no use for them, so a slow lookup can't eat that branch's tool deadline.
    const curiaEmails = await curiaOwnAddresses(ctx, 'ceo-inbox-list');

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
      //
      // Follow-up pages once came back unfiltered, because the cursor does
      // not carry in/unread (#2377). Read, archived mail then never left the
      // result set, so has_more stayed true and every drain wake re-triaged
      // handled mail. The client now re-sends the filters. As a backstop,
      // results that contradict the request are dropped here too, the same
      // way as Curia-self mail, before has_more is decided.
      const checkFolder = isSystemFolder(folder);
      const wantFolder = folder.toUpperCase();
      const isStale = (msg: NylasMessageSummary): boolean =>
        (unreadOnly && !msg.unread) ||
        (checkFolder && !msg.folders.some((f) => f.toUpperCase() === wantFolder));

      const collected: NylasMessageSummary[] = [];
      let droppedSelf = 0;
      let droppedStale = 0;
      let pageToken: string | undefined;
      let hasMore = false;
      let scanIncomplete = false;

      for (let page = 0; page < LIST_PAGE_CAP; page++) {
        const { messages: raw, nextCursor } = await client.listMessagesPage({
          // Follow-up pages use the full list cap. limit+1 (often 6) would
          // leave real mail past ~150 messages under-reported on every run,
          // because Curia-self mail is never marked read.
          limit: pageToken ? NYLAS_MAX_LIST_LIMIT : limit + 1,
          folder,
          unread: unreadOnly || undefined,
          ...(pageToken ? { pageToken } : {}),
        });

        const fresh = raw.filter((msg) => !isStale(msg));
        droppedStale += raw.length - fresh.length;
        const pageFiltered = fresh.filter(
          (msg) => !msg.from.some((p) => curiaEmails.has(p.email.toLowerCase())),
        );
        droppedSelf += fresh.length - pageFiltered.length;
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
          // nothing, so the next run repeats it. Stop instead, and say the
          // scan stopped early so older mail is not silently abandoned.
          hasMore = collected.length > 0;
          scanIncomplete = true;
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
      if (droppedStale > 0) {
        ctx.log.warn(
          { dropped: droppedStale, folder, unreadOnly },
          'ceo-inbox-list: dropped provider results that contradict the requested filter',
        );
      }

      const messages = collected.slice(0, limit);

      return {
        success: true,
        data: {
          messages,
          count: messages.length,
          has_more: hasMore,
          ...(scanIncomplete ? { scan_incomplete: true } : {}),
        },
      };
    } catch (err) {
      ctx.log.error({ err }, 'ceo-inbox-list: failed to list messages');
      return { success: false, error: 'Failed to list principal inbox messages' };
    }
  }
}
