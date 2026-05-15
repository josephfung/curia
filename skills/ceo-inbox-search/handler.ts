import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { CeoNylasClient } from '../_shared/ceo-nylas-client.js';

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 10;

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
