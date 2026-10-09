// ceo-draft-recipients.ts — recipients for drafts in the principal's mailbox (#2053, ADR-047).
//
// ceo-inbox-draft-compose and ceo-inbox-draft-edit address a recipient two ways:
//
// - a contact reference (a contact ID or `principal`, optional `#label`), resolved to the
//   contact's verified address and saved with the contact's display name. The model
//   chooses who and never retypes an address it already has;
// - a raw address, for someone who is not a contact (a sender found in the principal's
//   mail, a mailing list). It is accepted only when it has a source (#2061): it occurs in
//   a message a person sent in this conversation, or in a mail listing, page or document
//   read in it. An edit also accepts an address already on the draft. A typo occurs in
//   none of these, so it fails closed and nothing is saved. A raw entry gets no display
//   name, so it cannot hide behind a familiar one.
//
// Every failure names the input and position, never an address, so the model is not
// handed something to retype.

import type { ToolContext } from '../../src/skills/types.js';
import { parseRecipientReference } from '../../src/skills/_shared/recipient-reference.js';
import { isUnresolvedPlaceholder } from '../../src/skills/_shared/placeholder-guard.js';
import { isAddressLikeName } from '../../src/skills/_shared/address-like-name.js';
import { identifierHasSource, unsourcedIdentifierError } from '../../src/skills/_shared/identifier-source.js';
import { normalizeAgentIdentifier } from '../../src/contacts/agent-identifier.js';
import type { NylasParticipant } from './ceo-nylas-client.js';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Recipients one call may name across all its recipient inputs. Each reference is a contact read. */
export const MAX_DRAFT_RECIPIENTS = 25;

export type RecipientList = { ok: true; entries: string[] } | { ok: false; error: string };
export type ParticipantList = { ok: true; participants: NylasParticipant[] } | { ok: false; error: string };
/** Resolved references: `contactIds[i]` is the contact behind `participants[i]`. */
export type ReferenceList =
  | { ok: true; participants: NylasParticipant[]; contactIds: string[] }
  | { ok: false; error: string };

/** The paired names of one recipient line: the reference input and its raw-address input. */
export interface RecipientFieldPair {
  reference: string;
  raw: string;
}

/**
 * A recipient input: absent, one string, or an array of non-empty strings. Absent,
 * null and a blank string are empty. Anything else malformed is an error rather than
 * an empty list, so bad input never silently drops a recipient.
 */
export function parseRecipientList(raw: unknown, field: string): RecipientList {
  if (raw === undefined || raw === null) return { ok: true, entries: [] };
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    return { ok: true, entries: trimmed ? [trimmed] : [] };
  }
  if (Array.isArray(raw)) {
    const entries: string[] = [];
    for (const entry of raw) {
      if (typeof entry !== 'string' || !entry.trim()) {
        return { ok: false, error: `${field} must be a string or an array of non-empty strings` };
      }
      entries.push(entry.trim());
    }
    return { ok: true, entries };
  }
  return { ok: false, error: `${field} must be a string or an array of non-empty strings` };
}

/**
 * The contact's display name for a draft header, or undefined. Names come from inbound
 * headers: control characters are removed, and a name that looks like an address (a
 * contact the gateway named after its address) is dropped rather than shown.
 */
function headerName(displayName: string): string | undefined {
  const name = displayName.replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]+/g, ' ').trim().slice(0, 80);
  if (!name || isAddressLikeName(name)) return undefined;
  return name;
}

/**
 * Resolve contact references to participants carrying the contact's display name.
 * `consequence` ends each error ("No draft was saved.").
 */
export async function resolveReferenceRecipients(
  ctx: ToolContext,
  entries: readonly string[],
  fields: RecipientFieldPair,
  consequence: string,
): Promise<ReferenceList> {
  const participants: NylasParticipant[] = [];
  const contactIds: string[] = [];
  for (const [index, entry] of entries.entries()) {
    const position = `${fields.reference} entry ${index + 1}`;
    // A template token gets the resolver's own message; an address gets pointed at the raw input.
    if (!isUnresolvedPlaceholder(entry) && parseRecipientReference(entry) === null) {
      return {
        ok: false,
        error:
          `${position} is not a contact reference. ${fields.reference} takes contact IDs, or "principal". ` +
          `An address goes in ${fields.raw}, copied exactly from the principal's mail. ${consequence}`,
      };
    }
    if (!ctx.resolveRecipientReference) {
      ctx.log.error({ field: fields.reference }, 'draft recipients: no reference resolver (contact service not wired)');
      return { ok: false, error: `Contact references cannot be resolved right now. ${consequence}` };
    }
    const resolved = await ctx.resolveRecipientReference('email', entry, { field: fields.reference });
    if (!resolved.ok) {
      if (resolved.cause !== undefined) {
        ctx.log.warn({ err: resolved.cause, field: fields.reference }, 'draft recipients: reference lookup failed — refusing');
      }
      return {
        ok: false,
        error:
          `${position}: ${resolved.error} ${consequence} Someone with no verified email on file can be ` +
          `addressed in ${fields.raw}, with the address copied exactly from the principal's mail.`,
      };
    }
    if (!EMAIL_REGEX.test(resolved.identifier)) {
      // A stored identity Nylas cannot address: a data defect for an operator. The ID is
      // not echoed to the agent (it may be the principal's).
      ctx.log.warn({ contactId: resolved.contactId, field: fields.reference }, 'draft recipients: verified email identity is not a valid address — refusing');
      return {
        ok: false,
        error: `${position}: the contact's verified email identity is not a valid address. It needs correcting in Contacts. ${consequence}`,
      };
    }
    const name = headerName(resolved.displayName);
    participants.push(name ? { name, email: resolved.identifier } : { email: resolved.identifier });
    contactIds.push(resolved.contactId);
  }
  return { ok: true, participants, contactIds };
}

/**
 * Accept raw addresses that have a source (#2061), or that are already on the draft
 * (`onDraft`, keyed by lowercased address). One already on the draft keeps its
 * participant as stored, name included. Anything else fails closed.
 */
export async function checkRawRecipients(
  ctx: ToolContext,
  entries: readonly string[],
  fields: RecipientFieldPair,
  consequence: string,
  onDraft?: ReadonlyMap<string, NylasParticipant>,
): Promise<ParticipantList> {
  const participants: NylasParticipant[] = [];
  for (const [index, entry] of entries.entries()) {
    const position = `${fields.raw} entry ${index + 1}`;
    if (parseRecipientReference(entry) !== null) {
      return {
        ok: false,
        error: `${position} is a contact reference. ${fields.raw} takes email addresses; a contact ID goes in ${fields.reference}. ${consequence}`,
      };
    }
    const normalized = normalizeAgentIdentifier('email', entry);
    if (!normalized.ok) {
      return { ok: false, error: `${position} must be an email address (name@domain). ${consequence}` };
    }
    const address = normalized.identifier;
    const existing = onDraft?.get(address);
    if (existing) {
      participants.push(existing);
      continue;
    }
    if (!(await identifierHasSource(ctx, 'email', address))) {
      ctx.log.info({ field: fields.raw, position: index + 1 }, 'draft recipients: raw address has no source — refusing (#2053)');
      return {
        ok: false,
        error: `${position}: ${unsourcedIdentifierError('email', `${consequence} If they are a contact, pass their contact ID in ${fields.reference}.`)}`,
      };
    }
    // A blocked contact is refused by reference, so its address is refused here too.
    // A lookup that fails refuses as well: the check cannot be skipped by an outage.
    if (ctx.contactService) {
      try {
        const known = await ctx.contactService.resolveByChannelIdentity('email', address);
        if (known?.tier === 'blocked') {
          ctx.log.info({ field: fields.raw, position: index + 1 }, 'draft recipients: raw address belongs to a blocked contact — refusing');
          return { ok: false, error: `${position} belongs to a blocked contact. ${consequence}` };
        }
      } catch (err) {
        ctx.log.warn({ err, field: fields.raw }, 'draft recipients: blocked-contact check failed — refusing (fail-closed)');
        return { ok: false, error: `The contact lookup failed, so ${position} could not be checked. ${consequence} Try again.` };
      }
    }
    participants.push({ email: address });
  }
  return { ok: true, participants };
}

/** Lowercased address, the key recipients are compared by. */
export function participantKey(participant: NylasParticipant): string {
  return participant.email.trim().toLowerCase();
}

/** Participants with duplicates (by address, ignoring case) removed; the first one wins. */
export function uniqueParticipants(...lists: ReadonlyArray<readonly NylasParticipant[]>): NylasParticipant[] {
  const seen = new Set<string>();
  const out: NylasParticipant[] = [];
  for (const list of lists) {
    for (const participant of list) {
      const key = participantKey(participant);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(participant);
    }
  }
  return out;
}
