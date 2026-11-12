import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import { mailboxFields, namedOrDefaultMailbox, readMailboxInput } from '../../../_shared/principal-mailbox-client.js';
import type { PrincipalMailboxView } from '../../../../src/principal-mailboxes/service.js';
import { classifyEvidence, mailboxEvidence } from '../../../../src/principal-mailboxes/evidence.js';
import { type DraftAttachment } from '../../../_shared/ceo-nylas-client.js';
import { markdownToHtml } from '../../../../src/format/markdown-to-html.js';
import { parseAttachmentInputs } from '../../../_shared/parse-attachments.js';
import { readAttachmentFiles, MAX_ATTACHMENT_BYTES } from '../../../../src/skills/_shared/read-attachments.js';
import { captureDraftSnapshot } from '../../../_shared/voice-learning-capture.js';
import { PRINCIPAL_RECIPIENT_ALIAS, parseRecipientReference } from '../../../../src/skills/_shared/recipient-reference.js';
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

// A draft to the principal alone would sit in their own Drafts, from them to them.
// "Email me that" means mail from Curia's account; on 2026-10-23 it landed here and
// the principal had to send it to themselves (#2262).
const PRINCIPAL_ONLY_ERROR =
  'A draft addressed only to the principal is not saved: it would sit in their own Drafts, from them ' +
  'to them. When the principal asks to be emailed something, that email comes from Curia\'s own ' +
  'account. Reply that nothing was drafted, so the coordinator sends it to the principal with ' +
  `email-send. ${NOT_SAVED}`;

type RecipientLists = Record<'to' | 'cc' | 'to_addresses' | 'cc_addresses', string[]>;

/** True when every recipient is the `principal` alias and no raw address is given. Shape only. */
function isPrincipalAliasOnly(lists: RecipientLists): boolean {
  if (lists.to_addresses.length > 0 || lists.cc_addresses.length > 0) return false;
  const refs = [...lists.to, ...lists.cc];
  return refs.length > 0 && refs.every((entry) => parseRecipientReference(entry)?.kind === 'principal');
}

/**
 * True when every recipient the draft would carry is the principal: a reference to the
 * principal's contact ID, or a raw address that is the principal's (their resolved
 * address, or one linked to their contact). Covers what the alias pre-check cannot — the
 * contact-ID form, and a raw copy of the principal's address beside the alias, which the
 * To/Cc dedup would collapse to one self-addressed recipient. The principal comes from
 * the same resolver the alias goes through. When a lookup fails the draft is not refused:
 * this check redirects a misroute, it is not a security boundary.
 */
async function isPrincipalOnlyDraft(
  ctx: ToolContext,
  contactIds: readonly string[],
  rawAddresses: readonly string[],
): Promise<boolean> {
  if (contactIds.length + rawAddresses.length === 0 || !ctx.resolveRecipientReference) return false;
  const principal = await ctx.resolveRecipientReference('email', PRINCIPAL_RECIPIENT_ALIAS, { field: 'to' });
  if (!principal.ok) {
    ctx.log.warn({ err: principal.cause }, 'ceo-inbox-draft-compose: principal not resolvable — self-addressed check skipped');
    return false;
  }
  if (!contactIds.every((id) => id === principal.contactId)) return false;
  for (const address of rawAddresses) {
    if (address.toLowerCase() === principal.identifier.toLowerCase()) continue;
    try {
      const owner = await ctx.contactService?.resolveByChannelIdentity('email', address);
      if (owner?.contactId !== principal.contactId) return false;
    } catch (err) {
      ctx.log.warn({ err }, 'ceo-inbox-draft-compose: raw recipient lookup failed — self-addressed check skipped');
      return false;
    }
  }
  return true;
}

export class CeoInboxDraftComposeHandler implements ToolHandler {
  /** Which account the draft went in, and how the history with the recipients bears on that choice. */
  private async mailboxResult(
    ctx: ToolContext,
    mailbox: PrincipalMailboxView,
    recipients: string[],
  ): Promise<Record<string, unknown>> {
    // The draft already exists: evidence trouble must not turn that into a failure.
    try {
      const evidence = await mailboxEvidence(ctx.principalMailboxes!, recipients);
      return { ...mailboxFields(mailbox), evidence: classifyEvidence(evidence, mailbox.id) };
    } catch (err) {
      ctx.log.warn({ err }, 'ceo-inbox-draft-compose: mailbox evidence failed after the draft was created');
      return { ...mailboxFields(mailbox), evidence_unavailable: true };
    }
  }

  async execute(ctx: ToolContext): Promise<ToolResult> {
    // With more than one live mailbox a new message must say which account it leaves from:
    // no `mailbox` returns the evidence for the model to choose with (D5), after the
    // recipients are resolved. With one mailbox nothing changes: no evidence, no extra field.
    const named = readMailboxInput(ctx.input);
    if (!named.ok) return { success: false, error: named.error };
    const live = ctx.principalMailboxes ? await ctx.principalMailboxes.list() : [];
    const multi = live.length > 1;
    const needsPick = multi && named.mailbox === undefined;
    const picked = needsPick ? null : await namedOrDefaultMailbox(ctx, ctx.input, 'ceo-inbox-draft-compose');
    if (picked && !picked.ok) return { success: false, error: picked.error };

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
    // The alias form is refused before any lookup; the contact-ID form after resolution below.
    if (isPrincipalAliasOnly(lists)) {
      return { success: false, error: PRINCIPAL_ONLY_ERROR };
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
    // Every accepted recipient, before the To/Cc dedup collapses duplicates of the principal.
    const rawAddresses = [...toRaw.participants, ...ccRaw.participants].map((participant) => participant.email);
    if (await isPrincipalOnlyDraft(ctx, [...toRefs.contactIds, ...ccRefs.contactIds], rawAddresses)) {
      return { success: false, error: PRINCIPAL_ONLY_ERROR };
    }

    const to = uniqueParticipants(toRefs.participants, toRaw.participants);
    // Someone on the To line is not repeated on Cc.
    const toKeys = new Set(to.map(participantKey));
    const cc = uniqueParticipants(ccRefs.participants, ccRaw.participants)
      .filter((participant) => !toKeys.has(participantKey(participant)));

    if (needsPick) {
      const recipients = [...to, ...cc].map((participant) => participant.email);
      try {
        const evidence = await mailboxEvidence(ctx.principalMailboxes!, recipients);
        ctx.log.info({ recipientCount: recipients.length }, 'ceo-inbox-draft-compose: mailbox needed, returning evidence');
        return { success: true, data: { needs_mailbox: true, evidence } };
      } catch (err) {
        ctx.log.warn({ err }, 'ceo-inbox-draft-compose: mailbox evidence failed before any draft');
        return { success: false, error: `Could not check which account fits, so no draft was saved. Pass mailbox to choose one. ${NOT_SAVED}` };
      }
    }
    if (!picked || !picked.ok) return { success: false, error: 'The principal mailbox is unavailable.' };
    const at = picked.at;
    const client = at.client;

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
          ...(multi ? await this.mailboxResult(ctx, at.mailbox, [...to, ...cc].map((p) => p.email)) : {}),
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
