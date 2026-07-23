// handler.ts — query-relationships skill.
//
// Resolves an entity by label, then returns its relationship edges.
// Handles three cases:
//   - Zero matches  → empty result (entity not yet in the KG)
//   - One match     → returns edges, optionally filtered by type
//   - Many matches  → returns ambiguous:true with candidates for disambiguation

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import { EDGE_TYPES } from '../../../../src/memory/types.js';
import type { EdgeType } from '../../../../src/memory/types.js';

const EDGE_TYPES_SET: ReadonlySet<string> = new Set(EDGE_TYPES);

export class QueryRelationshipsHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const { entity, edge_type } = ctx.input as { entity?: string; edge_type?: string };

    if (!entity || typeof entity !== 'string') {
      return { success: false, error: 'Missing required input: entity (string)' };
    }
    if (!ctx.entityMemory) {
      ctx.log.error('query-relationships: entity memory not available');
      return { success: false, error: 'Entity memory not available — database not configured' };
    }

    // Validate edge_type if provided
    if (edge_type !== undefined && !EDGE_TYPES_SET.has(edge_type)) {
      return {
        success: false,
        error: `Unknown edge type: "${edge_type}". Valid types: ${EDGE_TYPES.join(', ')}`,
      };
    }
    const edgeTypeFilter = edge_type as EdgeType | undefined;

    try {
      const matches = await ctx.entityMemory.findEntities(entity);

      if (matches.length === 0) {
        ctx.log.debug({ entity }, 'query-relationships: entity not found in KG');
        return { success: true, data: { relationships: [], count: 0 } };
      }

      if (matches.length > 1) {
        ctx.log.debug({ entity, count: matches.length }, 'query-relationships: ambiguous entity label');
        return {
          success: true,
          data: {
            ambiguous: true,
            candidates: matches.map(n => ({ id: n.id, label: n.label, type: n.type })),
          },
        };
      }

      const entityNode = matches[0]!;
      const edges = await ctx.entityMemory.findEdges(
        entityNode.id,
        edgeTypeFilter !== undefined ? { type: edgeTypeFilter } : undefined,
      );

      const relationships = edges.map(({ edge, node, direction }) => ({
        edge_id: edge.id,
        // Use the resolved node's canonical label for the queried side (not the raw
        // `entity` input), so both sides read consistently — e.g. querying "jane doe"
        // returns "Jane Doe" to match the KG, not the caller's casing.
        subject: direction === 'outbound' ? entityNode.label : node.label,
        predicate: edge.type,
        object: direction === 'outbound' ? node.label : entityNode.label,
        direction,
        confidence: edge.temporal.confidence,
        last_confirmed_at: edge.temporal.lastConfirmedAt.toISOString(),
      }));

      ctx.log.info({ entity, count: relationships.length }, 'query-relationships: complete');
      return { success: true, data: { relationships, count: relationships.length } };
    } catch (err) {
      ctx.log.error({ err, entity }, 'query-relationships: unexpected error');
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
