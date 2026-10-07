// recipient-reference.ts — resolve a send skill's recipient reference to an address (#2033).
//
// The send skills (email-send, signal-send, sms-send, slack-send) take a contact
// reference instead of an address: a contact UUID, or the reserved alias
// `principal`. The address is read from that contact's verified, active identities
// on the channel, so the model chooses who and never re-types an address.
//
// Why: a model that holds the right address in context still types a different
// one, about 1 send in 5 on the coordinator's bullpen path (#727, #1950, #2033).
// A mistyped address fails open: the message goes to whoever owns it. A mistyped
// reference fails closed: no such contact, nothing sent.
//
// The principal's handle is the alias, never the contact ID. Spec 09 keeps
// `${principal_contact_id}` opt-in because it unlocks calendar and attribute
// reads. The alias resolves only to the verified identities every agent already
// sees in `## Principal Contact Details`.
//
// The outbound gateway (for the skill handlers) and Gate C (execution layer) both
// resolve through resolveRecipientReference, so the gate judges the same address
// the skill sends to. See ADR-047.

import type { ContactService } from '../../contacts/contact-service.js';
import type { ChannelIdentity, Contact } from '../../contacts/types.js';
import { findPrincipalChannelRules } from '../../contacts/principal-channel-registry.js';
import { isUuid } from '../../util/uuid.js';
import { isUnresolvedPlaceholder, unresolvedPlaceholderError } from './placeholder-guard.js';

/** The reserved alias for the principal. More aliases may join it later. */
export const PRINCIPAL_RECIPIENT_ALIAS = 'principal';

export type RecipientReference =
  | { kind: 'principal' }
  | { kind: 'contact'; contactId: string };

/**
 * Parse a recipient reference, or null when the value is not one (an address,
 * a phone number, a Slack id, free text). Shape only — no lookup.
 *
 * The shapes cannot collide with an address on any send channel: an email
 * address has an `@`, E.164 starts with `+`, and a Slack user id has no hyphens.
 * Gate C relies on that to normalize a mixed recipient list by shape.
 */
export function parseRecipientReference(value: string): RecipientReference | null {
  const trimmed = value.trim();
  if (trimmed.toLowerCase() === PRINCIPAL_RECIPIENT_ALIAS) return { kind: 'principal' };
  if (isUuid(trimmed)) return { kind: 'contact', contactId: trimmed };
  return null;
}

export type RecipientResolution =
  | { ok: true; contactId: string; identifier: string; displayName: string }
  /**
   * `error` is agent-facing and complete. `cause` is set only when the contact
   * lookup itself threw, so the caller can log it; the result still fails closed.
   */
  | { ok: false; error: string; cause?: unknown };

export interface RecipientReferenceFields {
  /** The reference input's name in tool.json (e.g. `to`, `recipient`). */
  field: string;
  /** The raw-address input's name in tool.json (e.g. `to_address`). */
  rawField: string;
}

export interface RecipientResolverDeps {
  contactService: Pick<ContactService, 'getContactWithIdentities'>;
  /**
   * The principal's contact ID, or undefined when no principal with a verified
   * identity is loaded. Callers derive it from the hot-reloaded principal
   * identity snapshot, which holds verified, active rows only.
   */
  principalContactId: string | undefined;
}

/** Stored display names come from inbound mail and are attacker-influenced. */
function safeName(name: string): string {
  return name.replace(/[\r\n]+/g, ' ').trim().slice(0, 80);
}

/** The contact's designated primary for the channel, if it has one. */
function primaryFor(contact: Contact, channel: string): string | null {
  if (channel === 'email') return contact.primaryEmail;
  if (channel === 'signal' || channel === 'sms') return contact.primaryPhone;
  return null;
}

/**
 * Pick the identity to send to: the contact's primary when it is one of the
 * usable identities, otherwise the oldest usable one. Never fails over to an
 * unverified or inactive row. Sending to another verified address of the right
 * person is a far smaller error than pushing the model back to typing one.
 */
function pickIdentity(
  contact: Contact,
  channel: string,
  usable: readonly ChannelIdentity[],
): ChannelIdentity | undefined {
  const primary = primaryFor(contact, channel);
  if (primary) {
    const rules = findPrincipalChannelRules(channel);
    const equal = (a: string, b: string) => (rules ? rules.identifiersEqual(a, b) : a === b);
    const match = usable.find((identity) => equal(identity.channelIdentifier, primary));
    if (match) return match;
  }
  return usable[0];
}

/**
 * Resolve a recipient reference to the address a send skill should deliver to.
 * Every failure is closed (nothing is sent) and names what is missing.
 */
export async function resolveRecipientReference(
  value: string,
  channel: string,
  fields: RecipientReferenceFields,
  deps: RecipientResolverDeps,
): Promise<RecipientResolution> {
  if (isUnresolvedPlaceholder(value)) {
    return {
      ok: false,
      error: `${unresolvedPlaceholderError(fields.field, value)} To send to the principal, pass ${fields.field}: "${PRINCIPAL_RECIPIENT_ALIAS}".`,
    };
  }

  const ref = parseRecipientReference(value);
  if (ref === null) {
    return {
      ok: false,
      error:
        `${fields.field} takes a contact ID or "${PRINCIPAL_RECIPIENT_ALIAS}", not "${safeName(value)}". ` +
        `Send to a known person by their contact ID; the address is looked up for you. ` +
        `Only for someone with no contact record, put their address in ${fields.rawField}.`,
    };
  }

  const isPrincipal = ref.kind === 'principal';
  const contactId = isPrincipal ? deps.principalContactId : ref.contactId;
  if (!contactId) {
    return {
      ok: false,
      error: `"${PRINCIPAL_RECIPIENT_ALIAS}" cannot be resolved: no principal with a verified address is configured. Nothing was sent.`,
    };
  }

  let found: Awaited<ReturnType<ContactService['getContactWithIdentities']>>;
  try {
    found = await deps.contactService.getContactWithIdentities(contactId);
  } catch (err) {
    return {
      ok: false,
      error: 'The contact lookup failed, so the recipient could not be resolved. Nothing was sent. Try again.',
      cause: err,
    };
  }

  if (!found) {
    return {
      ok: false,
      error: isPrincipal
        ? 'The principal contact could not be found. Nothing was sent.'
        : `No contact has ID ${contactId}. Nothing was sent. Check the contact ID (contact-lookup returns it), or pass "${PRINCIPAL_RECIPIENT_ALIAS}" to reach the principal.`,
    };
  }

  const onChannel = found.identities.filter((identity) => identity.channel === channel);
  const usable = onChannel
    .filter((identity) => identity.verified && identity.status === 'active')
    // Stable sort: rows with the same timestamp keep the backend's order.
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  const chosen = pickIdentity(found.contact, channel, usable);
  if (!chosen) {
    // Do not echo an unverified address back: the model would retype it into
    // the raw field, which is the failure this design removes.
    const who = isPrincipal
      ? 'The principal'
      : `Contact "${safeName(found.contact.displayName)}" (${contactId})`;
    const why = onChannel.length > 0 ? ' (the ones on file are unverified or inactive)' : '';
    const next = isPrincipal
      ? 'Use a channel listed in Principal Contact Details.'
      : 'Reach them on another channel, or ask the principal to verify an address.';
    return {
      ok: false,
      error: `${who} has no verified, active ${channel} address${why}. Nothing was sent. ${next}`,
    };
  }

  return {
    ok: true,
    contactId: found.contact.id,
    identifier: chosen.channelIdentifier,
    displayName: found.contact.displayName,
  };
}
