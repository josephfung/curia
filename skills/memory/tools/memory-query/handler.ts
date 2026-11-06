// handler.ts — memory-query skill.
//
// Performs freeform semantic search over the knowledge graph. Embeds the
// query string with the configured embedding model (ADR-051) and returns the
// most similar nodes by cosine similarity (highest score first).
//
// Supports three optional filters applied before the results are returned:
//   - type          — restrict to a specific node type (person, fact, etc.)
//   - max_sensitivity — restrict to nodes at or below a sensitivity ceiling
//   - limit         — cap the number of results (default 10, max 50)
//
// Each fact result names the entities it is attached to (#2502). A fact that matched only
// on wording otherwise reads as belonging to whoever the query named, so another contact's
// fact got reported as context about the query subject.

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import { NODE_TYPES, SENSITIVITY_LEVELS } from '../../../../src/memory/types.js';
import type { NodeType, Sensitivity } from '../../../../src/memory/types.js';
import type { FactOwner, FactOwnership } from '../../../../src/memory/knowledge-graph.js';

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 10;
/** Owners listed per fact. A fact normally has one; the rest are counted in more_owners. */
const MAX_OWNERS_PER_FACT = 5;

const NODE_TYPES_SET: ReadonlySet<string> = new Set(NODE_TYPES);
const SENSITIVITY_LEVELS_SET: ReadonlySet<string> = new Set(SENSITIVITY_LEVELS);

/**
 * The owner fields one fact result carries. `owners` is always present on a fact, so the
 * model never has to infer ownership from the query; `unattached` marks a fact linked to no
 * entity. The two counts appear only when non-zero.
 */
function factOwnerFields(entry: FactOwnership | undefined): {
  owners: FactOwner[];
  unattached?: true;
  more_owners?: number;
  owners_withheld?: number;
} {
  if (!entry) return { owners: [], unattached: true };
  const more = entry.visibleCount - entry.owners.length;
  return {
    owners: entry.owners,
    ...(more > 0 ? { more_owners: more } : {}),
    ...(entry.withheldCount > 0 ? { owners_withheld: entry.withheldCount } : {}),
  };
}

export class MemoryQueryHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const { query, type, limit: limitInput, max_sensitivity } = ctx.input as {
      query?: string;
      type?: string;
      limit?: number;
      max_sensitivity?: string;
    };

    // -- Input validation --

    if (!query || typeof query !== 'string') {
      return { success: false, error: 'Missing required input: query (string)' };
    }

    if (!ctx.entityMemory) {
      ctx.log.error({ query }, 'memory-query: entity memory not available');
      return { success: false, error: 'Entity memory not available — database not configured' };
    }

    if (type !== undefined && !NODE_TYPES_SET.has(type)) {
      return {
        success: false,
        error: `Unknown node type: "${type}". Valid types: ${NODE_TYPES.join(', ')}`,
      };
    }

    if (max_sensitivity !== undefined && !SENSITIVITY_LEVELS_SET.has(max_sensitivity)) {
      return {
        success: false,
        error: `Unknown sensitivity level: "${max_sensitivity}". Valid levels: ${SENSITIVITY_LEVELS.join(', ')}`,
      };
    }

    // Cap limit at MAX_LIMIT; apply default when not provided.
    // Guard against NaN/Infinity: a non-finite value would reach the SQL LIMIT
    // parameter and cause a driver error rather than a clear validation message.
    if (limitInput !== undefined && !Number.isFinite(limitInput)) {
      return { success: false, error: 'Invalid limit: must be a finite number' };
    }
    const limit = limitInput !== undefined
      ? Math.min(Math.max(1, Math.floor(limitInput)), MAX_LIMIT)
      : DEFAULT_LIMIT;

    try {
      const results = await ctx.entityMemory.search(query, {
        limit,
        type: type as NodeType | undefined,
        maxSensitivity: max_sensitivity as Sensitivity | undefined,
      });

      // Owners for every fact result in one batched query. Fail closed: if the lookup throws,
      // the whole call errors (catch below) rather than returning facts with no owner, which
      // is the shape that let a fact be attributed to the wrong person. The same sensitivity
      // ceiling applies, so an owner the caller could not see is counted, never named.
      const factIds = results.filter(({ node }) => node.type === 'fact').map(({ node }) => node.id);
      const ownership = await ctx.entityMemory.getFactOwners(factIds, {
        perFactLimit: MAX_OWNERS_PER_FACT,
        maxSensitivity: max_sensitivity as Sensitivity | undefined,
      });

      // Map SearchResult[] to flat output objects so agents see a clean,
      // self-contained record for each node rather than nested KgNode shapes.
      const nodes = results.map(({ node, score }) => ({
        id: node.id,
        type: node.type,
        label: node.label,
        ...(node.type === 'fact' ? factOwnerFields(ownership.get(node.id)) : {}),
        properties: node.properties,
        confidence: node.temporal.confidence,
        // decay_class tells the agent how stable this fact is expected to be;
        // fast_decay nodes with degraded confidence should be treated as potentially stale.
        decay_class: node.temporal.decayClass,
        // sensitivity tells the agent whether results can be shared or exported;
        // confidential/restricted facts must not be included in outbound messages
        // without explicit principal approval.
        sensitivity: node.sensitivity,
        last_confirmed_at: node.temporal.lastConfirmedAt.toISOString(),
        score,
      }));

      ctx.log.info({ query, count: nodes.length, type, max_sensitivity }, 'memory-query: complete');
      return { success: true, data: { results: nodes, count: nodes.length } };
    } catch (err) {
      ctx.log.error({ err, query }, 'memory-query: unexpected error');
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
