// skills/entity-context/handler.ts
//
// Assembles rich context about one or more entities for the LLM to use.
// Wraps EntityContextAssembler as a callable skill so agents can inspect
// entity context interactively (e.g., "what do you know about Jenna?").
//
// For automatic pre-enrichment before skill invocation, use the
// entity_enrichment manifest declaration instead — that runs the same
// assembler without an extra LLM round-trip.
//
// Three buckets come back and all three are surfaced: entities that assembled,
// `unresolved` IDs that matched nothing, and `nodeless` contacts that exist but
// cannot hold knowledge (#1694 / ADR-040).

import type { ToolHandler, ToolContext, ToolResult } from '../../src/skills/types.js';

// Shown to the LLM for every contact that resolved but holds no KG node.
//
// The wording is load-bearing. An empty result reads as "nothing is known about this
// contact", which invites the agent to fill the gap by asking or by storing what it
// learns — neither of which can work, because there is no node for a fact to attach
// to. It has to read as a capability gap instead.
//
// Kept free of issue numbers and internal schema vocabulary: this goes into a prompt
// and may be paraphrased to the principal, so "stored profile" rather than "KG node".
// Kept kind-neutral too — nodeless contacts include organizations, not just people
// (ADR-040's arm A exists precisely because org contacts are a large share of them).
const NODELESS_REASON =
  'This contact exists but has no stored profile, so it cannot hold facts, '
  + 'relationships, or background context. Having no context here does not mean the '
  + 'contact is unknown to us. Do not try to store facts about them; report the gap instead.';

export class EntityContextHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
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
        {
          resolvedCount: result.entities.length,
          unresolvedCount: result.unresolved.length,
          nodelessCount: result.nodeless.length,
        },
        'entity-context: assembled context',
      );

      // Key order is deliberate. The execution layer enforces an aggregate size cap by
      // JSON.stringify-ing this object and head-slicing it (see skillOutputMaxLength),
      // and JSON.stringify preserves insertion order. Emitting the small diagnostic
      // buckets first means a truncated payload sacrifices bulk entity data rather
      // than the warning that some contacts cannot hold knowledge at all — which,
      // being absent from `unresolved` too, would otherwise vanish without trace.
      return {
        success: true,
        data: {
          // Only present when non-empty: on the common path every contact has a
          // node, and an always-there empty array is pure prompt noise.
          ...(result.nodeless.length > 0
            ? {
                nodeless: result.nodeless.map(n => ({
                  // inputId is echoed back so the agent can map the answer to what it
                  // asked for. It matters most for email inputs, where contactId is a
                  // UUID the caller has never seen and displayName may not resemble
                  // the address.
                  inputId: n.inputId,
                  contactId: n.contactId,
                  displayName: n.displayName,
                  reason: NODELESS_REASON,
                })),
              }
            : {}),
          unresolved: result.unresolved,
          entities: result.entities,
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
