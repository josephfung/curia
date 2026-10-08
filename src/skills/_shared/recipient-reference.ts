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
//
// A reference may carry a label hint after `#` (`principal#personal`). The hint
// is part of the string every caller already passes, so the skill, the pre-gate
// check, Gate C and the approval display cannot choose different addresses.

import { cleanedIdentityLabel, visibleIdentityLabel } from '../../agents/principal-contact-block.js';
import type { ContactService } from '../../contacts/contact-service.js';
import type { ChannelIdentity, Contact } from '../../contacts/types.js';
import { findPrincipalChannelRules } from '../../contacts/principal-channel-registry.js';
import { isUuid } from '../../util/uuid.js';
import { isUnresolvedPlaceholder, unresolvedPlaceholderError } from './placeholder-guard.js';

/** The reserved alias for the principal. More aliases may join it later. */
export const PRINCIPAL_RECIPIENT_ALIAS = 'principal';

export type RecipientReference =
  | { kind: 'principal'; label?: string }
  | { kind: 'contact'; contactId: string; label?: string };

/**
 * A hint, a quoted candidate, and a reported identity name stop here. A label
 * copied from contact-lookup is matched in full up to this bound; the principal
 * block shows 40 characters, and that shorter form is also an exact match.
 */
const LABEL_HINT_MAX_CHARS = 200;

/** Tokenising a stored label stops here, so a huge note cannot be expanded. */
const MATCH_LABEL_MAX_CHARS = 2000;

/**
 * Parse a recipient reference, or null when the value is not one (an address,
 * a phone number, a Slack id, free text). Shape only — no lookup.
 *
 * An optional label hint follows a `#`: `principal#personal`, or
 * `<contact-id>#work`. The hint is everything after the first `#`. A blank
 * hint (`principal#`) is the same as no hint. The left side must already be a
 * reference, so `user#tag@example.com` stays an address.
 *
 * The shapes cannot collide with an address on any send channel: an email
 * address has an `@`, E.164 starts with `+`, and a Slack user id has no hyphens.
 * An email local-part may contain `#`, so a hint that itself contains `@` or a
 * run of 7 digits is not a hint — `principal#ops@vendor.example` stays an
 * address. Gate C relies on that to normalize a mixed recipient list by shape.
 */
export function parseRecipientReference(value: string): RecipientReference | null {
  const trimmed = value.trim();
  const hash = trimmed.indexOf('#');
  const refPart = (hash === -1 ? trimmed : trimmed.slice(0, hash)).trim();
  const rawLabel = hash === -1 ? '' : trimmed.slice(hash + 1).trim();
  // A label an agent can see never holds an address or a phone number
  // (cleanedIdentityLabel), so a hint shaped like one is not a hint: the left
  // side was typed into an address. Checked before the length cap, so a long
  // prefix cannot hide the `@`.
  if (rawLabel.includes('@') || /\d{7,}/.test(rawLabel)) return null;
  const labelPart = rawLabel.slice(0, LABEL_HINT_MAX_CHARS);
  const label = labelPart.length > 0 ? labelPart : undefined;

  if (refPart.toLowerCase() === PRINCIPAL_RECIPIENT_ALIAS) {
    return label ? { kind: 'principal', label } : { kind: 'principal' };
  }
  if (isUuid(refPart)) {
    return label ? { kind: 'contact', contactId: refPart, label } : { kind: 'contact', contactId: refPart };
  }
  return null;
}

export type RecipientResolution =
  /**
   * `kind` says how the recipient was named. Callers echo `contactId` back to the
   * model only for `contact`: for the alias it is the principal's contact ID,
   * which spec 09 keeps opt-in.
   */
  | {
      ok: true;
      kind: RecipientReference['kind'];
      contactId: string;
      identifier: string;
      displayName: string;
      /**
       * What to tell the agent about which identity was used: the label it can
       * see, or `primary` / `unlabelled`. Never an address (#2047).
       */
      identityName: string;
      /**
       * The channel-identity row that was selected. An approval stores this with
       * `identityName` and will not send if a later resolve picks a different row
       * or a different name (#2047).
       */
      identityId: string;
    }
  /**
   * `error` is agent-facing and complete. `cause` is set only when the contact
   * lookup itself threw, so the caller can log it; the result still fails closed.
   */
  | { ok: false; error: string; cause?: unknown };

export interface RecipientReferenceFields {
  /** The reference input's name in tool.json (e.g. `to`, `recipient`). */
  field: string;
}

/**
 * A send skill no longer takes a typed address (#2041). The message names the
 * retired field and the reference field the agent should use instead.
 */
export function retiredRawAddressError(rawField: string, referenceField: string): string {
  return (
    `${rawField} is no longer accepted. Record the person with contact-create, then pass their contact ID in ${referenceField}. ` +
    'Nothing was sent.'
  );
}

/**
 * The first retired raw-address field that is present, as an agent-facing error.
 * An empty string is absent. A non-string is present: it is still the retired field.
 */
export function presentRetiredRawField(
  input: Record<string, unknown>,
  fields: ReadonlyArray<readonly [rawField: string, referenceField: string]>,
): string | undefined {
  for (const [rawField, referenceField] of fields) {
    const value = input[rawField];
    const present = typeof value === 'string' ? value.trim().length > 0 : value !== undefined && value !== null;
    if (present) return retiredRawAddressError(rawField, referenceField);
  }
  return undefined;
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

/**
 * What an approval records for one hinted recipient, separate from the skill
 * payload. Replay must resolve the same identity row and the same name.
 * `identityName` is the label, or `primary` / `unlabelled` when the hint fell
 * back to the single unlabelled address.
 */
export interface SendRecipientPin {
  ref: string;
  identityId: string;
  identityName: string;
}

/** Shown when an approved hint no longer names the identity the principal saw. No address. */
export const STALE_SEND_APPROVAL_ERROR =
  'The approved recipient no longer matches the address that was shown. Nothing was sent.';

/** True when a fresh resolve still names every identity the approval recorded. */
export function sendPinsMatch(
  current: readonly SendRecipientPin[],
  approved: readonly SendRecipientPin[],
): boolean {
  if (current.length !== approved.length) return false;
  const byRef = new Map(current.map((pin) => [pin.ref, pin]));
  return approved.every((pin) => {
    const now = byRef.get(pin.ref);
    return now !== undefined
      && now.identityId === pin.identityId
      && now.identityName === pin.identityName;
  });
}

/**
 * Each send skill's recipient input. Code that reads a send skill's input
 * outside the handler (approval display, for one) uses this rather than
 * hard-coding field names. Raw-address siblings were removed (#2041).
 */
export const SEND_SKILL_RECIPIENT_FIELDS: Readonly<Record<string, { channel: string; reference: string }>> = {
  'email-send': { channel: 'email', reference: 'to' },
  'signal-send': { channel: 'signal', reference: 'recipient' },
  'sms-send': { channel: 'sms', reference: 'recipient' },
  'slack-send': { channel: 'slack', reference: 'recipient' },
};

/** Fields that used to take a typed address. A present value is refused, not sent. */
export const RETIRED_SEND_RAW_FIELDS: Readonly<Record<string, ReadonlyArray<readonly [string, string]>>> = {
  'email-send': [['to_address', 'to'], ['cc_addresses', 'cc']],
  'signal-send': [['recipient_number', 'recipient']],
  'sms-send': [['recipient_number', 'recipient']],
  'slack-send': [['recipient_user_id', 'recipient']],
};

/**
 * Stored display names come from inbound mail and are attacker-influenced.
 * Control characters and Unicode line/paragraph separators would open a new
 * line wherever the name lands (a prompt, an approval).
 */
function safeName(name: string): string {
  return name.replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]+/g, ' ').trim().slice(0, 80);
}

/**
 * A resolved recipient for a person to read (an approval): the verified address
 * first, then the contact name in quotes. The name comes from inbound headers, so
 * it is stripped of anything that could pass for an address or reorder the text
 * (angle brackets, `@`, quotes, bidi and zero-width characters). Otherwise a name
 * like `Pat <pat@home.example>` would put a fake address in front of the real one.
 */
export function formatResolvedRecipient(resolution: { identifier: string; displayName: string }): string {
  const raw = safeName(resolution.displayName);
  // A contact the gateway created is named after its address; showing it twice adds nothing.
  if (raw.toLowerCase() === resolution.identifier.toLowerCase()) return resolution.identifier;
  const name = raw.replace(/[<>@"​-‏‪-‮⁦-⁩﻿]/g, '').trim();
  return name ? `${resolution.identifier} (contact "${name}")` : resolution.identifier;
}

/**
 * Identifier shapes each channel's transport can address. A verified identity of
 * another shape (a Signal ACI UUID stored when an inbound message had no number,
 * an Enterprise Grid `W…` Slack id) is skipped, so it cannot shadow a sendable one.
 */
const SENDABLE: Readonly<Record<string, RegExp>> = {
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  signal: /^\+[1-9]\d{6,14}$/,
  sms: /^\+[1-9]\d{6,14}$/,
  slack: /^U[A-Z0-9]+$/,
};

/** The contact's designated primary for the channel, if it has one. */
function primaryFor(contact: Contact, channel: string): string | null {
  if (channel === 'email') return contact.primaryEmail;
  if (channel === 'signal' || channel === 'sms') return contact.primaryPhone;
  return null;
}

function identifiersEqual(channel: string, a: string, b: string): boolean {
  const rules = findPrincipalChannelRules(channel);
  return rules ? rules.identifiersEqual(a, b) : a === b;
}

function isPrimaryIdentity(contact: Contact, channel: string, identity: ChannelIdentity): boolean {
  const primary = primaryFor(contact, channel);
  if (!primary) return false;
  return identifiersEqual(channel, identity.channelIdentifier, primary);
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
  const primary = usable.find((identity) => isPrimaryIdentity(contact, channel, identity));
  return primary ?? usable[0];
}

/** Letter and number runs. `work` is a token of `work email`, not of `homework`. */
function labelTokens(value: string): string[] {
  return value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** The hint the matcher sees: no newlines or control characters, bounded. */
function normalizeHint(raw: string): string {
  return raw
    .replace(/[\r\n\u2028\u2029]/g, '')
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
    .trim()
    .slice(0, LABEL_HINT_MAX_CHARS);
}

function quoteForAgent(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * How to name the chosen identity back to the agent. The cleaned label wins
 * (bounded, so a long note is not cut mid-word at 40 characters); otherwise
 * `primary` when this row is the contact's primary, else `unlabelled`.
 */
function identityNameFor(contact: Contact, channel: string, identity: ChannelIdentity): string {
  const cleaned = cleanedIdentityLabel(identity.label);
  if (cleaned) return cleaned.slice(0, LABEL_HINT_MAX_CHARS);
  return isPrimaryIdentity(contact, channel, identity) ? 'primary' : 'unlabelled';
}

/** The label quoted in an error: the cleaned note, bounded so a retry still matches. */
function quotedLabel(raw: string | null | undefined): string | null {
  const cleaned = cleanedIdentityLabel(raw);
  return cleaned ? cleaned.slice(0, LABEL_HINT_MAX_CHARS) : null;
}

/**
 * A hint matched nothing usable, or matched more than one row. List every
 * candidate by the label the agent can see. Addresses stay out: a model handed
 * one will retype it into the raw field.
 */
function labelConflictError(
  contact: Contact,
  channel: string,
  usable: readonly ChannelIdentity[],
  hint: string,
  isPrincipal: boolean,
): string {
  const candidates = usable
    .map((identity) => {
      const visible = quotedLabel(identity.label);
      const name = visible ? quoteForAgent(visible) : 'unlabelled';
      return isPrimaryIdentity(contact, channel, identity) ? `${name} [primary]` : name;
    })
    .join(', ');
  // The parser already rejected an address-shaped hint, so quoting this one
  // cannot hand the model an address to retype.
  const which = `${quoteForAgent(hint)} does not identify exactly one`;
  const exampleLabel = usable
    .map((identity) => quotedLabel(identity.label))
    .find((label): label is string => label !== null);
  const example = exampleLabel
    ? (isPrincipal ? `${PRINCIPAL_RECIPIENT_ALIAS}#${exampleLabel}` : `${contact.id}#${exampleLabel}`)
    : null;
  const hasPrimary = usable.some((identity) => isPrimaryIdentity(contact, channel, identity));
  const omit = hasPrimary ? 'omit the label to use the primary' : 'omit the label to use the default address';
  const retry = example
    ? `Retry with one of those labels (for example ${example}), or ${omit}.`
    : `Omit the label to use the ${hasPrimary ? 'primary' : 'default address'}.`;
  const who = isPrincipal ? 'The principal' : contactWho(contact);
  return `${who} has verified ${channel} addresses and ${which} of them. Nothing was sent. Candidates: ${candidates}. ${retry}`;
}

/** Display names come from inbound mail and may themselves be an address. */
function contactWho(contact: Contact): string {
  const name = safeName(contact.displayName);
  if (!name || name.includes('@') || /\d{7,}/.test(name)) return `Contact ${contact.id}`;
  return `Contact "${name}" (${contact.id})`;
}

type IdentityPick =
  | { ok: true; identity: ChannelIdentity }
  | { ok: false; error: string };

/**
 * Choose the identity a reference sends to (#2047).
 *
 * No hint: the primary when it is usable, otherwise the oldest.
 * A hint matches case-insensitively against the cleaned label. Exact matches
 * win, on the full cleaned label, on its bounded prefix, or on the
 * 40-character form the principal block shows. If none is exact, a label
 * matches when every token of the hint is a token of the cleaned label
 * (`work` matches `work email`). One match sends to it. Several matches, or
 * a miss while any candidate has a cleaned label, send nothing — an
 * unlabelled address might have been the one meant. Several unlabelled
 * addresses and a hint also send nothing: the hint named an address and
 * there is more than one. A single unlabelled address still uses the default.
 */
function selectIdentity(
  contact: Contact,
  channel: string,
  usable: readonly ChannelIdentity[],
  hint: string | undefined,
  isPrincipal: boolean,
): IdentityPick {
  // Caller has already required at least one usable identity.
  const fallback = pickIdentity(contact, channel, usable) ?? usable[0]!;
  const normalized = hint ? normalizeHint(hint) : '';
  if (!normalized) return { ok: true, identity: fallback };

  const needle = normalized.toLowerCase();
  const rows = usable.map((identity) => {
    const cleaned = cleanedIdentityLabel(identity.label);
    const bounded = cleaned ? cleaned.slice(0, MATCH_LABEL_MAX_CHARS) : null;
    return {
      identity,
      bounded,
      // The 40-character form, so a hint copied from the principal block matches.
      visible: visibleIdentityLabel(identity.label),
    };
  });
  const exact = rows.filter((row) => {
    if (row.bounded === null) return false;
    const quoted = row.bounded.slice(0, LABEL_HINT_MAX_CHARS).toLowerCase();
    return row.bounded.toLowerCase() === needle
      || quoted === needle
      || row.visible?.toLowerCase() === needle;
  });
  const hintTokens = labelTokens(normalized);
  const token = exact.length > 0 || hintTokens.length === 0
    ? []
    : rows.filter((row) => {
        if (row.bounded === null) return false;
        const tokens = new Set(labelTokens(row.bounded));
        return hintTokens.every((part) => tokens.has(part));
      });
  const matches = exact.length > 0 ? exact : token;

  if (matches.length === 1) return { ok: true, identity: matches[0]!.identity };
  // A miss while any candidate is labelled is a conflict, including when some
  // addresses have no label: the unlabelled one might have been the target.
  // Several unlabelled addresses are a conflict too. One unlabelled address
  // still sends: there is nothing else the hint could have meant. An approval
  // pins that row, so a later replay cannot fall through to a different one.
  if (rows.some((row) => row.bounded !== null) || usable.length > 1) {
    return { ok: false, error: labelConflictError(contact, channel, usable, normalized, isPrincipal) };
  }
  return { ok: true, identity: fallback };
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
        `For someone with no contact record, record them with contact-create, then pass that contact ID. Nothing was sent.`,
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

  // Refuse here, not only at the gateway: the gateway checks the To recipient's
  // tier but not each cc, so a blocked contact referenced in cc would be delivered.
  if (found.contact.tier === 'blocked') {
    return {
      ok: false,
      error: isPrincipal
        ? 'The principal contact is marked blocked. Nothing was sent.'
        : `Contact "${safeName(found.contact.displayName)}" (${contactId}) is blocked. Nothing was sent.`,
    };
  }

  const onChannel = found.identities.filter((identity) => identity.channel === channel);
  const sendable = SENDABLE[channel];
  const usable = onChannel
    .filter((identity) => identity.verified && identity.status === 'active')
    .filter((identity) => !sendable || sendable.test(identity.channelIdentifier))
    // Stable sort: rows with the same timestamp keep the backend's order.
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  if (usable.length === 0) {
    // Do not echo an unverified address back: the model would retype it into
    // the raw field, which is the failure this design removes.
    const who = isPrincipal
      ? 'The principal'
      : `Contact "${safeName(found.contact.displayName)}" (${contactId})`;
    const why = onChannel.length > 0 ? ' (the ones on file are unverified, inactive, or not sendable on this channel)' : '';
    const next = isPrincipal
      ? 'Use a channel listed in Principal Contact Details.'
      : 'Reach them on another channel, or ask the principal to verify an address.';
    return {
      ok: false,
      error: `${who} has no verified, active ${channel} address${why}. Nothing was sent. ${next}`,
    };
  }

  const selection = selectIdentity(found.contact, channel, usable, ref.label, isPrincipal);
  if (!selection.ok) return { ok: false, error: selection.error };
  const chosen = selection.identity;

  return {
    ok: true,
    kind: ref.kind,
    contactId: found.contact.id,
    identifier: chosen.channelIdentifier,
    displayName: found.contact.displayName,
    identityName: identityNameFor(found.contact, channel, chosen),
    identityId: chosen.id,
  };
}
