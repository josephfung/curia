// handler.ts — delete-relationship skill.
//
// Finds and deletes a single knowledge graph edge identified by a human-readable triple:
// (subject label, edge type, object label).
//
// Design decisions:
// - Idempotent: returns deleted:false if no matching edge exists (not an error).
// - Disambiguates: if subject or object matches multiple nodes, returns candidates
//   so Nathan can ask the user to clarify before retrying.
// - Direction-agnostic: uses findEdges() which checks both directions, so the
//   caller does not need to know how the edge was originally stored.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { EDGE_TYPES } from '../../src/memory/types.js';
import type { EdgeType } from '../../src/memory/types.js';

const EDGE_TYPES_SET: ReadonlySet<string> = new Set(EDGE_TYPES);

export class DeleteRelationshipHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const { subject, predicate, object } = ctx.input as {
      subject?: string;
      predicate?: string;
      object?: string;
    };

    if (!subject || typeof subject !== 'string') {
      return { success: false, error: 'Missing required input: subject (string)' };
    }
    if (!predicate || typeof predicate !== 'string') {
      return { success: false, error: 'Missing required input: predicate (string)' };
    }
    if (!object || typeof object !== 'string') {
      return { success: false, error: 'Missing required input: object (string)' };
    }
    if (!ctx.entityMemory) {
      ctx.log.error('delete-relationship: entity memory not available');
      return { success: false, error: 'Entity memory not available — database not configured' };
    }

    // Validate predicate before any DB calls
    if (!EDGE_TYPES_SET.has(predicate)) {
      return {
        success: false,
        error: `Unknown edge type: "${predicate}". Valid types: ${EDGE_TYPES.join(', ')}`,
      };
    }
    const edgeType = predicate as EdgeType;

    try {
      // Resolve subject
      const subjectMatches = await ctx.entityMemory.findEntities(subject);
      if (subjectMatches.length === 0) {
        ctx.log.debug({ subject }, 'delete-relationship: subject not found in KG');
        return { success: true, data: { deleted: false } };
      }
      if (subjectMatches.length > 1) {
        ctx.log.debug({ subject, count: subjectMatches.length }, 'delete-relationship: ambiguous subject');
        return {
          success: true,
          data: {
            ambiguous: true,
            ambiguous_field: 'subject',
            candidates: subjectMatches.map(n => ({ id: n.id, label: n.label, type: n.type })),
          },
        };
      }
      const subjectNode = subjectMatches[0]!;

      // Resolve object
      const objectMatches = await ctx.entityMemory.findEntities(object);
      if (objectMatches.length === 0) {
        ctx.log.debug({ object }, 'delete-relationship: object not found in KG');
        return { success: true, data: { deleted: false } };
      }
      if (objectMatches.length > 1) {
        ctx.log.debug({ object, count: objectMatches.length }, 'delete-relationship: ambiguous object');
        return {
          success: true,
          data: {
            ambiguous: true,
            ambiguous_field: 'object',
            candidates: objectMatches.map(n => ({ id: n.id, label: n.label, type: n.type })),
          },
        };
      }
      const objectNode = objectMatches[0]!;

      // Find the edge matching the triple in either direction.
      // findEdges() checks both source and target directions, so (Joseph, spouse, Xiaopu)
      // finds the edge even if it was stored as (Xiaopu, spouse, Joseph).
      const edges = await ctx.entityMemory.findEdges(subjectNode.id, { type: edgeType });
      const match = edges.find(r => r.node.id === objectNode.id);

      if (!match) {
        ctx.log.debug({ subject, predicate, object }, 'delete-relationship: no matching edge found');
        return { success: true, data: { deleted: false } };
      }

      // Log before deletion for audit trail
      ctx.log.info(
        { edgeId: match.edge.id, subject, predicate, object, confidence: match.edge.temporal.confidence },
        'delete-relationship: deleting edge',
      );

      await ctx.entityMemory.deleteEdge(match.edge.id);

      return { success: true, data: { deleted: true, edge_id: match.edge.id } };
    } catch (err) {
      ctx.log.error({ err, subject, predicate, object }, 'delete-relationship: unexpected error');
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
