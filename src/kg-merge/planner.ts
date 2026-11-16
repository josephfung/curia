// planner.ts — pure merge planning: snapshot in, plan out. No DB, no clock, no I/O.
//
// Spec: docs/wip/2026-10-21-kg-node-merge-design.md §4 (survivorship), §5 (contacts),
// §8 (preview shape and deterministic ids). Everything here is a function of the snapshot
// alone, so the same data always yields the same plan, token and conflict ids — that is
// what lets apply() recompute the plan under row locks and compare tokens.

import { createHash } from 'node:crypto';
import { EmbeddingService } from '../memory/embedding.js';
import { hasConflictingIdentifiers } from '../memory/identifier-guard.js';
import { MAX_ALIASES_PER_ENTITY } from '../memory/entity-memory.js';
import { maxSensitivity } from '../memory/sensitivity.js';
import type { DecayClass } from '../memory/types.js';
import { isStructuralContact, survivingTier } from '../contacts/contact-service.js';
import type { ContactTier } from '../contacts/types.js';
import {
  CONTACT_MERGE_FIELD_LABELS,
  CONTACT_MERGE_FIELDS,
  PRINCIPAL_PRIMARY_FIELDS,
  type AuthOverrideConflictPlan,
  type ContactFieldConflictPlan,
  type ContactMergeField,
  type ContactPlan,
  type ContactPlanView,
  type EdgePlan,
  type FactChoice,
  type FactCollapse,
  type FactConflictPlan,
  type FactMove,
  type FactPlan,
  type MergeBlocker,
  type MergeFactSummary,
  type MergeNodeSummary,
  type MergePlan,
  type MergeSide,
  type MergeSnapshot,
  type MergeSummaryCounts,
  type MergeWarning,
  type NearDuplicateChoice,
  type NearDuplicatePlan,
  type NodePlan,
  type PropertyConflict,
  type Side,
  type SnapshotContact,
  type SnapshotFact,
  type OutsideEdgeRepointOp,
  type SnapshotEdge,
  type SnapshotNode,
} from './types.js';
import { setOwn } from './own.js';

/** Properties never copied from the absorbed node (§4.1). */
export const RESERVED_PROPERTY_KEYS: ReadonlySet<string> = new Set(['merged_into', 'merged_at', 'is_agent']);

const DECAY_RANK: Record<DecayClass, number> = { fast_decay: 0, slow_decay: 1, permanent: 2 };

// ---------------------------------------------------------------------------
// Canonical serialization and the plan token
// ---------------------------------------------------------------------------

/** JSON with object keys sorted recursively, so equal data always serializes equally. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      // setOwn: a `__proto__` key must reach the hash, not reset out's prototype.
      if (obj[key] !== undefined) setOwn(out, key, sortKeys(obj[key]));
    }
    return out;
  }
  return value;
}

/**
 * SHA-256 over the canonical snapshot (§3) and the fact-similarity settings. Changes whenever
 * anything the plan reads changes, including an embedding profile swapped between preview
 * and apply, which would pair facts differently.
 */
export function planToken(snapshot: MergeSnapshot, similarity?: FactSimilarity): string {
  const hashed = similarity ? { snapshot, similarity } : snapshot;
  return createHash('sha256').update(canonicalJson(hashed)).digest('hex');
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function deepEqual(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/** Lower-case, collapse whitespace, strip trailing '.'/'!' (§4.3 non-attribute facts). */
export function normalizeFactText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.!]+$/, '').trim();
}

function factAttribute(fact: SnapshotNode): string | null {
  const raw = fact.properties.attribute;
  if (typeof raw !== 'string') return null;
  const normalized = raw.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function factValueString(fact: SnapshotNode): string | null {
  const raw = fact.properties.value;
  if (raw === undefined || raw === null) return null;
  return typeof raw === 'string' ? raw : canonicalJson(raw);
}

/** The value an attribute fact asserts: normalized properties.value, else the normalized label. */
function factValueKey(fact: SnapshotNode): string {
  const value = factValueString(fact);
  return normalizeFactText(value ?? fact.label);
}

function isMultiValued(fact: SnapshotNode): boolean {
  return fact.properties.multi_valued === true;
}

/** Newest by last_confirmed_at; ties broken by id so the choice is deterministic. */
function newest<T extends { lastConfirmedAt: string; id: string }>(items: T[]): T {
  return [...items].sort((a, b) =>
    b.lastConfirmedAt.localeCompare(a.lastConfirmedAt) || a.id.localeCompare(b.id),
  )[0]!;
}

/** The newer side by last_confirmed_at; the survivor on a tie (§4.2). */
function newerSide(survivorConfirmedAt: string, absorbedConfirmedAt: string): Side {
  return absorbedConfirmedAt > survivorConfirmedAt ? 'absorbed' : 'survivor';
}

export function mostDurable(a: DecayClass, b: DecayClass): DecayClass {
  return DECAY_RANK[a] >= DECAY_RANK[b] ? a : b;
}

function maxIso(a: string, b: string): string {
  return a >= b ? a : b;
}

function minIso(a: string, b: string): string {
  return a <= b ? a : b;
}

export function isAgentNode(side: MergeSide): boolean {
  return String(side.node.properties.is_agent) === 'true'
    || side.contacts.some(c => c.systemRole === 'agent' || c.kind === 'agent');
}

function isPrincipalContact(c: SnapshotContact): boolean {
  return c.systemRole === 'principal';
}

function identityKey(channel: string, identifier: string): string {
  return `${channel}:${channel === 'email' ? identifier.toLowerCase() : identifier}`;
}

/** Sort contacts by created_at then id — the order the snapshot loads them in. */
function byCreation(a: SnapshotContact, b: SnapshotContact): number {
  return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

// ---------------------------------------------------------------------------
// Aliases (§4.1)
// ---------------------------------------------------------------------------

/**
 * Aliases for a given label choice: survivor aliases, then the unchosen label, then the
 * absorbed aliases — lower-cased, de-duplicated, minus the final label, capped.
 */
export function computeAliases(
  survivor: Pick<SnapshotNode, 'label' | 'aliases'>,
  absorbed: Pick<SnapshotNode, 'label' | 'aliases'>,
  label: Side,
): { label: string; aliases: string[]; droppedAliases: string[] } {
  const finalLabel = label === 'absorbed' ? absorbed.label : survivor.label;
  const otherLabel = label === 'absorbed' ? survivor.label : absorbed.label;
  const finalKey = finalLabel.trim().toLowerCase();
  const seen = new Set<string>();
  const all: string[] = [];
  for (const raw of [...survivor.aliases, otherLabel, ...absorbed.aliases]) {
    const alias = raw.trim().toLowerCase();
    if (alias.length === 0 || alias === finalKey || seen.has(alias)) continue;
    seen.add(alias);
    all.push(alias);
  }
  return {
    label: finalLabel,
    aliases: all.slice(0, MAX_ALIASES_PER_ENTITY),
    droppedAliases: all.slice(MAX_ALIASES_PER_ENTITY),
  };
}

// ---------------------------------------------------------------------------
// Facts (§4.3)
// ---------------------------------------------------------------------------

export function factConflictId(survivorFactId: string, absorbedFactId: string): string {
  return `fact:${survivorFactId}:${absorbedFactId}`;
}

export function nearDuplicateId(survivorFactId: string, absorbedFactId: string): string {
  return `near:${survivorFactId}:${absorbedFactId}`;
}

function groupByAttribute(facts: SnapshotFact[]): Map<string, SnapshotFact[]> {
  const groups = new Map<string, SnapshotFact[]>();
  for (const fact of facts) {
    const attr = factAttribute(fact.node);
    if (attr === null) continue;
    const group = groups.get(attr) ?? [];
    group.push(fact);
    groups.set(attr, group);
  }
  return groups;
}

/**
 * How to score two fact embeddings: only vectors stamped with `embeddingModel` are compared,
 * at that model's fact-dedup threshold (ADR-051). Scores from different models, or a
 * threshold from another model, mean nothing.
 */
export interface FactSimilarity {
  embeddingModel: string;
  threshold: number;
}

export function planFacts(survivor: MergeSide, absorbed: MergeSide, similarity?: FactSimilarity): FactPlan {
  const survivorFactIds = new Set(survivor.facts.map(f => f.node.id));
  const shared = absorbed.facts.filter(f => survivorFactIds.has(f.node.id));
  const absorbedOnly = absorbed.facts.filter(f => !survivorFactIds.has(f.node.id));

  const moves: FactMove[] = [];
  const collapses: FactCollapse[] = [];
  const conflicts: FactConflictPlan[] = [];
  const nearDuplicates: NearDuplicatePlan[] = [];
  const collapseTargets = new Set<string>();

  const collapse = (s: SnapshotNode, a: SnapshotNode): void => {
    collapses.push({ survivorFact: s, absorbedFact: a });
    collapseTargets.add(s.id);
  };

  // 1. Attribute facts, grouped by normalized attribute.
  const survivorByAttr = groupByAttribute(survivor.facts);
  const absorbedByAttr = groupByAttribute(absorbedOnly);
  for (const attr of [...absorbedByAttr.keys()].sort()) {
    const aGroup = absorbedByAttr.get(attr)!;
    const sGroup = survivorByAttr.get(attr);
    if (!sGroup) {
      moves.push(...aGroup.map(f => ({ fact: f.node, linkEdgeIds: f.linkEdgeIds })));
      continue;
    }
    // Same value as some survivor fact of this attribute → automatic duplicate. The newest
    // matching survivor fact keeps it.
    const remaining: SnapshotFact[] = [];
    for (const aFact of aGroup) {
      const key = factValueKey(aFact.node);
      const matches = sGroup.filter(s => factValueKey(s.node) === key).map(s => s.node);
      if (matches.length > 0) {
        collapse(newest(matches), aFact.node);
      } else {
        remaining.push(aFact);
      }
    }
    if (remaining.length === 0) continue;

    // A multi-valued attribute holds several values at once: different values are not a
    // contradiction (storeFact's rule, #1623), so they all move.
    const multi = [...sGroup, ...remaining].some(f => isMultiValued(f.node));
    if (multi) {
      moves.push(...remaining.map(f => ({ fact: f.node, linkEdgeIds: f.linkEdgeIds })));
      continue;
    }

    // Conflict compares the newest fact on each side; the others move unchanged.
    const sNewest = newest(sGroup.map(f => f.node));
    const aNewestNode = newest(remaining.map(f => f.node));
    const aNewest = remaining.find(f => f.node.id === aNewestNode.id)!;
    conflicts.push({
      id: factConflictId(sNewest.id, aNewest.node.id),
      attribute: attr,
      survivorFact: sNewest,
      absorbedFact: aNewest.node,
      absorbedLinkEdgeIds: aNewest.linkEdgeIds,
      default: newerSide(sNewest.lastConfirmedAt, aNewest.node.lastConfirmedAt),
    });
    for (const other of remaining) {
      if (other.node.id !== aNewest.node.id) moves.push({ fact: other.node, linkEdgeIds: other.linkEdgeIds });
    }
  }

  // 2. Non-attribute facts: exact (normalized) label duplicates collapse.
  const survivorPlain = survivor.facts.filter(f => factAttribute(f.node) === null);
  const byLabel = new Map<string, SnapshotNode[]>();
  for (const s of survivorPlain) {
    const key = normalizeFactText(s.node.label);
    byLabel.set(key, [...(byLabel.get(key) ?? []), s.node]);
  }
  const plainRemaining: SnapshotFact[] = [];
  for (const aFact of absorbedOnly.filter(f => factAttribute(f.node) === null)) {
    const matches = byLabel.get(normalizeFactText(aFact.node.label));
    if (matches && matches.length > 0) {
      collapse(newest(matches), aFact.node);
    } else {
      plainRemaining.push(aFact);
    }
  }

  // 3. Near-duplicates by embedding. Greedy by similarity so each absorbed fact pairs with
  // its best match and each survivor fact with at most one absorbed fact. Survivor facts
  // that already absorbed an exact duplicate are left out of pairing. Without a
  // FactSimilarity (no embedding profile) nothing is paired. Facts whose labels carry
  // different identifiers (two order numbers, two message ids) embed near-identically but are
  // different facts, and the factDedup threshold was calibrated with this guard on, as in
  // MemoryValidator's dedup loop (#2023, design §5): they are never paired.
  const pairs: { s: SnapshotNode; a: SnapshotFact; similarity: number }[] = [];
  const comparable = (node: SnapshotNode): number[] | null =>
    similarity && node.embeddingModel === similarity.embeddingModel ? node.embedding : null;
  for (const aFact of similarity ? plainRemaining : []) {
    const aEmb = comparable(aFact.node);
    if (!aEmb) continue;
    for (const s of survivorPlain) {
      const sEmb = comparable(s.node);
      if (!sEmb || sEmb.length !== aEmb.length || collapseTargets.has(s.node.id)) continue;
      if (hasConflictingIdentifiers(s.node.label, aFact.node.label)) continue;
      const score = EmbeddingService.cosineSimilarity(sEmb, aEmb);
      if (score >= similarity!.threshold) pairs.push({ s: s.node, a: aFact, similarity: score });
    }
  }
  pairs.sort((x, y) =>
    y.similarity - x.similarity || x.a.node.id.localeCompare(y.a.node.id) || x.s.id.localeCompare(y.s.id),
  );
  const pairedSurvivor = new Set<string>();
  const pairedAbsorbed = new Set<string>();
  for (const pair of pairs) {
    if (pairedSurvivor.has(pair.s.id) || pairedAbsorbed.has(pair.a.node.id)) continue;
    pairedSurvivor.add(pair.s.id);
    pairedAbsorbed.add(pair.a.node.id);
    nearDuplicates.push({
      id: nearDuplicateId(pair.s.id, pair.a.node.id),
      survivorFact: pair.s,
      absorbedFact: pair.a.node,
      absorbedLinkEdgeIds: pair.a.linkEdgeIds,
      // Rounded so the preview is stable across float formatting.
      similarity: Math.round(pair.similarity * 10_000) / 10_000,
    });
  }
  nearDuplicates.sort((x, y) => x.id.localeCompare(y.id));
  for (const aFact of plainRemaining) {
    if (!pairedAbsorbed.has(aFact.node.id)) moves.push({ fact: aFact.node, linkEdgeIds: aFact.linkEdgeIds });
  }

  moves.sort((x, y) => x.fact.id.localeCompare(y.fact.id));
  collapses.sort((x, y) => x.absorbedFact.id.localeCompare(y.absorbedFact.id));
  conflicts.sort((x, y) => x.id.localeCompare(y.id));

  return {
    moves,
    collapses,
    conflicts,
    nearDuplicates,
    sharedFactIds: shared.map(f => f.node.id).sort(),
    sharedLinkEdgeIds: shared.flatMap(f => f.linkEdgeIds).sort(),
    factOutsideEdges: [
      ...new Map([...survivor.facts, ...absorbed.facts].flatMap(f => f.outsideEdges).map(e => [e.id, e])).values(),
    ].sort((x, y) => x.id.localeCompare(y.id)),
  };
}

// ---------------------------------------------------------------------------
// Fact operations for a set of choices — shared by the preview summary and resolve.ts
// ---------------------------------------------------------------------------

export interface FactChoices {
  facts: Record<string, FactChoice>;
  nearDuplicateFacts: Record<string, NearDuplicateChoice>;
}

export interface BuiltFactOperations {
  deleteFactIds: string[];
  relinkEdgeIds: string[];
  deleteLinkEdgeIds: string[];
  repointOutsideEdges: OutsideEdgeRepointOp[];
  dropOutsideEdgeIds: string[];
  updates: Map<string, { fact: SnapshotNode; confidence: number; lastConfirmedAt: string; sensitivity: SnapshotNode['sensitivity']; previousValues: Record<string, unknown>[] }>;
  movedFactIds: Set<string>;
  collapsedFactCount: number;
}

/** A previous_values entry recording a value the merge dropped (§4.3). */
export function previousValueEntry(dropped: SnapshotNode, replacedAt: string): Record<string, unknown> {
  return {
    value: factValueString(dropped) ?? dropped.label,
    label: dropped.label,
    confidence: dropped.confidence,
    source: dropped.source,
    replaced_at: replacedAt,
    reason: 'node_merge',
  };
}

/** The previous_values history a fact node already carries; it must outlive the node. */
function existingHistory(fact: SnapshotNode): Record<string, unknown>[] {
  const history = fact.properties.previous_values;
  return Array.isArray(history)
    ? history.filter((h): h is Record<string, unknown> => typeof h === 'object' && h !== null)
    : [];
}

/**
 * The fact operations for a set of choices. Operations chain: a survivor fact can absorb a
 * duplicate (gaining its history and sensitivity) and then lose a conflict or a
 * near-duplicate pairing itself. So a deleted fact forwards everything it had accumulated —
 * history, sensitivity, and for a duplicate its confidence and confirmation — to the fact it
 * was folded into, and any later operation naming a deleted fact acts on its successor
 * (union-find style forwarding). No history entry and no sensitivity level is ever lost.
 */
export function buildFactOperations(plan: FactPlan, choices: FactChoices, replacedAt: string): BuiltFactOperations {
  const deleteFactIds = new Set<string>();
  /** fact id → its absorbed-side link edges to re-point */
  const relinks = new Map<string, string[]>();
  const movedFactIds = new Set<string>();
  const updates: BuiltFactOperations['updates'] = new Map();
  /** deleted fact id → the fact it was folded into */
  const successor = new Map<string, SnapshotNode>();
  let collapsedFactCount = plan.sharedFactIds.length;

  /** The live fact standing for `fact`: itself, or the fact its deletion forwarded to. */
  const live = (fact: SnapshotNode): SnapshotNode => {
    let current = fact;
    for (let next = successor.get(current.id); next; next = successor.get(current.id)) current = next;
    return current;
  };
  /** A fact's accumulated state: its pending update, or its stored values. Not recorded. */
  const stateOf = (fact: SnapshotNode) => updates.get(fact.id) ?? {
    fact,
    confidence: fact.confidence,
    lastConfirmedAt: fact.lastConfirmedAt,
    sensitivity: fact.sensitivity,
    previousValues: [] as Record<string, unknown>[],
  };
  const update = (fact: SnapshotNode) => {
    const u = stateOf(fact);
    updates.set(fact.id, u);
    return u;
  };

  /**
   * Fold `drop` into `keep` (each resolved to its live fact) and delete `drop`.
   * - 'duplicate': the same assertion — confidence and confirmation take the max.
   * - 'replaced': a different value — it is appended to the kept fact's previous_values.
   * Either way the kept fact takes the max sensitivity (it now holds the dropped history or
   * value) and inherits the dropped fact's stored and pending history. Returns false when
   * both already resolve to the same fact.
   */
  const fold = (keepFact: SnapshotNode, dropFact: SnapshotNode, mode: 'duplicate' | 'replaced'): boolean => {
    const keep = live(keepFact);
    const drop = live(dropFact);
    if (keep.id === drop.id) return false;
    const from = stateOf(drop);
    const into = update(keep);
    into.sensitivity = maxSensitivity(into.sensitivity, from.sensitivity);
    if (mode === 'duplicate') {
      into.confidence = Math.max(into.confidence, from.confidence);
      into.lastConfirmedAt = maxIso(into.lastConfirmedAt, from.lastConfirmedAt);
    }
    // The dropped node's own history first, then what it gathered in this merge, then (for
    // a replaced value) the value it held.
    into.previousValues.push(...existingHistory(drop), ...from.previousValues);
    if (mode === 'replaced') into.previousValues.push(previousValueEntry(drop, replacedAt));
    updates.delete(drop.id);
    deleteFactIds.add(drop.id);
    successor.set(drop.id, keep);
    return true;
  };
  const relink = (fact: SnapshotNode, linkEdgeIds: string[]) => {
    // A fact already folded away has no links left to move (they cascade with the node).
    if (deleteFactIds.has(fact.id)) return;
    relinks.set(fact.id, linkEdgeIds);
    movedFactIds.add(fact.id);
  };

  for (const move of plan.moves) relink(move.fact, move.linkEdgeIds);

  for (const c of plan.collapses) {
    if (fold(c.survivorFact, c.absorbedFact, 'duplicate')) collapsedFactCount++;
  }

  for (const conflict of plan.conflicts) {
    const choice = choices.facts[conflict.id] ?? conflict.default;
    if (choice === 'both') {
      relink(conflict.absorbedFact, conflict.absorbedLinkEdgeIds);
    } else if (choice === 'survivor') {
      fold(conflict.survivorFact, conflict.absorbedFact, 'replaced');
    } else {
      relink(conflict.absorbedFact, conflict.absorbedLinkEdgeIds);
      fold(conflict.absorbedFact, conflict.survivorFact, 'replaced');
    }
  }

  for (const pair of plan.nearDuplicates) {
    const choice = choices.nearDuplicateFacts[pair.id] ?? 'merge';
    if (choice === 'keep_both') {
      relink(pair.absorbedFact, pair.absorbedLinkEdgeIds);
      continue;
    }
    // merge keeps the higher-confidence fact (the survivor's on a tie), comparing what each
    // side has accumulated so far.
    const s = live(pair.survivorFact);
    const a = live(pair.absorbedFact);
    if (s.id === a.id) continue;
    if (stateOf(a).confidence > stateOf(s).confidence) {
      relink(pair.absorbedFact, pair.absorbedLinkEdgeIds);
      if (fold(a, s, 'duplicate')) collapsedFactCount++;
    } else if (fold(s, a, 'duplicate')) {
      collapsedFactCount++;
    }
  }

  // A fact deleted after it was moved (e.g. an absorbed fact that later lost a pairing)
  // is not moved after all: its link edges go with it.
  for (const id of deleteFactIds) {
    movedFactIds.delete(id);
    relinks.delete(id);
  }

  // A deleted fact's outside edges would cascade with it. Each moves to the fact its
  // endpoint was folded into. One that would then join a fact to itself, or duplicate an
  // edge that stays (idx_kg_edges_unique is direction-agnostic), is dropped instead; the
  // edge that stays keeps its own values.
  const liveId = (id: string): string => {
    let current = id;
    for (let next = successor.get(current); next; next = successor.get(current)) current = next.id;
    return current;
  };
  const edgeKey = (x: string, y: string, type: string): string => (x < y ? `${x}|${y}|${type}` : `${y}|${x}|${type}`);
  const touchesDeleted = (e: SnapshotEdge): boolean => deleteFactIds.has(e.sourceNodeId) || deleteFactIds.has(e.targetNodeId);
  const taken = new Set(
    plan.factOutsideEdges.filter(e => !touchesDeleted(e)).map(e => edgeKey(e.sourceNodeId, e.targetNodeId, e.type)),
  );
  const repointOutsideEdges: OutsideEdgeRepointOp[] = [];
  const dropOutsideEdgeIds: string[] = [];
  for (const e of plan.factOutsideEdges) {
    if (!touchesDeleted(e)) continue;
    const sourceNodeId = liveId(e.sourceNodeId);
    const targetNodeId = liveId(e.targetNodeId);
    const key = edgeKey(sourceNodeId, targetNodeId, e.type);
    if (sourceNodeId === targetNodeId || taken.has(key)) {
      dropOutsideEdgeIds.push(e.id);
      continue;
    }
    taken.add(key);
    repointOutsideEdges.push({ edgeId: e.id, sourceNodeId, targetNodeId });
  }

  return {
    deleteFactIds: [...deleteFactIds].sort(),
    relinkEdgeIds: [...relinks.values()].flat().sort(),
    deleteLinkEdgeIds: [...plan.sharedLinkEdgeIds],
    repointOutsideEdges,
    dropOutsideEdgeIds,
    updates,
    movedFactIds,
    collapsedFactCount,
  };
}

// ---------------------------------------------------------------------------
// Edges (§4.4)
// ---------------------------------------------------------------------------

export function planEdges(survivor: MergeSide, absorbed: MergeSide): EdgePlan {
  const sId = survivor.node.id;
  const aId = absorbed.node.id;
  const plan: EdgePlan = { dropped: [], collapsed: [], moved: [] };
  for (const edge of absorbed.edges) {
    const other = edge.sourceNodeId === aId ? edge.targetNodeId : edge.sourceNodeId;
    if (other === sId || other === aId) {
      plan.dropped.push(edge);
      continue;
    }
    // idx_kg_edges_unique: the unordered pair plus the type.
    const collision = survivor.edges.find(se =>
      se.type === edge.type
      && ((se.sourceNodeId === sId && se.targetNodeId === other) || (se.targetNodeId === sId && se.sourceNodeId === other)),
    );
    if (collision) {
      plan.collapsed.push({ absorbedEdge: edge, survivorEdge: collision });
    } else {
      plan.moved.push(edge);
    }
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Properties (§4.1–4.2)
// ---------------------------------------------------------------------------

export function planProperties(survivor: SnapshotNode, absorbed: SnapshotNode): {
  mergedProperties: Record<string, unknown>;
  conflicts: PropertyConflict[];
} {
  const merged: Record<string, unknown> = { ...survivor.properties };
  const conflicts: PropertyConflict[] = [];
  for (const key of Object.keys(absorbed.properties).sort()) {
    if (RESERVED_PROPERTY_KEYS.has(key)) continue;
    const absorbedValue = absorbed.properties[key];
    // Own keys only: an absorbed `toString` is not a conflict with an inherited function.
    if (!Object.hasOwn(survivor.properties, key)) {
      setOwn(merged, key, absorbedValue);
      continue;
    }
    const survivorValue = survivor.properties[key];
    if (deepEqual(survivorValue, absorbedValue)) continue;
    conflicts.push({
      key,
      survivorValue,
      absorbedValue,
      default: newerSide(survivor.lastConfirmedAt, absorbed.lastConfirmedAt),
    });
  }
  return { mergedProperties: merged, conflicts };
}

// ---------------------------------------------------------------------------
// Contacts (§5)
// ---------------------------------------------------------------------------

function emptyFieldBase(): Record<ContactMergeField, string | null> {
  return Object.fromEntries(CONTACT_MERGE_FIELDS.map(f => [f, null])) as Record<ContactMergeField, string | null>;
}

function sameFieldValue(field: ContactMergeField, a: string, b: string): boolean {
  return field === 'primary_email' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function planContacts(
  survivor: MergeSide,
  absorbed: MergeSide,
  blockers: MergeBlocker[],
  warnings: MergeWarning[],
): ContactPlan {
  const type = survivor.node.type;
  const cs = [...survivor.contacts].sort(byCreation);
  const ca = [...absorbed.contacts].sort(byCreation);
  const plan: ContactPlan = {
    action: 'none',
    surviving: null,
    survivingFrom: null,
    merged: [],
    repointed: [],
    resultingKind: null,
    fieldBase: emptyFieldBase(),
    fieldConflicts: [],
    authOverrideConflicts: [],
    foldOverridePreferences: [],
    principalIdentitiesTransferred: [],
  };

  if (type === 'person') {
    if (cs.length > 1) {
      blockers.push({
        code: 'survivor_multiple_contacts',
        message: `‘${survivor.node.label}’ is linked to ${cs.length} contacts. Merge those contacts on the Contacts page first.`,
      });
    }
    const surviving = cs[0] ?? ca[0] ?? null;
    if (!surviving) return plan;
    plan.surviving = surviving;
    plan.survivingFrom = cs[0] ? 'survivor' : 'absorbed';
    plan.merged = [...cs, ...ca].filter(c => c.id !== surviving.id);
    plan.resultingKind = isStructuralContact(surviving) ? surviving.kind : 'person';
    if (plan.survivingFrom === 'absorbed') {
      plan.repointed.push({ contact: surviving, kind: plan.resultingKind });
    }
    for (const m of plan.merged) {
      if (isStructuralContact(m)) {
        blockers.push({
          code: 'absorbed_structural_contact',
          message: `‘${m.displayName}’ is a system contact and cannot be merged away.`,
        });
      }
    }
    plan.action = plan.merged.length > 0 ? 'merge' : plan.repointed.length > 0 ? 'repoint' : 'none';
    if (plan.action === 'merge') planContactFields(plan, surviving, warnings);
    return plan;
  }

  if (type === 'organization') {
    for (const c of ca) {
      plan.repointed.push({ contact: c, kind: isStructuralContact(c) ? c.kind : 'organization' });
    }
    if (ca.length > 0) {
      plan.action = 'repoint';
      plan.resultingKind = 'organization';
      warnings.push({
        code: 'contacts_repointed',
        message: `${ca.length} contact${ca.length === 1 ? '' : 's'} now link${ca.length === 1 ? 's' : ''} to ‘${survivor.node.label}’; merge duplicates on the Contacts page.`,
        requiresAck: false,
        details: ca.map(c => c.displayName),
      });
    }
    return plan;
  }

  if (ca.length > 0) {
    blockers.push({
      code: 'absorbed_has_contacts_incompatible_type',
      message: `‘${absorbed.node.label}’ has a contact record, which a ${type} node cannot hold. Merge in the other direction, or into a person or organization.`,
    });
  }
  return plan;
}

/** A contact field value as shown in a warning line — quoted and, if long, shortened. */
function quoteValue(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return `'${flat.length > 60 ? `${flat.slice(0, 57)}...` : flat}'`;
}

/**
 * Field and auth-override survivorship of a contact fold (§5.1).
 *
 * Only a contact that was already linked to the survivor node is *anchored*: its values are
 * the "survivor" side of a choosable conflict. When the survivor node had no contact, the
 * surviving contact was promoted from the absorbed side (plan.survivingFrom === 'absorbed')
 * — it is just the row the fold lands on, so it and every other folded contact are peers.
 * Peers never raise a conflict: a field keeps the earliest-created holder's value and a
 * permission keeps the deny, and each such disagreement is listed in contacts_disagree.
 */
function planContactFields(plan: ContactPlan, surviving: SnapshotContact, warnings: MergeWarning[]): void {
  // Lines for the contacts_disagree warning: values decided by rule rather than by choice,
  // and values no choice can keep.
  const disagreements: string[] = [];
  const anchored = plan.survivingFrom === 'survivor';
  const peers = (anchored ? [...plan.merged] : [surviving, ...plan.merged]).sort(byCreation);

  for (const field of CONTACT_MERGE_FIELDS) {
    const survivorValue = anchored ? surviving.fields[field] : null;
    if (survivorValue !== null) {
      plan.fieldBase[field] = survivorValue;
      // Every distinct value the folded contacts hold that differs from the survivor's, in
      // fold order. The conflict is binary (survivor vs the first); the rest would vanish
      // without a trace, so each is named in the warning.
      const differing: { value: string; contact: SnapshotContact }[] = [];
      for (const m of plan.merged) {
        const value = m.fields[field];
        if (value === null || sameFieldValue(field, value, survivorValue)) continue;
        if (differing.some(d => sameFieldValue(field, d.value, value))) continue;
        differing.push({ value, contact: m });
      }
      const [offered, ...dropped] = differing;
      if (offered) {
        plan.fieldConflicts.push({ field, survivorValue, absorbedValue: offered.value });
        for (const d of dropped) {
          disagreements.push(
            `${CONTACT_MERGE_FIELD_LABELS[field]}: ${quoteValue(d.value)} (${d.contact.displayName}) will be dropped; `
            + `the choice is between ${quoteValue(survivorValue)} and ${quoteValue(offered.value)}`,
          );
        }
      }
      continue;
    }
    // No anchored value: the earliest-created peer holding one wins.
    const holders = peers.filter(m => m.fields[field] !== null);
    const kept = holders[0];
    plan.fieldBase[field] = kept ? kept.fields[field] : null;
    if (!kept) continue;
    const keptValue = kept.fields[field]!;
    const losers = holders.filter(m => !sameFieldValue(field, m.fields[field]!, keptValue));
    if (losers.length > 0) {
      disagreements.push(
        `${CONTACT_MERGE_FIELD_LABELS[field]}: ${quoteValue(keptValue)} (${kept.displayName}) kept over `
        + losers.map(m => `${quoteValue(m.fields[field]!)} (${m.displayName})`).join(', '),
      );
    }
  }

  const survivorOverrides = new Map(anchored ? surviving.authOverrides.map(o => [o.permission, o.granted]) : []);
  const seen = new Set<string>();
  // permission → peers holding an active override for it, in fold order: the surviving
  // contact first (its row is in place before any fold), then each folded contact.
  const unanchored = new Map<string, { contact: SnapshotContact; granted: boolean }[]>();
  const addUnanchored = (contact: SnapshotContact, granted: boolean, permission: string) =>
    unanchored.set(permission, [...(unanchored.get(permission) ?? []), { contact, granted }]);
  if (!anchored) {
    for (const o of surviving.authOverrides) addUnanchored(surviving, o.granted, o.permission);
  }
  for (const m of plan.merged) {
    for (const o of m.authOverrides) {
      const survivorGranted = survivorOverrides.get(o.permission);
      if (survivorGranted === undefined) {
        addUnanchored(m, o.granted, o.permission);
        continue;
      }
      if (survivorGranted === o.granted || seen.has(o.permission)) continue;
      seen.add(o.permission);
      plan.authOverrideConflicts.push({
        permission: o.permission,
        survivorGranted,
        absorbedGranted: o.granted,
        absorbedContactId: m.id,
        // The side that denies is the default (security-safe); the user can still pick the grant.
        default: survivorGranted ? 'absorbed' : 'survivor',
      });
    }
  }
  plan.authOverrideConflicts.sort((a, b) => a.permission.localeCompare(b.permission));

  // Peers that disagree on a permission: the deny wins (the security-safe reading). A fold
  // keeps the surviving row's override and drops a later same-permission row, so when the
  // first holder grants — the surviving contact's own grant, or the grant the first fold
  // carried in — the first denying contact must be preferred at its fold, which revokes
  // that grant before the deny is reattached.
  for (const permission of [...unanchored.keys()].sort()) {
    const holders = unanchored.get(permission)!;
    const firstDeny = holders.find(h => !h.granted);
    if (!firstDeny || !holders.some(h => h.granted)) continue;
    if (holders[0]!.granted) {
      plan.foldOverridePreferences.push({ permission, contactId: firstDeny.contact.id });
    }
    disagreements.push(`${permission}: denied kept over granted`);
  }

  if (disagreements.length > 0) {
    warnings.push({
      code: 'contacts_disagree',
      message: 'The contacts being merged disagree on values that are not offered as a choice. '
        + 'Where no contact already on the kept node holds a value, the earliest contact’s field value is kept '
        + 'and, for each permission, denied wins over granted. Values listed as dropped are lost.',
      requiresAck: false,
      details: disagreements,
    });
  }
}

/** Tier survivorship of a fold: the contacts module's one rule (survivingTier), across every contact. */
export function foldTier(surviving: SnapshotContact, merged: SnapshotContact[]): ContactTier {
  return survivingTier(surviving, merged);
}

/**
 * Warning lines for the principal's primary email / phone a fold would fill, or would
 * replace if the user picks the absorbed side of a field conflict. These fields identify
 * the principal too, so they belong next to the identities in the trust warning.
 */
function principalPrimaryFieldLines(plan: ContactPlan): string[] {
  const surviving = plan.surviving;
  if (!surviving) return [];
  const lines: string[] = [];
  for (const field of PRINCIPAL_PRIMARY_FIELDS) {
    const label = CONTACT_MERGE_FIELD_LABELS[field];
    const conflict = plan.fieldConflicts.find(c => c.field === field);
    if (conflict) {
      lines.push(`${label} will become ${conflict.absorbedValue} if the absorbed value is chosen`);
      continue;
    }
    const value = plan.fieldBase[field];
    if (surviving.fields[field] === null && value !== null) lines.push(`${label} will become ${value}`);
  }
  return lines;
}

function contactPlanView(plan: ContactPlan, survivor: MergeSide): ContactPlanView {
  const survivorContactIds = new Set(survivor.contacts.map(c => c.id));
  const involved = plan.surviving ? [plan.surviving, ...plan.merged] : [];
  const seen = new Set<string>();
  const identities: ContactPlanView['identities'] = [];
  for (const c of involved) {
    const from: Side = survivorContactIds.has(c.id) ? 'survivor' : 'absorbed';
    for (const i of c.identities) {
      const key = identityKey(i.channel, i.identifier);
      identities.push({ channel: i.channel, identifier: i.identifier, from, duplicate: seen.has(key), verified: i.verified });
      seen.add(key);
    }
  }
  return {
    action: plan.action,
    survivingContactId: plan.surviving?.id ?? null,
    mergedContactIds: plan.merged.map(c => c.id),
    repointedContactIds: plan.repointed.map(r => r.contact.id),
    resultingKind: plan.resultingKind,
    identities,
  };
}

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

function nodeSummary(side: MergeSide): MergeNodeSummary {
  const n = side.node;
  return {
    id: n.id,
    label: n.label,
    type: n.type,
    aliases: [...n.aliases],
    identitySource: n.identitySource,
    sensitivity: n.sensitivity,
    confidence: n.confidence,
    decayClass: n.decayClass,
    lastConfirmedAt: n.lastConfirmedAt,
    factCount: side.facts.length,
    edgeCount: side.edges.length,
    contacts: side.contacts.map(c => ({
      id: c.id,
      displayName: c.displayName,
      kind: c.kind,
      systemRole: c.systemRole,
      tier: c.tier,
      identityCount: c.identities.length,
    })),
  };
}

export function factSummary(fact: SnapshotNode): MergeFactSummary {
  const attr = fact.properties.attribute;
  return {
    id: fact.id,
    label: fact.label,
    attribute: typeof attr === 'string' ? attr : null,
    value: factValueString(fact),
    confidence: fact.confidence,
    lastConfirmedAt: fact.lastConfirmedAt,
    source: fact.source,
    sensitivity: fact.sensitivity,
  };
}

export function summaryCounts(edges: EdgePlan, facts: BuiltFactOperations): MergeSummaryCounts {
  return {
    factsMoved: facts.movedFactIds.size,
    factsCollapsed: facts.collapsedFactCount,
    edgesMoved: edges.moved.length,
    edgesCollapsed: edges.collapsed.length,
    edgesDropped: edges.dropped.length,
  };
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

/** `similarity` comes from the live embedding profile; without it no facts pair as near-duplicates. */
export function planNodeMerge(snapshot: MergeSnapshot, similarity?: FactSimilarity): MergePlan {
  const token = planToken(snapshot, similarity);
  const { survivor, absorbed } = snapshot;
  const s = survivor.node;
  const a = absorbed.node;
  const blockers: MergeBlocker[] = [];
  const warnings: MergeWarning[] = [];

  // -- Guards (§5.2, §7) --
  if (s.type === 'fact' || a.type === 'fact') {
    blockers.push({ code: 'fact_node', message: 'Fact nodes cannot be merged.' });
  }
  if (isAgentNode(survivor) || isAgentNode(absorbed)) {
    blockers.push({ code: 'agent_node', message: 'The agent’s own node cannot be merged.' });
  }
  const absorbedIsPrincipal = absorbed.contacts.some(isPrincipalContact);
  if (absorbedIsPrincipal) {
    blockers.push({
      code: 'absorbed_is_principal',
      message: `‘${a.label}’ is the principal’s node and cannot be merged away. Swap the direction to keep it.`,
    });
  }
  const survivorIsPrincipal = survivor.contacts.some(isPrincipalContact);

  // -- Contacts (§5) --
  const contacts = planContacts(survivor, absorbed, blockers, warnings);
  if (survivorIsPrincipal && contacts.merged.length > 0) {
    const survivorKeys = new Set(
      (contacts.surviving?.identities ?? []).map(i => identityKey(i.channel, i.identifier)),
    );
    const transferred: string[] = [];
    for (const m of contacts.merged) {
      for (const i of m.identities) {
        const key = identityKey(i.channel, i.identifier);
        if (survivorKeys.has(key)) continue;
        survivorKeys.add(key);
        transferred.push(`${i.channel}: ${i.identifier}`);
      }
    }
    contacts.principalIdentitiesTransferred = transferred;
    warnings.push({
      code: 'principal_identity_transfer',
      message: transferred.length > 0
        ? `These identities will become principal identities, which carry principal-level trust.`
        : `The contact of ‘${a.label}’ will be folded into the principal’s contact.`,
      requiresAck: true,
      details: [...transferred, ...principalPrimaryFieldLines(contacts)],
    });
  }

  // -- Label collision (idx_kg_nodes_unique) --
  const resultIdentitySource = s.type === 'person' && contacts.surviving ? 'contact' : s.identitySource;
  const labelOwner = snapshot.absorbedLabelOwner;
  if (labelOwner && resultIdentitySource === 'label' && a.label.toLowerCase() !== s.label.toLowerCase()) {
    warnings.push({
      code: 'label_collision',
      message: `‘${a.label}’ cannot be the name: another ${s.type} node already uses it.`,
      requiresAck: false,
      details: [`${labelOwner.label} (${labelOwner.type})`],
    });
  }

  // -- Node scalars (§4.1) --
  const { mergedProperties, conflicts: propertyConflicts } = planProperties(s, a);
  const anchoredNow = resultIdentitySource === 'contact' && s.identitySource === 'label';
  const warnedAt = anchoredNow ? null : (s.warnedAt ?? a.warnedAt);
  const warnReason = anchoredNow ? null : (s.warnedAt ? s.warnReason : a.warnReason);
  const node: NodePlan = {
    mergedProperties,
    propertyConflicts,
    confidence: Math.max(s.confidence, a.confidence),
    decayClass: mostDurable(s.decayClass, a.decayClass),
    sensitivity: maxSensitivity(s.sensitivity, a.sensitivity),
    createdAt: minIso(s.createdAt, a.createdAt),
    lastConfirmedAt: maxIso(s.lastConfirmedAt, a.lastConfirmedAt),
    warnedAt,
    warnReason,
    identitySource: resultIdentitySource,
  };

  // -- Facts and edges (§4.3–4.4) --
  const facts = planFacts(survivor, absorbed, similarity);
  const edges = planEdges(survivor, absorbed);
  // The preview summary describes the default choices. The timestamp is irrelevant to counts.
  const defaultOps = buildFactOperations(facts, { facts: {}, nearDuplicateFacts: {} }, s.lastConfirmedAt);

  // -- Direction suggestion (§8) --
  let suggestedDirection: { swap: boolean; reason: string | null } = { swap: false, reason: null };
  if (absorbedIsPrincipal) {
    suggestedDirection = { swap: true, reason: `‘${a.label}’ is the principal’s own node.` };
  } else if (absorbed.contacts.length > 0 && s.type !== 'person' && s.type !== 'organization') {
    suggestedDirection = { swap: true, reason: `‘${a.label}’ has a contact record, which a ${s.type} node cannot hold.` };
  } else if (a.type === 'person' && absorbed.contacts.length > 0 && survivor.contacts.length === 0 && s.type !== 'person') {
    suggestedDirection = {
      swap: true,
      reason: `‘${a.label}’ is a person with a contact record; keeping ‘${s.label}’ would make the result a ${s.type} and lose that personhood.`,
    };
  }

  const aliases = computeAliases(s, a, 'survivor');
  const absorbedLabelAliases = computeAliases(s, a, 'absorbed');

  const preview: MergePlan['preview'] = {
    dryRun: true,
    planToken: token,
    survivor: nodeSummary(survivor),
    absorbed: nodeSummary(absorbed),
    crossType: s.type !== a.type,
    suggestedDirection,
    result: {
      type: s.type,
      labels: { survivor: s.label, absorbed: a.label },
      defaultLabel: 'survivor',
      aliases: aliases.aliases,
      droppedAliases: aliases.droppedAliases,
      aliasOptions: {
        survivor: { aliases: aliases.aliases, droppedAliases: aliases.droppedAliases },
        absorbed: { aliases: absorbedLabelAliases.aliases, droppedAliases: absorbedLabelAliases.droppedAliases },
      },
      sensitivity: node.sensitivity,
      confidence: node.confidence,
      decayClass: node.decayClass,
      identitySource: node.identitySource,
    },
    blockers,
    warnings,
    conflicts: {
      properties: propertyConflicts,
      facts: facts.conflicts.map(c => ({
        id: c.id,
        attribute: c.attribute,
        survivor: factSummary(c.survivorFact),
        absorbed: factSummary(c.absorbedFact),
        default: c.default,
      })),
      nearDuplicateFacts: facts.nearDuplicates.map(n => ({
        id: n.id,
        survivor: factSummary(n.survivorFact),
        absorbed: factSummary(n.absorbedFact),
        similarity: n.similarity,
        default: 'merge' as const,
      })),
      contactFields: contacts.fieldConflicts.map((c: ContactFieldConflictPlan) => ({
        field: c.field,
        label: CONTACT_MERGE_FIELD_LABELS[c.field],
        survivorValue: c.survivorValue,
        absorbedValue: c.absorbedValue,
        default: 'survivor' as const,
      })),
      authOverrides: contacts.authOverrideConflicts.map((c: AuthOverrideConflictPlan) => ({
        permission: c.permission,
        survivorGranted: c.survivorGranted,
        absorbedGranted: c.absorbedGranted,
        default: c.default,
      })),
    },
    contactPlan: contactPlanView(contacts, survivor),
    summary: summaryCounts(edges, defaultOps),
  };

  return { planToken: token, snapshot, preview, node, facts, edges, contacts };
}
