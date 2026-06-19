import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { isPrincipalOriginated } from '../../src/contacts/principal.js';
import type { TaskOriginator } from '../../src/contacts/types.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class DeclineGrantRecommendationHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    if (!isPrincipalOriginated(ctx.taskMetadata)) {
      ctx.log.warn('decline-grant-recommendation: rejected — task not originated by principal');
      return { success: false, error: 'This skill requires principal authorization.' };
    }

    const { recommendation_id } = ctx.input as { recommendation_id?: string };
    if (!recommendation_id || !UUID_RE.test(recommendation_id)) {
      return { success: false, error: 'Missing or invalid required input: recommendation_id (UUID)' };
    }
    if (!ctx.contactService) {
      return { success: false, error: 'decline-grant-recommendation: contactService not available' };
    }

    const originator = ctx.taskMetadata?.originator as TaskOriginator | undefined;
    const actorId = ctx.caller?.contactId ?? originator?.contactId;
    if (!actorId || !UUID_RE.test(actorId)) {
      return { success: false, error: 'Cannot determine valid actor identity for audit trail' };
    }

    try {
      const rec = await ctx.contactService.getGrantRecommendation(recommendation_id);
      if (!rec) {
        return { success: false, error: `Grant recommendation '${recommendation_id}' not found.` };
      }
      if (rec.status !== 'pending') {
        return { success: false, error: `Recommendation is already ${rec.status} — cannot decline.` };
      }

      const declined = await ctx.contactService.declineGrantRecommendation(recommendation_id, actorId);
      if (!declined) {
        return { success: false, error: 'Decline failed — recommendation may have been concurrently resolved.' };
      }
      ctx.log.info({ recommendationId: recommendation_id, contactId: rec.contactId, permission: rec.permission, actorId }, 'decline-grant-recommendation: declined (anti-nag recorded)');
      return {
        success: true,
        data: {
          recommendation_id,
          contact_id: rec.contactId,
          permission: rec.permission,
          status: 'declined',
        },
      };
    } catch (err) {
      ctx.log.error({ err, recommendationId: recommendation_id, actorId }, 'decline-grant-recommendation: failed');
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Failed to decline recommendation: ${message}` };
    }
  }
}
