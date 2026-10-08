// duplicate-refusal.ts — what contact-create and contact-link-identity tell the agent
// when the duplicate check (ContactService.findLikelyDuplicates) stops a write (#2041).
//
// Messages name contacts and reasons, never an address or number: a model handed
// one will retype it. The principal is named by the alias; their contact ID stays
// out of the model's context (spec 09).

import type { Contact, DuplicateCandidate, DuplicateReason } from '../../contacts/types.js';
import { PRINCIPAL_RECIPIENT_ALIAS } from './recipient-reference.js';

export function isPrincipalContact(contact: Contact): boolean {
  return contact.systemRole === 'principal';
}

/** What distinct_from takes for a candidate: its contact ID, or "principal". */
export function distinctFromToken(contact: Contact): string {
  return isPrincipalContact(contact) ? PRINCIPAL_RECIPIENT_ALIAS : contact.id;
}

/**
 * distinct_from as the agent passed it: a list of strings, or one comma-separated
 * string. Tokens are trimmed and lowercased (contact IDs compare case-insensitively).
 */
export function parseDistinctFrom(
  value: unknown,
): { ok: true; tokens: Set<string> } | { ok: false; error: string } {
  if (value === undefined || value === null || value === '') return { ok: true, tokens: new Set() };
  const entries: unknown[] | null = typeof value === 'string' ? value.split(',') : Array.isArray(value) ? value : null;
  if (entries === null || entries.some((entry) => typeof entry !== 'string')) {
    return { ok: false, error: `distinct_from must be a list of contact IDs (or "${PRINCIPAL_RECIPIENT_ALIAS}").` };
  }
  const tokens = (entries as string[]).map((entry) => entry.trim().toLowerCase()).filter((entry) => entry.length > 0);
  return { ok: true, tokens: new Set(tokens) };
}

/** Candidates the agent has not named in distinct_from. */
export function uncoveredCandidates(
  candidates: readonly DuplicateCandidate[],
  tokens: ReadonlySet<string>,
): DuplicateCandidate[] {
  return candidates.filter((candidate) => !tokens.has(distinctFromToken(candidate.contact).toLowerCase()));
}

/**
 * How to name a contact to the agent. Display names come from inbound headers, and a
 * contact the gateway created is named after its address, so a name that looks like
 * an address or a number is left out.
 *
 * Stored display names have been through sanitizeDisplayName, which strips the "@", so
 * `sam@vendor.example` is stored as `samvendor.example`. A single token with a dot inside
 * is therefore treated as an address too. Over-matching only costs the name: the contact
 * is listed by ID, which is the safe form.
 */
function who(contact: Contact): string {
  const name = contact.displayName
    .replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029"]+/g, ' ')
    .trim()
    .slice(0, 80);
  const looksLikeAddress = name.includes('@') || (!/\s/.test(name) && /\S\.\S/.test(name));
  if (!name || looksLikeAddress || /\d{7,}/.test(name)) return `contact ${contact.id}`;
  return `"${name}" (${contact.id})`;
}

function describeReason(reason: DuplicateReason): string {
  switch (reason.kind) {
    case 'same_name':
      return 'same name';
    case 'similar_address':
      return reason.channel === 'email' ? 'similar email address' : `similar ${reason.channel} number`;
    case 'same_number':
      return `same number on ${reason.channel}`;
  }
}

/**
 * Another contact already holds this identifier on this channel. Not overridable:
 * the store cannot hold it twice. `action` says what did not happen.
 */
export function takenError(taken: { contact: Contact; channel: string }, action: string): string {
  if (isPrincipalContact(taken.contact)) {
    return `That ${taken.channel} address is the principal's. ${action} To reach them, send to "${PRINCIPAL_RECIPIENT_ALIAS}".`;
  }
  return (
    `That ${taken.channel} address is already on ${who(taken.contact)}. ${action} ` +
    `Use that contact's ID; contact-link-identity adds another address to it.`
  );
}

/**
 * Every candidate, by name, ID and reason. Overridable with distinct_from.
 * `action` says what did not happen; `next` says how to continue.
 */
export function candidatesError(candidates: readonly DuplicateCandidate[], action: string, next: string): string {
  const lines = candidates.map((candidate) => {
    const reasons = candidate.reasons.map(describeReason).join(', ');
    return isPrincipalContact(candidate.contact)
      ? `- the principal ("${PRINCIPAL_RECIPIENT_ALIAS}" in distinct_from): ${reasons}`
      : `- ${who(candidate.contact)}: ${reasons}`;
  });
  return [`This may be someone already in contacts. ${action}`, ...lines, next].join('\n');
}
