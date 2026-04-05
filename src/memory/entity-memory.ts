import type { KnowledgeGraphStore } from './knowledge-graph.js';
// EmbeddingService is part of the public constructor signature so callers don't need
// to know whether it's used directly here or delegated to the store. Currently the store
// owns all embedding calls (createNode embeds labels, semanticSearch embeds queries),
// so EntityMemory holds no direct reference. Kept in the API for forward-compatibility.
import type { EmbeddingService } from './embedding.js';
import type { MemoryValidator } from './validation.js';
import type {
  KgNode,
  KgEdge,
  NodeType,
  EdgeType,
  StoreFactOptions,
  SearchResult,
} from './types.js';

// -- Public input types --

export interface CreateEntityOptions {
  type: NodeType;
  label: string;
  properties: Record<string, unknown>;
  source: string;
}

export interface StoreFactResult {
  stored: boolean;
  /** The ID of the persisted (or existing) fact node, if stored is true. */
  nodeId?: string;
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
 */
export class EntityMemory {
  constructor(
    private store: KnowledgeGraphStore,
    private validator: MemoryValidator,
    // embeddingService is accepted to keep the constructor signature stable for callers
    // that wire the dependency graph. All embedding work is currently delegated to the
    // store (createNode embeds labels; semanticSearch embeds query strings internally).
    _embeddingService: EmbeddingService,
  ) {}

  /**
   * Create a non-fact entity node (person, org, project, etc.).
   * Facts about the entity are stored separately via storeFact().
   */
  async createEntity(options: CreateEntityOptions): Promise<KgNode> {
    return this.store.createNode({
      type: options.type,
      label: options.label,
      properties: options.properties,
      source: options.source,
    });
  }

  /** Retrieve an entity node by ID. Returns undefined if not found. */
  async getEntity(id: string): Promise<KgNode | undefined> {
    return this.store.getNode(id);
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
   * - { stored: true, nodeId } on create (new fact node + edge persisted)
   * - { stored: true, nodeId } on update (duplicate merged into existing node)
   * - { stored: false, conflict } on rate-limit rejection or contradiction
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
        // Persist the fact node, then link it to the entity with a 'relates_to' edge
        // so getFacts() can discover it. store.createNode() returns the persisted node
        // with its assigned ID, so we use that directly for the edge.
        const persistedNode = await this.store.createNode({
          type: FACT_TYPE,
          label: result.node.label,
          properties: result.node.properties,
          confidence: result.node.temporal.confidence,
          decayClass: result.node.temporal.decayClass,
          source: result.node.temporal.source,
          // Pass the pre-computed embedding from the validator's dedup check
          // to avoid a redundant OpenAI API call.
          embedding: result.node.embedding,
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
          // Attempt to clean up the orphan node; ignore errors (best effort)
          try { await this.store.deleteNode(persistedNode.id); } catch { /* best effort */ }
          throw err;
        }

        this.validator.recordWrite(options.source);
        return { stored: true, nodeId: persistedNode.id };
      }

      case 'update': {
        // Near-duplicate detected — merge properties into the existing node.
        await this.store.updateNode(result.existingNodeId, {
          properties: result.mergedProperties,
        });
        this.validator.recordWrite(options.source);
        return { stored: true, nodeId: result.existingNodeId };
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
      if (node && node.type === FACT_TYPE) {
        facts.push(node);
      }
    }

    return facts;
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
   * Phase 1 scope: scalar properties + facts. Edge re-pointing and secondary
   * node deletion are deferred to Phase 2.
   * @TODO Phase 2: re-point relationship edges from secondary to primary,
   * then delete secondary node.
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
      // We propagate the original source so provenance is preserved.
      await this.storeFact({
        entityNodeId: primaryId,
        label: factNode.label,
        properties: factNode.properties,
        confidence: factNode.temporal.confidence,
        decayClass: factNode.temporal.decayClass,
        source: factNode.temporal.source,
      });
    }
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
      if (!node) continue;

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
