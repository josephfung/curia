import type { KnowledgeGraphStore } from './knowledge-graph.js';
// Value import (not `import type`) because we call the static method
// EmbeddingService.cosineSimilarity() at runtime.
import { EmbeddingService } from './embedding.js';
import type { StoreFactOptions, ValidationResult, KgNode } from './types.js';
import { createNodeId } from './types.js';

// Spec line 116: cosine similarity threshold for deduplication
const DEDUP_SIMILARITY_THRESHOLD = 0.92;

// Spec line 126: max writes per agent per task
const MAX_WRITES_PER_AGENT_TASK = 50;

/**
 * Memory validation gates per spec 01 (lines 107-131).
 *
 * All writes to entity memory pass through these checks:
 * 1. Rate limiting — max 50 writes per agent per task execution
 * 2. Deduplication — same entity + similar label (cosine > 0.92) → merge
 * 3. Contradiction detection — conflicting facts → escalate to user
 * 4. Source attribution — every write records full provenance chain
 *
 * Note: Auto-resolution for contradictions is stubbed out.
 * Currently all contradictions are flagged for human review regardless of
 * relative confidence. TODO: Implement auto-resolution for lower-confidence
 * contradictions (spec lines 121-123).
 */
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
    const count = this.writeCounts.get(agentTaskKey) ?? 0;
    this.writeCounts.set(agentTaskKey, count + 1);
  }

  /**
   * Reset rate limit counters for a given agent+task key.
   * Should be called when a task completes so the next task gets a clean slate.
   */
  resetRateLimit(agentTaskKey: string): void {
    this.writeCounts.delete(agentTaskKey);
  }

  /**
   * Full validation pipeline: rate limit → dedup → create.
   *
   * Contradiction detection is a separate method (validateContradiction) because
   * it requires attribute metadata that not all callers have.
   *
   * Returns a ValidationResult discriminated union:
   * - 'rejected' if the rate limit is exceeded
   * - 'update' if a near-duplicate fact already exists (caller should merge)
   * - 'create' with a fully-constructed KgNode ready to persist
   */
  async validate(options: StoreFactOptions): Promise<ValidationResult> {
    // 1. Rate limiting — checked against the source string which encodes agent+task identity
    const writeCount = this.writeCounts.get(options.source) ?? 0;
    if (writeCount >= MAX_WRITES_PER_AGENT_TASK) {
      return {
        action: 'rejected',
        reason: `Memory write rate limit exceeded (${MAX_WRITES_PER_AGENT_TASK} per agent per task)`,
      };
    }

    // 2. Deduplication — scoped to the entity's edges, not a global scan.
    //    Spec line 115: "same entity + similar label" prevents cross-entity false matches
    //    and avoids a full table scan as the fact count grows.
    const entityEdges = await this.store.getEdgesForNode(options.entityNodeId);
    const newEmbedding = await this.embeddingService.embed(options.label);

    for (const edge of entityEdges) {
      // Walk either direction of the edge to find the connected node
      const targetId = edge.sourceNodeId === options.entityNodeId
        ? edge.targetNodeId
        : edge.sourceNodeId;
      const targetNode = await this.store.getNode(targetId);

      // Only compare against existing fact nodes that have been embedded
      if (!targetNode || targetNode.type !== 'fact') continue;
      if (!targetNode.embedding) continue;

      const similarity = EmbeddingService.cosineSimilarity(newEmbedding, targetNode.embedding);
      if (similarity >= DEDUP_SIMILARITY_THRESHOLD) {
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

    // 3. No duplicate found — construct a new fact node with full provenance.
    //    The node is NOT persisted here; the caller owns the store write so that
    //    it can coordinate with edge creation atomically.
    const now = new Date();
    const node: KgNode = {
      id: createNodeId(),
      type: 'fact',
      label: options.label,
      properties: options.properties ?? {},
      embedding: newEmbedding,
      temporal: {
        createdAt: now,
        lastConfirmedAt: now,
        confidence: options.confidence ?? 0.7,
        decayClass: options.decayClass ?? 'slow_decay',
        // Full provenance chain: "agent:<name>/task:<id>/channel:<name>"
        source: options.source,
      },
    };

    return { action: 'create', node };
  }

  /**
   * Contradiction detection for attribute-based facts.
   *
   * Checks if an existing fact on the same entity has the same `attribute`
   * property but a different label value. Per spec (lines 118-123):
   * - Higher confidence existing → reject (TODO: auto-resolution)
   * - Lower confidence existing → update (TODO: auto-resolution)
   * - Equal confidence → flag for human review
   *
   * TODO: Implement auto-resolution for higher/lower confidence cases.
   * For now, all contradictions are escalated to the user regardless of
   * relative confidence — this is the safest default while the system matures.
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

      // Same entity, same attribute, different label → contradiction.
      // Identical label is not a contradiction (dedup will handle it).
      if (targetNode.label !== options.label) {
        // @TODO: Auto-resolution stub. All contradictions escalate to user review
        // until the auto-resolver is implemented (spec lines 121-123).
        return {
          action: 'conflict',
          existingNodeId: targetNode.id,
          reason: `Contradicting fact: existing "${targetNode.label}" (confidence: ${targetNode.temporal.confidence}) vs new "${options.label}" (confidence: ${options.confidence})`,
        };
      }
    }

    // No contradiction found — proceed with normal validation pipeline
    return this.validate(options);
  }
}
