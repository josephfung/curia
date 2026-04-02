// skills/entity-context/handler.ts
//
// Assembles rich context about one or more entities for the LLM to use.
// Wraps EntityContextAssembler as a callable skill so agents can inspect
// entity context interactively (e.g., "what do you know about Jenna?").
//
// For automatic pre-enrichment before skill invocation, use the
// entity_enrichment manifest declaration instead — that runs the same
// assembler without an extra LLM round-trip.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

export class EntityContextHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const assembler = ctx.entityContextAssembler;
    if (!assembler) {
      return { success: false, error: 'Entity context assembler not available — database not configured' };
    }

    const { entityIds, contactIds, includeRelationships } = ctx.input as {
      entityIds?: string[];
      contactIds?: string[];
      includeRelationships?: boolean;
    };

    // Merge contactIds and entityIds into a single list to resolve.
    // Both contact IDs and KG node IDs are accepted by assembleMany().
    const ids: string[] = [
      ...(Array.isArray(contactIds) ? contactIds : []),
      ...(Array.isArray(entityIds) ? entityIds : []),
    ];

    // Default: assemble context for the caller when no IDs provided
    if (ids.length === 0) {
      const callerId = ctx.caller?.contactId;
      if (!callerId) {
        return { success: false, error: 'No entity IDs provided and no caller context available' };
      }
      ids.push(callerId);
    }

    try {
      const result = await assembler.assembleMany(ids, {
        includeRelationships: includeRelationships !== false,
      });

      ctx.log.info(
        { resolvedCount: result.entities.length, unresolvedCount: result.unresolved.length },
        'entity-context: assembled context',
      );

      return {
        success: true,
        data: {
          entities: result.entities,
          unresolved: result.unresolved,
        },
      };
    } catch (err) {
      // Log the full error server-side but don't expose DB internals (table names,
      // column names, SQL state codes) to the LLM via the skill result string.
      ctx.log.error({ err, ids }, 'entity-context: assembly failed');
      return { success: false, error: 'Failed to assemble entity context — see server logs for details' };
    }
  }
}
