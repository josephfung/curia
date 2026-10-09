import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import { CeoNylasClient, type DraftAttachment } from '../../../_shared/ceo-nylas-client.js';
import { markdownToHtml } from '../../../../src/format/markdown-to-html.js';
import { parseAttachmentInputs } from '../../../_shared/parse-attachments.js';
import { readAttachmentFiles, MAX_ATTACHMENT_BYTES } from '../../../../src/skills/_shared/read-attachments.js';
import { captureDraftSnapshot } from '../../../_shared/voice-learning-capture.js';
import {
  MAX_DRAFT_RECIPIENTS,
  checkRawRecipients,
  parseRecipientList,
  participantKey,
  resolveReferenceRecipients,
  uniqueParticipants,
  type RecipientFieldPair,
} from '../../../_shared/ceo-draft-recipients.js';

const MAX_BODY_LENGTH = 50_000;
const NOT_SAVED = 'No draft was saved.';

// Recipients (#2053, ADR-047): to/cc take contact references, resolved to the contact's
// verified address and saved with their display name. to_addresses/cc_addresses take an
// address for someone who is not a contact, accepted only when it has a source (a mail
// listing or message read in this conversation, or a person's own message). A typo has
// none, so it fails closed. Curia cannot send these drafts: the principal sends them
// from Gmail.

export class CeoInboxDraftComposeHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    let apiKey: string;
    let grantId: string;
    try {
      apiKey = ctx.secret('nylas_api_key');
      grantId = ctx.secret('ceo_nylas_grant_id');
    } catch (err) {
      ctx.log.error({ err }, 'ceo-inbox-draft-compose: required secret not available');
      return { success: false, error: 'principal inbox is not configured (missing credentials)' };
    }

    const client = new CeoNylasClient(apiKey, grantId, ctx.log, ctx);

    const input =
      ctx.input && typeof ctx.input === 'object' ? (ctx.input as Record<string, unknown>) : {};

    // Each input: absent, one string, or an array of strings (#2053). to/cc take contact
    // references; to_addresses/cc_addresses take addresses for people who are not contacts.
    const lists: Record<'to' | 'cc' | 'to_addresses' | 'cc_addresses', string[]> = {
      to: [], cc: [], to_addresses: [], cc_addresses: [],
    };
    for (const field of Object.keys(lists) as Array<keyof typeof lists>) {
      const parsed = parseRecipientList(input[field], field);
      if (!parsed.ok) return { success: false, error: parsed.error };
      lists[field] = parsed.entries;
    }

    const subject = typeof input.subject === 'string' ? input.subject.trim() : '';
    const body = typeof input.body === 'string' ? input.body.trim() : '';

    if (lists.to.length === 0 && lists.to_addresses.length === 0) {
      return {
        success: false,
        error: "A draft needs a To recipient: a contact ID (or \"principal\") in to, or an address copied from the principal's mail in to_addresses.",
      };
    }
    const recipientCount = Object.values(lists).reduce((sum, entries) => sum + entries.length, 0);
    if (recipientCount > MAX_DRAFT_RECIPIENTS) {
      return { success: false, error: `Too many recipients (${recipientCount}); the limit is ${MAX_DRAFT_RECIPIENTS}. No draft was saved.` };
    }
    if (!subject) {
      return { success: false, error: 'subject is required' };
    }
    if (!body) {
      return { success: false, error: 'body is required' };
    }
    if (body.length > MAX_BODY_LENGTH) {
      return { success: false, error: `body must be ${MAX_BODY_LENGTH} characters or fewer` };
    }

    // Recipients before attachments: a refused recipient should not cost a file read.
    // Every failure is closed — nothing is saved.
    const TO: RecipientFieldPair = { reference: 'to', raw: 'to_addresses' };
    const CC: RecipientFieldPair = { reference: 'cc', raw: 'cc_addresses' };
    const toRefs = await resolveReferenceRecipients(ctx, lists.to, TO, NOT_SAVED);
    if (!toRefs.ok) return { success: false, error: toRefs.error };
    const ccRefs = await resolveReferenceRecipients(ctx, lists.cc, CC, NOT_SAVED);
    if (!ccRefs.ok) return { success: false, error: ccRefs.error };
    const toRaw = await checkRawRecipients(ctx, lists.to_addresses, TO, NOT_SAVED);
    if (!toRaw.ok) return { success: false, error: toRaw.error };
    const ccRaw = await checkRawRecipients(ctx, lists.cc_addresses, CC, NOT_SAVED);
    if (!ccRaw.ok) return { success: false, error: ccRaw.error };

    const to = uniqueParticipants(toRefs.participants, toRaw.participants);
    // Someone on the To line is not repeated on Cc.
    const toKeys = new Set(to.map(participantKey));
    const cc = uniqueParticipants(ccRefs.participants, ccRaw.participants)
      .filter((participant) => !toKeys.has(participantKey(participant)));

    const attachmentInputsParsed = parseAttachmentInputs(input.attachments);
    if (typeof attachmentInputsParsed === 'string') {
      return { success: false, error: attachmentInputsParsed };
    }

    let attachments: DraftAttachment[] = [];
    if (attachmentInputsParsed.length > 0) {
      try {
        attachments = await readAttachmentFiles(attachmentInputsParsed, MAX_ATTACHMENT_BYTES);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, error: `Attachment error: ${message}` };
      }
    }

    ctx.log.info(
      { toCount: to.length, ccCount: cc.length, subject, attachmentCount: attachments.length },
      'ceo-inbox-draft-compose: creating compose draft',
    );

    try {
      const htmlBody = markdownToHtml(body, { wrap: true });

      const draft = await client.createDraft({
        subject,
        body: htmlBody,
        to,
        ...(cc.length > 0 ? { cc } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
      });

      ctx.log.info(
        { draftId: draft.id, subject: draft.subject },
        'ceo-inbox-draft-compose: draft created',
      );

      // Best-effort voice-learning snapshot — fire-and-forget so working-document I/O
      // never adds latency to draft creation (#1421). captureDraftSnapshot logs its own
      // failures and never rejects; the .catch guards against an unexpected throw becoming
      // an unhandled rejection.
      void captureDraftSnapshot(ctx, {
        draftId: draft.id,
        threadId: draft.threadId,
        subject: draft.subject,
        to: draft.to,
        cc: draft.cc,
        body,
      }).catch((err) =>
        ctx.log.error({ err }, 'ceo-inbox-draft-compose: voice snapshot capture rejected'),
      );

      return {
        success: true,
        data: {
          draft_id: draft.id,
          subject: draft.subject,
          to: draft.to,
          cc: draft.cc,
        },
      };
    } catch (err) {
      ctx.log.error(
        { err, subject },
        'ceo-inbox-draft-compose: Nylas API call failed',
      );
      return { success: false, error: 'Failed to create draft in principal inbox' };
    }
  }
}
