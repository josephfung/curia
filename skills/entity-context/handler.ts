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
// Four buckets come back and all are surfaced: entities that assembled,
// `unresolved` IDs that matched nothing, `nodeless` contacts that exist but
// cannot hold knowledge (#1694 / ADR-040), and `failed` IDs whose lookup errored
// (#1702). The handler owns all LLM-facing wording for `nodeless` and `failed`.

import type { ToolHandler, ToolContext, ToolResult } from '../../src/skills/types.js';
import type { AssembleManyFailedEntry, AssembleManyResult } from '../../src/entity-context/assembler.js';

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

const NOT_UNKNOWN_SUFFIX =
  'This is not evidence the contact or entity is unknown.';

function formatFailedReason(retryable: boolean): string {
  if (retryable) {
    return `Entity context lookup failed due to a transient error. Retry the lookup; ${NOT_UNKNOWN_SUFFIX}`;
  }
  return `Entity context lookup failed due to a system error. Do not retry; report the failure. ${NOT_UNKNOWN_SUFFIX}`;
}

function formatTotalFailureError(failed: AssembleManyFailedEntry[]): string {
  const retryable = failed.some(f => f.retryable);
  if (retryable) {
    return `Entity context lookup failed for all requested IDs due to transient errors. Retry; ${NOT_UNKNOWN_SUFFIX}`;
  }
  return `Entity context lookup failed for all requested IDs due to a system error. Do not retry; report the failure. ${NOT_UNKNOWN_SUFFIX}`;
}

function buildSuccessData(result: AssembleManyResult): Record<string, unknown> {
  return {
    ...(result.nodeless.length > 0
      ? {
          nodeless: result.nodeless.map(n => ({
            inputId: n.inputId,
            contactId: n.contactId,
            displayName: n.displayName,
            reason: NODELESS_REASON,
          })),
        }
      : {}),
    ...(result.failed.length > 0
      ? {
          failed: result.failed.map(f => ({
            inputId: f.inputId,
            reason: formatFailedReason(f.retryable),
          })),
        }
      : {}),
    unresolved: result.unresolved,
    entities: result.entities,
  };
}

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
          failedCount: result.failed.length,
        },
        'entity-context: assembled context',
      );

      if (result.failed.length > 0) {
        const retryableCount = result.failed.filter(f => f.retryable).length;
        ctx.log.warn(
          { failedCount: result.failed.length, retryableCount },
          'entity-context: some lookups failed — see failed bucket in result',
        );
      }

      // Total failure: every ID errored and nothing assembled. A success-shaped
      // result with only a retry hint has nothing to stop the agent retrying into
      // a hard-down DB (#1702 review).
      if (result.entities.length === 0 && result.failed.length > 0) {
        return { success: false, error: formatTotalFailureError(result.failed) };
      }

      // Key order is deliberate. The execution layer enforces an aggregate size cap by
      // JSON.stringify-ing this object and head-slicing it (see skillOutputMaxLength),
      // and JSON.stringify preserves insertion order. Emitting the small diagnostic
      // buckets first means a truncated payload sacrifices bulk entity data rather
      // than the warning that some contacts cannot hold knowledge at all — which,
      // being absent from `unresolved` too, would otherwise vanish without trace.
      return {
        success: true,
        data: buildSuccessData(result),
      };
    } catch (err) {
      // Log the full error server-side but don't expose DB internals (table names,
      // column names, SQL state codes) to the LLM via the skill result string.
      ctx.log.error({ err, ids }, 'entity-context: assembly failed');
      return { success: false, error: 'Failed to assemble entity context — see server logs for details' };
    }
  }
}
