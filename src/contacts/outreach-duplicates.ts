// outreach-duplicates.ts — "is this already someone we have?" before a contact is made (#2041).
//
// Cold outreach types an address once, into contact-create or contact-link-identity,
// and every later send uses the contact id. That one typing is where a near-miss of
// an existing person has to surface, before the row exists. The check is exact first
// (the address is already on file), then Jaro-Winkler on the same channel, then on
// the display name. See ADR-047.
//
// Errors name the contact and never the address. A model handed an address retypes it.

import { jaroWinkler } from './dedup-service.js';

/**
 * Address near-miss. 0.92 catches a TLD swap and an inserted dot (both about
 * 0.96, the #1950 and #2033 shapes) and a one-digit phone change, and it leaves
 * jenna@work.com / jenna@personal.com (0.89) as two addresses.
 */
export const ADDRESS_NEAR_MISS_THRESHOLD = 0.92;

/** Display-name near-miss. 0.9 is the dedup "certain" band: "Priya Natarajan" / "Priya Natrajan". */
export const NAME_NEAR_MISS_THRESHOLD = 0.9;

/** Shorter than this, Jaro-Winkler treats almost any edit as a match. Exact match still applies. */
const MIN_NEAR_MISS_LENGTH = 8;

export interface IdentitySummary {
  contactId: string;
  displayName: string;
  channel: string;
  channelIdentifier: string;
  /** False when the stored identity cannot be sent to until the principal verifies it. */
  verified: boolean;
}

export interface NameSummary {
  contactId: string;
  displayName: string;
}

export interface OutreachDuplicate {
  contactId: string;
  displayName: string;
  kind: 'same_address' | 'similar_address' | 'similar_name';
  channel?: string;
  /** Exact address hits only. False means that stored identity is unverified. */
  verified?: boolean;
}

export interface OutreachDuplicateReport {
  /** The address is already on this contact. `confirm_new` does not override. */
  exact: OutreachDuplicate[];
  /** A near-miss address or name. `confirm_new` overrides. */
  likely: OutreachDuplicate[];
}

export function isConfirmNew(value: unknown): boolean {
  return value === true || value === 'true';
}

function addressKey(channel: string, identifier: string): string {
  const trimmed = identifier.trim();
  return channel === 'email' ? trimmed.toLowerCase() : trimmed;
}

function normalizeName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function safeName(name: string): string {
  const cleaned = name.replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029"]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (cleaned.length > 0 ? cleaned : 'unknown').slice(0, 80);
}

/**
 * Compare a proposed person with the contacts already on file.
 * `excludeContactId` is the contact being updated, so their own rows are not a conflict.
 */
export function matchOutreachDuplicates(input: {
  displayName?: string;
  identifiers: ReadonlyArray<{ channel: string; identifier: string }>;
  identities: readonly IdentitySummary[];
  names: readonly NameSummary[];
  excludeContactId?: string;
}): OutreachDuplicateReport {
  const exact: OutreachDuplicate[] = [];
  const likely: OutreachDuplicate[] = [];
  const exactIds = new Set<string>();
  const likelyIds = new Set<string>();
  const skip = (contactId: string): boolean => contactId === input.excludeContactId;

  for (const proposed of input.identifiers) {
    const key = addressKey(proposed.channel, proposed.identifier);
    if (!key) continue;
    for (const row of input.identities) {
      if (row.channel !== proposed.channel || skip(row.contactId)) continue;
      const existing = addressKey(row.channel, row.channelIdentifier);
      if (!existing) continue;
      if (existing === key) {
        if (!exactIds.has(row.contactId)) {
          exactIds.add(row.contactId);
          exact.push({
            contactId: row.contactId,
            displayName: row.displayName,
            kind: 'same_address',
            channel: row.channel,
            verified: row.verified,
          });
        }
        continue;
      }
      if (
        key.length >= MIN_NEAR_MISS_LENGTH
        && existing.length >= MIN_NEAR_MISS_LENGTH
        && !exactIds.has(row.contactId)
        && !likelyIds.has(row.contactId)
        && jaroWinkler(key, existing) >= ADDRESS_NEAR_MISS_THRESHOLD
      ) {
        likelyIds.add(row.contactId);
        likely.push({
          contactId: row.contactId,
          displayName: row.displayName,
          kind: 'similar_address',
          channel: row.channel,
        });
      }
    }
  }

  const proposedName = input.displayName ? normalizeName(input.displayName) : '';
  if (proposedName) {
    for (const row of input.names) {
      if (skip(row.contactId) || exactIds.has(row.contactId) || likelyIds.has(row.contactId)) continue;
      const existing = normalizeName(row.displayName);
      if (!existing) continue;
      if (jaroWinkler(proposedName, existing) >= NAME_NEAR_MISS_THRESHOLD) {
        likelyIds.add(row.contactId);
        likely.push({
          contactId: row.contactId,
          displayName: row.displayName,
          kind: 'similar_name',
        });
      }
    }
  }

  return { exact, likely: likely.filter((hit) => !exactIds.has(hit.contactId)) };
}

function formatHit(hit: OutreachDuplicate): string {
  const who = `"${safeName(hit.displayName)}" (${hit.contactId})`;
  if (hit.kind === 'same_address' && hit.verified === false) {
    return `Same ${hit.channel ?? 'channel'} address on ${who}, unverified.`;
  }
  if (hit.kind === 'same_address') return `Same ${hit.channel ?? 'channel'} address on ${who}.`;
  if (hit.kind === 'similar_address') return `Similar ${hit.channel ?? 'channel'} address on ${who}.`;
  return `Similar name to ${who}.`;
}

/**
 * Agent-facing refusal. Names contacts and says how to retry. Contains no address.
 *
 * A near-miss is not permission to send to the contact's current address: that
 * would deliver to the old primary when the principal named a new one. An exact
 * hit on an unverified identity cannot be sent to either; the principal has to
 * verify it (#2041).
 */
export function outreachDuplicateError(
  report: OutreachDuplicateReport,
  verb: 'created' | 'linked',
): string {
  const lines = [...report.exact, ...report.likely].map(formatHit);
  const head = report.exact.length > 0
    ? exactHead(verb, report.exact)
    : likelyHead(verb);
  return [head, ...lines].join(' ');
}

function exactHead(verb: 'created' | 'linked', exact: readonly OutreachDuplicate[]): string {
  const unverified = exact.every((hit) => hit.verified === false);
  if (unverified) {
    return (
      `Nothing was ${verb}: this address is on file but unverified. Ask the principal to verify it before sending. ` +
      'confirm_new does not apply when the address is already on file.'
    );
  }
  return (
    `Nothing was ${verb}: this address is already on a contact. Send to that contact. ` +
    'confirm_new does not apply when the address is already on file.'
  );
}

function likelyHead(verb: 'created' | 'linked'): string {
  return (
    `Nothing was ${verb}: this may be someone already on file. ` +
    'If that contact already has this address, send to that contact. ' +
    'If this is a new address for the same person, add it with contact-link-identity and a label, then send to <id>#<label>. ' +
    'Pass confirm_new true only if this is a different person.'
  );
}
