import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { CeoNylasClient } from '../_shared/ceo-nylas-client.js';
import { ConfigStore } from '../../src/memory/config-store.js';

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;

const WATERMARK_NAMESPACE = 'ceo_inbox';
const WATERMARK_KEY = 'last_processed_at';

// Default lookback when no persisted watermark exists (first run).
const FIRST_RUN_HOURS = 24;

// Drafts live in a separate Nylas v3 resource (`/drafts`), not the `/messages`
// collection. Listing them via the message path returns a silent empty array
// (issue #1000), so we detect the drafts folder and route to listDrafts instead.
// Both the Gmail UI name ("DRAFTS") and the API label ("DRAFT") map here.
const DRAFTS_FOLDER_NAMES = new Set(['DRAFT', 'DRAFTS']);

export class CeoInboxListHandler implements SkillHandler {
  // Namespace is injectable so integration tests can scope their writes to a
  // test-only namespace and avoid corrupting the production watermark.
  private readonly ns: string;

  constructor(ns = WATERMARK_NAMESPACE) {
    this.ns = ns;
  }

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
    // Short-circuit here, BEFORE any watermark logic: drafts have no meaningful
    // "received" date, so applying received_after would re-zero the result, and
    // advancing the inbox triage watermark off a draft's date would corrupt it.
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

    // received_after_hours: first-run fallback only. The absolute watermark is
    // now managed by this skill via ConfigStore — the LLM no longer supplies
    // timestamps. (fix: issue #866)
    const receivedAfterHours =
      typeof input.received_after_hours === 'number' && Number.isFinite(input.received_after_hours)
        ? Math.max(1, Math.floor(input.received_after_hours))
        : undefined;

    // ── Watermark read (code-owned, not LLM-owned) ────────────────────────────
    //
    // Read last_processed_at from ConfigStore. The LLM never supplies this
    // value — model-fabricated unix timestamps drifted 29 days into the future
    // and blinded inbox triage for ~19 hours (issue #866).
    const nowSeconds = Math.floor(Date.now() / 1_000);
    // effectiveWatermark: the value used to compute receivedAfter.
    // watermarkFloor: the monotonicity floor for the advance guard; may differ from
    // effectiveWatermark when we heal a poisoned future timestamp (we fall through
    // to the default 24h lookback while keeping nowSeconds as the floor so the
    // advance write doesn't regress back to a past message date).
    let effectiveWatermark: number | undefined;
    let watermarkFloor: number | undefined;
    let configStore: ConfigStore | undefined;
    // Set to true when a future watermark is detected and healed. When true the
    // received_after_hours caller input is ignored — a poisoned watermark always
    // recovers via the hard 24h default to guarantee the backlog is visible.
    let poisonedWatermark = false;

    if (ctx.entityMemory) {
      configStore = new ConfigStore(ctx.entityMemory, ctx.log);
      try {
        const stored = await configStore.get(this.ns, WATERMARK_KEY);
        if (stored !== null) {
          const parsed = Math.floor(Number(stored));
          if (Number.isFinite(parsed)) {
            if (parsed > nowSeconds) {
              // Defensive clamp: a future watermark is physically impossible.
              // Treat as "no watermark" for this query (fall through to the default
              // 24h lookback) so the current run can recover the recent backlog.
              // Heal the stored value immediately so future runs start clean.
              ctx.log.warn(
                { stored, nowSeconds, deltaSeconds: parsed - nowSeconds },
                'ceo-inbox-list: last_processed_at is in the future — healing stored value and falling back to default lookback',
              );
              effectiveWatermark = undefined; // use default 24h lookback for this run
              watermarkFloor = nowSeconds; // advance guard never regresses past healed value
              poisonedWatermark = true; // bypass received_after_hours override on poisoned runs
              // Heal asynchronously; don't block the Nylas query on this write.
              configStore.set(this.ns, WATERMARK_KEY, String(nowSeconds)).catch((err) => {
                ctx.log.error({ err, healedTo: nowSeconds }, 'ceo-inbox-list: failed to heal future watermark in ConfigStore');
              });
            } else {
              effectiveWatermark = parsed;
              watermarkFloor = parsed;
            }
          }
        }
      } catch (err) {
        // Config read failure is non-fatal: fall through to first-run defaults.
        ctx.log.error(
          { err, errorType: err instanceof Error ? err.constructor.name : typeof err },
          'ceo-inbox-list: failed to read watermark from ConfigStore — using first-run default',
        );
      }
    } else {
      ctx.log.warn({}, 'ceo-inbox-list: entityMemory not available — watermark reads/writes skipped');
    }

    // +1 on the stored watermark converts "last processed" to "strictly after",
    // preventing re-fetch of the last-seen message (Nylas uses inclusive >= comparison).
    // When the watermark was poisoned (future timestamp), always use the hard 24h default
    // regardless of any received_after_hours caller input — we must recover the backlog.
    const receivedAfter =
      effectiveWatermark !== undefined
        ? effectiveWatermark + 1
        : !poisonedWatermark && receivedAfterHours !== undefined
          ? Math.floor((Date.now() - receivedAfterHours * 3_600_000) / 1_000)
          : nowSeconds - FIRST_RUN_HOURS * 3_600; // hard default: last 24h

    ctx.log.info(
      {
        limit,
        folder,
        unreadOnly,
        receivedAfter,
        source:
          effectiveWatermark !== undefined
            ? 'config-store'
            : poisonedWatermark
              ? 'poison-recovery'
              : receivedAfterHours !== undefined
                ? 'hours'
                : 'default',
      },
      'ceo-inbox-list: listing messages',
    );

    try {
      const raw = await client.listMessages({
        limit,
        folder,
        unread: unreadOnly || undefined,
        receivedAfter,
      });

      // Drop messages sent by Curia itself — the agent should never triage,
      // archive, or draft replies to its own outbound emails arriving in the
      // CEO's inbox.
      const messages = curiaEmail
        ? raw.filter(
            (msg) => !msg.from.some((p) => p.email.toLowerCase() === curiaEmail),
          )
        : raw;

      if (messages.length < raw.length) {
        ctx.log.info(
          { filtered: raw.length - messages.length },
          'ceo-inbox-list: filtered out messages from Curia',
        );
      }

      // ── Watermark advance (code-owned, not LLM-owned) ──────────────────────
      //
      // Advance to max(msg.date) of the raw (pre-filter) result. Using `raw`
      // rather than `messages` prevents a stall when every fetched message is
      // Curia-originated: in that case `messages` would be empty, the watermark
      // would never advance, and the same Curia messages would be re-fetched
      // every run while newer external mail sits unseen beyond the limit window.
      // Only writes when there are raw messages and the new max strictly advances
      // past watermarkFloor (the persisted value, or nowSeconds after a heal).
      // A zero-raw-message run leaves last_processed_at unchanged.
      if (raw.length > 0 && configStore) {
        // Use reduce rather than spread+Math.max to avoid a RangeError for very large arrays.
        const maxDate = raw.reduce((max, m) => (m.date > max ? m.date : max), 0);
        if (watermarkFloor === undefined || maxDate > watermarkFloor) {
          configStore.set(this.ns, WATERMARK_KEY, String(maxDate)).catch((err) => {
            ctx.log.error({ err, advanceTo: maxDate }, 'ceo-inbox-list: failed to advance watermark in ConfigStore');
          });
        }
      }

      return {
        success: true,
        data: { messages, count: messages.length },
      };
    } catch (err) {
      ctx.log.error({ err }, 'ceo-inbox-list: failed to list messages');
      return { success: false, error: 'Failed to list CEO inbox messages' };
    }
  }
}
