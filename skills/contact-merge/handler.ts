// handler.ts — contact-merge skill
//
// Merges two contacts into one. Use dry_run: true to preview the golden record
// before committing. The Coordinator MUST present the preview to the CEO and
// get confirmation before calling with dry_run: false.
//
// Elevated skill — requires caller context (same pattern as contact-grant-permission).
//
// @TODO (autonomy): When the autonomy engine reaches "supervised" or higher, consider
// lowering the confirmation requirement for `certain`-confidence merges. At "full" autonomy,
// the Coordinator should execute merges from batch scan without CEO interruption. The
// `dry_run` flag is the gate — at higher autonomy levels, `dry_run: false` is sent directly
// for high-confidence pairs. See docs/superpowers/specs/2026-04-03-autonomy-engine-design.md.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ContactMergeHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const { primary_contact_id, secondary_contact_id, dry_run } = ctx.input as {
      primary_contact_id?: string;
      secondary_contact_id?: string;
      dry_run?: boolean;
    };

    if (!primary_contact_id || typeof primary_contact_id !== 'string') {
      return { success: false, error: 'Missing required input: primary_contact_id (string)' };
    }
    if (!secondary_contact_id || typeof secondary_contact_id !== 'string') {
      return { success: false, error: 'Missing required input: secondary_contact_id (string)' };
    }
    if (!UUID_RE.test(primary_contact_id)) {
      return { success: false, error: `primary_contact_id must be a valid UUID. Use contact-lookup to find the real ID.` };
    }
    if (!UUID_RE.test(secondary_contact_id)) {
      return { success: false, error: `secondary_contact_id must be a valid UUID. Use contact-lookup to find the real ID.` };
    }
    if (primary_contact_id === secondary_contact_id) {
      return { success: false, error: 'primary_contact_id and secondary_contact_id must not be the same contact.' };
    }
    if (!ctx.contactService) {
      return { success: false, error: 'contact-merge: contactService not available — this is a universal service, check ExecutionLayer configuration.' };
    }
    // Elevated skill — execution layer guarantees caller is set, but guard explicitly
    // so a broken invariant produces a clear error instead of a cryptic TypeError.
    if (!ctx.caller) {
      return { success: false, error: 'caller context is required for this elevated skill.' };
    }

    // Default dry_run: true — safe default, prevents accidental merges without CEO confirmation
    const dryRun = dry_run !== false;

    ctx.log.info(
      { primaryContactId: primary_contact_id, secondaryContactId: secondary_contact_id, dryRun },
      'Contact merge invoked',
    );

    try {
      const result = await ctx.contactService.mergeContacts(
        primary_contact_id,
        secondary_contact_id,
        dryRun,
      );

      const goldenRecord = result.goldenRecord;

      return {
        success: true,
        data: {
          primary_contact_id: result.primaryContactId,
          secondary_contact_id: result.secondaryContactId,
          golden_record: {
            display_name: goldenRecord.displayName,
            role: goldenRecord.role,
            notes: goldenRecord.notes,
            status: goldenRecord.status,
            identity_count: goldenRecord.identities.length,
            auth_override_count: goldenRecord.authOverrides.length,
          },
          dry_run: result.dryRun,
          ...('mergedAt' in result && result.mergedAt
            ? { merged_at: result.mergedAt.toISOString() }
            : {}),
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('not found')) {
        return {
          success: false,
          error: `Contact not found: ${message}. Use contact-lookup to verify the contact IDs before retrying.`,
        };
      }
      ctx.log.error({ err, primary_contact_id, secondary_contact_id }, 'contact-merge failed');
      return { success: false, error: `Merge failed: ${message}` };
    }
  }
}
