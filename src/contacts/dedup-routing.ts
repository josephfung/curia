// src/contacts/dedup-routing.ts
//
// What the weekly dedup scan does with a candidate pair (#2493). The classifier
// (dedup-classifier.ts) says how strong the evidence is; this module turns that into an
// action:
//
//   - auto-merge — structural proof, nothing protected, nothing elevated. No task.
//   - review, route 'curia' — Curia decides the pair itself: merge or exclude.
//   - review, route 'principal' — Curia may hand the pair to the principal: both sides
//     are people and one is known/trusted, or a merge would lend a known/trusted tier
//     to the other side.
//
// Pure functions over Contact rows, so every rule is unit-testable without a database.

import { createHash } from 'node:crypto';
import type { ChannelIdentity, Contact } from './types.js';
import type { PairClassification } from './dedup-classifier.js';
import { isStructuralContact } from './contact-service.js';
import { normalizeDisplayName } from './dedup-service.js';

/** Who decides a fuzzy pair. Stamped on the review task as a `dedup-route:` tag. */
export type DedupRoute = 'curia' | 'principal';

export const DEDUP_ROUTE_TAG_PREFIX = 'dedup-route:';
/** Fingerprint of both contacts when the task was filed (see dedupPairFingerprint). */
export const DEDUP_FINGERPRINT_TAG_PREFIX = 'dedup-fp:';

export function dedupRouteTag(route: DedupRoute): string {
  return `${DEDUP_ROUTE_TAG_PREFIX}${route}`;
}

export function dedupFingerprintTag(fingerprint: string): string {
  return `${DEDUP_FINGERPRINT_TAG_PREFIX}${fingerprint}`;
}

/** The route stamped on a task's tags, or null for a task filed before #2493. */
export function routeFromTags(tags: readonly string[] | null | undefined): DedupRoute | null {
  for (const tag of tags ?? []) {
    if (tag === dedupRouteTag('curia')) return 'curia';
    if (tag === dedupRouteTag('principal')) return 'principal';
  }
  return null;
}

/** The fingerprint stamped on a task's tags, or null for a task filed before #2493. */
export function fingerprintFromTags(tags: readonly string[] | null | undefined): string | null {
  for (const tag of tags ?? []) {
    if (tag.startsWith(DEDUP_FINGERPRINT_TAG_PREFIX)) return tag.slice(DEDUP_FINGERPRINT_TAG_PREFIX.length);
  }
  return null;
}

/**
 * Tiers that mean the principal has vouched for the contact. A pair touching one of
 * these is about someone the principal knows, so it is theirs to settle.
 */
function isVouchedFor(c: Pick<Contact, 'tier'>): boolean {
  return c.tier === 'known' || c.tier === 'trusted';
}

/**
 * Whether merging the pair would give one side a trust tier the principal never granted
 * it: one side is known or trusted and the other is at a different tier. A merge keeps
 * the higher tier and moves both sides' addresses onto the survivor, so the lower side's
 * addresses would inherit the principal's grant. Display names, and for organizations
 * the shared KG node, are both reachable by a stranger (#2493 security review).
 */
function mergeWouldElevate(a: Pick<Contact, 'tier'>, b: Pick<Contact, 'tier'>): boolean {
  return a.tier !== b.tier && (isVouchedFor(a) || isVouchedFor(b));
}

/**
 * Route a fuzzy pair (or a structural one that may not be auto-merged).
 *
 * The principal decides when both sides are people and one is known or trusted, and
 * whenever a merge would lend a known or trusted tier to the other side, whatever the
 * kinds: a stranger's role address named "Acme Corp" must not be folded into the
 * principal's trusted Acme Corp by Curia alone. Everything else (companies and senders
 * at the same tier, people nobody has vouched for) is Curia's to curate.
 */
export function dedupReviewRoute(a: Pick<Contact, 'kind' | 'tier'>, b: Pick<Contact, 'kind' | 'tier'>): DedupRoute {
  const bothPeople = a.kind === 'person' && b.kind === 'person';
  if (bothPeople && (isVouchedFor(a) || isVouchedFor(b))) return 'principal';
  return mergeWouldElevate(a, b) ? 'principal' : 'curia';
}

/**
 * Whether a structural pair may be merged with no review at all.
 *
 * - Never for a structural contact (principal, agent, system role): a merge deletes the
 *   secondary and copies identities onto the primary, which for the principal means new
 *   addresses that Gate C and the `principal` alias trust.
 * - Never when the two tiers differ: the survivor keeps the higher tier, so the merge
 *   would hand one side's addresses a grant the principal never made for them.
 * - A name-only proof needs both sides at tier `unknown`. A display name is chosen by
 *   whoever sends the message, so a stranger writing as "Jane Doe" would otherwise be
 *   folded into the principal's Jane Doe.
 * - A shared KG node proves nothing when either side is an organization. Organization
 *   contacts share their company's node by design, and an inbound role address is linked
 *   to an existing org node by the display name its sender chose.
 */
export function canAutoMerge(
  a: Contact,
  b: Contact,
  classification: PairClassification,
): boolean {
  if (classification.type !== 'structural') return false;
  if (isStructuralContact(a) || isStructuralContact(b)) return false;
  if (a.tier !== b.tier) return false;
  if (classification.proof === 'name') return a.tier === 'unknown';
  if (classification.proof === 'kg_node') return a.kind !== 'organization' && b.kind !== 'organization';
  return true;
}

/**
 * Pick the survivor of an automatic merge, using the contacts agent's heuristic:
 * more verified identities, then a role, then the older record. The contact id breaks
 * a full tie so the choice is deterministic.
 */
export function choosePrimary(
  a: Contact,
  aIdentities: readonly ChannelIdentity[],
  b: Contact,
  bIdentities: readonly ChannelIdentity[],
): { primary: Contact; secondary: Contact } {
  const verified = (ids: readonly ChannelIdentity[]) => ids.filter(i => i.verified).length;
  const aWins = (): boolean => {
    const av = verified(aIdentities);
    const bv = verified(bIdentities);
    if (av !== bv) return av > bv;
    if (Boolean(a.role) !== Boolean(b.role)) return Boolean(a.role);
    const at = a.createdAt.getTime();
    const bt = b.createdAt.getTime();
    if (at !== bt) return at < bt;
    return a.id < b.id;
  };
  return aWins() ? { primary: a, secondary: b } : { primary: b, secondary: a };
}

/**
 * A short hash of what the dedup scan compares for a pair: each contact's normalized
 * name and its channel identities. Stamped on the review task when it is filed, so a
 * later scan can tell whether either contact changed since (a name edit, an identity
 * added or removed) and re-file a deferred pair early.
 *
 * Order-independent: the two contacts are sorted by id.
 */
export function dedupPairFingerprint(
  a: Pick<Contact, 'id' | 'displayName'>,
  aIdentities: readonly ChannelIdentity[],
  b: Pick<Contact, 'id' | 'displayName'>,
  bIdentities: readonly ChannelIdentity[],
): string {
  const describe = (c: Pick<Contact, 'id' | 'displayName'>, ids: readonly ChannelIdentity[]) => {
    const keys = ids
      .map(i => `${i.channel}:${i.channel === 'email' ? i.channelIdentifier.toLowerCase() : i.channelIdentifier}`)
      .sort();
    return `${c.id.toLowerCase()}|${normalizeDisplayName(c.displayName)}|${keys.join(',')}`;
  };
  const sides = [describe(a, aIdentities), describe(b, bIdentities)].sort();
  return createHash('sha256').update(sides.join('\n')).digest('hex').slice(0, 16);
}
