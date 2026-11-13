import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import { encodePageToken, pageScope } from '../../../_shared/composite-page-token.js';
import { allFailedMessage, collectAcross, listAcrossMailboxes, mergeNewestFirst, readPageToken, resolveTargets } from '../../../_shared/cross-mailbox-listing.js';
import { curiaOwnAddresses } from '../../../_shared/curia-own-addresses.js';
import { NYLAS_MAX_LIST_LIMIT, type NylasDraftSummary, type NylasMessageSummary } from '../../../_shared/ceo-nylas-client.js';
import { triageList } from '../../../_shared/triage-listing.js';
import { isPrincipalDirectedMailboxSend } from '../../../../src/skills/principal-send/authority.js';
import { grantSafeErrorFields } from '../../../../src/principal-mailboxes/error-fields.js';
import { DateTime } from 'luxon';
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

// How far back a principal-directed sweep may move a start line ("about a year").
const SWEEP_MAX_DAYS = 366;

export class CeoInboxListHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const input =
      ctx.input && typeof ctx.input === 'object' ? (ctx.input as Record<string, unknown>) : {};

    // A principal-directed sweep moves a start line back (D4). Done before targets are read, so a
    // triage call in the same turn sees the new line.
    if (input.sweep_since !== undefined) {
      const swept = await this.sweep(ctx, input);
      if (!swept.ok) return { success: false, error: swept.error };
      if (input.triage !== true) return { success: true, data: swept.data };
    }

    const resolved = await resolveTargets(ctx, ctx.input, 'ceo-inbox-list');
    if (!resolved.ok) return { success: false, error: resolved.error };
    const { targets } = resolved;

    if (input.triage === true) {
      return triageList(ctx, targets, await curiaOwnAddresses(ctx, 'ceo-inbox-list'));
    }

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
        // Every mailbox is read the same way and the drafts merged newest first (#2475).
        const { ok, errors } = await collectAcross(targets, async (client) => {
          let fetched: NylasDraftSummary[];
          let truncated = false;
          if (since.seconds === null) {
            fetched = await client.listDrafts({ limit });
          } else {
            const all = await client.listAllDrafts({ maxScan: DRAFT_SCAN_LIMIT, pageSize: NYLAS_MAX_LIST_LIMIT });
            fetched = all.drafts;
            truncated = all.truncated;
          }
          return { drafts: filterModifiedSince(fetched, since.seconds).slice(0, limit), truncated, scanned: fetched.length };
        }, { log: ctx.log, tool: 'ceo-inbox-list' });
        if (ok.length === 0) {
          ctx.log.error({ errors }, 'ceo-inbox-list: failed to list drafts');
          return { success: false, error: allFailedMessage('Failed to list principal inbox drafts', errors) };
        }
        const scanIncomplete = ok.some((o) => o.value.truncated);
        if (scanIncomplete) {
          ctx.log.warn({ cap: DRAFT_SCAN_LIMIT }, 'ceo-inbox-list: draft scan hit the cap — older drafts were not checked against modified_since');
        }
        const merged = mergeNewestFirst(ok.map((o) => ({ mailbox: o.mailbox, items: o.value.drafts })), limit);
        const annotated = await annotateDrafts(ctx, merged, 'ceo-inbox-list');
        const drafts = annotated.drafts.map((d, i) => ({ ...d, mailbox: merged[i]!.mailbox, mailbox_label: merged[i]!.mailbox_label }));
        return {
          success: true,
          // `drafts` (not `messages`) + an explicit `folder` make a genuine
          // empty result distinguishable from the old silent-zero failure where
          // the wrong endpoint was queried.
          data: {
            drafts, count: drafts.length, folder: 'DRAFTS', displayTimezone: annotated.displayTimezone,
            ...(scanIncomplete ? { scan_incomplete: true } : {}),
            ...(errors.length > 0 ? { mailbox_errors: errors } : {}),
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

    // A token continues only the listing that made it: same folder, unread filter and mailbox
    // selection (one named mailbox, or every one).
    const scope = pageScope({ tool: 'ceo-inbox-list', folder, unreadOnly, mailbox: typeof input.mailbox === 'string' ? input.mailbox : null });
    const token = readPageToken(input, limit, scope, { log: ctx.log, tool: 'ceo-inbox-list' });
    if (!token.ok) return { success: false, error: token.error };

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

      let droppedSelf = 0;
      let droppedStale = 0;

      // Every mailbox is scanned from its own resume point in page_token (none: from the start),
      // limit+1 kept items each so has_more is known without another round-trip. The filters are
      // re-sent on every page (#2377).
      const cross = await listAcrossMailboxes<NylasMessageSummary>(targets, token.cursors, {
        failures: { log: ctx.log, tool: 'ceo-inbox-list' },
        limit,
        need: limit + 1,
        pageCap: LIST_PAGE_CAP,
        // Follow-up pages use the full list cap. limit+1 (often 6) would
        // leave real mail past ~150 messages under-reported on every run,
        // because Curia-self mail is never marked read.
        fetchPage: (client, cursor) => client.listMessagesPage({
          limit: cursor ? NYLAS_MAX_LIST_LIMIT : limit + 1,
          folder,
          unread: unreadOnly || undefined,
          ...(cursor ? { pageToken: cursor } : {}),
        }),
        keep: (msg) => {
          if (isStale(msg)) { droppedStale++; return false; }
          if (msg.from.some((p) => curiaEmails.has(p.email.toLowerCase()))) { droppedSelf++; return false; }
          return true;
        },
      });

      if (cross.capped) {
        ctx.log.error(
          { pages: LIST_PAGE_CAP, kept: cross.items.length },
          'ceo-inbox-list: paging cap reached before the mailbox was exhausted',
        );
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
      if (cross.allFailed) {
        ctx.log.error({ errors: cross.errors }, 'ceo-inbox-list: every mailbox failed');
        return { success: false, error: allFailedMessage('Failed to list principal inbox messages', cross.errors) };
      }

      return {
        success: true,
        data: {
          messages: cross.items,
          count: cross.items.length,
          has_more: cross.hasMore,
          ...(cross.hasMore ? { next_page_token: encodePageToken(cross.positions, limit, scope) } : {}),
          // count 0 + has_more true spins the agent: an empty page archives
          // nothing, so the next run repeats it. A capped scan with nothing kept
          // stops instead, and says so, so older mail is not silently abandoned.
          ...(cross.capped ? { scan_incomplete: true } : {}),
          ...(cross.errors.length > 0 ? { mailbox_errors: cross.errors } : {}),
          // A live mailbox the token marks finished is named, not silently left out (S2).
          ...(cross.skipped.length > 0 ? { skipped_mailboxes: cross.skipped } : {}),
        },
      };
    } catch (err) {
      ctx.log.error({ err }, 'ceo-inbox-list: failed to list messages');
      return { success: false, error: 'Failed to list principal inbox messages' };
    }
  }

  /** sweep_since: move one mailbox's start line back. The principal's own live turn only. */
  private async sweep(
    ctx: ToolContext,
    input: Record<string, unknown>,
  ): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: string }> {
    if (!isPrincipalDirectedMailboxSend({ liveTurn: ctx.liveTurn, taskMetadata: ctx.taskMetadata })) {
      ctx.log.warn({ tool: 'ceo-inbox-list' }, 'ceo-inbox-list: sweep_since refused: not a live principal turn');
      return { ok: false, error: 'sweep_since is only available when the principal asks for it in a live conversation.' };
    }
    const mailboxId = typeof input.mailbox === 'string' ? input.mailbox.trim() : '';
    if (!mailboxId) return { ok: false, error: 'sweep_since needs the mailbox id to sweep.' };
    const raw = typeof input.sweep_since === 'string' ? input.sweep_since.trim() : '';
    const parsed = DateTime.fromISO(raw, { zone: ctx.timezone ?? 'UTC' });
    if (!raw || !parsed.isValid) return { ok: false, error: 'sweep_since must be an ISO 8601 date, for example 2026-11-01.' };
    const at = parsed.toJSDate();
    const now = Date.now();
    if (at.getTime() > now) return { ok: false, error: 'sweep_since must be in the past.' };
    if (now - at.getTime() > SWEEP_MAX_DAYS * 86_400_000) return { ok: false, error: 'sweep_since can reach back at most a year.' };
    const svc = ctx.triageServices;
    if (!svc) return { ok: false, error: 'Triage is unavailable: triage services are not configured.' };
    if (!ctx.principalMailboxes) return { ok: false, error: 'No principal mailbox is connected.' };
    try {
      const mailbox = await ctx.principalMailboxes.get(mailboxId);
      if (mailbox.triageStartAt === null) return { ok: false, error: `${mailbox.label} has no start line: all of its unread mail is already triaged.` };
      if (at.getTime() >= mailbox.triageStartAt.getTime()) return { ok: false, error: `${mailbox.label}'s start line is already earlier than that.` };
      await svc.setTriageStart(mailbox.id, at);
      // Make the mailbox due now and let a new backlog alarm fire for the larger range.
      await svc.state.setDraining(mailbox.id, true);
      await svc.state.setBacklogAlarmed(mailbox.id, false);
      ctx.log.info({ mailboxId: mailbox.id }, 'ceo-inbox-list: moved a triage start line back on the principal\'s request');
      return { ok: true, data: { mailbox: mailbox.id, mailbox_label: mailbox.label, triage_start_at: at.toISOString(), messages: [], count: 0 } };
    } catch (err) {
      ctx.log.warn({ tool: 'ceo-inbox-list', ...grantSafeErrorFields(err) }, 'ceo-inbox-list: sweep_since failed');
      return { ok: false, error: err instanceof Error && /unknown|removed|no longer/i.test(err.message) ? err.message : 'Could not move the start line.' };
    }
  }
}
