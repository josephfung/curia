import type { DbPool } from '../db/connection.js';
import type { Logger } from '../logger.js';
import type {
  KgNode,
  KgEdge,
  NodeType,
  EdgeType,
  DecayClass,
  Sensitivity,
  IdentitySource,
  SearchResult,
  TraversalResult,
} from './types.js';
import { createNodeId, createEdgeId, SENSITIVITY_LEVELS } from './types.js';
import { EmbeddingService } from './embedding.js';
import { embeddingStamp, type EmbeddingPurpose } from './embedding-profiles.js';

/** Longest withAdvisoryLock() waits for another holder before failing (Postgres interval). */
const ADVISORY_LOCK_TIMEOUT = '10s';

// -- Public option interfaces --

export interface CreateNodeOptions {
  type: NodeType;
  label: string;
  properties: Record<string, unknown>;
  confidence?: number;    // defaults to 0.7
  decayClass?: DecayClass; // defaults to 'slow_decay'
  source: string;
  /** Pre-computed embedding; when provided, skips the embed API call.
   *  Used by EntityMemory.storeFact() to avoid double-embedding — the validator
   *  already embedded the label during dedup checks. */
  embedding?: number[];
  /** Sensitivity classification assigned at creation (#200). EntityMemory resolves
   *  this via SensitivityClassifier before calling createNode, so this should always
   *  be set. Defaults to 'internal' if somehow omitted. */
  sensitivity?: Sensitivity;
  /** Identity tier (ADR-040). Defaults to 'label'. Pass 'contact' only when minting a
   *  node that backs a specific contact — those are exempt from label uniqueness, so
   *  createNode cannot fall back on ON CONFLICT to deduplicate them.
   *  upsertNode ignores this field: it is the label-keyed path, exclusively. */
  identitySource?: IdentitySource;
}

export interface CreateEdgeOptions {
  sourceNodeId: string;
  targetNodeId: string;
  type: EdgeType;
  properties: Record<string, unknown>;
  confidence?: number;
  decayClass?: DecayClass;
  source: string;
}

export interface TraversalOptions {
  maxDepth?: number; // defaults to 3 per spec
}

/** What a backend semantic search may return. Any filter besides `embeddingModel` must be
 *  applied before the result is limited, never to an already-limited candidate list (#2248). */
export interface SemanticSearchFilters {
  embeddingModel: string;
  type?: NodeType;
  /** Leave fact nodes out, so the limit counts entities only (fuzzy entity resolution). */
  entitiesOnly?: boolean;
  maxSensitivity?: Sensitivity;
}

/** An entity a fact node is attached to (#2502): the non-fact node at the other end of one
 *  of the fact's live edges. */
export interface FactOwner {
  id: string;
  type: NodeType;
  label: string;
}

/** The owners of one fact, as getFactOwners reports them. A fact with no live non-fact
 *  neighbour has no entry at all, which is how a caller tells it is unattached. */
export interface FactOwnership {
  /** Owners at or below the sensitivity ceiling, at most `perFactLimit` of them. Owners on
   *  an entity → fact edge (the direction storeFact writes) come first, then by label. */
  owners: FactOwner[];
  /** Owners at or below the ceiling in total, including any past `perFactLimit`. */
  visibleCount: number;
  /** Owners above the ceiling. Counted so the fact is not mistaken for unattached, but never
   *  named: the caller asked not to see nodes at that level. */
  withheldCount: number;
}

export interface FactOwnerOptions {
  /** Most owners to return per fact (the counts still cover all of them). */
  perFactLimit: number;
  /** Same ceiling as semanticSearch: owners above it are withheld, not named. */
  maxSensitivity?: Sensitivity;
}

/** Returned by listDecayWarnings — one entry per warned node. */
export interface DecayWarningRow {
  nodeId: string;
  nodeType: NodeType;
  label: string;
  confidence: number;
  sensitivity: Sensitivity;
  edgeCount: number;
  reason: 'high_sensitivity' | 'high_connectivity' | 'both';
  warnedAt: Date;
}

/** Returned by confirmDecayWarning and dismissDecayWarning. */
export interface DecayWarningActionResult {
  success: boolean;
  /** The node's label, included so the skill can confirm back to the coordinator. */
  label?: string;
}

// -- Internal backend interface --

interface KnowledgeGraphBackend {
  createNode(node: KgNode): Promise<void>;
  getNode(id: string): Promise<KgNode | undefined>;
  updateNode(id: string, node: KgNode): Promise<void>;
  deleteNode(id: string): Promise<void>;
  /** Soft-delete a node by setting archived_at = now(). Used by DreamEngine. */
  archiveNode(id: string): Promise<void>;
  /** Soft-delete an edge by setting archived_at = now(). Used by DreamEngine. */
  archiveEdge(id: string): Promise<void>;
  findNodesByType(type: NodeType): Promise<KgNode[]>;
  findNodesByLabel(label: string): Promise<KgNode[]>;
  /** Atomically append an alias to a node's aliases array.
   *  Returns true if the alias was appended, false if skipped
   *  (already present, cap reached, or node not found). */
  addAlias(nodeId: string, alias: string): Promise<boolean>;
  createEdge(edge: KgEdge): Promise<void>;
  getEdgesForNode(nodeId: string): Promise<KgEdge[]>;
  /**
   * Fact nodes connected to `nodeId` by a non-archived edge (either direction).
   * One round trip on Postgres (JOIN); used by exact-key upsert and getFacts
   * so large config anchors do not issue N getNode queries (#2252).
   */
  getConnectedFacts(nodeId: string): Promise<KgNode[]>;
  /**
   * Connected facts that can match an exact-key lookup: `properties.key` equals
   * `key`, or (legacy) no `properties.key` and `label` equals `key`. Narrows in
   * the database so unrelated facts and their embeddings are never loaded.
   */
  getConnectedFactsByKey(nodeId: string, key: string): Promise<KgNode[]>;
  /**
   * Owners of each fact in `factIds` (#2502): live non-fact nodes joined to the fact by a
   * live edge of any type, in either direction. One round trip on Postgres. `allowedLevels`
   * is the sensitivity set an owner must be in to be named; undefined means any.
   */
  getFactOwners(
    factIds: string[],
    perFactLimit: number,
    allowedLevels: readonly string[] | undefined,
  ): Promise<Map<string, FactOwnership>>;
  /**
   * Run `fn` while holding a database-wide mutex named `lockKey`, so callers in
   * other processes serialize on the same name. `fn` may use any connection.
   */
  withAdvisoryLock<T>(lockKey: string, fn: () => Promise<T>): Promise<T>;
  deleteEdge(id: string): Promise<void>;
  updateEdge(id: string, updates: { confidence: number; lastConfirmedAt: Date }): Promise<KgEdge>;
  // Atomic upsert: creates if no matching (src, tgt, type) pair exists in either
  // direction; otherwise raises confidence and refreshes lastConfirmedAt.
  upsertEdge(edge: KgEdge): Promise<{ edge: KgEdge; created: boolean }>;
  // Idempotent node creation: matches on lower(label) + type for non-fact,
  // label-tier nodes. fact nodes always insert as new regardless of label collision,
  // and contact-anchored nodes are never matched (ADR-040 invariant 1).
  upsertNode(node: KgNode): Promise<{ node: KgNode; created: boolean }>;
  /** Promote a label-tier node to contact-anchored (ADR-040). Compare-and-set: returns
   *  false if the node is missing, archived, or already anchored to some contact, which
   *  is what makes concurrent adoption safe without a transaction. */
  anchorNode(id: string): Promise<boolean>;
  traverse(startNodeId: string, maxDepth: number): Promise<TraversalResult>;
  semanticSearch(
    queryEmbedding: number[],
    limit: number,
    // embeddingModel is required: a vector from another model must never be ranked
    // against this query, even while a re-embed has left the table mixed.
    filters: SemanticSearchFilters,
  ): Promise<SearchResult[]>;
  /** List all warned (warned_at IS NOT NULL), non-archived, LABEL-TIER nodes, oldest-first.
   *  Contact-anchored nodes are excluded: they cannot decay, so a "confirm this or lose it"
   *  prompt for one is a question the system will never act on (ADR-040). */
  listDecayWarnings(): Promise<DecayWarningRow[]>;
  /** Confirm a warned node: reset last_confirmed_at = NOW(), confidence = 1.0, warned_at = NULL.
   *  Returns success: false if the node is not in a warned state. */
  confirmDecayWarning(nodeId: string): Promise<DecayWarningActionResult>;
  /** Dismiss a warned node: set archived_at = NOW(), warned_at = NULL.
   *  Returns success: false if the node is not in a warned state. */
  dismissDecayWarning(nodeId: string): Promise<DecayWarningActionResult>;
}

/**
 * Knowledge graph store for Tier 3 memory.
 * Stores entities (nodes) and relationships (edges) with temporal metadata
 * and vector embeddings for semantic search.
 *
 * Follows the same backend-interface pattern as WorkingMemory:
 * private constructor, static factory methods, in-memory backend for testing,
 * Postgres backend for production.
 */
export class KnowledgeGraphStore {
  private backend: KnowledgeGraphBackend;
  private embeddingService: EmbeddingService;

  private constructor(backend: KnowledgeGraphBackend, embeddingService: EmbeddingService) {
    this.backend = backend;
    this.embeddingService = embeddingService;
  }

  /** Create a Postgres-backed instance for production use */
  static createWithPostgres(
    pool: DbPool,
    embeddingService: EmbeddingService,
    logger: Logger,
  ): KnowledgeGraphStore {
    return new KnowledgeGraphStore(
      new PostgresBackend(pool, logger),
      embeddingService,
    );
  }

  /** Create an in-memory instance for testing */
  static createInMemory(embeddingService: EmbeddingService): KnowledgeGraphStore {
    return new KnowledgeGraphStore(
      new InMemoryBackend(),
      embeddingService,
    );
  }

  /**
   * Create a new node in the knowledge graph.
   * Generates an embedding from the label for semantic search.
   */
  async createNode(options: CreateNodeOptions): Promise<KgNode> {
    const now = new Date();
    // Use pre-computed embedding if provided (avoids redundant API call when
    // the validator already embedded the label during dedup checks).
    const embedding = options.embedding ?? await this.embeddingService.embed(options.label, 'document');

    const node: KgNode = {
      id: createNodeId(),
      type: options.type,
      label: options.label,
      properties: { ...options.properties },
      embedding,
      embeddingModel: embeddingStamp(this.embeddingService.profile),
      temporal: {
        createdAt: now,
        lastConfirmedAt: now,
        confidence: options.confidence ?? 0.7,
        decayClass: options.decayClass ?? 'slow_decay',
        source: options.source,
      },
      sensitivity: options.sensitivity ?? 'internal',
      aliases: [],
      identitySource: options.identitySource ?? 'label',
    };

    await this.backend.createNode(node);
    return node;
  }

  /**
   * Promote a label-tier node to contact-anchored (ADR-040 adoption).
   *
   * Compare-and-set on identity_source, so two contacts racing to adopt the same
   * unanchored node cannot both win: the loser gets false and mints its own node
   * rather than silently sharing an identity.
   *
   * Returns false when the node does not exist, is archived, or is already anchored.
   */
  async anchorNode(id: string): Promise<boolean> {
    return this.backend.anchorNode(id);
  }

  /**
   * Idempotent node creation for non-fact entity nodes.
   *
   * Creates a new node if none with the same (lower(label), type) exists.
   * If one exists, raises its confidence (never lowers) and refreshes
   * lastConfirmedAt. Properties, label, and embedding of the existing node
   * are left untouched — use updateNode() to change those explicitly.
   *
   * fact nodes always create a new node regardless of label collision.
   *
   * ADR-040 invariant 1: this is the label-keyed path, exclusively. It only ever inserts
   * identity_source = 'label' rows and its ON CONFLICT predicate matches the narrowed
   * idx_kg_nodes_unique, so no caller can accidentally upsert its way onto a node that
   * already belongs to a contact. Anchored nodes are minted through createNode().
   *
   * Returns the persisted node and whether it was newly created.
   */
  async upsertNode(options: CreateNodeOptions & { confidence: number }): Promise<{ node: KgNode; created: boolean }> {
    const now = new Date();
    const embedding = options.embedding ?? await this.embeddingService.embed(options.label, 'document');

    const node: KgNode = {
      id: createNodeId(),
      type: options.type,
      label: options.label,
      properties: { ...options.properties },
      embedding,
      embeddingModel: embeddingStamp(this.embeddingService.profile),
      temporal: {
        createdAt: now,
        lastConfirmedAt: now,
        confidence: options.confidence,
        decayClass: options.decayClass ?? 'slow_decay',
        source: options.source,
      },
      sensitivity: options.sensitivity ?? 'internal',
      aliases: [],
      // Not options.identitySource — see the invariant above. upsertNode is label-tier only.
      identitySource: 'label',
    };

    return this.backend.upsertNode(node);
  }

  /** Retrieve a node by ID, or undefined if not found */
  async getNode(id: string): Promise<KgNode | undefined> {
    return this.backend.getNode(id);
  }

  /**
   * Fact nodes linked to an entity (either edge direction). Single JOIN on
   * Postgres — prefer this over getEdges + N× getNode for large anchors (#2252).
   */
  async getConnectedFacts(nodeId: string): Promise<KgNode[]> {
    return this.backend.getConnectedFacts(nodeId);
  }

  /**
   * Connected facts whose `properties.key` equals `key`, plus legacy facts with
   * no `properties.key` whose label equals it. Exact-key upserts use this so a
   * large config anchor does not load every fact (and embedding) per write.
   */
  async getConnectedFactsByKey(nodeId: string, key: string): Promise<KgNode[]> {
    return this.backend.getConnectedFactsByKey(nodeId, key);
  }

  /**
   * The entities each fact is attached to (#2502), for search results that would otherwise
   * read as belonging to whoever the query named. Facts with no owner are absent from the
   * map. One query for the whole batch, never one per fact.
   */
  async getFactOwners(factIds: string[], options: FactOwnerOptions): Promise<Map<string, FactOwnership>> {
    if (factIds.length === 0) return new Map();
    let allowedLevels: readonly string[] | undefined;
    if (options.maxSensitivity !== undefined) {
      const maxRank = SENSITIVITY_LEVELS.indexOf(options.maxSensitivity);
      // Same as semanticSearch: an unknown ceiling is a caller bug, not "show nothing".
      if (maxRank === -1) {
        throw new Error(`getFactOwners: unknown maxSensitivity value "${options.maxSensitivity}"`);
      }
      allowedLevels = SENSITIVITY_LEVELS.slice(0, maxRank + 1);
    }
    return this.backend.getFactOwners(factIds, Math.max(1, Math.floor(options.perFactLimit)), allowedLevels);
  }

  /**
   * Run `fn` under a database-wide mutex named `lockKey` (a transaction-scoped
   * Postgres advisory lock), so a check-then-create in `fn` is safe against the
   * same call in another process. Locks are never nested; hold one only briefly.
   */
  async withAdvisoryLock<T>(lockKey: string, fn: () => Promise<T>): Promise<T> {
    return this.backend.withAdvisoryLock(lockKey, fn);
  }

  /**
   * Update a node's label and/or properties.
   * Always refreshes lastConfirmedAt. Re-embeds if the label changed.
   */
  async updateNode(
    id: string,
    updates: {
      label?: string;
      properties?: Record<string, unknown>;
      sensitivity?: Sensitivity;
      confidence?: number; // allows auto_resolved to raise stored confidence
      /** Replaces the full aliases array when provided (e.g. after alias learning). */
      aliases?: string[];
    },
  ): Promise<KgNode> {
    const existing = await this.backend.getNode(id);
    if (!existing) {
      throw new Error(`Node not found: ${id}`);
    }

    const labelChanged = updates.label !== undefined && updates.label !== existing.label;

    const updated: KgNode = {
      ...existing,
      label: updates.label ?? existing.label,
      properties: updates.properties ?? existing.properties,
      sensitivity: updates.sensitivity ?? existing.sensitivity,
      aliases: updates.aliases ?? existing.aliases,
      // Re-embed if the label changed, otherwise keep existing embedding
      embedding: labelChanged
        ? await this.embeddingService.embed(updates.label!, 'document')
        : existing.embedding,
      embeddingModel: labelChanged ? embeddingStamp(this.embeddingService.profile) : existing.embeddingModel,
      temporal: {
        ...existing.temporal,
        lastConfirmedAt: new Date(),
        confidence: updates.confidence ?? existing.temporal.confidence,
      },
    };

    await this.backend.updateNode(id, updated);
    return updated;
  }

  /**
   * Delete a node and all its edges.
   * In-memory backend cascades explicitly; Postgres uses ON DELETE CASCADE.
   */
  async deleteNode(id: string): Promise<void> {
    await this.backend.deleteNode(id);
  }

  /** Soft-delete a node — sets archived_at, does not remove the row. */
  async archiveNode(id: string): Promise<void> {
    return this.backend.archiveNode(id);
  }

  /** Soft-delete an edge — sets archived_at, does not remove the row. */
  async archiveEdge(id: string): Promise<void> {
    return this.backend.archiveEdge(id);
  }

  /** Find all nodes of a given type */
  async findNodesByType(type: NodeType): Promise<KgNode[]> {
    return this.backend.findNodesByType(type);
  }

  /** Find nodes by label (case-insensitive exact match) */
  async findNodesByLabel(label: string): Promise<KgNode[]> {
    return this.backend.findNodesByLabel(label);
  }

  /** Atomically append an alias — see KnowledgeGraphBackend.addAlias for semantics. */
  async addAlias(nodeId: string, alias: string): Promise<boolean> {
    return this.backend.addAlias(nodeId, alias);
  }

  /** Create an edge between two nodes */
  async createEdge(options: CreateEdgeOptions): Promise<KgEdge> {
    const now = new Date();

    const edge: KgEdge = {
      id: createEdgeId(),
      sourceNodeId: options.sourceNodeId,
      targetNodeId: options.targetNodeId,
      type: options.type,
      properties: { ...options.properties },
      temporal: {
        createdAt: now,
        lastConfirmedAt: now,
        confidence: options.confidence ?? 0.7,
        decayClass: options.decayClass ?? 'slow_decay',
        source: options.source,
      },
    };

    await this.backend.createEdge(edge);
    return edge;
  }

  /** Get all edges where the node is either source or target */
  async getEdgesForNode(nodeId: string): Promise<KgEdge[]> {
    return this.backend.getEdgesForNode(nodeId);
  }

  /** Delete an edge by ID */
  async deleteEdge(id: string): Promise<void> {
    await this.backend.deleteEdge(id);
  }

  /** Update an edge's confidence and lastConfirmedAt. Used by upsertEdge for idempotency. */
  async updateEdge(id: string, updates: { confidence: number; lastConfirmedAt: Date }): Promise<KgEdge> {
    return this.backend.updateEdge(id, updates);
  }

  /**
   * Atomic idempotent edge creation.
   * Creates a new edge if none of the same type connects the same node pair
   * (in either direction). If one exists, raises its confidence and refreshes
   * lastConfirmedAt. Never lowers confidence.
   */
  async upsertEdge(options: CreateEdgeOptions & { confidence: number }): Promise<{ edge: KgEdge; created: boolean }> {
    const now = new Date();
    const edge: KgEdge = {
      id: createEdgeId(),
      sourceNodeId: options.sourceNodeId,
      targetNodeId: options.targetNodeId,
      type: options.type,
      properties: { ...options.properties },
      temporal: {
        createdAt: now,
        lastConfirmedAt: now,
        confidence: options.confidence,
        decayClass: options.decayClass ?? 'slow_decay',
        source: options.source,
      },
    };
    return this.backend.upsertEdge(edge);
  }

  /**
   * BFS traversal from a start node, depth-limited and cycle-safe.
   * Returns all reachable nodes within the depth limit and the edges between them.
   */
  async traverse(startNodeId: string, options?: TraversalOptions): Promise<TraversalResult> {
    const maxDepth = options?.maxDepth ?? 3;
    return this.backend.traverse(startNodeId, maxDepth);
  }

  /**
   * Semantic search: embed the query, then find the most similar nodes.
   * Returns results sorted by similarity (highest first).
   *
   * `purpose` is 'query' for a question against stored labels, and 'similarity' when the
   * text is itself a label being matched against stored labels (fuzzy entity resolution).
   * `entitiesOnly` leaves fact nodes out before the limit applies.
   */
  async semanticSearch(
    query: string,
    options?: {
      limit?: number;
      type?: NodeType;
      entitiesOnly?: boolean;
      maxSensitivity?: Sensitivity;
      purpose?: Exclude<EmbeddingPurpose, 'document'>;
    },
  ): Promise<SearchResult[]> {
    const limit = options?.limit ?? 10;
    const queryEmbedding = await this.embeddingService.embed(query, options?.purpose ?? 'query');
    return this.backend.semanticSearch(queryEmbedding, limit, {
      embeddingModel: embeddingStamp(this.embeddingService.profile),
      type: options?.type,
      entitiesOnly: options?.entitiesOnly,
      maxSensitivity: options?.maxSensitivity,
    });
  }

  /** List all warned (warned_at IS NOT NULL), non-archived nodes for the principal re-confirmation flow. */
  async listDecayWarnings(): Promise<DecayWarningRow[]> {
    return this.backend.listDecayWarnings();
  }

  /** Confirm a warned node: reset decay clock (last_confirmed_at = NOW(), confidence = 1.0), clear warned_at. */
  async confirmDecayWarning(nodeId: string): Promise<DecayWarningActionResult> {
    return this.backend.confirmDecayWarning(nodeId);
  }

  /** Dismiss a warned node: archive it immediately, clear warned_at. */
  async dismissDecayWarning(nodeId: string): Promise<DecayWarningActionResult> {
    return this.backend.dismissDecayWarning(nodeId);
  }
}

// -- Postgres backend --

/**
 * Postgres-backed storage using pgvector for semantic search
 * and recursive CTEs for graph traversal.
 */
class PostgresBackend implements KnowledgeGraphBackend {
  constructor(private pool: DbPool, private logger: Logger) {}

  async createNode(node: KgNode): Promise<void> {
    this.logger.debug({ nodeId: node.id, type: node.type, sensitivity: node.sensitivity }, 'kg: creating node');
    const embeddingStr = node.embedding ? `[${node.embedding.join(',')}]` : null;
    await this.pool.query(
      `INSERT INTO kg_nodes (id, type, label, properties, embedding, confidence, decay_class, source, created_at, last_confirmed_at, sensitivity, aliases, identity_source, embedding_model)
       VALUES ($1, $2, $3, $4, $5::vector, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        node.id,
        node.type,
        node.label,
        JSON.stringify(node.properties),
        embeddingStr,
        node.temporal.confidence,
        node.temporal.decayClass,
        node.temporal.source,
        node.temporal.createdAt,
        node.temporal.lastConfirmedAt,
        node.sensitivity,
        node.aliases,
        node.identitySource,
        embeddingModelFor(node),
      ],
    );
  }

  async anchorNode(id: string): Promise<boolean> {
    // Compare-and-set: the identity_source = 'label' predicate is the whole point —
    // it makes losing an adoption race observable (rowCount 0) instead of letting two
    // contacts quietly share one identity.
    //
    // Clearing warned_at is the same reasoning as migration 085 step 2b: a node adopted
    // while a decay warning was pending is a node we have just promised to keep, so the
    // "confirm this or lose it" prompt is void. Leaving it set would strand the node in a
    // permanently warned state now that Pass 2a skips anchored rows.
    const result = await this.pool.query(
      `UPDATE kg_nodes
          SET identity_source = 'contact',
              warned_at = NULL,
              warn_reason = NULL
        WHERE id = $1
          AND archived_at IS NULL
          AND identity_source = 'label'`,
      [id],
    );
    const anchored = (result.rowCount ?? 0) > 0;
    this.logger.debug({ nodeId: id, anchored }, 'kg: anchorNode');
    return anchored;
  }

  async upsertNode(node: KgNode): Promise<{ node: KgNode; created: boolean }> {
    this.logger.debug({ type: node.type, label: node.label }, 'kg: upserting node');
    const embeddingStr = node.embedding ? `[${node.embedding.join(',')}]` : null;
    const result = await this.pool.query<PgNodeRow & { is_new: boolean }>(
      // identity_source is hardcoded 'label' rather than parameterised: the ON CONFLICT
      // predicate below must match the narrowed idx_kg_nodes_unique, and an anchored row
      // would not be in that index at all, so the upsert would silently always insert.
      `INSERT INTO kg_nodes (id, type, label, properties, embedding, confidence, decay_class, source, created_at, last_confirmed_at, sensitivity, aliases, identity_source, embedding_model)
       VALUES ($1, $2, $3, $4, $5::vector, $6, $7, $8, $9, $9, $10, $11, 'label', $12)
       ON CONFLICT (lower(label), type) WHERE type != 'fact' AND archived_at IS NULL AND identity_source = 'label'
       DO UPDATE SET
         confidence = GREATEST(kg_nodes.confidence, EXCLUDED.confidence),
         last_confirmed_at = EXCLUDED.last_confirmed_at
       RETURNING *, (xmax = 0) AS is_new`,
      [
        node.id,
        node.type,
        node.label,
        JSON.stringify(node.properties),
        embeddingStr,
        node.temporal.confidence,
        node.temporal.decayClass,
        node.temporal.source,
        node.temporal.createdAt,
        node.sensitivity,
        node.aliases,
        embeddingModelFor(node),
      ],
    );
    const row = result.rows[0];
    if (!row) {
      this.logger.error(
        { type: node.type, label: node.label },
        'kg: upsertNode — RETURNING produced no row; possible trigger or RLS suppression',
      );
      throw new Error('upsertNode: database returned no row after INSERT ... ON CONFLICT');
    }
    return { node: pgRowToNode(row), created: row.is_new };
  }

  async getNode(id: string): Promise<KgNode | undefined> {
    const result = await this.pool.query<PgNodeRow>(
      'SELECT * FROM kg_nodes WHERE id = $1 AND archived_at IS NULL',
      [id],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return pgRowToNode(row);
  }

  async updateNode(id: string, node: KgNode): Promise<void> {
    this.logger.debug({ nodeId: id }, 'kg: updating node');
    const embeddingStr = node.embedding ? `[${node.embedding.join(',')}]` : null;
    // confidence is included so that auto_resolved paths that raise confidence
    // via KnowledgeGraphStore.updateNode() are durably persisted to the DB.
    await this.pool.query(
      `UPDATE kg_nodes
       SET label = $1, properties = $2, embedding = $3::vector, last_confirmed_at = $4, confidence = $5, sensitivity = $6, aliases = $7, embedding_model = $9
       WHERE id = $8`,
      [
        node.label,
        JSON.stringify(node.properties),
        embeddingStr,
        node.temporal.lastConfirmedAt,
        node.temporal.confidence,
        node.sensitivity,
        node.aliases,
        id,
        embeddingModelFor(node),
      ],
    );
  }

  async deleteNode(id: string): Promise<void> {
    this.logger.debug({ nodeId: id }, 'kg: deleting node');
    // Relies on ON DELETE CASCADE for kg_edges foreign keys
    await this.pool.query('DELETE FROM kg_nodes WHERE id = $1', [id]);
  }

  async archiveNode(id: string): Promise<void> {
    this.logger.debug({ nodeId: id }, 'kg: archiving node');
    await this.pool.query('UPDATE kg_nodes SET archived_at = now() WHERE id = $1', [id]);
    // Cascade: any active edge touching this node is also archived so it cannot
    // be returned by getEdgesForNode before the next DreamEngine decay pass runs.
    const edgeResult = await this.pool.query(
      'UPDATE kg_edges SET archived_at = now() WHERE (source_node_id = $1 OR target_node_id = $1) AND archived_at IS NULL',
      [id],
    );
    this.logger.debug({ nodeId: id, edgesArchived: edgeResult.rowCount ?? 0 }, 'kg: cascaded archive to incident edges');
  }

  async archiveEdge(id: string): Promise<void> {
    this.logger.debug({ edgeId: id }, 'kg: archiving edge');
    await this.pool.query('UPDATE kg_edges SET archived_at = now() WHERE id = $1', [id]);
  }

  async findNodesByType(type: NodeType): Promise<KgNode[]> {
    const result = await this.pool.query<PgNodeRow>(
      'SELECT * FROM kg_nodes WHERE type = $1 AND archived_at IS NULL',
      [type],
    );
    return result.rows.map(pgRowToNode);
  }

  async findNodesByLabel(label: string): Promise<KgNode[]> {
    // Case-insensitive match on canonical label OR any stored alias.
    // Aliases are stored pre-lowercased, so lower($1) matches directly.
    // The btree index on lower(label) handles the first condition;
    // the GIN index on aliases handles the second.
    const result = await this.pool.query<PgNodeRow>(
      `SELECT * FROM kg_nodes
       WHERE (lower(label) = lower($1) OR aliases @> ARRAY[lower($1)])
         AND archived_at IS NULL`,
      [label],
    );
    return result.rows.map(pgRowToNode);
  }

  async addAlias(nodeId: string, alias: string): Promise<boolean> {
    // Single atomic UPDATE: predicate enforces dedup and cap at the DB level.
    // No SELECT needed — rowCount tells us whether the guard passed.
    const result = await this.pool.query(
      `UPDATE kg_nodes
       SET aliases = array_append(aliases, $2)
       WHERE id = $1
         AND archived_at IS NULL
         AND NOT ($2 = ANY(aliases))
         AND cardinality(aliases) < 10`,  /* must match MAX_ALIASES_PER_ENTITY */
      [nodeId, alias],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async createEdge(edge: KgEdge): Promise<void> {
    this.logger.debug({ edgeId: edge.id, type: edge.type }, 'kg: creating edge');
    await this.pool.query(
      `INSERT INTO kg_edges (id, source_node_id, target_node_id, type, properties, confidence, decay_class, source, created_at, last_confirmed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        edge.id,
        edge.sourceNodeId,
        edge.targetNodeId,
        edge.type,
        JSON.stringify(edge.properties),
        edge.temporal.confidence,
        edge.temporal.decayClass,
        edge.temporal.source,
        edge.temporal.createdAt,
        edge.temporal.lastConfirmedAt,
      ],
    );
  }

  async getEdgesForNode(nodeId: string): Promise<KgEdge[]> {
    const result = await this.pool.query<PgEdgeRow>(
      'SELECT * FROM kg_edges WHERE (source_node_id = $1 OR target_node_id = $1) AND archived_at IS NULL',
      [nodeId],
    );
    return result.rows.map(pgRowToEdge);
  }

  async getConnectedFacts(nodeId: string): Promise<KgNode[]> {
    // Dedup via IN (UNION …) so a fact with two edge types is returned once —
    // matches InMemoryBackend. Each arm uses idx_kg_edges_source / _target.
    const result = await this.pool.query<PgNodeRow>(
      `SELECT n.*
       FROM kg_nodes n
       WHERE n.type = 'fact'
         AND n.archived_at IS NULL
         AND n.id IN (
           SELECT target_node_id FROM kg_edges
            WHERE source_node_id = $1 AND archived_at IS NULL
           UNION
           SELECT source_node_id FROM kg_edges
            WHERE target_node_id = $1 AND archived_at IS NULL
         )`,
      [nodeId],
    );
    return result.rows.map(pgRowToNode);
  }

  async getConnectedFactsByKey(nodeId: string, key: string): Promise<KgNode[]> {
    // Same connected-fact set as getConnectedFacts, narrowed to rows that can
    // match the key. Callers still apply their own exact checks (string type,
    // namespace) — this only keeps unrelated rows out of the result.
    const result = await this.pool.query<PgNodeRow>(
      `SELECT n.*
       FROM kg_nodes n
       WHERE n.type = 'fact'
         AND n.archived_at IS NULL
         AND (
           n.properties->>'key' = $2
           OR (NOT (n.properties ? 'key') AND n.label = $2)
         )
         AND n.id IN (
           SELECT target_node_id FROM kg_edges
            WHERE source_node_id = $1 AND archived_at IS NULL
           UNION
           SELECT source_node_id FROM kg_edges
            WHERE target_node_id = $1 AND archived_at IS NULL
         )`,
      [nodeId, key],
    );
    return result.rows.map(pgRowToNode);
  }

  async getFactOwners(
    factIds: string[],
    perFactLimit: number,
    allowedLevels: readonly string[] | undefined,
  ): Promise<Map<string, FactOwnership>> {
    // One round trip for the batch. `links` walks both edge directions (each arm uses
    // idx_kg_edges_target / _source) because getConnectedFacts treats either as ownership;
    // `dir` 0 marks the entity → fact direction storeFact writes, which sorts first. GROUP BY
    // folds an owner linked by two edges into one. Rows come back bounded: at most
    // perFactLimit named owners per fact, plus one withheld row that carries only the counts.
    // Only id, type and label are read, so no embedding or properties leave the database.
    const result = await this.pool.query<{
      fact_id: string;
      id: string;
      type: NodeType;
      label: string;
      visible: boolean;
      visible_count: string;
      withheld_count: string;
    }>(
      `WITH links AS (
         SELECT target_node_id AS fact_id, source_node_id AS owner_id, 0 AS dir
           FROM kg_edges
          WHERE target_node_id = ANY($1::uuid[]) AND archived_at IS NULL
         UNION ALL
         SELECT source_node_id AS fact_id, target_node_id AS owner_id, 1 AS dir
           FROM kg_edges
          WHERE source_node_id = ANY($1::uuid[]) AND archived_at IS NULL
       ),
       owners AS (
         SELECT l.fact_id, n.id, n.type, n.label, MIN(l.dir) AS dir,
                ($2::text[] IS NULL OR n.sensitivity = ANY($2::text[])) AS visible
           FROM links l
           JOIN kg_nodes n ON n.id = l.owner_id
          WHERE n.archived_at IS NULL AND n.type <> 'fact'
          GROUP BY l.fact_id, n.id, n.type, n.label, n.sensitivity
       ),
       ranked AS (
         SELECT o.*,
                COUNT(*) FILTER (WHERE o.visible) OVER (PARTITION BY o.fact_id) AS visible_count,
                COUNT(*) FILTER (WHERE NOT o.visible) OVER (PARTITION BY o.fact_id) AS withheld_count,
                ROW_NUMBER() OVER (PARTITION BY o.fact_id, o.visible ORDER BY o.dir, o.label, o.id) AS rn
           FROM owners o
       )
       SELECT fact_id, id, type, label, visible, visible_count, withheld_count
         FROM ranked
        WHERE (visible AND rn <= $3) OR (NOT visible AND rn = 1)
        ORDER BY fact_id, dir, label, id`,
      [factIds, allowedLevels ?? null, perFactLimit],
    );

    const byFact = new Map<string, FactOwnership>();
    for (const row of result.rows) {
      let entry = byFact.get(row.fact_id);
      if (!entry) {
        entry = {
          owners: [],
          visibleCount: Number(row.visible_count),
          withheldCount: Number(row.withheld_count),
        };
        byFact.set(row.fact_id, entry);
      }
      if (row.visible) entry.owners.push({ id: row.id, type: row.type, label: row.label });
    }
    return byFact;
  }

  async withAdvisoryLock<T>(lockKey: string, fn: () => Promise<T>): Promise<T> {
    // The lock lives on its own connection inside a transaction that does no work:
    // COMMIT (or ROLLBACK, or the connection dropping) releases it. `fn` runs its
    // queries on other pool connections in autocommit, so its writes are durable
    // before the lock is released and the next holder sees them.
    const client = await this.pool.connect();
    // Set when ROLLBACK fails: the connection may still be in the transaction and
    // holding the lock, so it must be destroyed, not returned to the pool.
    let discard: Error | undefined;
    try {
      await client.query('BEGIN');
      // A stuck holder surfaces as a lock_timeout error rather than a silent hang.
      // set_config(..., true) is SET LOCAL with a bind parameter.
      await client.query(`SELECT set_config('lock_timeout', $1, true)`, [ADVISORY_LOCK_TIMEOUT]);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKey]);
      const result = await fn();
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        discard = rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr));
        this.logger.error(
          { err: rollbackErr, lockKey },
          'kg: advisory lock rollback failed — discarding the connection so it cannot keep the lock',
        );
      }
      throw err;
    } finally {
      // A truthy argument makes pg destroy the client instead of pooling it.
      client.release(discard);
    }
  }

  async deleteEdge(id: string): Promise<void> {
    this.logger.debug({ edgeId: id }, 'kg: deleting edge');
    await this.pool.query('DELETE FROM kg_edges WHERE id = $1', [id]);
  }

  async upsertEdge(edge: KgEdge): Promise<{ edge: KgEdge; created: boolean }> {
    this.logger.debug({ sourceNodeId: edge.sourceNodeId, targetNodeId: edge.targetNodeId, type: edge.type }, 'kg: upserting edge');
    // ON CONFLICT uses the full expression from idx_kg_edges_unique.
    // xmax = 0 reliably detects new inserts: Postgres sets xmax to 0 on INSERT and
    // to the updating transaction XID on UPDATE, making it the canonical new-row check.
    const result = await this.pool.query<PgEdgeRow & { is_new: boolean }>(
      `INSERT INTO kg_edges
         (id, source_node_id, target_node_id, type, properties, confidence, decay_class, source, created_at, last_confirmed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
       ON CONFLICT (
         LEAST(source_node_id::text, target_node_id::text),
         GREATEST(source_node_id::text, target_node_id::text),
         type
       ) WHERE archived_at IS NULL DO UPDATE SET
         confidence = GREATEST(kg_edges.confidence, EXCLUDED.confidence),
         last_confirmed_at = EXCLUDED.last_confirmed_at
       RETURNING *, (xmax = 0) AS is_new`,
      [
        edge.id,
        edge.sourceNodeId,
        edge.targetNodeId,
        edge.type,
        JSON.stringify(edge.properties),
        edge.temporal.confidence,
        edge.temporal.decayClass,
        edge.temporal.source,
        edge.temporal.createdAt,
      ],
    );
    const row = result.rows[0];
    if (!row) {
      // INSERT ... RETURNING should always return exactly one row. If it doesn't,
      // a trigger or RLS policy may be suppressing the RETURNING clause.
      this.logger.error(
        { sourceNodeId: edge.sourceNodeId, targetNodeId: edge.targetNodeId, type: edge.type },
        'kg: upsertEdge — RETURNING produced no row; possible trigger or RLS suppression',
      );
      throw new Error('upsertEdge: database returned no row after INSERT ... ON CONFLICT');
    }
    return { edge: pgRowToEdge(row), created: row.is_new };
  }

  async updateEdge(id: string, updates: { confidence: number; lastConfirmedAt: Date }): Promise<KgEdge> {
    this.logger.debug({ edgeId: id }, 'kg: updating edge');
    // Use GREATEST so confidence is monotonically non-decreasing even if two concurrent
    // re-assertions both read the same prior value (lost-update race condition).
    const result = await this.pool.query<PgEdgeRow>(
      `UPDATE kg_edges SET confidence = GREATEST(confidence, $1), last_confirmed_at = $2 WHERE id = $3 RETURNING *`,
      [updates.confidence, updates.lastConfirmedAt, id],
    );
    const row = result.rows[0];
    if (!row) {
      this.logger.error({ edgeId: id }, 'kg: updateEdge — edge not found in database');
      throw new Error(`Edge not found: ${id}`);
    }
    return pgRowToEdge(row);
  }

  async traverse(startNodeId: string, maxDepth: number): Promise<TraversalResult> {
    // Step 1: Collect reachable nodes via recursive CTE (cycle-safe).
    // Both the edge join and the final node select filter out archived rows
    // so that archived nodes and their edges are invisible to traversal.
    const nodesResult = await this.pool.query<PgNodeRow>(
      `WITH RECURSIVE reachable AS (
        SELECT $1::uuid AS node_id, 0 AS depth, ARRAY[$1::uuid] AS visited
        UNION ALL
        SELECT
          CASE WHEN e.source_node_id = r.node_id THEN e.target_node_id ELSE e.source_node_id END,
          r.depth + 1,
          r.visited || CASE WHEN e.source_node_id = r.node_id THEN e.target_node_id ELSE e.source_node_id END
        FROM reachable r
        JOIN kg_edges e ON (e.source_node_id = r.node_id OR e.target_node_id = r.node_id)
        WHERE r.depth < $2
          AND e.archived_at IS NULL
          AND NOT (CASE WHEN e.source_node_id = r.node_id THEN e.target_node_id ELSE e.source_node_id END) = ANY(r.visited)
      )
      SELECT DISTINCT n.* FROM reachable r JOIN kg_nodes n ON n.id = r.node_id WHERE n.archived_at IS NULL`,
      [startNodeId, maxDepth],
    );

    const nodes = nodesResult.rows.map(pgRowToNode);
    const nodeIds = nodes.map(n => n.id);

    if (nodeIds.length === 0) {
      return { nodes: [], edges: [] };
    }

    // Step 2: Collect edges between reachable nodes (archived edges excluded)
    const edgesResult = await this.pool.query<PgEdgeRow>(
      `SELECT e.* FROM kg_edges e
       WHERE e.source_node_id = ANY($1::uuid[])
         AND e.target_node_id = ANY($1::uuid[])
         AND e.archived_at IS NULL`,
      [nodeIds],
    );

    const edges = edgesResult.rows.map(pgRowToEdge);
    return { nodes, edges };
  }

  async semanticSearch(
    queryEmbedding: number[],
    limit: number,
    filters: SemanticSearchFilters,
  ): Promise<SearchResult[]> {
    const embeddingStr = `[${queryEmbedding.join(',')}]`;
    const params: unknown[] = [embeddingStr, limit, filters.embeddingModel];
    const extraClauses: string[] = [];

    if (filters?.type) {
      params.push(filters.type);
      extraClauses.push(`AND type = $${params.length}`);
    }

    if (filters?.entitiesOnly) {
      extraClauses.push(`AND type <> 'fact'`);
    }

    if (filters?.maxSensitivity !== undefined) {
      // Build the allowed sensitivity set from the ordered SENSITIVITY_LEVELS array.
      // SENSITIVITY_LEVELS is ['public','internal','confidential','restricted'], so
      // slice(0, rank+1) gives all levels at or below the ceiling.
      const maxRank = SENSITIVITY_LEVELS.indexOf(filters.maxSensitivity);
      // Fail loudly rather than silently returning an empty result set.
      // An unrecognized value means the caller has a bug — returning zero rows
      // with no error would make that invisible.
      if (maxRank === -1) {
        throw new Error(`semanticSearch: unknown maxSensitivity value "${filters.maxSensitivity}"`);
      }
      const allowedLevels = SENSITIVITY_LEVELS.slice(0, maxRank + 1) as string[];
      params.push(allowedLevels);
      extraClauses.push(`AND sensitivity = ANY($${params.length}::text[])`);
    }

    // Unfiltered: order by the distance operator, so the planner can use the HNSW index
    // (idx_kg_nodes_embedding). This is the plain memory-query path and must stay fast.
    //
    // Filtered: an exact scan. The HNSW index covers every node and hands back only its
    // hnsw.ef_search (40) nearest before the WHERE clause runs, so when 40 nodes that fail the
    // filter sit closer (facts that name their entity, mostly), the matching nodes never
    // arrive (#2248). Ordering by the computed similarity rather than `embedding <=> $1`
    // keeps the index out, as NodeMergeService.candidates does; the filter then runs before
    // any distance is computed. hnsw.iterative_scan and a partial index over non-fact nodes
    // were measured and rejected: both still approximate, they returned 78-82% of the true
    // top-k on clustered vectors (#2248).
    // TODO(#2248): the scan costs about 15 ms (entities only) and 27 ms (sensitivity ceiling
    // alone, which passes most rows) at 7.5k nodes, but 170 / 330 ms at 50k. Revisit
    // (halfvec storage, or iterative_scan for the permissive sensitivity-only case) before
    // graphs grow that large.
    const result = extraClauses.length === 0
      ? await this.pool.query<PgNodeRow & { similarity: number }>(
        `SELECT *, 1 - (embedding <=> $1::vector) AS similarity
         FROM kg_nodes
         WHERE embedding IS NOT NULL
           AND embedding_model = $3
           AND archived_at IS NULL
         ORDER BY embedding <=> $1::vector
         LIMIT $2`,
        params,
      )
      : await this.pool.query<PgNodeRow & { similarity: number }>(
        `SELECT * FROM (
           SELECT *, 1 - (embedding <=> $1::vector) AS similarity
           FROM kg_nodes
           WHERE embedding IS NOT NULL
             AND embedding_model = $3
             AND archived_at IS NULL
             ${extraClauses.join('\n             ')}
         ) scored
         ORDER BY similarity DESC, id
         LIMIT $2`,
        params,
      );

    return result.rows.map((row) => ({
      node: pgRowToNode(row),
      score: row.similarity,
      edges: [], // Edges are not included in basic semantic search results
    }));
  }

  async listDecayWarnings(): Promise<DecayWarningRow[]> {
    const result = await this.pool.query<{
      id: string;
      type: NodeType;
      label: string;
      confidence: number;
      sensitivity: Sensitivity;
      edge_count: string;  // pg returns bigint counts as strings
      warn_reason: 'high_sensitivity' | 'high_connectivity' | 'both';
      warned_at: Date;
    }>(
      `SELECT n.id, n.type, n.label, n.confidence, n.sensitivity,
              n.warn_reason,
              n.warned_at,
              COUNT(e.id) AS edge_count
         FROM kg_nodes n
         LEFT JOIN kg_edges e ON (e.source_node_id = n.id OR e.target_node_id = n.id)
                               AND e.archived_at IS NULL
        WHERE n.warned_at IS NOT NULL
          AND n.archived_at IS NULL
          AND n.identity_source = 'label'
        GROUP BY n.id, n.type, n.label, n.confidence, n.sensitivity,
                 n.warn_reason, n.warned_at
        ORDER BY n.warned_at ASC`,
    );
    return result.rows.map(row => ({
      nodeId: row.id,
      nodeType: row.type,
      label: row.label,
      confidence: row.confidence,
      sensitivity: row.sensitivity,
      edgeCount: parseInt(row.edge_count, 10),
      // warn_reason is always set alongside warned_at, but the column is nullable.
      // Defensive fallback prevents undefined flowing to the coordinator.
      reason: row.warn_reason ?? 'high_sensitivity',
      warnedAt: row.warned_at,
    }));
  }

  async confirmDecayWarning(nodeId: string): Promise<DecayWarningActionResult> {
    const result = await this.pool.query<{ label: string }>(
      `UPDATE kg_nodes
          SET last_confirmed_at = now(),
              confidence = 1.0,
              warned_at = NULL,
              warn_reason = NULL
        WHERE id = $1
          AND warned_at IS NOT NULL
          AND archived_at IS NULL
        RETURNING label`,
      [nodeId],
    );
    if (!result.rows[0]) return { success: false };
    return { success: true, label: result.rows[0].label };
  }

  async dismissDecayWarning(nodeId: string): Promise<DecayWarningActionResult> {
    // identity_source = 'label' matters here as much as it does in DreamEngine: this is an
    // archival path OUTSIDE the decay passes. A contact-anchored node reaching it — via a
    // warning raised before it was anchored — would be archived out from under a live
    // contact, which is precisely what ADR-040 says nothing but contact deletion may do.
    // Returns success: false rather than throwing, matching the not-warned case.
    const result = await this.pool.query<{ label: string }>(
      `UPDATE kg_nodes
          SET archived_at = now(),
              warned_at = NULL,
              warn_reason = NULL
        WHERE id = $1
          AND warned_at IS NOT NULL
          AND archived_at IS NULL
          AND identity_source = 'label'
        RETURNING label`,
      [nodeId],
    );
    if (!result.rows[0]) return { success: false };
    // Cascade: archive incident edges immediately, matching archiveNode() behaviour.
    // Without this, live edges dangle until the next DreamEngine decay pass (up to 24h).
    await this.pool.query(
      'UPDATE kg_edges SET archived_at = now() WHERE (source_node_id = $1 OR target_node_id = $1) AND archived_at IS NULL',
      [nodeId],
    );
    return { success: true, label: result.rows[0].label };
  }
}

// -- Postgres row types and converters --

interface PgNodeRow {
  id: string;
  type: string;
  label: string;
  properties: Record<string, unknown>;
  embedding: string | null;
  confidence: number;
  decay_class: string;
  source: string;
  created_at: Date;
  last_confirmed_at: Date;
  sensitivity: string;
  archived_at: Date | null;
  aliases: string[];
  identity_source: string;
  embedding_model: string | null;
}

interface PgEdgeRow {
  id: string;
  source_node_id: string;
  target_node_id: string;
  type: string;
  properties: Record<string, unknown>;
  confidence: number;
  decay_class: string;
  source: string;
  created_at: Date;
  last_confirmed_at: Date;
  archived_at: Date | null;
}

function pgRowToNode(row: PgNodeRow): KgNode {
  return {
    id: row.id,
    type: row.type as NodeType,
    label: row.label,
    properties: row.properties,
    embedding: row.embedding ? parseVector(row.embedding) : undefined,
    embeddingModel: row.embedding_model ?? undefined,
    temporal: {
      createdAt: row.created_at,
      lastConfirmedAt: row.last_confirmed_at,
      confidence: row.confidence,
      decayClass: row.decay_class as DecayClass,
      source: row.source,
    },
    sensitivity: (row.sensitivity as Sensitivity) ?? 'internal',
    aliases: row.aliases ?? [],
    // Default rather than cast-and-trust: a row read through a projection that omits the
    // column must not be mistaken for an anchored node, or callers would skip decay and
    // refuse adoption for a node that is in fact label-keyed. 'label' is the safe read.
    identitySource: row.identity_source === 'contact' ? 'contact' : 'label',
  };
}

function pgRowToEdge(row: PgEdgeRow): KgEdge {
  return {
    id: row.id,
    sourceNodeId: row.source_node_id,
    targetNodeId: row.target_node_id,
    type: row.type as EdgeType,
    properties: row.properties,
    temporal: {
      createdAt: row.created_at,
      lastConfirmedAt: row.last_confirmed_at,
      confidence: row.confidence,
      decayClass: row.decay_class as DecayClass,
      source: row.source,
    },
  };
}

/** The stamp to store beside a node's vector: none without a vector (migration 103's CHECK). */
function embeddingModelFor(node: KgNode): string | null {
  return node.embedding ? (node.embeddingModel ?? null) : null;
}

/** Parse a pgvector string like "[0.1,0.2,0.3]" into a number array */
function parseVector(vectorStr: string): number[] {
  // pgvector returns strings like "[0.1,0.2,0.3]"
  const values = vectorStr
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .split(',')
    .map(Number);

  // Guard against corrupted DB rows where a token failed to parse (e.g. empty
  // string after split, or a non-numeric character in the stored vector).
  if (values.some(Number.isNaN)) {
    throw new Error(`Malformed pgvector string: contains NaN values`);
  }

  return values;
}

// -- In-memory backend --

/**
 * In-memory storage for testing. No database required.
 * Handles cascade deletes for nodes and BFS traversal with cycle detection.
 */
class InMemoryBackend implements KnowledgeGraphBackend {
  private nodes = new Map<string, KgNode>();
  private edges = new Map<string, KgEdge>();
  // Soft-deleted IDs — rows are retained but invisible to all read paths
  private archivedNodes = new Set<string>();
  private archivedEdges = new Set<string>();
  // warned state — tracks nodeId → { warnedAt, reason } for decay warning tests
  private warnedNodes = new Map<string, { warnedAt: Date; reason: 'high_sensitivity' | 'high_connectivity' | 'both' }>();

  async createNode(node: KgNode): Promise<void> {
    this.nodes.set(node.id, node);
  }

  async upsertNode(node: KgNode): Promise<{ node: KgNode; created: boolean }> {
    // fact nodes are never deduplicated — always insert as new
    if (node.type === 'fact') {
      this.nodes.set(node.id, node);
      return { node, created: true };
    }

    const lowerLabel = node.label.toLowerCase();
    let existing: KgNode | undefined;
    for (const n of this.nodes.values()) {
      // Mirrors the partial index idx_kg_nodes_unique: archived nodes are treated as
      // non-existent, and contact-anchored nodes are outside the label-keyed tier
      // entirely, so upsert must never merge onto one (ADR-040 invariant 1).
      if (
        n.type !== 'fact'
        && n.label.toLowerCase() === lowerLabel
        && n.type === node.type
        && n.identitySource === 'label'
        && !this.archivedNodes.has(n.id)
      ) {
        existing = n;
        break;
      }
    }

    if (existing) {
      const updated: KgNode = {
        ...existing,
        temporal: {
          ...existing.temporal,
          confidence: Math.max(existing.temporal.confidence, node.temporal.confidence),
          lastConfirmedAt: node.temporal.lastConfirmedAt,
        },
      };
      this.nodes.set(existing.id, updated);
      return { node: updated, created: false };
    }

    this.nodes.set(node.id, node);
    return { node, created: true };
  }

  async getNode(id: string): Promise<KgNode | undefined> {
    if (this.archivedNodes.has(id)) return undefined;
    return this.nodes.get(id);
  }

  async updateNode(id: string, node: KgNode): Promise<void> {
    this.nodes.set(id, node);
  }

  async deleteNode(id: string): Promise<void> {
    this.nodes.delete(id);
    // Cascade: remove all edges that reference this node
    for (const [edgeId, edge] of this.edges) {
      if (edge.sourceNodeId === id || edge.targetNodeId === id) {
        this.edges.delete(edgeId);
      }
    }
  }

  async anchorNode(id: string): Promise<boolean> {
    const node = this.nodes.get(id);
    if (!node || this.archivedNodes.has(id) || node.identitySource !== 'label') return false;
    this.nodes.set(id, { ...node, identitySource: 'contact' });
    return true;
  }

  async archiveNode(id: string): Promise<void> {
    this.archivedNodes.add(id);
    // Cascade: archive all active edges touching this node so getEdgesForNode
    // cannot return dangling edges to the newly archived node.
    for (const edge of this.edges.values()) {
      if ((edge.sourceNodeId === id || edge.targetNodeId === id) && !this.archivedEdges.has(edge.id)) {
        this.archivedEdges.add(edge.id);
      }
    }
  }

  async archiveEdge(id: string): Promise<void> {
    this.archivedEdges.add(id);
  }

  async findNodesByType(type: NodeType): Promise<KgNode[]> {
    const results: KgNode[] = [];
    for (const node of this.nodes.values()) {
      if (node.type === type && !this.archivedNodes.has(node.id)) {
        results.push(node);
      }
    }
    return results;
  }

  async findNodesByLabel(label: string): Promise<KgNode[]> {
    const lowerLabel = label.toLowerCase();
    const results: KgNode[] = [];
    for (const node of this.nodes.values()) {
      if (this.archivedNodes.has(node.id)) continue;
      const labelMatch = node.label.toLowerCase() === lowerLabel;
      const aliasMatch = node.aliases.some(a => a === lowerLabel);
      if (labelMatch || aliasMatch) {
        results.push(node);
      }
    }
    return results;
  }

  async addAlias(nodeId: string, alias: string): Promise<boolean> {
    // JS is single-threaded so no true race exists, but this mirrors the
    // Postgres predicate semantics so in-memory tests are reliable proxies.
    const node = this.nodes.get(nodeId);
    if (!node || this.archivedNodes.has(nodeId)) return false;
    if (node.aliases.includes(alias)) return false;
    if (node.aliases.length >= 10) return false; // must match MAX_ALIASES_PER_ENTITY
    this.nodes.set(nodeId, { ...node, aliases: [...node.aliases, alias] });
    return true;
  }

  async createEdge(edge: KgEdge): Promise<void> {
    this.edges.set(edge.id, edge);
  }

  async upsertEdge(edge: KgEdge): Promise<{ edge: KgEdge; created: boolean }> {
    // Check for an existing *active* edge of the same type in either direction.
    // Archived edges are invisible for conflict detection — a new edge should be
    // created fresh rather than reviving a soft-deleted row.
    let existing: KgEdge | undefined;
    for (const e of this.edges.values()) {
      if (
        !this.archivedEdges.has(e.id) &&
        e.type === edge.type &&
        (
          (e.sourceNodeId === edge.sourceNodeId && e.targetNodeId === edge.targetNodeId) ||
          (e.sourceNodeId === edge.targetNodeId && e.targetNodeId === edge.sourceNodeId)
        )
      ) {
        existing = e;
        break;
      }
    }

    if (existing) {
      // Re-assertion: raise confidence (never lower), refresh lastConfirmedAt
      const updated: KgEdge = {
        ...existing,
        temporal: {
          ...existing.temporal,
          confidence: Math.max(existing.temporal.confidence, edge.temporal.confidence),
          lastConfirmedAt: edge.temporal.lastConfirmedAt,
        },
      };
      this.edges.set(existing.id, updated);
      return { edge: updated, created: false };
    }

    this.edges.set(edge.id, edge);
    return { edge, created: true };
  }

  async getEdgesForNode(nodeId: string): Promise<KgEdge[]> {
    const results: KgEdge[] = [];
    for (const edge of this.edges.values()) {
      if (
        (edge.sourceNodeId === nodeId || edge.targetNodeId === nodeId) &&
        !this.archivedEdges.has(edge.id)
      ) {
        results.push(edge);
      }
    }
    return results;
  }

  async getConnectedFacts(nodeId: string): Promise<KgNode[]> {
    const facts: KgNode[] = [];
    const seen = new Set<string>();
    for (const edge of this.edges.values()) {
      if (this.archivedEdges.has(edge.id)) continue;
      if (edge.sourceNodeId !== nodeId && edge.targetNodeId !== nodeId) continue;
      const otherId = edge.sourceNodeId === nodeId ? edge.targetNodeId : edge.sourceNodeId;
      if (seen.has(otherId) || this.archivedNodes.has(otherId)) continue;
      seen.add(otherId);
      const node = this.nodes.get(otherId);
      if (node?.type === 'fact') facts.push(node);
    }
    return facts;
  }

  async getConnectedFactsByKey(nodeId: string, key: string): Promise<KgNode[]> {
    // Mirrors the Postgres filter: `->>'key'` yields text for any JSON scalar,
    // so compare String(value) for keyed rows; legacy rows have no key at all
    // (undefined counts as absent — JSON storage drops it).
    const facts = await this.getConnectedFacts(nodeId);
    return facts.filter((f) => {
      const props = f.properties as Record<string, unknown>;
      if (props.key === undefined) return f.label === key;
      return props.key !== null && String(props.key) === key;
    });
  }

  async getFactOwners(
    factIds: string[],
    perFactLimit: number,
    allowedLevels: readonly string[] | undefined,
  ): Promise<Map<string, FactOwnership>> {
    // Mirrors the Postgres query: live edges either way, live non-fact neighbours, an
    // owner linked twice counted once, entity → fact owners first, then label, then id.
    const wanted = new Set(factIds);
    const found = new Map<string, Map<string, { node: KgNode; dir: number }>>();
    for (const edge of this.edges.values()) {
      if (this.archivedEdges.has(edge.id)) continue;
      const pairs: Array<[string, string, number]> = [];
      if (wanted.has(edge.targetNodeId)) pairs.push([edge.targetNodeId, edge.sourceNodeId, 0]);
      if (wanted.has(edge.sourceNodeId)) pairs.push([edge.sourceNodeId, edge.targetNodeId, 1]);
      for (const [factId, ownerId, dir] of pairs) {
        if (this.archivedNodes.has(ownerId)) continue;
        const node = this.nodes.get(ownerId);
        if (!node || node.type === 'fact') continue;
        let owners = found.get(factId);
        if (!owners) {
          owners = new Map();
          found.set(factId, owners);
        }
        const prior = owners.get(ownerId);
        if (!prior || dir < prior.dir) owners.set(ownerId, { node, dir });
      }
    }

    const byFact = new Map<string, FactOwnership>();
    for (const [factId, owners] of found) {
      const all = [...owners.values()].sort((a, b) =>
        a.dir - b.dir
        || (a.node.label < b.node.label ? -1 : a.node.label > b.node.label ? 1 : 0)
        || (a.node.id < b.node.id ? -1 : a.node.id > b.node.id ? 1 : 0));
      const visible = all.filter((o) => allowedLevels === undefined || allowedLevels.includes(o.node.sensitivity));
      byFact.set(factId, {
        owners: visible.slice(0, perFactLimit).map(({ node }) => ({ id: node.id, type: node.type, label: node.label })),
        visibleCount: visible.length,
        withheldCount: all.length - visible.length,
      });
    }
    return byFact;
  }

  async withAdvisoryLock<T>(_lockKey: string, fn: () => Promise<T>): Promise<T> {
    // One process owns an in-memory graph, so there is no other holder to exclude.
    return fn();
  }

  async deleteEdge(id: string): Promise<void> {
    this.edges.delete(id);
  }

  async updateEdge(id: string, updates: { confidence: number; lastConfirmedAt: Date }): Promise<KgEdge> {
    const edge = this.edges.get(id);
    if (!edge) throw new Error(`Edge not found: ${id}`);
    const updated: KgEdge = {
      ...edge,
      temporal: {
        ...edge.temporal,
        confidence: updates.confidence,
        lastConfirmedAt: updates.lastConfirmedAt,
      },
    };
    this.edges.set(id, updated);
    return updated;
  }

  /**
   * BFS traversal from startNodeId, limited to maxDepth hops.
   * Uses a visited set to prevent cycles. Archived nodes and edges are
   * invisible — traversal will not cross an archived edge or visit an archived node.
   */
  async traverse(startNodeId: string, maxDepth: number): Promise<TraversalResult> {
    const visited = new Set<string>();
    // BFS queue: each entry is [nodeId, currentDepth]
    const queue: Array<[string, number]> = [[startNodeId, 0]];
    visited.add(startNodeId);

    while (queue.length > 0) {
      const entry = queue.shift()!;
      const [currentNodeId, depth] = entry;

      // Don't explore neighbors if we're at the depth limit
      if (depth >= maxDepth) continue;

      // Find all non-archived edges connected to this node
      for (const edge of this.edges.values()) {
        // Skip archived edges — they must not contribute to traversal
        if (this.archivedEdges.has(edge.id)) continue;

        let neighborId: string | undefined;
        if (edge.sourceNodeId === currentNodeId) {
          neighborId = edge.targetNodeId;
        } else if (edge.targetNodeId === currentNodeId) {
          neighborId = edge.sourceNodeId;
        }

        // Skip archived neighbor nodes
        if (neighborId && !visited.has(neighborId) && !this.archivedNodes.has(neighborId)) {
          visited.add(neighborId);
          queue.push([neighborId, depth + 1]);
        }
      }
    }

    // Collect all visited nodes, excluding any that were archived after being visited
    const nodes: KgNode[] = [];
    for (const nodeId of visited) {
      if (this.archivedNodes.has(nodeId)) continue;
      const node = this.nodes.get(nodeId);
      if (node) {
        nodes.push(node);
      }
    }

    // Collect non-archived edges where both endpoints are in the visited set
    const edges: KgEdge[] = [];
    for (const edge of this.edges.values()) {
      if (
        !this.archivedEdges.has(edge.id) &&
        visited.has(edge.sourceNodeId) &&
        visited.has(edge.targetNodeId)
      ) {
        edges.push(edge);
      }
    }

    return { nodes, edges };
  }

  /**
   * Semantic search: compute cosine similarity between the query embedding
   * and all node embeddings, return top results sorted by similarity.
   * Archived nodes are excluded from results.
   */
  async semanticSearch(
    queryEmbedding: number[],
    limit: number,
    filters: SemanticSearchFilters,
  ): Promise<SearchResult[]> {
    const scored: SearchResult[] = [];
    // Pre-compute sensitivity ceiling rank once outside the loop.
    // Throw on an unrecognized value rather than silently returning an empty set —
    // a caller with a bad maxSensitivity bug should see an error, not ghost results.
    const maxSensitivityRank =
      filters?.maxSensitivity !== undefined
        ? SENSITIVITY_LEVELS.indexOf(filters.maxSensitivity)
        : undefined;
    if (maxSensitivityRank === -1) {
      throw new Error(`semanticSearch: unknown maxSensitivity value "${filters!.maxSensitivity}"`);
    }

    for (const node of this.nodes.values()) {
      if (!node.embedding) continue;
      if (node.embeddingModel !== filters.embeddingModel) continue;
      // Archived nodes must not appear in semantic search results
      if (this.archivedNodes.has(node.id)) continue;
      // Apply type filter
      if (filters?.type && node.type !== filters.type) continue;
      if (filters?.entitiesOnly && node.type === 'fact') continue;
      // Apply sensitivity ceiling filter.
      // Nodes with unrecognized sensitivity values are treated as fail-closed:
      // indexOf returns -1, which is never <= any valid ceiling rank, so they
      // are excluded rather than leaked through the filter.
      if (maxSensitivityRank !== undefined) {
        const nodeRank = SENSITIVITY_LEVELS.indexOf(node.sensitivity);
        if (nodeRank === -1 || nodeRank > maxSensitivityRank) continue;
      }
      const score = EmbeddingService.cosineSimilarity(queryEmbedding, node.embedding);
      scored.push({ node, score, edges: [] });
    }

    // Sort by similarity descending, then take top N
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  // @internal — for tests only. Seeds a node into the warned state, as DreamEngine would via SQL.
  _setWarnedState(nodeId: string, warnedAt: Date, reason: 'high_sensitivity' | 'high_connectivity' | 'both'): void {
    this.warnedNodes.set(nodeId, { warnedAt, reason });
  }

  async listDecayWarnings(): Promise<DecayWarningRow[]> {
    const rows: DecayWarningRow[] = [];
    for (const [nodeId, warnState] of this.warnedNodes) {
      if (this.archivedNodes.has(nodeId)) continue;
      const node = this.nodes.get(nodeId);
      if (!node) continue;
      // Mirrors the Postgres predicate: anchored nodes never decay, so they are never
      // offered for re-confirmation (ADR-040).
      if (node.identitySource !== 'label') continue;
      const edgeCount = Array.from(this.edges.values()).filter(
        e => !this.archivedEdges.has(e.id) && (e.sourceNodeId === nodeId || e.targetNodeId === nodeId),
      ).length;
      rows.push({
        nodeId,
        nodeType: node.type,
        label: node.label,
        confidence: node.temporal.confidence,
        sensitivity: node.sensitivity,
        edgeCount,
        reason: warnState.reason,
        warnedAt: warnState.warnedAt,
      });
    }
    return rows.sort((a, b) => a.warnedAt.getTime() - b.warnedAt.getTime());
  }

  async confirmDecayWarning(nodeId: string): Promise<DecayWarningActionResult> {
    if (!this.warnedNodes.has(nodeId) || this.archivedNodes.has(nodeId)) {
      return { success: false };
    }
    const node = this.nodes.get(nodeId);
    if (!node) return { success: false };
    this.warnedNodes.delete(nodeId);
    this.nodes.set(nodeId, {
      ...node,
      temporal: { ...node.temporal, lastConfirmedAt: new Date(), confidence: 1.0 },
    });
    return { success: true, label: node.label };
  }

  async dismissDecayWarning(nodeId: string): Promise<DecayWarningActionResult> {
    if (!this.warnedNodes.has(nodeId) || this.archivedNodes.has(nodeId)) {
      return { success: false };
    }
    const node = this.nodes.get(nodeId);
    if (!node) return { success: false };
    // Mirrors the Postgres predicate: dismissing archives, and nothing but contact
    // deletion may archive an anchored node (ADR-040).
    if (node.identitySource !== 'label') return { success: false };
    this.warnedNodes.delete(nodeId);
    // archiveNode handles both node and incident edge archival, keeping
    // behaviour consistent with the Postgres backend and archiveNode().
    await this.archiveNode(nodeId);
    return { success: true, label: node.label };
  }
}
