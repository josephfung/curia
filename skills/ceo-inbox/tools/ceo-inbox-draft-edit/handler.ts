import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import {
  CeoNylasClient,
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
    let apiKey: string;
    let grantId: string;
    try {
      apiKey = ctx.secret('nylas_api_key');
      grantId = ctx.secret('ceo_nylas_grant_id');
    } catch (err) {
      ctx.log.error({ err }, 'ceo-inbox-draft-edit: required secret not available');
      return { success: false, error: 'principal inbox is not configured (missing credentials)' };
    }

    const client = new CeoNylasClient(apiKey, grantId, ctx.log, ctx);

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

    if (!hasRecipients && !hasSubject && !hasBody) {
      return {
        success: false,
        error: 'At least one of add_to, add_cc, add_to_addresses, add_cc_addresses, remove, subject, or body must be provided to update the draft',
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

    if (hasRecipients) {
      // Nylas replaces a recipient list whole, so the edit starts from the draft as stored.
      let current: NylasDraftFull;
      try {
        current = await client.getDraft(draftId);
      } catch (err) {
        ctx.log.error({ err, draftId }, 'ceo-inbox-draft-edit: could not read the draft to change its recipients');
        return { success: false, error: `Failed to read the draft in principal inbox. ${NOT_CHANGED}` };
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
      }).catch((err) =>
        ctx.log.error({ err }, 'ceo-inbox-draft-edit: voice snapshot capture rejected'),
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
      ctx.log.error({ err, draftId }, 'ceo-inbox-draft-edit: Nylas API call failed');
      return { success: false, error: 'Failed to update draft in principal inbox' };
    }
  }
}
