import type { DbPool } from '../db/connection.js';
import type { Logger } from '../logger.js';
import type {
  KgNode,
  KgEdge,
  NodeType,
  EdgeType,
  DecayClass,
  SearchResult,
  TraversalResult,
} from './types.js';
import { createNodeId, createEdgeId } from './types.js';
import { EmbeddingService } from './embedding.js';

// -- Public option interfaces --

export interface CreateNodeOptions {
  type: NodeType;
  label: string;
  properties: Record<string, unknown>;
  confidence?: number;    // defaults to 0.7
  decayClass?: DecayClass; // defaults to 'slow_decay'
  source: string;
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

// -- Internal backend interface --

interface KnowledgeGraphBackend {
  createNode(node: KgNode): Promise<void>;
  getNode(id: string): Promise<KgNode | undefined>;
  updateNode(id: string, node: KgNode): Promise<void>;
  deleteNode(id: string): Promise<void>;
  findNodesByType(type: NodeType): Promise<KgNode[]>;
  findNodesByLabel(label: string): Promise<KgNode[]>;
  createEdge(edge: KgEdge): Promise<void>;
  getEdgesForNode(nodeId: string): Promise<KgEdge[]>;
  deleteEdge(id: string): Promise<void>;
  traverse(startNodeId: string, maxDepth: number): Promise<TraversalResult>;
  semanticSearch(queryEmbedding: number[], limit: number): Promise<SearchResult[]>;
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
    const embedding = await this.embeddingService.embed(options.label);

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
    };

    await this.backend.createNode(node);
    return node;
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
    updates: { label?: string; properties?: Record<string, unknown> },
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
      // Re-embed if the label changed, otherwise keep existing embedding
      embedding: labelChanged
        ? await this.embeddingService.embed(updates.label!)
        : existing.embedding,
      temporal: {
        ...existing.temporal,
        lastConfirmedAt: new Date(),
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

  /** Find all nodes of a given type */
  async findNodesByType(type: NodeType): Promise<KgNode[]> {
    return this.backend.findNodesByType(type);
  }

  /** Find nodes by label (case-insensitive substring match) */
  async findNodesByLabel(label: string): Promise<KgNode[]> {
    return this.backend.findNodesByLabel(label);
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
    options?: { limit?: number },
  ): Promise<SearchResult[]> {
    const limit = options?.limit ?? 10;
    const queryEmbedding = await this.embeddingService.embed(query);
    return this.backend.semanticSearch(queryEmbedding, limit);
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
    this.logger.debug({ nodeId: node.id, type: node.type }, 'kg: creating node');
    const embeddingStr = node.embedding ? `[${node.embedding.join(',')}]` : null;
    await this.pool.query(
      `INSERT INTO kg_nodes (id, type, label, properties, embedding, confidence, decay_class, source, created_at, last_confirmed_at)
       VALUES ($1, $2, $3, $4, $5::vector, $6, $7, $8, $9, $10)`,
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
      ],
    );
  }

  async getNode(id: string): Promise<KgNode | undefined> {
    const result = await this.pool.query<PgNodeRow>(
      'SELECT * FROM kg_nodes WHERE id = $1',
      [id],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return pgRowToNode(row);
  }

  async updateNode(id: string, node: KgNode): Promise<void> {
    this.logger.debug({ nodeId: id }, 'kg: updating node');
    const embeddingStr = node.embedding ? `[${node.embedding.join(',')}]` : null;
    await this.pool.query(
      `UPDATE kg_nodes
       SET label = $1, properties = $2, embedding = $3::vector, last_confirmed_at = $4
       WHERE id = $5`,
      [
        node.label,
        JSON.stringify(node.properties),
        embeddingStr,
        node.temporal.lastConfirmedAt,
        id,
      ],
    );
  }

  async deleteNode(id: string): Promise<void> {
    this.logger.debug({ nodeId: id }, 'kg: deleting node');
    // Relies on ON DELETE CASCADE for kg_edges foreign keys
    await this.pool.query('DELETE FROM kg_nodes WHERE id = $1', [id]);
  }

  async findNodesByType(type: NodeType): Promise<KgNode[]> {
    const result = await this.pool.query<PgNodeRow>(
      'SELECT * FROM kg_nodes WHERE type = $1',
      [type],
    );
    return result.rows.map(pgRowToNode);
  }

  async findNodesByLabel(label: string): Promise<KgNode[]> {
    // Case-insensitive match using ILIKE
    const result = await this.pool.query<PgNodeRow>(
      'SELECT * FROM kg_nodes WHERE label ILIKE $1',
      [label],
    );
    return result.rows.map(pgRowToNode);
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
      'SELECT * FROM kg_edges WHERE source_node_id = $1 OR target_node_id = $1',
      [nodeId],
    );
    return result.rows.map(pgRowToEdge);
  }

  async deleteEdge(id: string): Promise<void> {
    this.logger.debug({ edgeId: id }, 'kg: deleting edge');
    await this.pool.query('DELETE FROM kg_edges WHERE id = $1', [id]);
  }

  async traverse(startNodeId: string, maxDepth: number): Promise<TraversalResult> {
    // Step 1: Collect reachable nodes via recursive CTE (cycle-safe)
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
          AND NOT (CASE WHEN e.source_node_id = r.node_id THEN e.target_node_id ELSE e.source_node_id END) = ANY(r.visited)
      )
      SELECT DISTINCT n.* FROM reachable r JOIN kg_nodes n ON n.id = r.node_id`,
      [startNodeId, maxDepth],
    );

    const nodes = nodesResult.rows.map(pgRowToNode);
    const nodeIds = nodes.map(n => n.id);

    if (nodeIds.length === 0) {
      return { nodes: [], edges: [] };
    }

    // Step 2: Collect edges between reachable nodes
    const edgesResult = await this.pool.query<PgEdgeRow>(
      `SELECT e.* FROM kg_edges e
       WHERE e.source_node_id = ANY($1::uuid[])
         AND e.target_node_id = ANY($1::uuid[])`,
      [nodeIds],
    );

    const edges = edgesResult.rows.map(pgRowToEdge);
    return { nodes, edges };
  }

  async semanticSearch(queryEmbedding: number[], limit: number): Promise<SearchResult[]> {
    const embeddingStr = `[${queryEmbedding.join(',')}]`;
    const result = await this.pool.query<PgNodeRow & { similarity: number }>(
      `SELECT *, 1 - (embedding <=> $1::vector) AS similarity
       FROM kg_nodes
       WHERE embedding IS NOT NULL
       ORDER BY embedding <=> $1::vector
       LIMIT $2`,
      [embeddingStr, limit],
    );

    return result.rows.map((row) => ({
      node: pgRowToNode(row),
      score: row.similarity,
      edges: [], // Edges are not included in basic semantic search results
    }));
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

  async createNode(node: KgNode): Promise<void> {
    this.nodes.set(node.id, node);
  }

  async getNode(id: string): Promise<KgNode | undefined> {
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

  async findNodesByType(type: NodeType): Promise<KgNode[]> {
    const results: KgNode[] = [];
    for (const node of this.nodes.values()) {
      if (node.type === type) {
        results.push(node);
      }
    }
    return results;
  }

  async findNodesByLabel(label: string): Promise<KgNode[]> {
    const lowerLabel = label.toLowerCase();
    const results: KgNode[] = [];
    for (const node of this.nodes.values()) {
      if (node.label.toLowerCase() === lowerLabel) {
        results.push(node);
      }
    }
    return results;
  }

  async createEdge(edge: KgEdge): Promise<void> {
    this.edges.set(edge.id, edge);
  }

  async getEdgesForNode(nodeId: string): Promise<KgEdge[]> {
    const results: KgEdge[] = [];
    for (const edge of this.edges.values()) {
      if (edge.sourceNodeId === nodeId || edge.targetNodeId === nodeId) {
        results.push(edge);
      }
    }
    return results;
  }

  async deleteEdge(id: string): Promise<void> {
    this.edges.delete(id);
  }

  /**
   * BFS traversal from startNodeId, limited to maxDepth hops.
   * Uses a visited set to prevent cycles.
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

      // Find all edges connected to this node
      for (const edge of this.edges.values()) {
        let neighborId: string | undefined;
        if (edge.sourceNodeId === currentNodeId) {
          neighborId = edge.targetNodeId;
        } else if (edge.targetNodeId === currentNodeId) {
          neighborId = edge.sourceNodeId;
        }

        if (neighborId && !visited.has(neighborId)) {
          visited.add(neighborId);
          queue.push([neighborId, depth + 1]);
        }
      }
    }

    // Collect all visited nodes
    const nodes: KgNode[] = [];
    for (const nodeId of visited) {
      const node = this.nodes.get(nodeId);
      if (node) {
        nodes.push(node);
      }
    }

    // Collect edges where both endpoints are in the visited set
    const edges: KgEdge[] = [];
    for (const edge of this.edges.values()) {
      if (visited.has(edge.sourceNodeId) && visited.has(edge.targetNodeId)) {
        edges.push(edge);
      }
    }

    return { nodes, edges };
  }

  /**
   * Semantic search: compute cosine similarity between the query embedding
   * and all node embeddings, return top results sorted by similarity.
   */
  async semanticSearch(queryEmbedding: number[], limit: number): Promise<SearchResult[]> {
    const scored: SearchResult[] = [];

    for (const node of this.nodes.values()) {
      if (!node.embedding) continue;
      const score = EmbeddingService.cosineSimilarity(queryEmbedding, node.embedding);
      scored.push({ node, score, edges: [] });
    }

    // Sort by similarity descending, then take top N
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }
}
