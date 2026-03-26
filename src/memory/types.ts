import { randomUUID } from 'node:crypto';

// -- Node types from spec (01-memory-system.md line 61) --
export const NODE_TYPES = [
  'person',
  'organization',
  'project',
  'decision',
  'event',
  'concept',
  'fact',
] as const;
export type NodeType = (typeof NODE_TYPES)[number];

// -- Edge types from spec (01-memory-system.md line 72) --
export const EDGE_TYPES = [
  'works_on',
  'decided',
  'attended',
  'relates_to',
  'belongs_to',
  'authored',
  'mentioned_in',
] as const;
export type EdgeType = (typeof EDGE_TYPES)[number];

// -- Decay classes from spec (01-memory-system.md line 86-89) --
export const DECAY_CLASSES = ['permanent', 'slow_decay', 'fast_decay'] as const;
export type DecayClass = (typeof DECAY_CLASSES)[number];

// -- Temporal metadata, present on every node and edge (spec line 82-91) --
export interface TemporalMetadata {
  createdAt: Date;
  lastConfirmedAt: Date;
  confidence: number; // 0-1 scale
  decayClass: DecayClass;
  source: string; // which agent/channel/interaction created it
}

// -- Knowledge Graph Node --
export interface KgNode {
  id: string;
  type: NodeType;
  label: string;
  properties: Record<string, unknown>;
  embedding?: number[]; // VECTOR(1536) — undefined until embedded
  temporal: TemporalMetadata;
}

// -- Knowledge Graph Edge --
export interface KgEdge {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  type: EdgeType;
  properties: Record<string, unknown>;
  temporal: TemporalMetadata;
}

// -- Options for storing a new fact --
export interface StoreFactOptions {
  entityNodeId: string;
  label: string;
  properties?: Record<string, unknown>;
  confidence?: number; // defaults to 0.7
  decayClass?: DecayClass; // defaults to 'slow_decay'
  source: string; // provenance: "agent:coordinator/task:abc123/channel:cli"
}

// -- Validation result --
export type ValidationResult =
  | { action: 'create'; node: KgNode }
  | { action: 'update'; existingNodeId: string; mergedProperties: Record<string, unknown> }
  | { action: 'conflict'; existingNodeId: string; reason: string }
  | { action: 'rejected'; reason: string };

// -- Search result (semantic or label-based) --
export interface SearchResult {
  node: KgNode;
  score: number; // cosine similarity for semantic, 1.0 for exact match
  edges: KgEdge[]; // edges connecting this node to the queried entity
}

// -- Graph traversal result --
export interface TraversalResult {
  nodes: KgNode[];
  edges: KgEdge[];
}

// -- ID factories --
export function createNodeId(): string {
  return randomUUID();
}

export function createEdgeId(): string {
  return randomUUID();
}

// -- Embedding dimensions constant (hardcoded for text-embedding-3-small) --
export const EMBEDDING_DIMENSIONS = 1536;
