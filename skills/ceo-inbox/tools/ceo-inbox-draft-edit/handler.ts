import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import {
  locateInMailbox,
  mailboxClient,
  mailboxFields,
  type MailboxClient,
} from '../../../_shared/principal-mailbox-client.js';
import { MissingNylasApiKeyError, RemovedMailboxError, UnknownMailboxError } from '../../../../src/principal-mailboxes/types.js';
import { grantSafeErrorFields } from '../../../../src/principal-mailboxes/error-fields.js';
import { nylasStatus } from '../../../../src/channels/email/nylas-message-id.js';
import { budgetExpired, remainingMs } from '../../../../src/util/call-budget.js';
import type { ErrorType } from '../../../../src/errors/types.js';
import {
  htmlToPlainText,
  type NylasDraftFull,
  type NylasParticipant,
  type UpdateDraftOptions,
} from '../../../_shared/ceo-nylas-client.js';
import { markdownToHtml } from '../../../../src/format/markdown-to-html.js';
import { captureDraftSnapshot } from '../../../_shared/voice-learning-capture.js';
import { parseRecipientReference } from '../../../../src/skills/_shared/recipient-reference.js';
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
const NOT_CHANGED = 'The draft was not changed.';

/**
 * The least time a move needs left before it creates the new draft (SF11, S3): a create and a
 * delete, each one request. With less, the move is refused before anything is written.
 */
const MOVE_MIN_REMAINING_MS = 5_000;

/**
 * A failed Nylas call on the draft itself (read or update), classified by HTTP status (#2593).
 *
 * Without an errorType the agent can't tell "this draft no longer exists" from a blip, and it
 * retries the same dead ID. A 404 gets the same "do not retry with this ID" wording the other
 * ceo-inbox tools use for a missing message. Status 0 is CeoNylasClient's "no HTTP answer":
 * a timed-out call (the budget expired) or a failed fetch.
 */
function draftCallFailure(
  ctx: ToolContext,
  err: unknown,
  draftId: string,
  summary: string,
): { success: false; error: string; errorType: ErrorType } {
  const status = nylasStatus(err);
  // Class and HTTP status only: a Nylas error can carry the grant id (#2475, R20).
  ctx.log.error({ ...grantSafeErrorFields(err), draftId }, `ceo-inbox-draft-edit: ${summary}`);
  if (status === 404) {
    return {
      success: false,
      error:
        `Draft not found: the mailbox has no draft with ID "${draftId}". ${NOT_CHANGED} ` +
        'Do not retry with this ID. List the Drafts folder or search the mailbox to get the current one.',
      errorType: 'NOT_FOUND',
    };
  }
  const errorType: ErrorType =
    status === 429 ? 'RATE_LIMIT'
    : status === 401 || status === 403 ? 'AUTH_FAILURE'
    : status !== undefined && status >= 500 ? 'PROVIDER_ERROR'
    : status !== undefined && status >= 400 ? 'VALIDATION_ERROR'
    : budgetExpired(ctx) ? 'TIMEOUT'
    // No status at all (a network failure, or a non-HTTP error): treat as a transient provider fault.
    : 'PROVIDER_ERROR';
  return { success: false, error: `${summary}. ${NOT_CHANGED}`, errorType };
}

const TO: RecipientFieldPair = { reference: 'add_to', raw: 'add_to_addresses' };
const CC: RecipientFieldPair = { reference: 'add_cc', raw: 'add_cc_addresses' };
const RECIPIENT_FIELDS = ['add_to', 'add_cc', 'add_to_addresses', 'add_cc_addresses', 'remove'] as const;
type RecipientField = typeof RECIPIENT_FIELDS[number];

/**
 * The lowercased addresses of `contactId` that are on this draft: every email identity
 * of the contact, plus `resolvedAddress`, so a recipient added with another of their
 * addresses (by the principal in Gmail, or with a #label hint) is matched too. A failed
 * identity lookup matches the resolved address only.
 */
async function contactKeysOnDraft(
  ctx: ToolContext,
  contactId: string,
  resolvedAddress: string,
  onDraft: ReadonlyMap<string, NylasParticipant>,
): Promise<string[]> {
  const addresses = new Set([resolvedAddress.trim().toLowerCase()]);
  if (ctx.contactService) {
    try {
      const found = await ctx.contactService.getContactWithIdentities(contactId);
      for (const identity of found?.identities ?? []) {
        if (identity.channel === 'email') addresses.add(identity.channelIdentifier.trim().toLowerCase());
      }
    } catch (err) {
      ctx.log.warn({ err }, 'ceo-inbox-draft-edit: identity lookup failed — matching the resolved address only');
    }
  }
  return [...addresses].filter((key) => onDraft.has(key));
}

/**
 * The lowercased addresses a `remove` entry names on this draft, or an error. An
 * address must be on the draft as written (ignoring case), so a mistyped one matches
 * nothing and fails closed. A contact reference matches every recipient whose address
 * is one of that contact's email identities.
 */
async function removalTargets(
  ctx: ToolContext,
  entry: string,
  position: string,
  onDraft: ReadonlyMap<string, NylasParticipant>,
): Promise<{ ok: true; keys: string[] } | { ok: false; error: string }> {
  if (parseRecipientReference(entry) === null) {
    const key = entry.trim().toLowerCase();
    if (!onDraft.has(key)) {
      return {
        ok: false,
        error: `${position} is not on this draft. ${NOT_CHANGED} ceo-inbox-read with the draft_id lists its recipients; remove takes one of those addresses as shown, or a contact ID.`,
      };
    }
    return { ok: true, keys: [key] };
  }

  if (!ctx.resolveRecipientReference) {
    ctx.log.error({}, 'ceo-inbox-draft-edit: no reference resolver (contact service not wired)');
    return { ok: false, error: `Contact references cannot be resolved right now. ${NOT_CHANGED}` };
  }
  const resolved = await ctx.resolveRecipientReference('email', entry, { field: 'remove' });
  if (!resolved.ok) {
    if (resolved.cause !== undefined) {
      ctx.log.warn({ err: resolved.cause }, 'ceo-inbox-draft-edit: reference lookup for remove failed — refusing');
    }
    return {
      ok: false,
      error: `${position}: ${resolved.error} ${NOT_CHANGED} To remove them anyway, pass the address as it appears on the draft.`,
    };
  }
  const keys = await contactKeysOnDraft(ctx, resolved.contactId, resolved.identifier, onDraft);
  if (keys.length === 0) {
    return { ok: false, error: `${position}: that contact is not on this draft. ${NOT_CHANGED}` };
  }
  return { ok: true, keys };
}

/** One person going onto a line: the entry to add, and the addresses on the draft that are them. */
interface Addition {
  participant: NylasParticipant;
  /** Lowercased addresses already on the draft that belong to this person. */
  onDraftKeys: string[];
}

/**
 * Additions for one line. A contact already on the draft, under any of their addresses,
 * keeps the entry stored there (the address the principal or an earlier edit chose);
 * otherwise the resolved address goes on, with the contact's name.
 */
async function additions(
  ctx: ToolContext,
  refs: { participants: NylasParticipant[]; contactIds: string[] },
  raw: NylasParticipant[],
  onDraft: ReadonlyMap<string, NylasParticipant>,
): Promise<Addition[]> {
  const out: Addition[] = [];
  for (const [index, participant] of refs.participants.entries()) {
    const keys = await contactKeysOnDraft(ctx, refs.contactIds[index]!, participant.email, onDraft);
    const stored = keys.length > 0 ? onDraft.get(keys[0]!) : undefined;
    out.push({ participant: stored ?? participant, onDraftKeys: keys });
  }
  for (const participant of raw) {
    const key = participantKey(participant);
    out.push({ participant, onDraftKeys: onDraft.has(key) ? [key] : [] });
  }
  return out;
}

/**
 * The draft's new To and Cc after `remove`, then the additions. Recipients not named
 * keep their entry as stored, display name included. Adding someone who is on the other
 * line, under any of their addresses, moves them; adding someone already on the line is
 * a no-op.
 */
async function editRecipients(
  ctx: ToolContext,
  draft: NylasDraftFull,
  lists: Record<RecipientField, string[]>,
): Promise<{ ok: true; to: NylasParticipant[]; cc: NylasParticipant[] } | { ok: false; error: string }> {
  const onDraft = new Map<string, NylasParticipant>();
  for (const participant of [...draft.to, ...draft.cc]) {
    if (!onDraft.has(participantKey(participant))) onDraft.set(participantKey(participant), participant);
  }

  const removed = new Set<string>();
  for (const [index, entry] of lists.remove.entries()) {
    const targets = await removalTargets(ctx, entry, `remove entry ${index + 1}`, onDraft);
    if (!targets.ok) return targets;
    for (const key of targets.keys) removed.add(key);
  }

  const toRefs = await resolveReferenceRecipients(ctx, lists.add_to, TO, NOT_CHANGED);
  if (!toRefs.ok) return toRefs;
  const ccRefs = await resolveReferenceRecipients(ctx, lists.add_cc, CC, NOT_CHANGED);
  if (!ccRefs.ok) return ccRefs;
  // An address already on the draft needs no source: it is there already.
  const toRaw = await checkRawRecipients(ctx, lists.add_to_addresses, TO, NOT_CHANGED, onDraft);
  if (!toRaw.ok) return toRaw;
  const ccRaw = await checkRawRecipients(ctx, lists.add_cc_addresses, CC, NOT_CHANGED, onDraft);
  if (!ccRaw.ok) return ccRaw;

  const addTo = await additions(ctx, toRefs, toRaw.participants, onDraft);
  const addCc = await additions(ctx, ccRefs, ccRaw.participants, onDraft);
  const keysOf = (adds: Addition[]): Set<string> =>
    new Set(adds.flatMap((add) => [participantKey(add.participant), ...add.onDraftKeys]));
  const addToKeys = keysOf(addTo);
  const addCcKeys = keysOf(addCc);

  // A recipient both removed and added is a contradiction, not an edit.
  for (const key of [...addToKeys, ...addCcKeys]) {
    if (removed.has(key)) {
      return { ok: false, error: `The same recipient is both removed and added. ${NOT_CHANGED}` };
    }
  }

  const keptTo = draft.to.filter((p) => !removed.has(participantKey(p)) && !addCcKeys.has(participantKey(p)));
  const keptCc = draft.cc.filter((p) => !removed.has(participantKey(p)) && !addToKeys.has(participantKey(p)));
  // Someone already on the line they are added to keeps their stored entry and is not added again.
  const onLine = (kept: NylasParticipant[], adds: Addition[]): NylasParticipant[] => {
    const keptKeys = new Set(kept.map(participantKey));
    return adds
      .filter((add) => ![participantKey(add.participant), ...add.onDraftKeys].some((key) => keptKeys.has(key)))
      .map((add) => add.participant);
  };
  const to = uniqueParticipants(keptTo, onLine(keptTo, addTo));
  const toKeys = new Set(to.map(participantKey));
  const cc = uniqueParticipants(keptCc, onLine(keptCc, addCc)).filter((p) => !toKeys.has(participantKey(p)));

  // Refuse only an edit that empties the To line. A draft the principal started with no
  // To (Cc only) may still have its Cc changed.
  if (draft.to.length > 0 && to.length === 0) {
    return { ok: false, error: `That would leave the draft with no To recipient. ${NOT_CHANGED}` };
  }
  return { ok: true, to, cc };
}

/**
 * Update an existing draft in the principal's mailbox (issue #1000). Lets the agent
 * fix a wrong recipient, subject, or body on a draft that was already created —
 * the capability that was missing, which left bad drafts uneditable.
 *
 * Recipients change one at a time (#2053, ADR-047): `remove` takes entries off, and
 * `add_to`/`add_cc` (contact references) or `add_to_addresses`/`add_cc_addresses`
 * (addresses with a source, or already on the draft) put them on. Everyone else stays
 * as stored, so a one-recipient change never retypes the rest.
 */
export class CeoInboxDraftEditHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const input =
      ctx.input && typeof ctx.input === 'object' ? (ctx.input as Record<string, unknown>) : {};

    const draftId = typeof input.draft_id === 'string' ? input.draft_id.trim() : '';
    if (!draftId) {
      return { success: false, error: 'draft_id is required' };
    }

    // The whole-list `to`/`cc` inputs are retired (#2053): replacing a list meant
    // retyping every recipient to change one. Refused rather than ignored, so a
    // requested change is never silently dropped. A blank value is refused too: `cc: []`
    // used to mean "clear the CC line", and the inputs are no longer in the schema.
    for (const retired of ['to', 'cc'] as const) {
      if (input[retired] !== undefined && input[retired] !== null) {
        return {
          success: false,
          error:
            `${retired} is no longer accepted: recipients change one at a time. Use remove for anyone coming off, ` +
            `and add_to / add_cc (contact IDs) or add_to_addresses / add_cc_addresses (addresses from the principal's mail) ` +
            `for anyone going on. Everyone else stays as they are. ${NOT_CHANGED}`,
        };
      }
    }

    const lists = {} as Record<RecipientField, string[]>;
    for (const field of RECIPIENT_FIELDS) {
      const parsed = parseRecipientList(input[field], field);
      if (!parsed.ok) return { success: false, error: parsed.error };
      lists[field] = parsed.entries;
    }
    const recipientCount = RECIPIENT_FIELDS.reduce((sum, field) => sum + lists[field].length, 0);
    if (recipientCount > MAX_DRAFT_RECIPIENTS) {
      return { success: false, error: `Too many recipient changes (${recipientCount}); the limit is ${MAX_DRAFT_RECIPIENTS}. ${NOT_CHANGED}` };
    }

    // Detect which fields the caller wants to change by KEY PRESENCE, not by type.
    // Only `subject`/`body` keys that are actually present become part of the update —
    // we never send an omitted field, so a partial edit can't blank out the rest of the
    // draft. Presence (not `typeof === 'string'`) is deliberate: a malformed value like
    // `subject: 123` must be rejected, not silently skipped, or the caller gets a success
    // response that misrepresents what was applied.
    const hasRecipients = recipientCount > 0;
    const hasSubject = input.subject !== undefined;
    const hasBody = input.body !== undefined;

    // `move_to_mailbox` is checked here, before any call, so a malformed value changes nothing.
    const moveTo = input.move_to_mailbox;
    if (moveTo !== undefined && moveTo !== null && (typeof moveTo !== 'string' || !moveTo.trim())) {
      return { success: false, error: `move_to_mailbox must be a mailbox id. ${NOT_CHANGED}` };
    }
    const moveTarget = typeof moveTo === 'string' ? moveTo.trim() : undefined;

    if (!hasRecipients && !hasSubject && !hasBody && moveTarget === undefined) {
      return {
        success: false,
        error: 'At least one of add_to, add_cc, add_to_addresses, add_cc_addresses, remove, subject, body, or move_to_mailbox must be provided to update the draft',
      };
    }

    const updates: UpdateDraftOptions = {};

    if (hasSubject) {
      // Reject non-string or whitespace-only subjects. A blank subject would
      // silently clear the draft's existing subject line on an accidental input.
      if (typeof input.subject !== 'string' || !input.subject.trim()) {
        return { success: false, error: 'subject must be a non-empty string' };
      }
      updates.subject = input.subject.trim();
    }

    if (hasBody) {
      if (typeof input.body !== 'string' || !input.body.trim()) {
        return { success: false, error: 'body must be a non-empty string' };
      }
      const body = input.body.trim();
      if (body.length > MAX_BODY_LENGTH) {
        return { success: false, error: `body must be ${MAX_BODY_LENGTH} characters or fewer` };
      }
      try {
        updates.body = markdownToHtml(body, { wrap: true });
      } catch (err) {
        ctx.log.error({ err, draftId }, 'ceo-inbox-draft-edit: failed to convert body to HTML');
        return { success: false, error: 'Failed to convert email body to HTML' };
      }
    }

    // The draft is wherever it is: an explicit `mailbox`, else the one that holds it (#2475).
    const picked = await locateInMailbox(ctx, input, 'ceo-inbox-draft-edit', 'draft', draftId);
    if (!picked.ok) return { success: false, error: picked.error, ...(picked.errorType ? { errorType: picked.errorType } : {}) };
    const client = picked.at.client;

    if (moveTarget !== undefined) {
      return this.moveDraft(ctx, { source: picked.at, targetId: moveTarget, draftId, updates, lists, hasRecipients, markdownBody: hasBody ? String(input.body).trim() : undefined });
    }

    if (hasRecipients) {
      // Nylas replaces a recipient list whole, so the edit starts from the draft as stored.
      let current: NylasDraftFull;
      try {
        current = await client.getDraft(draftId);
      } catch (err) {
        return draftCallFailure(ctx, err, draftId, 'Failed to read the draft in principal inbox');
      }
      const edited = await editRecipients(ctx, current, lists);
      if (!edited.ok) return { success: false, error: edited.error };
      updates.to = edited.to;
      updates.cc = edited.cc;
    }

    ctx.log.info(
      {
        draftId,
        updatedFields: Object.keys(updates),
      },
      'ceo-inbox-draft-edit: updating draft',
    );

    try {
      const draft = await client.updateDraft(draftId, updates);

      // Snapshot the post-edit draft for voice learning. Prefer the markdown body
      // the caller just supplied; fall back to plain text from the stored HTML.
      const snapshotBody =
        hasBody && typeof input.body === 'string' && input.body.trim()
          ? input.body.trim()
          : htmlToPlainText(draft.body);

      // Best-effort voice-learning snapshot — fire-and-forget so it never adds latency to
      // the edit (#1421). captureDraftSnapshot logs its own failures and never rejects;
      // the .catch guards against an unexpected throw becoming an unhandled rejection.
      void captureDraftSnapshot(ctx, {
        draftId: draft.id,
        threadId: draft.threadId,
        subject: draft.subject,
        to: draft.to,
        cc: draft.cc,
        body: snapshotBody,
        mailbox: picked.at.mailbox.id,
      }).catch((err) =>
        ctx.log.error({ err }, 'ceo-inbox-draft-edit: voice snapshot capture rejected'),
      );

      return {
        success: true,
        data: {
          draft_id: draft.id,
          // Provenance reads this audit row: the mailbox keys the draft it names (#2475).
          ...mailboxFields(picked.at.mailbox),
          subject: draft.subject,
          to: draft.to,
          cc: draft.cc,
        },
      };
    } catch (err) {
      // The locating GET can still return a draft Nylas no longer lets us write (#2593: a stale
      // read answered 200 and the PUT failed), so a 404 here is a real "gone", not a lookup slip.
      return draftCallFailure(ctx, err, draftId, 'Failed to update draft in principal inbox');
    }
  }

  /**
   * Move a draft to another mailbox (#2475, design D5 "Correction"): create it there, and only
   * after that succeeds delete the original, so the principal is never left without a draft.
   * Any other edits in the call apply to the new draft. The result carries `moved_from`, which
   * draft provenance reads: the new draft keeps the original's authorship class for send review.
   */
  private async moveDraft(
    ctx: ToolContext,
    args: {
      source: MailboxClient;
      targetId: string;
      draftId: string;
      updates: UpdateDraftOptions;
      lists: Record<RecipientField, string[]>;
      hasRecipients: boolean;
      markdownBody: string | undefined;
    },
  ): Promise<ToolResult> {
    const { source, draftId, updates, lists } = args;
    const log = ctx.log;

    if (args.targetId === source.mailbox.id) {
      return { success: false, error: `That draft is already in the ${source.mailbox.label} mailbox (${source.mailbox.id}). ${NOT_CHANGED}` };
    }
    let target: MailboxClient;
    try {
      target = await mailboxClient(ctx, args.targetId);
    } catch (err) {
      log.error({ ...grantSafeErrorFields(err), draftId }, 'ceo-inbox-draft-edit: move target mailbox unavailable');
      const known = err instanceof UnknownMailboxError || err instanceof RemovedMailboxError || err instanceof MissingNylasApiKeyError;
      return { success: false, error: `${known ? err.message : 'The target mailbox is unavailable.'} ${NOT_CHANGED}` };
    }

    let current: NylasDraftFull;
    try {
      current = await source.client.getDraft(draftId);
    } catch (err) {
      log.error({ ...grantSafeErrorFields(err), draftId }, 'ceo-inbox-draft-edit: could not read the draft to move it');
      return { success: false, error: `Failed to read the draft in the ${source.mailbox.label} mailbox. ${NOT_CHANGED}` };
    }
    // The Nylas client reads a draft's attachments as a count only and cannot copy their bytes to
    // another account, so a draft with any is not moved: dropping them silently would send an
    // email missing its attachments.
    if ((current.attachmentCount ?? 0) > 0) {
      return {
        success: false,
        error: `This draft has ${current.attachmentCount} attachment(s), which cannot be carried to another mailbox. ${NOT_CHANGED} Ask the principal to move it in Gmail, or recreate it in ${target.mailbox.label} without them.`,
      };
    }

    let to = current.to;
    let cc = current.cc;
    if (args.hasRecipients) {
      const edited = await editRecipients(ctx, current, lists);
      if (!edited.ok) return { success: false, error: edited.error };
      to = edited.to;
      cc = edited.cc;
    }
    const subject = updates.subject ?? current.subject;
    const body = updates.body ?? current.body;

    // A reply's thread lives in the source account, so the moved draft starts a new thread there.
    // LIVE-CHECK (#2475): the client's createDraft sends no In-Reply-To / References (only
    // createDraftReply's reply_to_message_id, which names a message in the source account and
    // cannot be used here); new_thread is true only for a draft with reply_to_message_id. Verify once on a live grant whether the recipient's client still
    // threads a moved reply, and whether Nylas accepts those headers on a draft, before relying on it.
    // Gmail gives every draft a thread id, so reply-ness comes from reply_to_message_id.
    const newThread = (current.replyToMessageId ?? '') !== '';

    // Refuse before writing anything when the call is cancelled or nearly out of time (SF11, S3).
    // Residual (same class as the compose and reply timeouts, #2474; see R39/R40): a create that
    // starts with enough time can still finish after the deadline, leaving the new draft beside
    // the original. The agent then sees a timeout, and ceo-inbox-list shows both drafts.
    if (budgetExpired(ctx) || remainingMs(ctx) < MOVE_MIN_REMAINING_MS) {
      log.warn({ draftId, remainingMs: remainingMs(ctx) }, 'ceo-inbox-draft-edit: too little time left to move the draft — refused before creating it');
      return { success: false, error: `There isn't enough time left in this call to move the draft safely. ${NOT_CHANGED} Try the move again.` };
    }

    let created: Awaited<ReturnType<MailboxClient['client']['createDraft']>>;
    try {
      created = await target.client.createDraft({
        subject,
        body,
        to,
        ...(cc.length > 0 ? { cc } : {}),
        ...(current.bcc.length > 0 ? { bcc: current.bcc } : {}),
      });
    } catch (err) {
      // Nothing was created, and the original is untouched.
      log.error({ ...grantSafeErrorFields(err), draftId, targetMailbox: target.mailbox.id }, 'ceo-inbox-draft-edit: creating the draft in the target mailbox failed');
      return { success: false, error: `Failed to create the draft in the ${target.mailbox.label} mailbox. The original draft is unchanged in ${source.mailbox.label}.` };
    }

    // Best-effort voice-learning snapshot of the new draft, as for any edit.
    void captureDraftSnapshot(ctx, {
      draftId: created.id,
      threadId: created.threadId,
      subject: created.subject,
      to: created.to,
      cc: created.cc,
      body: args.markdownBody ?? htmlToPlainText(body),
      mailbox: target.mailbox.id,
    }).catch((err) => log.error({ ...grantSafeErrorFields(err) }, 'ceo-inbox-draft-edit: voice snapshot capture rejected'));

    let warning: string | undefined;
    try {
      await source.client.deleteDraft(draftId);
    } catch (err) {
      if (nylasStatus(err) === 404) {
        // Already gone (the principal deleted or sent it meanwhile): the move's goal holds (SF11).
        log.info({ draftId, newDraftId: created.id }, 'ceo-inbox-draft-edit: the original was already gone when the move deleted it');
      } else {
        // The new draft exists: this is a success, never a failure, or the agent would retry the move.
        log.error({ ...grantSafeErrorFields(err), draftId, newDraftId: created.id }, 'ceo-inbox-draft-edit: deleting the original after the move failed');
        warning = `The draft was created in ${target.mailbox.label}, but the original could not be deleted and still exists in ${source.mailbox.label} (draft ${draftId}).`;
      }
    }

    log.info(
      { draftId, newDraftId: created.id, from: source.mailbox.id, to: target.mailbox.id, deleted: warning === undefined },
      'ceo-inbox-draft-edit: moved draft between mailboxes',
    );
    return {
      success: true,
      data: {
        draft_id: created.id,
        ...mailboxFields(target.mailbox),
        // Provenance reads this: the new draft keeps the original's authorship class.
        moved_from: { mailbox: source.mailbox.id, draft_id: draftId },
        new_thread: newThread,
        subject: created.subject,
        to: created.to,
        cc: created.cc,
        note: `The draft now lives in the ${target.mailbox.label} mailbox; store the principal's account preference for this contact and topic with memory-store so the next draft goes to the right account.`,
        ...(warning ? { warning } : {}),
      },
    };
  }
}
