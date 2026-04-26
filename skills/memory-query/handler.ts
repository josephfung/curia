// handler.ts — memory-query skill.
//
// Performs freeform semantic search over the knowledge graph. Embeds the
// query string via text-embedding-3-small and returns the most similar nodes
// by cosine similarity (highest score first).
//
// Supports three optional filters applied before the results are returned:
//   - type          — restrict to a specific node type (person, fact, etc.)
//   - max_sensitivity — restrict to nodes at or below a sensitivity ceiling
//   - limit         — cap the number of results (default 10, max 50)

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { NODE_TYPES, SENSITIVITY_LEVELS } from '../../src/memory/types.js';
import type { NodeType, Sensitivity } from '../../src/memory/types.js';

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 10;

const NODE_TYPES_SET: ReadonlySet<string> = new Set(NODE_TYPES);
const SENSITIVITY_LEVELS_SET: ReadonlySet<string> = new Set(SENSITIVITY_LEVELS);

export class MemoryQueryHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
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
      ctx.log.error('memory-query: entity memory not available');
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

    // Cap limit at MAX_LIMIT; apply default when not provided
    const limit = limitInput !== undefined
      ? Math.min(Math.max(1, Math.floor(limitInput)), MAX_LIMIT)
      : DEFAULT_LIMIT;

    try {
      const results = await ctx.entityMemory.search(query, {
        limit,
        type: type as NodeType | undefined,
        maxSensitivity: max_sensitivity as Sensitivity | undefined,
      });

      // Map SearchResult[] to flat output objects so agents see a clean,
      // self-contained record for each node rather than nested KgNode shapes.
      const nodes = results.map(({ node, score }) => ({
        id: node.id,
        type: node.type,
        label: node.label,
        properties: node.properties,
        confidence: node.temporal.confidence,
        // decay_class tells the agent how stable this fact is expected to be;
        // fast_decay nodes with degraded confidence should be treated as potentially stale.
        decay_class: node.temporal.decayClass,
        // sensitivity tells the agent whether results can be shared or exported;
        // confidential/restricted facts must not be included in outbound messages
        // without explicit CEO approval.
        sensitivity: node.sensitivity,
        last_confirmed_at: node.temporal.lastConfirmedAt,
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
