import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { CeoNylasClient, type NylasDraftSummary } from '../_shared/ceo-nylas-client.js';

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 10;

// Folder names that mean "search the CEO's unsent drafts" (issue #1000).
const DRAFTS_FOLDER_NAMES = new Set(['DRAFT', 'DRAFTS']);

// Drafts have no native server-side search in Nylas v3, so we list-then-filter
// client-side. Pull a generous page first; mailboxes rarely hold many drafts.
const DRAFT_SCAN_LIMIT = 100;

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

export class CeoInboxSearchHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const apiKey = ctx.secret('nylas_api_key');
    const grantId = ctx.secret('ceo_nylas_grant_id');
    const client = new CeoNylasClient(apiKey, grantId, ctx.log);

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
        const allDrafts = await client.listDrafts({ limit: DRAFT_SCAN_LIMIT });
        // The client-side filter only sees this first page. If we hit the scan
        // cap, matches could exist beyond it — warn rather than truncate silently
        // (mailboxes rarely hold 100+ drafts; full pagination is a follow-up).
        if (allDrafts.length >= DRAFT_SCAN_LIMIT) {
          ctx.log.warn(
            { scanned: allDrafts.length, cap: DRAFT_SCAN_LIMIT },
            'ceo-inbox-search: draft scan hit the cap — matches beyond the first page are not searched',
          );
        }
        const drafts = allDrafts.filter((d) => draftMatchesQuery(d, query)).slice(0, limit);
        return {
          success: true,
          data: { drafts, count: drafts.length, folder: 'DRAFTS' },
        };
      } catch (err) {
        ctx.log.error({ err }, 'ceo-inbox-search: draft search failed');
        return { success: false, error: 'Failed to search CEO inbox drafts' };
      }
    }

    ctx.log.info(
      { queryLength: query.length, limit },
      'ceo-inbox-search: searching messages',
    );

    try {
      const raw = await client.listMessages({ query, limit });

      const messages = curiaEmail
        ? raw.filter(
            (msg) => !msg.from.some((p) => p.email.toLowerCase() === curiaEmail),
          )
        : raw;

      return {
        success: true,
        data: { messages, count: messages.length },
      };
    } catch (err) {
      ctx.log.error({ err }, 'ceo-inbox-search: search failed');
      return { success: false, error: 'Failed to search CEO inbox' };
    }
  }
}
