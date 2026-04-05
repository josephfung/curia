// src/contacts/dedup-service.ts
//
// Deterministic contact deduplication scoring.
//
// Three signals (combined, clamped to [0, 1]):
//   1. Exact channel identifier overlap → auto-ceiling of 1.0 (certain)
//   2. Jaro-Winkler name similarity (best across all name variants) — primary signal
//   3. Shared KG facts (same org/title) × 0.2 (booster, only when both have kg_node_id)
//
// Blocking: contacts are grouped by the first 3 chars of ALL their normalized name
// variants before scoring, so "J. Torres" and "Jenna Torres" still get compared.
//
// Thresholds:
//   score ≥ 0.9 → 'certain'
//   score 0.7–0.9 → 'probable'
//   score < 0.7 → ignored

import type { Contact, ChannelIdentity, DedupConfidence, DuplicatePair } from './types.js';

// ---------------------------------------------------------------------------
// Jaro-Winkler implementation (no external dependency)
// ---------------------------------------------------------------------------

function jaroSimilarity(s1: string, s2: string): number {
  if (s1 === s2) return 1;
  if (s1.length === 0 || s2.length === 0) return 0;

  const matchDist = Math.max(Math.floor(Math.max(s1.length, s2.length) / 2) - 1, 0);
  const s1Matches = new Array<boolean>(s1.length).fill(false);
  const s2Matches = new Array<boolean>(s2.length).fill(false);
  let matches = 0;

  for (let i = 0; i < s1.length; i++) {
    const lo = Math.max(0, i - matchDist);
    const hi = Math.min(i + matchDist + 1, s2.length);
    for (let j = lo; j < hi; j++) {
      if (s2Matches[j] || s1[i] !== s2[j]) continue;
      s1Matches[i] = true;
      s2Matches[j] = true;
      matches++;
      break;
    }
  }

  if (matches === 0) return 0;

  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < s1.length; i++) {
    if (!s1Matches[i]) continue;
    while (!s2Matches[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }

  return (
    matches / s1.length +
    matches / s2.length +
    (matches - transpositions / 2) / matches
  ) / 3;
}

function jaroWinkler(s1: string, s2: string): number {
  const jaro = jaroSimilarity(s1, s2);
  let prefixLen = 0;
  const maxPrefix = Math.min(4, s1.length, s2.length);
  for (let i = 0; i < maxPrefix; i++) {
    if (s1[i] === s2[i]) prefixLen++;
    else break;
  }
  return jaro + prefixLen * 0.1 * (1 - jaro);
}

// ---------------------------------------------------------------------------
// Name normalization and blocking
// ---------------------------------------------------------------------------

/**
 * Normalize a display name for comparison:
 * - Lowercase
 * - Strip non-alphanumeric except spaces
 * - Collapse whitespace
 */
function normalizeDisplayName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Generate name variants to handle "First Last", "Last First", and "F. Last" forms.
 * E.g., "jenna torres" → ["jenna torres", "torres jenna", "j torres"]
 */
function nameVariants(normalized: string): string[] {
  const variants = [normalized];
  const parts = normalized.split(' ').filter(Boolean);
  if (parts.length >= 2) {
    // Last-first variant
    variants.push([parts[parts.length - 1], ...parts.slice(0, -1)].join(' '));
    // Initial variant (first initial + rest)
    if (parts[0]!.length > 0) {
      variants.push([parts[0]![0], ...parts.slice(1)].join(' '));
    }
  }
  return [...new Set(variants)]; // deduplicate
}

/**
 * Return all blocking keys for a contact (first 3 chars of each name variant).
 * A contact lands in multiple blocks so it can be compared against name-reversed
 * or initial-abbreviated duplicates.
 */
function blockingKeys(contact: Contact): string[] {
  const normalized = normalizeDisplayName(contact.displayName);
  const variants = nameVariants(normalized);
  return [...new Set(variants.map((v) => v.slice(0, 3)))];
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

const THRESHOLD_CERTAIN = 0.9;
const THRESHOLD_PROBABLE = 0.7;

function scoreContacts(
  a: Contact,
  aIdentities: ChannelIdentity[],
  b: Contact,
  bIdentities: ChannelIdentity[],
): { score: number; reason: string } | null {
  // Skip self-comparison
  if (a.id === b.id) return null;

  // Signal 1: exact channel identifier overlap → instant ceiling
  const aIds = new Set(aIdentities.map((i) => `${i.channel}:${i.channelIdentifier}`));
  for (const bId of bIdentities) {
    const key = `${bId.channel}:${bId.channelIdentifier}`;
    if (aIds.has(key)) {
      return {
        score: 1.0,
        // Reason omits the actual identifier value — it would be an email address or phone
        // number, which should not flow into bus events or LLM context.
        reason: `Same ${bId.channel} identifier`,
      };
    }
  }

  // Signal 2: Jaro-Winkler name similarity across all variant pairs.
  // We take the best score across all name variant combinations so that
  // "J. Torres" and "Jenna Torres" match via their shared "j torres" variant.
  const aVariants = nameVariants(normalizeDisplayName(a.displayName));
  const bVariants = nameVariants(normalizeDisplayName(b.displayName));
  let maxNameSim = 0;
  for (const av of aVariants) {
    for (const bv of bVariants) {
      maxNameSim = Math.max(maxNameSim, jaroWinkler(av, bv));
    }
  }

  // Signal 3: shared KG facts booster (only when both have KG nodes).
  // The booster is a fixed +0.2 when both contacts reference the same organization
  // in their KG nodes. Since KG queries require async I/O, this signal is not
  // evaluated in the synchronous scoring path. It must be wired at a higher level
  // if needed. The 0.2 weight is reserved for future async enrichment.
  // @TODO: wire KG fact booster when async scoring is introduced.

  // Name similarity is the primary signal; perfect match = 1.0 (certain).
  // When the KG booster is wired it will add up to +0.2 after clamping.
  const totalScore = Math.min(maxNameSim, 1.0);

  if (totalScore < THRESHOLD_PROBABLE) return null;

  const reason = `Similar name (Jaro-Winkler: ${maxNameSim.toFixed(2)})`;

  return { score: totalScore, reason };
}

// ---------------------------------------------------------------------------
// DedupService
// ---------------------------------------------------------------------------

export class DedupService {
  /**
   * Check a newly-created contact against a list of candidate contacts.
   *
   * @param newContact - the contact that was just created
   * @param newIdentities - channel identities for the new contact
   * @param existingContacts - contacts to compare against (new contact should NOT be in this list)
   * @param existingIdentitiesMap - channel identities keyed by contactId
   */
  checkForDuplicates(
    newContact: Contact,
    newIdentities: ChannelIdentity[],
    existingContacts: Contact[],
    existingIdentitiesMap: Map<string, ChannelIdentity[]>,
  ): DuplicatePair[] {
    const pairs: DuplicatePair[] = [];
    const alreadyMatched = new Set<string>(); // contactIds already added as certain matches

    // Pre-scan: channel identifier overlap is an auto-certain match regardless of name.
    // This runs before blocking so contacts in different name-blocks are still compared.
    const newIdKeys = new Set(newIdentities.map((i) => `${i.channel}:${i.channelIdentifier}`));
    for (const candidate of existingContacts) {
      if (candidate.id === newContact.id) continue;
      const candidateIds = existingIdentitiesMap.get(candidate.id) ?? [];
      for (const cId of candidateIds) {
        const key = `${cId.channel}:${cId.channelIdentifier}`;
        if (newIdKeys.has(key)) {
          alreadyMatched.add(candidate.id);
          pairs.push({
            contactA: { id: newContact.id, displayName: newContact.displayName, role: newContact.role, identities: newIdentities },
            contactB: { id: candidate.id, displayName: candidate.displayName, role: candidate.role, identities: candidateIds },
            score: 1.0,
            confidence: 'certain',
            reason: `Same ${cId.channel} identifier`,
          });
          break; // one overlap is enough — stop checking more identities for this candidate
        }
      }
    }

    // Name-blocking pass: skip contacts already matched via channel overlap
    const blockMap = new Map<string, Contact[]>();
    for (const c of existingContacts) {
      if (alreadyMatched.has(c.id)) continue; // already a certain match
      for (const key of blockingKeys(c)) {
        if (!blockMap.has(key)) blockMap.set(key, []);
        blockMap.get(key)!.push(c);
      }
    }

    const candidateSet = new Set<string>(alreadyMatched); // don't re-add already-matched
    const candidates: Contact[] = [];
    for (const key of blockingKeys(newContact)) {
      for (const candidate of blockMap.get(key) ?? []) {
        if (!candidateSet.has(candidate.id)) {
          candidateSet.add(candidate.id);
          candidates.push(candidate);
        }
      }
    }

    for (const candidate of candidates) {
      const result = scoreContacts(
        newContact,
        newIdentities,
        candidate,
        existingIdentitiesMap.get(candidate.id) ?? [],
      );
      if (!result) continue;
      const confidence: DedupConfidence = result.score >= THRESHOLD_CERTAIN ? 'certain' : 'probable';
      pairs.push({
        contactA: { id: newContact.id, displayName: newContact.displayName, role: newContact.role, identities: newIdentities },
        contactB: { id: candidate.id, displayName: candidate.displayName, role: candidate.role, identities: existingIdentitiesMap.get(candidate.id) ?? [] },
        score: result.score,
        confidence,
        reason: result.reason,
      });
    }

    return pairs.sort((a, b) => b.score - a.score);
  }

  /**
   * Full scan: find all probable duplicate pairs across all contacts.
   *
   * @param contacts - full contact list
   * @param identitiesMap - channel identities keyed by contactId
   * @param minConfidence - filter threshold (default: 'probable')
   */
  findAllDuplicates(
    contacts: Contact[],
    identitiesMap: Map<string, ChannelIdentity[]>,
    minConfidence: DedupConfidence = 'probable',
  ): DuplicatePair[] {
    if (contacts.length < 2) return [];

    const pairs: DuplicatePair[] = [];
    const seen = new Set<string>(); // track "a:b" pairs already evaluated

    // Pre-scan: build a reverse index from channel identity key → all contactIds
    // that share it. Exact channel overlap is a certain match regardless of name.
    const channelIndex = new Map<string, string[]>(); // "channel:identifier" → [contactId, ...]
    for (const c of contacts) {
      for (const identity of identitiesMap.get(c.id) ?? []) {
        const key = `${identity.channel}:${identity.channelIdentifier}`;
        const existing = channelIndex.get(key);
        if (existing) {
          existing.push(c.id);
        } else {
          channelIndex.set(key, [c.id]);
        }
      }
    }

    // Emit certain pairs for every group of contacts sharing a channel identifier.
    // Using N×(N-1)/2 enumeration ensures three-way (or larger) overlaps are fully covered —
    // the old single-entry map only linked A↔B but missed the B↔C pair.
    for (const [key, contactIds] of channelIndex) {
      if (contactIds.length < 2) continue;
      // Parse the channel name for the reason string (e.g. "email" from "email:alice@acme.com").
      // The identifier value itself is not included in the reason — it would be an email address
      // or phone number, which should not flow into bus events or LLM context.
      const channelName = key.split(':')[0]!;
      for (let i = 0; i < contactIds.length; i++) {
        for (let j = i + 1; j < contactIds.length; j++) {
          const aId = contactIds[i]!;
          const bId = contactIds[j]!;
          const pairKey = aId < bId ? `${aId}:${bId}` : `${bId}:${aId}`;
          if (seen.has(pairKey)) continue;
          seen.add(pairKey);
          const a = contacts.find((x) => x.id === aId)!;
          const b = contacts.find((x) => x.id === bId)!;
          pairs.push({
            contactA: { id: a.id, displayName: a.displayName, role: a.role, identities: identitiesMap.get(a.id) ?? [] },
            contactB: { id: b.id, displayName: b.displayName, role: b.role, identities: identitiesMap.get(b.id) ?? [] },
            score: 1.0,
            confidence: 'certain',
            reason: `Same ${channelName} identifier`,
          });
        }
      }
    }

    // Name-blocking pass for contacts not already matched by channel overlap
    const blockMap = new Map<string, Contact[]>();
    for (const c of contacts) {
      for (const key of blockingKeys(c)) {
        if (!blockMap.has(key)) blockMap.set(key, []);
        blockMap.get(key)!.push(c);
      }
    }

    for (const group of blockMap.values()) {
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const a = group[i]!;
          const b = group[j]!;
          const pairKey = a.id < b.id ? `${a.id}:${b.id}` : `${b.id}:${a.id}`;
          if (seen.has(pairKey)) continue; // already added via channel overlap
          seen.add(pairKey);

          const result = scoreContacts(
            a,
            identitiesMap.get(a.id) ?? [],
            b,
            identitiesMap.get(b.id) ?? [],
          );
          if (!result) continue;

          const confidence: DedupConfidence = result.score >= THRESHOLD_CERTAIN ? 'certain' : 'probable';
          if (minConfidence === 'certain' && confidence !== 'certain') continue;

          pairs.push({
            contactA: { id: a.id, displayName: a.displayName, role: a.role, identities: identitiesMap.get(a.id) ?? [] },
            contactB: { id: b.id, displayName: b.displayName, role: b.role, identities: identitiesMap.get(b.id) ?? [] },
            score: result.score,
            confidence,
            reason: result.reason,
          });
        }
      }
    }

    return pairs.sort((a, b) => b.score - a.score);
  }
}
