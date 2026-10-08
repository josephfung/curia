// handler.ts — contact-merge skill
//
// Merges two contacts into one. Use dry_run: true to preview the golden record
// before committing. The Coordinator MUST present the preview to the principal and
// get confirmation before calling with dry_run: false.
//
// SECURITY / AUTONOMY: #1126 reclassified contact-merge from `elevated` to `normal` +
// action_risk:'medium' (autonomy-governed). A live-principal-driven turn (incl. the delegated
// contacts specialist) clears the autonomy gate via the principal-bypass; an autonomous/woken
// task needs score >= 70, else the merge surfaces an ADR-018 approval request — "surface and
// confirm". There is NO handler-level origination re-check; the execution-layer gates are the
// sole enforcement point. The `dry_run` flag remains the in-handler safety default (preview
// before commit); the Coordinator/specialist presents the preview and only commits on
// confirmation. caller may be undefined for delegated specialists.
//
// @TODO (autonomy): the medium (70) threshold lets a sufficiently-trusted autonomous dedup task
// auto-commit a `certain`-confidence merge. If that proves too eager, raise action_risk rather
// than reintroducing a handler gate. See docs/specs/14-autonomy-engine.md.

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import type { Contact } from '../../../../src/contacts/types.js';
import { ContactNotFoundError } from '../../../../src/contacts/types.js';
import { structuralContactRefusal } from '../../../../src/skills/_shared/structural-contact-guard.js';
import { isUuid } from '../../../../src/util/uuid.js';

const NOT_MERGED = 'Nothing was merged.';

export class ContactMergeHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
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
    if (!isUuid(primary_contact_id)) {
      return { success: false, error: `primary_contact_id must be a valid UUID. Use contact-lookup to find the real ID.` };
    }
    if (!isUuid(secondary_contact_id)) {
      return { success: false, error: `secondary_contact_id must be a valid UUID. Use contact-lookup to find the real ID.` };
    }
    if (primary_contact_id === secondary_contact_id) {
      return { success: false, error: 'primary_contact_id and secondary_contact_id must not be the same contact.' };
    }
    if (!ctx.contactService) {
      return { success: false, error: 'contact-merge: contactService not available — this is a universal service, check ExecutionLayer configuration.' };
    }

    // The primary keeps the secondary's identities, so a merge into a structural contact
    // adds addresses to it: onto the principal, verified addresses that Gate C and the
    // "principal" alias trust (#2041). Refused here, on the agent path only (the console
    // merge does not come through this skill). ContactService also refuses a structural
    // secondary, but its error says to make that contact the primary, which this guard
    // refuses too; checking the secondary here gives the agent the one answer. Checked
    // before the log below, which carries both IDs.
    let primary: Contact | undefined;
    let secondary: Contact | undefined;
    try {
      [primary, secondary] = await Promise.all([
        ctx.contactService.getContact(primary_contact_id),
        ctx.contactService.getContact(secondary_contact_id),
      ]);
    } catch (err) {
      ctx.log.error({ err }, 'contact-merge: contact lookup failed');
      return { success: false, error: `The contact lookup failed. ${NOT_MERGED} Try again.` };
    }
    // A missing contact falls through: mergeContacts reports it as not found.
    for (const contact of [primary, secondary]) {
      if (!contact) continue;
      const structural = structuralContactRefusal(contact, NOT_MERGED, ctx.log, 'contact-merge');
      if (structural) return { success: false, error: structural };
    }

    // Default dry_run: true — safe default, prevents accidental merges without principal confirmation
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
            // tier replaced the legacy status field on the golden record in #955.
            tier: goldenRecord.tier,
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
      if (err instanceof ContactNotFoundError) {
        return {
          success: false,
          error: `Contact not found: ${err.message}. Use contact-lookup to verify the contact IDs before retrying.`,
        };
      }
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, primary_contact_id, secondary_contact_id }, 'contact-merge failed');
      return { success: false, error: `Merge failed: ${message}` };
    }
  }
}
