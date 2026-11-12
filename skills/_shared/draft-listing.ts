// draft-listing.ts — shared DRAFTS-result shaping for ceo-inbox-list and ceo-inbox-search (#2474).
//
// The principal says "send the drafts I wrote this morning": the model needs a date filter
// (Nylas /drafts has none, so it is applied client-side) and a per-draft flag telling Curia's
// drafts from the principal's own.

import type { ToolContext } from '../../src/skills/types.js';
import { DraftProvenance, draftKey } from '../../src/skills/principal-send/draft-provenance.js';
import { toLocalIso, formatDisplayTimezone, normalizeTimestamp } from '../../src/time/timestamp.js';
import type { NylasDraftSummary } from './ceo-nylas-client.js';

export type ModifiedSince = { ok: true; seconds: number | null } | { ok: false; error: string };

/**
 * Parse the optional `modified_since` input to unix seconds. Absent/blank means no filter.
 * An offset-less value is the principal's local time, not the server's: normalizeTimestamp reads it
 * in `timezone` (UTC when unset), so "2026-11-07T08:00:00" cannot select the wrong drafts to send.
 */
export function parseModifiedSince(raw: unknown, timezone?: string): ModifiedSince {
  if (raw === undefined || raw === null || raw === '') return { ok: true, seconds: null };
  const error = { ok: false as const, error: 'modified_since must be an ISO 8601 date-time (e.g. 2026-11-07T08:00:00-05:00)' };
  if (typeof raw !== 'string') return error;
  try {
    const ms = Date.parse(normalizeTimestamp(raw, timezone ?? 'UTC'));
    return Number.isNaN(ms) ? error : { ok: true, seconds: ms / 1000 };
  } catch {
    // Fail closed: an unreadable cutoff is reported to the model, never guessed at.
    return error;
  }
}

/** Keep drafts last changed at or after the cutoff. Draft `date` is unix seconds. */
export function filterModifiedSince(drafts: NylasDraftSummary[], seconds: number | null): NylasDraftSummary[] {
  return seconds === null ? drafts : drafts.filter((d) => d.date >= seconds);
}

/**
 * Add `created_by_curia` and `date_local` to each draft.
 * Fail-open for listing: if the provenance lookup fails the drafts are still listed with
 * `created_by_curia: null` (unknown). Nothing is sent from this listing; the send path
 * re-checks provenance itself and fails toward review.
 */
export async function annotateDrafts(ctx: ToolContext, drafts: Array<NylasDraftSummary & { mailbox: string }>, toolName: string) {
  let curiaIds: Set<string> | null = null;
  if (ctx.auditLogRepo) {
    try {
      const defaultMailboxId = async (): Promise<string> => {
        const def = await ctx.principalMailboxes?.defaultMailbox();
        if (!def) throw new Error('No default principal mailbox');
        return def.id;
      };
      curiaIds = await new DraftProvenance(ctx.auditLogRepo, ctx.log, undefined, defaultMailboxId, async () => (await ctx.principalMailboxes?.list() ?? []).map((m) => m.id))
        .createdByCuria(drafts.map((d) => ({ mailbox: d.mailbox, draftId: d.id })));
    } catch (err) {
      ctx.log.warn({ err }, `${toolName}: draft provenance lookup failed — created_by_curia unknown`);
    }
  } else {
    ctx.log.warn(`${toolName}: no auditLogRepo — created_by_curia unknown`);
  }
  return {
    drafts: drafts.map((d) => ({
      ...d,
      created_by_curia: curiaIds ? curiaIds.has(draftKey(d.mailbox, d.id)) : null,
      date_local: toLocalIso(d.date, ctx.timezone),
    })),
    displayTimezone: ctx.timezone ? formatDisplayTimezone(ctx.timezone, new Date()) : 'UTC',
  };
}
