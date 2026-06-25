import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { CeoNylasClient } from '../_shared/ceo-nylas-client.js';

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;

// Drafts live in a separate Nylas v3 resource (`/drafts`), not the `/messages`
// collection. Listing them via the message path returns a silent empty array
// (issue #1000), so we detect the drafts folder and route to listDrafts instead.
// Both the Gmail UI name ("DRAFTS") and the API label ("DRAFT") map here.
const DRAFTS_FOLDER_NAMES = new Set(['DRAFT', 'DRAFTS']);

export class CeoInboxListHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
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
        return { success: false, error: 'Failed to list CEO inbox drafts' };
      }
    }

    const unreadOnly = input.unread_only !== false; // default true

    ctx.log.info({ limit, folder, unreadOnly }, 'ceo-inbox-list: listing messages');

    try {
      // Fetch one extra so we can report `has_more` without a second round-trip.
      // The ceo-inbox agent triages the inbox in fixed-size batches and uses
      // `has_more` to decide whether to schedule a self-wake and continue
      // draining. There is no server-side watermark: the unread set IS the
      // not-yet-triaged set, because every triaged message is either archived
      // (Cleared/Handled/Drafted) or marked read (Seen/Urgent/Stuck) and thus
      // drops out of the unread-INBOX query for the next batch.
      const raw = await client.listMessages({
        limit: limit + 1,
        folder,
        unread: unreadOnly || undefined,
      });

      // Drop messages sent by Curia itself — the agent should never triage,
      // archive, or draft replies to its own outbound emails arriving in the
      // CEO's inbox.
      const filtered = curiaEmail
        ? raw.filter(
            (msg) => !msg.from.some((p) => p.email.toLowerCase() === curiaEmail),
          )
        : raw;

      if (filtered.length < raw.length) {
        ctx.log.info(
          { filtered: raw.length - filtered.length },
          'ceo-inbox-list: filtered out messages from Curia',
        );
      }

      // `has_more` is computed from the RAW probe (limit + 1), not the filtered
      // set, so the Curia-self filter can never make it under-report a real
      // backlog. Under-reporting would silently abandon real unread mail until
      // the next cron tick; over-reporting only costs at most one extra empty
      // self-wake. So: if Nylas had more than `limit` matching unread, signal
      // more. (Pathological edge: a batch that is ENTIRELY Curia-self returns
      // count 0 with has_more true — the caller's "count 0 → finish/exit" rule
      // terminates cleanly there, since this read-only skill never marks the
      // Curia-self messages read. Acceptable: Curia does not bulk-email the CEO.)
      const hasMore = raw.length > limit;
      const messages = filtered.slice(0, limit);

      return {
        success: true,
        data: { messages, count: messages.length, has_more: hasMore },
      };
    } catch (err) {
      ctx.log.error({ err }, 'ceo-inbox-list: failed to list messages');
      return { success: false, error: 'Failed to list CEO inbox messages' };
    }
  }
}
