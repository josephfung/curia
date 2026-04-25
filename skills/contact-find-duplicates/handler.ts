// handler.ts — contact-find-duplicates skill
//
// Scans all contacts for probable duplicate pairs using the DedupService
// (wired into ContactService at bootstrap). Returns a ranked list for the
// Coordinator to present to the CEO for review and merge confirmation.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import type { DuplicatePair } from '../../src/contacts/types.js';

const VALID_CONFIDENCES = new Set(['certain', 'probable']);

export class ContactFindDuplicatesHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const { min_confidence } = ctx.input as { min_confidence?: string };

    if (min_confidence !== undefined && !VALID_CONFIDENCES.has(min_confidence)) {
      return {
        success: false,
        error: `Invalid min_confidence: "${min_confidence}". Must be "certain" or "probable".`,
      };
    }

    if (!ctx.contactService) {
      return {
        success: false,
        error: 'contact-find-duplicates: contactService not available — this is a universal service, check ExecutionLayer configuration.',
      };
    }

    ctx.log.info({ minConfidence: min_confidence ?? 'probable' }, 'Scanning for duplicate contacts');

    try {
      const pairs = await ctx.contactService.findDuplicates(
        (min_confidence as 'certain' | 'probable' | undefined) ?? 'probable',
      );

      return {
        success: true,
        data: {
          pairs: pairs.map((p: DuplicatePair) => ({
            contact_a: {
              contact_id: p.contactA.id,
              display_name: p.contactA.displayName,
              role: p.contactA.role,
            },
            contact_b: {
              contact_id: p.contactB.id,
              display_name: p.contactB.displayName,
              role: p.contactB.role,
            },
            score: Math.round(p.score * 100) / 100,
            confidence: p.confidence,
            reason: p.reason,
          })),
          count: pairs.length,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err }, 'contact-find-duplicates failed');
      return { success: false, error: `Failed to scan for duplicates: ${message}` };
    }
  }
}
