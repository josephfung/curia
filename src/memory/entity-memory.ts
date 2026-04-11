import type { KnowledgeGraphStore } from './knowledge-graph.js';
// EmbeddingService is part of the public constructor signature so callers don't need
// to know whether it's used directly here or delegated to the store. Currently the store
// owns all embedding calls (createNode embeds labels, semanticSearch embeds queries),
// so EntityMemory holds no direct reference. Kept in the API for forward-compatibility.
import type { EmbeddingService } from './embedding.js';
import type { MemoryValidator } from './validation.js';
import type { Logger } from '../logger.js';
import { maxSensitivity } from './sensitivity.js';
import type { SensitivityClassifier } from './sensitivity.js';
import type {
  KgNode,
  KgEdge,
  NodeType,
  EdgeType,
  Sensitivity,
  StoreFactOptions,
  SearchResult,
} from './types.js';

export interface EdgeResult {
  edge: KgEdge;
  /** The node at the other end of the edge */
  node: KgNode;
  direction: 'inbound' | 'outbound';
}

// -- Public input types --

export interface CreateEntityOptions {
  type: NodeType;
  label: string;
  properties: Record<string, unknown>;
  source: string;
  // Optional confidence override; defaults to 0.7 (the store default).
  // Pass a lower value (e.g. 0.6) when creating nodes from LLM extraction
  // output, where the entity may be a first-time mention with no prior context.
  confidence?: number;
  // Explicit sensitivity override. When omitted, EntityMemory auto-classifies
  // the content using SensitivityClassifier and defaults to 'internal'.
  sensitivity?: Sensitivity;
  // Optional category hint for the classifier (e.g. 'financial').
  sensitivityCategory?: string;
}

export interface StoreFactResult {
  stored: boolean;
  /** The ID of the persisted (or existing) fact node, if stored is true. */
  nodeId?: string;
  /** The sensitivity level that was assigned to the node (for audit event emission). */
  sensitivity?: Sensitivity;
  /** True when the sensitivity was re-classified from incoming content because the stored
   *  node could not be read back after an update (race condition / transient DB error).
   *  The emitted audit event sensitivity may differ from what is stored on the node.
   *  The caller should log a warning when this is true. */
  sensitivityFallback?: boolean;
  /** Human-readable reason for a conflict or rate-limit rejection. */
  conflict?: string;
}

export interface QueryResult {
  entity: KgNode;
  facts: KgNode[];
  /** Non-fact nodes directly connected to the entity, with the edge that links them. */
  relationships: Array<{ edge: KgEdge; node: KgNode }>;
}

// Fact node types — used to distinguish fact nodes from entity nodes when walking edges.
// Per types.ts, 'fact' is the only node type that carries atomic facts about entities.
const FACT_TYPE: NodeType = 'fact';

/**
 * EntityMemory: the high-level query layer that agents interact with.
 *
 * Wraps KnowledgeGraphStore (raw CRUD) and MemoryValidator (validation pipeline)
 * with domain-level operations: create entities, store facts, link entities,
 * semantic search, and the "what do I know about X?" compound query.
 *
 * Design: EntityMemory owns no storage — it delegates to store and validator.
 * This keeps it thin and testable. The store handles persistence and embeddings;
 * the validator handles rate limiting, deduplication, and contradiction detection.
 *
 * The optional SensitivityClassifier (issue #200) auto-assigns sensitivity to nodes
 * when the caller does not specify one. Without a classifier, nodes default to 'internal'.
 */
export class EntityMemory {
  constructor(
    private store: KnowledgeGraphStore,
    private validator: MemoryValidator,
    // embeddingService is accepted to keep the constructor signature stable for callers
    // that wire the dependency graph. All embedding work is currently delegated to the
    // store (createNode embeds labels; semanticSearch embeds query strings internally).
    _embeddingService: EmbeddingService,
    private logger: Logger,
    private sensitivityClassifier?: SensitivityClassifier,
  ) {}

  /**
   * Create a non-fact entity node (person, org, project, etc.).
   * Facts about the entity are stored separately via storeFact().
   *
   * Uses upsertNode internally so that calling createEntity twice with the
   * same (label, type) pair returns the existing node rather than creating
   * a duplicate. The `created` flag lets callers distinguish first-insert
   * from re-assertion, which is useful for applying defaults (e.g. roles in
   * ContactService) without overwriting data set by a later, richer call.
   *
   * Sensitivity is auto-classified from the label + properties unless explicitly
   * provided by the caller.
   */
  async createEntity(options: CreateEntityOptions): Promise<{ entity: KgNode; created: boolean }> {
    const sensitivity: Sensitivity = options.sensitivity
      ?? this.sensitivityClassifier?.classify(options.label, options.properties, options.sensitivityCategory)
      ?? 'internal';

    const { node, created } = await this.store.upsertNode({
      type: options.type,
      label: options.label,
      properties: options.properties,
      source: options.source,
      confidence: options.confidence ?? 0.7,
      sensitivity,
    });
    return { entity: node, created };
  }

  /** Retrieve an entity node by ID. Returns undefined if not found. */
  async getEntity(id: string): Promise<KgNode | undefined> {
    return this.store.getNode(id);
  }

  /**
   * Update a node's label and/or properties.
   *
   * ╔══════════════════════════════════════════════════════════════════════╗
   * ║  IMPORTANT — READ BEFORE CALLING THIS METHOD                        ║
   * ║                                                                      ║
   * ║  When `updates.label` is provided, this method checks whether the   ║
   * ║  new label collides with an existing node of the same type.         ║
   * ║  If a collision is found, the two nodes are MERGED — the existing   ║
   * ║  node becomes canonical and the node you passed in is DELETED.      ║
   * ║                                                                      ║
   * ║  When merged === true:                                               ║
   * ║    • node.id in the result is DIFFERENT from the id you passed in   ║
   * ║    • The original id no longer exists in the knowledge graph        ║
   * ║    • You MUST update any local reference to the old id              ║
   * ║    • Surface this to the agent — it needs to know the canonical id  ║
   * ║                                                                      ║
   * ║  Example:                                                            ║
   * ║    const { node, merged } = await entityMemory.updateNode(          ║
   * ║      joeId, { label: 'Joseph Fung' }                                ║
   * ║    );                                                                ║
   * ║    if (merged) {                                                     ║
   * ║      // joeId is gone. node.id is the canonical Joseph Fung node.   ║
   * ║      // Log, surface to the agent, update your local reference.     ║
   * ║    }                                                                 ║
   * ╚══════════════════════════════════════════════════════════════════════╝
   */
  async updateNode(
    id: string,
    updates: { label?: string; properties?: Record<string, unknown> },
  ): Promise<{ node: KgNode; merged: boolean }> {
    if (!updates.label) {
      // Properties-only update — no collision possible, simple pass-through
      const node = await this.store.updateNode(id, updates);
      return { node, merged: false };
    }

    // Label change: check for a collision with an existing node of the same type
    const current = await this.store.getNode(id);
    if (!current) throw new Error(`Node not found: ${id}`);

    if (current.type !== FACT_TYPE) {
      const candidates = await this.store.findNodesByLabel(updates.label);
      const collision = candidates.find(n => n.type === current.type && n.id !== id);

      if (collision) {
        // Merge: the existing node is canonical; the node being renamed is secondary.
        // mergeEntities handles property merge, fact migration, edge re-pointing,
        // and deletion of the secondary node.
        await this.mergeEntities(collision.id, id);
        // Re-fetch canonical to get post-merge state (properties may have been updated)
        const canonical = await this.store.getNode(collision.id);
        if (!canonical) throw new Error(`Canonical node not found after merge: ${collision.id}`);
        return { node: canonical, merged: true };
      }
    }

    // No collision — proceed with normal label update.
    // Wrap in try/catch to handle a TOCTOU race: another process may have inserted
    // a conflicting node between the findNodesByLabel check above and the UPDATE here.
    // Postgres error 23505 (unique_violation) indicates exactly this scenario.
    try {
      const node = await this.store.updateNode(id, updates);
      return { node, merged: false };
    } catch (err) {
      const pgCode = (err as { code?: string }).code;
      const errMessage = (err as { message?: string }).message ?? '';
      const isUniqueViolation = pgCode === '23505' || errMessage.toLowerCase().includes('unique');

      if (!isUniqueViolation) throw err;

      // Race lost: re-do collision lookup now that the conflicting row exists.
      // Re-fetch current to ensure we have the latest type (the node may have been
      // modified by the concurrent process between our initial getNode and now).
      const raced = await this.store.getNode(id);
      if (!raced) throw new Error(`Node not found after unique-violation race: ${id}`);

      const racedCandidates = await this.store.findNodesByLabel(updates.label!);
      const racedCollision = racedCandidates.find(n => n.type === raced.type && n.id !== id);

      if (!racedCollision) {
        // The conflicting node was deleted before we re-queried — retry the update.
        const node = await this.store.updateNode(id, updates);
        return { node, merged: false };
      }

      // Collision confirmed post-race: merge as normal.
      await this.mergeEntities(racedCollision.id, id);
      const canonical = await this.store.getNode(racedCollision.id);
      if (!canonical) throw new Error(`Canonical node not found after race-condition merge: ${racedCollision.id}`);
      return { node: canonical, merged: true };
    }
  }

  /**
   * Find entity nodes by label (case-insensitive, exact match).
   * Delegates to store.findNodesByLabel which uses ILIKE in Postgres
   * and a toLowerCase comparison in the in-memory backend.
   */
  async findEntities(label: string): Promise<KgNode[]> {
    return this.store.findNodesByLabel(label);
  }

  /**
   * Store a fact about an entity, running it through the full validation pipeline:
   * rate limiting → deduplication → (optionally) contradiction detection.
   *
   * Returns:
   * - { stored: true, nodeId, sensitivity } on create (new fact node + edge persisted)
   * - { stored: true, nodeId, sensitivity } on update (duplicate merged into existing node)
   * - { stored: false, conflict } on rate-limit rejection or contradiction
   *
   * The sensitivity field in the result is what was actually assigned to the node —
   * the execution layer uses this to populate memory.store audit events.
   *
   * Note: storeFact calls validator.validate(), which handles rate limiting and
   * deduplication but NOT contradiction detection. Contradiction detection
   * requires callers to invoke validator.validateContradiction() directly when
   * they have attribute metadata and a confidence value to compare against.
   */
  async storeFact(options: StoreFactOptions): Promise<StoreFactResult> {
    const result = await this.validator.validate(options);

    switch (result.action) {
      case 'create': {
        // Resolve sensitivity: caller override → classifier → default 'internal'.
        // The classifier runs on the fact label and any provided properties so that
        // content like "Q3 salary plan: $2.4M" is tagged 'confidential' automatically.
        const sensitivity: Sensitivity = options.sensitivity
          ?? this.sensitivityClassifier?.classify(
            options.label,
            options.properties ?? {},
            options.sensitivityCategory,
          )
          ?? 'internal';

        // Persist the fact node, then link it to the entity with a 'relates_to' edge
        // so getFacts() can discover it. store.createNode() returns the persisted node
        // with its assigned ID, so we use that directly for the edge.
        const persistedNode = await this.store.createNode({
          type: FACT_TYPE,
          label: result.validated.label,
          properties: result.validated.properties,
          confidence: result.validated.provenance.confidence,
          decayClass: result.validated.provenance.decayClass,
          source: result.validated.provenance.source,
          // Pass the pre-computed embedding from the validator's dedup check
          // to avoid a redundant OpenAI API call.
          embedding: result.validated.embedding,
          sensitivity,
        });

        // If edge creation fails, the node we just created becomes an orphan
        // (unreachable via any entity) — attempt to clean it up before re-throwing.
        try {
          await this.store.createEdge({
            sourceNodeId: options.entityNodeId,
            targetNodeId: persistedNode.id,
            type: 'relates_to',
            properties: {},
            source: options.source,
          });
        } catch (err) {
          // Attempt to clean up the orphan node. If cleanup also fails, log at error level
          // so the dangling node can be found and removed manually.
          try {
            await this.store.deleteNode(persistedNode.id);
          } catch (cleanupErr) {
            // Include both errors so the log entry is self-contained — an operator can see
            // why the edge failed and why cleanup failed without correlating with caller logs.
            this.logger.error(
              { nodeId: persistedNode.id, edgeCreationErr: err, cleanupErr },
              'storeFact: edge creation failed and orphan cleanup also failed — fact node is now dangling',
            );
          }
          throw err;
        }

        this.validator.recordWrite(options.source);
        return { stored: true, nodeId: persistedNode.id, sensitivity };
      }

      case 'update': {
        // Near-duplicate detected — merge properties into the existing node.
        await this.store.updateNode(result.existingNodeId, {
          properties: result.mergedProperties,
        });
        this.validator.recordWrite(options.source);

        // Read the existing node after the merge to get the current state.
        // A successful updateNode followed by a missing getNode is unexpected — flag it
        // via sensitivityFallback so the caller (execution layer observer) can log a
        // warning. We still emit the audit event rather than dropping it.
        const existingNode = await this.store.getNode(result.existingNodeId);
        const sensitivityFallback = existingNode === undefined;
        const existingSensitivity: Sensitivity = existingNode?.sensitivity ?? 'internal';

        // Ratchet: merged content can only increase sensitivity, never decrease.
        // A near-duplicate that adds PII or financial data must be persisted at the
        // higher level — keeping the original classification would silently under-protect.
        const incomingSensitivity: Sensitivity = options.sensitivity
          ?? this.sensitivityClassifier?.classify(
            options.label,
            result.mergedProperties ?? options.properties ?? {},
            options.sensitivityCategory,
          )
          ?? 'internal';
        const sensitivity = maxSensitivity(existingSensitivity, incomingSensitivity);

        if (!sensitivityFallback && sensitivity !== existingSensitivity) {
          await this.store.updateNode(result.existingNodeId, { sensitivity });
        }

        return { stored: true, nodeId: result.existingNodeId, sensitivity, sensitivityFallback };
      }

      case 'conflict':
        return { stored: false, conflict: result.reason };

      case 'rejected':
        return { stored: false, conflict: result.reason };
    }
  }

  /**
   * Get all fact nodes linked to an entity.
   *
   * Walks all edges from the entity node and filters for nodes whose type
   * is 'fact'. This deliberately excludes other entity nodes that happen to
   * be linked (e.g. a person linked to a project via 'works_on') — those are
   * returned by query() as relationships instead.
   */
  async getFacts(entityNodeId: string): Promise<KgNode[]> {
    const edges = await this.store.getEdgesForNode(entityNodeId);
    const facts: KgNode[] = [];

    for (const edge of edges) {
      // Edges are bidirectional — find the node on the other side of each edge
      const otherId = edge.sourceNodeId === entityNodeId
        ? edge.targetNodeId
        : edge.sourceNodeId;

      const node = await this.store.getNode(otherId);
      if (!node) {
        // Dangling edge — referenced node no longer exists (referential integrity violation).
        // @TODO: emit a bus event for the audit logger once bus access is available here.
        this.logger.error(
          { edgeId: edge.id, nodeId: otherId, entityNodeId },
          'getFacts: dangling edge detected — referenced node does not exist',
        );
        continue;
      }
      if (node.type === FACT_TYPE) {
        facts.push(node);
      }
    }

    return facts;
  }

  /**
   * Find entity-to-entity relationship edges for a node.
   *
   * Returns edges in both directions by default. Excludes edges to 'fact' nodes —
   * those are atomic facts stored on a single entity and are not relationships.
   *
   * Each result includes the connected node and a direction label relative to nodeId.
   * 'outbound' means nodeId is the source; 'inbound' means nodeId is the target.
   */
  async findEdges(
    nodeId: string,
    opts?: { type?: EdgeType; direction?: 'inbound' | 'outbound' | 'both' },
  ): Promise<EdgeResult[]> {
    const direction = opts?.direction ?? 'both';
    const allEdges = await this.store.getEdgesForNode(nodeId);
    const results: EdgeResult[] = [];

    for (const edge of allEdges) {
      // Determine direction relative to nodeId
      const isOutbound = edge.sourceNodeId === nodeId;
      const edgeDirection: 'inbound' | 'outbound' = isOutbound ? 'outbound' : 'inbound';

      // Apply direction filter
      if (direction !== 'both' && edgeDirection !== direction) continue;

      // Apply type filter
      if (opts?.type !== undefined && edge.type !== opts.type) continue;

      // Resolve the node on the other side
      const otherId = isOutbound ? edge.targetNodeId : edge.sourceNodeId;
      const node = await this.store.getNode(otherId);
      if (!node) {
        // Dangling edge — the referenced node no longer exists. This indicates a referential
        // integrity violation (cascade delete failure or missing migration). Skip the edge so
        // the caller still gets a result, but log so this surfaces in monitoring.
        // @TODO: emit a bus event for the audit logger once bus access is available here.
        this.logger.error(
          { edgeId: edge.id, nodeId: otherId, entityNodeId: nodeId },
          'findEdges: dangling edge detected — referenced node does not exist',
        );
        continue;
      }

      // Exclude fact nodes — they're stored facts about a single entity, not relationships
      if (node.type === FACT_TYPE) continue;

      results.push({ edge, node, direction: edgeDirection });
    }

    return results;
  }

  /**
   * Delete a relationship edge by ID. Hard delete — permanent, no soft-delete.
   * The store logs the deletion at debug level internally.
   *
   * @TODO Phase 2: emit a bus event for the audit logger (requires bus access in EntityMemory).
   */
  async deleteEdge(id: string): Promise<void> {
    await this.store.deleteEdge(id);
  }

  /**
   * Create a typed relationship edge between two entity nodes.
   * This is for entity-to-entity links (person works_on project, etc.)
   * rather than entity-to-fact links (which storeFact handles internally).
   */
  async link(
    sourceId: string,
    targetId: string,
    edgeType: EdgeType,
    properties: Record<string, unknown>,
    source: string,
  ): Promise<KgEdge> {
    return this.store.createEdge({
      sourceNodeId: sourceId,
      targetNodeId: targetId,
      type: edgeType,
      properties,
      source,
    });
  }

  /**
   * Merge secondary KG node into primary.
   *
   * Survivorship rules:
   * - Scalar properties: most-recent-wins by comparing node temporal.lastConfirmedAt
   *   timestamps. If timestamps are equal, primary wins.
   * - Facts (child fact nodes): secondary's facts are re-stored on primary
   *   via storeFact() to preserve deduplication logic.
   *
   * Phase 1: scalar properties + facts. Phase 2: relationship edge re-pointing
   * and secondary node deletion (implemented below).
   */
  async mergeEntities(primaryId: string, secondaryId: string): Promise<void> {
    const primaryNode = await this.store.getNode(primaryId);
    const secondaryNode = await this.store.getNode(secondaryId);

    if (!primaryNode) throw new Error(`Primary KG node not found: ${primaryId}`);
    if (!secondaryNode) throw new Error(`Secondary KG node not found: ${secondaryId}`);

    // Merge scalar properties: most-recent-wins by lastConfirmedAt; primary wins on tie.
    const primaryUpdatedAt = primaryNode.temporal.lastConfirmedAt.getTime();
    const secondaryUpdatedAt = secondaryNode.temporal.lastConfirmedAt.getTime();

    const mergedProperties: Record<string, unknown> = { ...primaryNode.properties };

    if (secondaryUpdatedAt > primaryUpdatedAt) {
      // Secondary is more recent — its non-null properties override primary
      for (const [key, val] of Object.entries(secondaryNode.properties)) {
        if (val !== null && val !== undefined) {
          mergedProperties[key] = val;
        }
      }
    } else {
      // Primary wins — fill in only missing properties from secondary
      for (const [key, val] of Object.entries(secondaryNode.properties)) {
        if (val !== null && val !== undefined && !(key in mergedProperties)) {
          mergedProperties[key] = val;
        }
      }
    }

    // Update primary node with the merged property set
    await this.store.updateNode(primaryId, { properties: mergedProperties });

    // Move facts: fetch secondary's facts and re-store them on primary.
    // getFacts() is more efficient than query() here — it returns only fact nodes
    // without resolving relationship edges, which we don't need for the merge.
    // storeFact() will handle deduplication — near-duplicate facts will merge
    // rather than create duplicates.
    const secondaryFacts = await this.getFacts(secondaryId);
    for (const factNode of secondaryFacts) {
      // Fact content lives in the node label; extra attributes may be in properties.
      // We propagate the original source and sensitivity so provenance is preserved.
      await this.storeFact({
        entityNodeId: primaryId,
        label: factNode.label,
        properties: factNode.properties,
        confidence: factNode.temporal.confidence,
        decayClass: factNode.temporal.decayClass,
        source: factNode.temporal.source,
        // Carry the original sensitivity — don't re-classify on merge since the node's
        // content hasn't changed.
        sensitivity: factNode.sensitivity,
      });
    }

    // Phase 2: Re-point secondary's entity relationship edges to primary.
    // We iterate all edges on secondary and upsert equivalent edges on primary.
    // upsertEdge handles the bidirectional uniqueness constraint atomically —
    // if primary already has the same edge, confidence is raised rather than
    // creating a duplicate. Edges to fact nodes are skipped — facts were
    // already re-stored on primary in Phase 1 via storeFact().
    const secondaryEdges = await this.store.getEdgesForNode(secondaryId);
    const secondaryFactNodeIds: string[] = [];

    for (const edge of secondaryEdges) {
      const isOutbound = edge.sourceNodeId === secondaryId;
      const otherId = isOutbound ? edge.targetNodeId : edge.sourceNodeId;

      // Self-loop guard (should not exist, but be defensive)
      if (otherId === secondaryId) continue;
      // Skip edges pointing to primary — would become self-loops after merge
      if (otherId === primaryId) continue;

      const otherNode = await this.store.getNode(otherId);
      if (!otherNode) continue;

      if (otherNode.type === FACT_TYPE) {
        // Collect secondary fact node IDs for cleanup after edge transfer.
        // These were re-stored on primary in Phase 1; deleting them here
        // prevents orphaned fact nodes after the secondary entity is removed.
        secondaryFactNodeIds.push(otherId);
        continue;
      }

      // Transfer the relationship edge to primary
      await this.store.upsertEdge({
        sourceNodeId: isOutbound ? primaryId : otherId,
        targetNodeId: isOutbound ? otherId : primaryId,
        type: edge.type,
        properties: edge.properties,
        confidence: edge.temporal.confidence,
        decayClass: edge.temporal.decayClass,
        source: edge.temporal.source,
      });
    }

    // Delete secondary's fact nodes (already re-created on primary in Phase 1).
    // Must happen before deleteNode so cascade doesn't beat us to it.
    for (const factNodeId of secondaryFactNodeIds) {
      await this.store.deleteNode(factNodeId);
    }

    // Delete the secondary entity node. ON DELETE CASCADE on kg_edges removes
    // any remaining edges (e.g. self-loops or edges not transferred above).
    await this.store.deleteNode(secondaryId);
  }

  /**
   * Idempotent edge creation between two entity nodes.
   *
   * Delegates to KnowledgeGraphStore.upsertEdge() which handles the atomic
   * ON CONFLICT DO UPDATE at the database level. This is race-condition-safe —
   * concurrent calls will not create duplicate edges.
   *
   * The store performs a bidirectional duplicate check (LEAST/GREATEST on node IDs),
   * raises confidence on re-assertion (never lowers it), and refreshes lastConfirmedAt.
   *
   * Returns the edge and whether it was newly created.
   */
  async upsertEdge(
    sourceId: string,
    targetId: string,
    edgeType: EdgeType,
    properties: Record<string, unknown>,
    source: string,
    confidence: number,
  ): Promise<{ edge: KgEdge; created: boolean }> {
    return this.store.upsertEdge({
      sourceNodeId: sourceId,
      targetNodeId: targetId,
      type: edgeType,
      properties,
      confidence,
      source,
    });
  }

  /**
   * Reset rate limit counters for a given agent+task key.
   * Delegates to the validator so the runtime doesn't need a direct validator reference.
   *
   * Should be called by AgentRuntime after a task completes (success or error) to
   * prevent unbounded growth of the validator's writeCounts map. Without this,
   * each task's source key accumulates indefinitely in a long-running process.
   */
  resetRateLimit(agentTaskKey: string): void {
    this.validator.resetRateLimit(agentTaskKey);
  }

  /**
   * Semantic search across all nodes in the knowledge graph.
   * Embeds the query string and finds the most similar nodes by cosine similarity.
   *
   * Returns SearchResult[] sorted by score descending (most similar first).
   */
  async search(query: string, options?: { limit?: number }): Promise<SearchResult[]> {
    return this.store.semanticSearch(query, options);
  }

  /**
   * "What do I know about X?" — the primary compound query for agents.
   *
   * Returns:
   * - entity: the node itself
   * - facts: all fact nodes linked to the entity
   * - relationships: all non-fact nodes linked to the entity, each paired with
   *   the connecting edge so the caller knows the relationship type and direction
   *
   * Throws if the entity node does not exist, since querying a non-existent entity
   * is almost certainly a caller bug.
   */
  async query(entityNodeId: string): Promise<QueryResult> {
    const entity = await this.store.getNode(entityNodeId);
    if (!entity) {
      throw new Error(`Entity not found: ${entityNodeId}`);
    }

    const edges = await this.store.getEdgesForNode(entityNodeId);
    const facts: KgNode[] = [];
    const relationships: Array<{ edge: KgEdge; node: KgNode }> = [];

    for (const edge of edges) {
      const otherId = edge.sourceNodeId === entityNodeId
        ? edge.targetNodeId
        : edge.sourceNodeId;

      const node = await this.store.getNode(otherId);
      if (!node) {
        // Dangling edge — referenced node no longer exists (referential integrity violation).
        // @TODO: emit a bus event for the audit logger once bus access is available here.
        this.logger.error(
          { edgeId: edge.id, nodeId: otherId, entityNodeId },
          'query: dangling edge detected — referenced node does not exist',
        );
        continue;
      }

      if (node.type === FACT_TYPE) {
        // Fact nodes belong in the facts bucket
        facts.push(node);
      } else {
        // Non-fact nodes (other entities) are direct relationships
        relationships.push({ edge, node });
      }
    }

    return { entity, facts, relationships };
  }
}
