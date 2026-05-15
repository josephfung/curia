import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { CeoNylasClient } from '../_shared/ceo-nylas-client.js';

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;

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

    const unreadOnly = input.unread_only !== false; // default true

    // Date gate: received_after_timestamp (absolute, from config-store high-water
    // mark) takes precedence over received_after_hours (relative, first-run fallback).
    // config-store returns all values as strings, so we coerce with Number() to
    // handle both string and number inputs from the LLM. (fix: issue #44)
    const rawTimestamp = Number(input.received_after_timestamp);
    const receivedAfterTimestamp =
      Number.isFinite(rawTimestamp)
        ? Math.floor(rawTimestamp)
        : undefined;

    const receivedAfterHours =
      typeof input.received_after_hours === 'number' && Number.isFinite(input.received_after_hours)
        ? Math.max(1, Math.floor(input.received_after_hours))
        : undefined;

    // +1 on the high-water mark converts "last processed" to "strictly after",
    // preventing re-processing when Nylas uses inclusive >= comparison. The +1
    // only applies to the absolute timestamp path — the hours-based fallback is
    // already an approximate cutoff, not a precise high-water mark. (fix: issue #44)
    const receivedAfter = receivedAfterTimestamp !== undefined
      ? receivedAfterTimestamp + 1
      : (receivedAfterHours !== undefined
        ? Math.floor((Date.now() - receivedAfterHours * 3_600_000) / 1_000)
        : undefined);

    ctx.log.info(
      { limit, folder, unreadOnly, receivedAfter, source: receivedAfterTimestamp ? 'timestamp' : 'hours' },
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
