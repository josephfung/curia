import type { KnowledgeGraphStore } from './knowledge-graph.js';
// Value import (not `import type`) because we call the static method
// EmbeddingService.cosineSimilarity() at runtime.
import { EmbeddingService } from './embedding.js';
import { embeddingStamp } from './embedding-profiles.js';
import type { StoreFactOptions, ValidationResult } from './types.js';
// Value import — config-store only type-imports EntityMemory, so no runtime cycle.
import { SYSTEM_CONFIG_SOURCE } from './config-store.js';

// Spec line 126: max writes per agent per task
// Exported so tests can exhaust the limit without hard-coding the magic number.
export const MAX_WRITES_PER_AGENT_TASK = 50;

/**
 * True when either the incoming write or the existing fact is multi-valued AND
 * their `value` properties differ — these are independent facts, not duplicates
 * or contradictions. Incoming writes set `StoreFactOptions.multiValued`; existing
 * facts persist the marker as `properties.multi_valued` so subsequent unrelated
 * writes cannot silently merge into them (#1623).
 */
function isDistinctMultiValuedFact(
  options: StoreFactOptions,
  existingProperties: Record<string, unknown>,
): boolean {
  const incomingMulti =
    options.multiValued === true ||
    (options.properties as Record<string, unknown> | undefined)?.multi_valued === true;
  const existingMulti = existingProperties.multi_valued === true;
  if (!incomingMulti && !existingMulti) return false;

  const existingValue = existingProperties.value;
  const incomingValue = (options.properties as Record<string, unknown> | undefined)?.value;
  return existingValue !== incomingValue;
}

/**
 * True when semantic dedup must not merge into (or from) an exact-key fact.
 * Either side may carry the protection: a persisted `exact_key` / string `key`
 * on the existing node, or an incoming write with `exactKey` / string `key`.
 * Same string key is allowed through (idempotent merge); anything else is
 * skipped so mergeEntities / memory-store cannot recreate #2252.
 */
function isExactKeyProtected(
  options: StoreFactOptions,
  existingProperties: Record<string, unknown>,
): boolean {
  const incomingProps = (options.properties ?? {}) as Record<string, unknown>;
  const incomingExact =
    options.exactKey === true ||
    incomingProps.exact_key === true ||
    typeof incomingProps.key === 'string';
  const existingExact =
    existingProperties.exact_key === true ||
    typeof existingProperties.key === 'string';
  if (!incomingExact && !existingExact) return false;

  const incomingKey = incomingProps.key;
  const existingKey = existingProperties.key;
  if (typeof incomingKey === 'string' && incomingKey === existingKey) return false;
  return true;
}

/**
 * Only ConfigStore's fixed source is exempt from the per-task write cap.
 * Broader `system:` matching would also exempt checkpoint fact extraction
 * (`system:checkpoint/...`), which must stay capped (spec 01 §Rate Limiting).
 */
function isConfigStoreSystemSource(source: string): boolean {
  return source === SYSTEM_CONFIG_SOURCE;
}

/**
 * Memory validation gates per spec 01 (lines 107-131).
 *
 * All writes to entity memory pass through these checks:
 * 1. Rate limiting — max 50 writes per agent per task execution
 * 2. Deduplication — same entity + similar label (cosine at or above the profile's
 *    factDedup threshold) → merge
 * 3. Contradiction detection — conflicting facts → escalate to user
 * 4. Source attribution — every write records full provenance chain
 *
 * Contradiction resolution follows spec lines 121-123:
 * - Higher existing confidence → auto_rejected (incoming write discarded)
 * - Lower existing confidence → auto_resolved (existing superseded, old value
 *   appended to properties.previous_values for an audit trail)
 * - Equal confidence → conflict (escalated to human review)
 */
/**
 * The write-cap key of a fact source. A `/mailboxes:<ids>` segment records where the data came
 * from (checkpoint provenance, #2475), not who is writing, so it must not open a fresh budget:
 * the cap counts per writer, whichever mailboxes a batch touched.
 */
export function rateLimitKeyOf(source: string): string {
  return source.replace(/\/mailboxes:[^/]*/g, '');
}

export class MemoryValidator {
  // Tracks write counts per agent+task key across a task execution.
  // Key format mirrors the source provenance string, e.g. "agent:coordinator/task:abc123".
  private writeCounts = new Map<string, number>();

  constructor(
    private store: KnowledgeGraphStore,
    private embeddingService: EmbeddingService,
  ) {}

  /**
   * Track a write against the rate limiter.
   * Called by the caller after each successful memory write — the validator
   * doesn't call this internally because the caller owns the store write.
   */
  recordWrite(agentTaskKey: string): void {
    // ConfigStore's source is process-lifetime and never reset — counting it
    // would trip the limit after 50 infrastructure writes. Other system:
    // sources (e.g. checkpoint extraction) must still be capped.
    if (isConfigStoreSystemSource(agentTaskKey)) return;
    const key = rateLimitKeyOf(agentTaskKey);
    const count = this.writeCounts.get(key) ?? 0;
    this.writeCounts.set(key, count + 1);
  }

  /**
   * Reset rate limit counters for a given agent+task key.
   * Should be called when a task completes so the next task gets a clean slate.
   */
  resetRateLimit(agentTaskKey: string): void {
    this.writeCounts.delete(rateLimitKeyOf(agentTaskKey));
  }

  /**
   * Full validation pipeline: rate limit → entity existence → dedup → create.
   *
   * Contradiction detection is a separate method (validateContradiction) because
   * it requires attribute metadata that not all callers have.
   *
   * Returns a ValidationResult discriminated union:
   * - 'rate_limited' if the rate limit is exceeded
   * - 'entity_not_found' if the entity node does not exist
   * - 'update' if a near-duplicate fact already exists (caller should merge)
   * - 'create' with validated fact data (label, properties, temporal, embedding) ready to persist
   */
  async validate(options: StoreFactOptions): Promise<ValidationResult> {
    // 1. Rate limiting — per agent+task source. Only ConfigStore's fixed source
    //    is exempt (process-lifetime, never reset). Checkpoint extraction and
    //    other system: sources stay capped.
    if (!isConfigStoreSystemSource(options.source)) {
      const writeCount = this.writeCounts.get(rateLimitKeyOf(options.source)) ?? 0;
      if (writeCount >= MAX_WRITES_PER_AGENT_TASK) {
        return {
          action: 'rate_limited',
          reason: `Memory write rate limit exceeded (${MAX_WRITES_PER_AGENT_TASK} per agent per task)`,
        };
      }
    }

    // 2. Entity existence — reject early if the target entity has been deleted
    //    or was never created. Avoids creating dangling fact nodes/edges and
    //    surfaces the problem with a clear message rather than a FK violation.
    const entityNode = await this.store.getNode(options.entityNodeId);
    if (!entityNode) {
      return {
        action: 'entity_not_found',
        reason: `Entity node not found: ${options.entityNodeId}`,
      };
    }

    // Exact-key path (#2252): config keys are opaque identifiers, not prose.
    if (options.exactKey === true) {
      return this.validateExactKey(options);
    }

    // 4. Deduplication — one JOIN for connected facts, then early-exit on the
    //    first cosine hit (spec line 115: same entity + similar label).
    const connectedFacts = await this.store.getConnectedFacts(options.entityNodeId);

    const newEmbedding = await this.embeddingService.embed(options.label, 'similarity');
    // The threshold belongs to the model that produced the scores (ADR-051).
    const dedupThreshold = this.embeddingService.profile.thresholds.factDedup;

    for (const targetNode of connectedFacts) {
      if (!targetNode.embedding) continue;
      // A vector from another model or document prefix is not comparable (ADR-051).
      if (targetNode.embeddingModel !== embeddingStamp(this.embeddingService.profile)) continue;

      const similarity = EmbeddingService.cosineSimilarity(newEmbedding, targetNode.embedding);
      if (similarity >= dedupThreshold) {
        const existingProps = targetNode.properties as Record<string, unknown>;
        // Multi-valued facts must not be merged when their `value` differs —
        // near-identical labels would otherwise overwrite `value` and destroy
        // the first fact. Check either side so an unrelated incoming write
        // cannot merge into an existing multi-valued fact either.
        if (isDistinctMultiValuedFact(options, existingProps)) {
          continue;
        }
        // Exact-key facts (config-store) must not be merged by label similarity —
        // a write without exactKey (e.g. mergeEntities) would otherwise recreate #2252.
        if (isExactKeyProtected(options, existingProps)) {
          continue;
        }

        // Near-duplicate detected — signal a merge. Caller is responsible for
        // persisting the merged properties via store.updateNode().
        return {
          action: 'update',
          existingNodeId: targetNode.id,
          // Merge: existing properties are the base; new properties win on collision
          mergedProperties: {
            ...targetNode.properties,
            ...(options.properties ?? {}),
          },
        };
      }
    }

    // 5. No duplicate found — return validated fact data for the caller to persist.
    //    Reuse the dedup vector only when similarity and document prefixes match
    //    (ADR-051); otherwise the store embeds as document.
    return this.buildCreateResult(options, this.embeddingForCreate(newEmbedding));
  }

  /**
   * Exact-key upsert for opaque identifiers (config-store). Never compares
   * embeddings. Matches properties.key, or a legacy label-only fact whose
   * label equals the key (adopts it and stamps key/exact_key) — but never a
   * fact that already carries a conflicting `properties.namespace` (meta-index
   * rows corrupted by the old semantic merge).
   */
  private async validateExactKey(options: StoreFactOptions): Promise<ValidationResult> {
    const incomingProps = (options.properties ?? {}) as Record<string, unknown>;
    const incomingKey = incomingProps.key;
    if (typeof incomingKey !== 'string') {
      // Programmer error — silently creating would pile up permanent duplicates.
      throw new Error(
        'StoreFactOptions.exactKey requires a string properties.key (opaque identifier upsert)',
      );
    }

    // Persist the marker so semantic writes without exactKey still skip this fact.
    const optionsWithMarker: StoreFactOptions = {
      ...options,
      properties: { ...options.properties, exact_key: true },
    };

    // Key-filtered in the store — debrief anchors grow unbounded with per-instance
    // keys, so loading every fact (and embedding) per write would scale with the
    // namespace. The checks below remain the source of truth for a match.
    const connectedFacts = await this.store.getConnectedFactsByKey(options.entityNodeId, incomingKey);

    // Prefer the most recently confirmed match when duplicates somehow exist.
    // Also adopt legacy label-only facts (no properties.key) so a rewrite does
    // not create a twin that list() would show twice — unless the fact already
    // names a different namespace (corrupted index fact from #2252).
    let bestMatch: { id: string; properties: Record<string, unknown>; confirmedAt: number } | undefined;

    for (const targetNode of connectedFacts) {
      const props = targetNode.properties as Record<string, unknown>;
      const existingKey = props.key;
      const keyMatch = existingKey === incomingKey;
      const namespaceOk =
        props.namespace === undefined || props.namespace === incomingProps.namespace;
      const legacyLabelMatch =
        existingKey === undefined
        && targetNode.label === incomingKey
        && namespaceOk;
      if (!keyMatch && !legacyLabelMatch) continue;

      const confirmedAt = targetNode.temporal.lastConfirmedAt.getTime();
      if (!bestMatch || confirmedAt > bestMatch.confirmedAt) {
        bestMatch = {
          id: targetNode.id,
          properties: props,
          confirmedAt,
        };
      }
    }

    if (bestMatch) {
      return {
        action: 'update',
        existingNodeId: bestMatch.id,
        mergedProperties: {
          ...bestMatch.properties,
          ...(optionsWithMarker.properties ?? {}),
        },
        // Keep label === key so retrieve and the mismatch query stay clean.
        newLabel: options.label,
      };
    }

    // Exact-key matching never uses embeddings — let the store embed as document.
    return this.buildCreateResult(optionsWithMarker, undefined);
  }

  /**
   * Embedding to pass through on create when the profile uses the same vector
   * for similarity and document storage; otherwise undefined so the store embeds
   * as document (ADR-051). Accepts a precomputed similarity vector so the
   * semantic path does not embed twice.
   */
  private embeddingForCreate(similarityEmbedding: number[]): number[] | undefined {
    const { prefixes } = this.embeddingService.profile;
    if (prefixes.similarity !== prefixes.document) return undefined;
    return similarityEmbedding;
  }

  private buildCreateResult(
    options: StoreFactOptions,
    embedding: number[] | undefined,
  ): ValidationResult {
    return {
      action: 'create',
      validated: {
        label: options.label,
        properties: options.properties ?? {},
        ...(embedding ? { embedding } : {}),
        provenance: {
          confidence: options.confidence ?? 0.7,
          decayClass: options.decayClass ?? 'slow_decay',
          // Full provenance chain: "agent:<name>/task:<id>/channel:<name>"
          source: options.source,
        },
      },
    };
  }

  /**
   * Contradiction detection for attribute-based facts.
   *
   * Checks if an existing fact on the same entity has the same `attribute`
   * property but a different label value. Per spec (lines 118-123):
   * - Higher existing confidence → 'auto_rejected' (incoming write discarded)
   * - Lower existing confidence → 'auto_resolved' (existing superseded; old
   *   value appended to properties.previous_values for an append-only audit trail)
   * - Equal confidence → 'conflict' (escalated to human review)
   *
   * Falls through to validate() when:
   * - No `attribute` property is present (can't detect contradictions)
   * - No existing fact shares the same attribute (no conflict possible)
   */
  async validateContradiction(options: StoreFactOptions & {
    confidence: number;
  }): Promise<ValidationResult> {
    const attribute = (options.properties as Record<string, unknown> | undefined)?.attribute;
    if (!attribute) {
      // No attribute metadata — contradiction detection is not applicable.
      // Proceed with normal dedup + rate-limit validation.
      return this.validate(options);
    }

    // Find all fact nodes connected to this entity and check for attribute conflicts
    const edges = await this.store.getEdgesForNode(options.entityNodeId);
    for (const edge of edges) {
      const targetId = edge.sourceNodeId === options.entityNodeId
        ? edge.targetNodeId
        : edge.sourceNodeId;
      const targetNode = await this.store.getNode(targetId);
      if (!targetNode || targetNode.type !== 'fact') continue;

      const existingAttribute = (targetNode.properties as Record<string, unknown>).attribute;
      if (existingAttribute !== attribute) continue;

      // Multi-valued facts can hold N distinct values per entity. Skip contradiction
      // when either side is multi-valued and the value property differs.
      if (isDistinctMultiValuedFact(options, targetNode.properties as Record<string, unknown>)) {
        continue;
      }

      // Same entity, same attribute, different label → contradiction.
      // Identical label is not a contradiction (dedup will handle it).
      if (targetNode.label !== options.label) {
        const existingConfidence = targetNode.temporal.confidence;
        const incomingConfidence = options.confidence;

        if (existingConfidence > incomingConfidence) {
          // Spec line 121: existing fact has higher confidence — reject incoming write
          return {
            action: 'auto_rejected',
            existingNodeId: targetNode.id,
            reason: `Existing fact "${targetNode.label}" (confidence: ${existingConfidence}) has higher confidence than incoming "${options.label}" (confidence: ${incomingConfidence}) — write rejected`,
          };
        }

        if (existingConfidence < incomingConfidence) {
          // Spec line 122: incoming has higher confidence — supersede existing fact,
          // preserving the old value in an append-only previous_values audit trail.
          const existingPreviousValues = Array.isArray(targetNode.properties.previous_values)
            ? (targetNode.properties.previous_values as Array<Record<string, unknown>>)
            : [];

          return {
            action: 'auto_resolved',
            existingNodeId: targetNode.id,
            newLabel: options.label,
            newConfidence: incomingConfidence,
            newProperties: {
              ...targetNode.properties,
              ...(options.properties ?? {}),
              previous_values: [
                ...existingPreviousValues,
                {
                  label: targetNode.label,
                  confidence: existingConfidence,
                  replacedAt: new Date().toISOString(),
                  replacedBy: options.source,
                },
              ],
            },
            reason: `Incoming fact "${options.label}" (confidence: ${incomingConfidence}) supersedes existing "${targetNode.label}" (confidence: ${existingConfidence}) — previous value preserved in properties.previous_values`,
          };
        }

        // Spec line 123: equal confidence — flag for human review
        return {
          action: 'conflict',
          existingNodeId: targetNode.id,
          reason: `Contradicting fact: existing "${targetNode.label}" (confidence: ${existingConfidence}) vs new "${options.label}" (confidence: ${incomingConfidence})`,
        };
      }
    }

    // No contradiction found — proceed with normal validation pipeline
    return this.validate(options);
  }
}
