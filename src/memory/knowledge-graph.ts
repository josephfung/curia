import type { DbPool } from '../db/connection.js';
import type { Logger } from '../logger.js';
import type {
  KgNode,
  KgEdge,
  NodeType,
  EdgeType,
  DecayClass,
  Sensitivity,
  SearchResult,
  TraversalResult,
} from './types.js';
import { createNodeId, createEdgeId, SENSITIVITY_LEVELS } from './types.js';
import { EmbeddingService } from './embedding.js';

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
  deleteEdge(id: string): Promise<void>;
  updateEdge(id: string, updates: { confidence: number; lastConfirmedAt: Date }): Promise<KgEdge>;
  // Atomic upsert: creates if no matching (src, tgt, type) pair exists in either
  // direction; otherwise raises confidence and refreshes lastConfirmedAt.
  upsertEdge(edge: KgEdge): Promise<{ edge: KgEdge; created: boolean }>;
  // Idempotent node creation: matches on lower(label) + type for non-fact nodes.
  // fact nodes always insert as new regardless of label collision.
  upsertNode(node: KgNode): Promise<{ node: KgNode; created: boolean }>;
  traverse(startNodeId: string, maxDepth: number): Promise<TraversalResult>;
  semanticSearch(
    queryEmbedding: number[],
    limit: number,
    filters?: { type?: NodeType; maxSensitivity?: Sensitivity },
  ): Promise<SearchResult[]>;
  /** List all warned (warned_at IS NOT NULL), non-archived nodes, sorted oldest-first. */
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
    const embedding = options.embedding ?? await this.embeddingService.embed(options.label);

    const node: KgNode = {
      id: createNodeId(),
      type: options.type,
      label: options.label,
      properties: { ...options.properties },
      embedding,
      temporal: {
        createdAt: now,
        lastConfirmedAt: now,
        confidence: options.confidence ?? 0.7,
        decayClass: options.decayClass ?? 'slow_decay',
        source: options.source,
      },
      sensitivity: options.sensitivity ?? 'internal',
      aliases: [],
    };

    await this.backend.createNode(node);
    return node;
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
   * Returns the persisted node and whether it was newly created.
   */
  async upsertNode(options: CreateNodeOptions & { confidence: number }): Promise<{ node: KgNode; created: boolean }> {
    const now = new Date();
    const embedding = options.embedding ?? await this.embeddingService.embed(options.label);

    const node: KgNode = {
      id: createNodeId(),
      type: options.type,
      label: options.label,
      properties: { ...options.properties },
      embedding,
      temporal: {
        createdAt: now,
        lastConfirmedAt: now,
        confidence: options.confidence,
        decayClass: options.decayClass ?? 'slow_decay',
        source: options.source,
      },
      sensitivity: options.sensitivity ?? 'internal',
      aliases: [],
    };

    return this.backend.upsertNode(node);
  }

  /** Retrieve a node by ID, or undefined if not found */
  async getNode(id: string): Promise<KgNode | undefined> {
    return this.backend.getNode(id);
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
        ? await this.embeddingService.embed(updates.label!)
        : existing.embedding,
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
   */
  async semanticSearch(
    query: string,
    options?: { limit?: number; type?: NodeType; maxSensitivity?: Sensitivity },
  ): Promise<SearchResult[]> {
    const limit = options?.limit ?? 10;
    const queryEmbedding = await this.embeddingService.embed(query);
    return this.backend.semanticSearch(queryEmbedding, limit, {
      type: options?.type,
      maxSensitivity: options?.maxSensitivity,
    });
  }

  /** List all warned (warned_at IS NOT NULL), non-archived nodes for the CEO re-confirmation flow. */
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
      `INSERT INTO kg_nodes (id, type, label, properties, embedding, confidence, decay_class, source, created_at, last_confirmed_at, sensitivity, aliases)
       VALUES ($1, $2, $3, $4, $5::vector, $6, $7, $8, $9, $10, $11, $12)`,
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
      ],
    );
  }

  async upsertNode(node: KgNode): Promise<{ node: KgNode; created: boolean }> {
    this.logger.debug({ type: node.type, label: node.label }, 'kg: upserting node');
    const embeddingStr = node.embedding ? `[${node.embedding.join(',')}]` : null;
    const result = await this.pool.query<PgNodeRow & { is_new: boolean }>(
      `INSERT INTO kg_nodes (id, type, label, properties, embedding, confidence, decay_class, source, created_at, last_confirmed_at, sensitivity, aliases)
       VALUES ($1, $2, $3, $4, $5::vector, $6, $7, $8, $9, $9, $10, $11)
       ON CONFLICT (lower(label), type) WHERE type != 'fact' AND archived_at IS NULL
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
       SET label = $1, properties = $2, embedding = $3::vector, last_confirmed_at = $4, confidence = $5, sensitivity = $6, aliases = $7
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
         AND cardinality(aliases) < 10`,
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
    filters?: { type?: NodeType; maxSensitivity?: Sensitivity },
  ): Promise<SearchResult[]> {
    const embeddingStr = `[${queryEmbedding.join(',')}]`;
    const params: unknown[] = [embeddingStr, limit];
    const extraClauses: string[] = [];

    if (filters?.type) {
      params.push(filters.type);
      extraClauses.push(`AND type = $${params.length}`);
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

    const result = await this.pool.query<PgNodeRow & { similarity: number }>(
      `SELECT *, 1 - (embedding <=> $1::vector) AS similarity
       FROM kg_nodes
       WHERE embedding IS NOT NULL
         AND archived_at IS NULL
         ${extraClauses.join('\n         ')}
       ORDER BY embedding <=> $1::vector
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
    const result = await this.pool.query<{ label: string }>(
      `UPDATE kg_nodes
          SET archived_at = now(),
              warned_at = NULL,
              warn_reason = NULL
        WHERE id = $1
          AND warned_at IS NOT NULL
          AND archived_at IS NULL
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
    temporal: {
      createdAt: row.created_at,
      lastConfirmedAt: row.last_confirmed_at,
      confidence: row.confidence,
      decayClass: row.decay_class as DecayClass,
      source: row.source,
    },
    sensitivity: (row.sensitivity as Sensitivity) ?? 'internal',
    aliases: row.aliases ?? [],
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
      // Archived nodes are treated as non-existent — don't merge with them
      if (n.type !== 'fact' && n.label.toLowerCase() === lowerLabel && n.type === node.type && !this.archivedNodes.has(n.id)) {
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
    if (node.aliases.length >= 10) return false;
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
    filters?: { type?: NodeType; maxSensitivity?: Sensitivity },
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
      // Archived nodes must not appear in semantic search results
      if (this.archivedNodes.has(node.id)) continue;
      // Apply type filter
      if (filters?.type && node.type !== filters.type) continue;
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
    this.warnedNodes.delete(nodeId);
    // archiveNode handles both node and incident edge archival, keeping
    // behaviour consistent with the Postgres backend and archiveNode().
    await this.archiveNode(nodeId);
    return { success: true, label: node.label };
  }
}
