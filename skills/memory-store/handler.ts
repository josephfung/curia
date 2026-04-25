// handler.ts — memory-store skill.
//
// Writes a named fact about a known entity to the knowledge graph.
// Resolves the entity by label or direct node ID, then delegates to
// EntityMemory.storeFact() which runs the full validation pipeline
// (rate limit → contradiction detection → dedup → persist).
//
// Possible outcomes:
//   created   — new fact node created and linked to the entity
//   updated   — near-duplicate found; existing node merged in place
//   conflict  — contradicts an existing attribute fact; agent should surface to CEO
//   rejected  — rate limit exceeded or entity node no longer exists

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { DECAY_CLASSES, SENSITIVITY_LEVELS } from '../../src/memory/types.js';
import type { DecayClass, Sensitivity } from '../../src/memory/types.js';

const DECAY_CLASSES_SET: ReadonlySet<string> = new Set(DECAY_CLASSES);
const SENSITIVITY_LEVELS_SET: ReadonlySet<string> = new Set(SENSITIVITY_LEVELS);

export class MemoryStoreHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const {
      entity,
      field,
      value,
      source,
      confidence,
      decay_class,
      sensitivity,
      sensitivity_category,
    } = ctx.input as {
      entity?: string;
      field?: string;
      value?: string;
      source?: string;
      confidence?: number;
      decay_class?: string;
      sensitivity?: string;
      sensitivity_category?: string;
    };

    // --- Input validation ---

    if (!entity || typeof entity !== 'string') {
      return { success: false, error: 'Missing required input: entity (string)' };
    }
    if (!field || typeof field !== 'string') {
      return { success: false, error: 'Missing required input: field (string)' };
    }
    if (value === undefined || value === null || typeof value !== 'string') {
      return { success: false, error: 'Missing required input: value (string)' };
    }
    if (!source || typeof source !== 'string') {
      return { success: false, error: 'Missing required input: source (string)' };
    }

    if (confidence !== undefined) {
      if (typeof confidence !== 'number' || confidence < 0 || confidence > 1) {
        return { success: false, error: 'confidence must be a number between 0 and 1' };
      }
    }

    if (decay_class !== undefined && !DECAY_CLASSES_SET.has(decay_class)) {
      return {
        success: false,
        error: `Unknown decay_class: "${decay_class}". Valid values: ${DECAY_CLASSES.join(', ')}`,
      };
    }

    if (sensitivity !== undefined && !SENSITIVITY_LEVELS_SET.has(sensitivity)) {
      return {
        success: false,
        error: `Unknown sensitivity: "${sensitivity}". Valid values: ${SENSITIVITY_LEVELS.join(', ')}`,
      };
    }

    if (!ctx.entityMemory) {
      ctx.log.error('memory-store: entity memory not available');
      return { success: false, error: 'Entity memory not available — database not configured' };
    }

    try {
      // --- Entity resolution ---
      //
      // Try label-based lookup first (case-insensitive). If nothing is found,
      // fall back to a direct ID lookup — this allows callers to pass either
      // a human-readable name or a UUID obtained from a previous KG query.

      const resolved = await resolveEntity(ctx, entity);

      if (resolved.kind === 'ambiguous') {
        // Multiple nodes share the same label — caller must disambiguate.
        // We reuse the candidates already fetched by resolveEntity rather than
        // calling findEntities a second time (avoids a race window and extra DB round-trip).
        ctx.log.debug({ entity, count: resolved.candidates.length }, 'memory-store: ambiguous entity label');
        return {
          success: true,
          data: {
            ambiguous: true,
            candidates: resolved.candidates.map(n => ({ id: n.id, label: n.label, type: n.type })),
          },
        };
      }

      if (resolved.kind === 'not_found') {
        ctx.log.debug({ entity }, 'memory-store: entity not found in KG');
        return {
          success: true,
          data: {
            stored: false,
            action: 'rejected',
            reason: `Entity not found in knowledge graph: "${entity}". Create the entity first or check the spelling.`,
          },
        };
      }

      const entityNode = resolved.node;

      // --- Fact storage ---
      //
      // Label format "<field>: <value>" is the canonical convention used by
      // extract-facts and other skills — human-readable and dedup-stable.
      // Properties carry the structured attribute + value so that
      // validateContradiction() can detect same-field conflicts.
      const label = `${field}: ${value}`;

      const result = await ctx.entityMemory.storeFact({
        entityNodeId: entityNode.id,
        label,
        properties: { attribute: field, value },
        confidence: confidence ?? 0.8,
        decayClass: (decay_class as DecayClass | undefined) ?? 'slow_decay',
        source,
        sensitivity: sensitivity as Sensitivity | undefined,
        sensitivityCategory: sensitivity_category,
      });

      if (result.stored) {
        // The execution-layer observer logs sensitivityFallback via the audit event,
        // but if this handler is called outside that observer (e.g. in a direct test or
        // future CLI integration), the fallback would otherwise be silent. Log defensively.
        if (result.sensitivityFallback) {
          ctx.log.warn(
            { entity, field, nodeId: result.nodeId, sensitivity: result.sensitivity },
            'memory-store: sensitivity in result may be inaccurate — stored node was unreadable after update (race/transient DB error)',
          );
        }
        ctx.log.info(
          { entity, field, action: result.action, nodeId: result.nodeId },
          'memory-store: fact stored',
        );
        return {
          success: true,
          data: {
            stored: true,
            action: result.action,
            node_id: result.nodeId,
            sensitivity: result.sensitivity,
          },
        };
      }

      // stored === false: conflict or rejected
      if (result.action === 'conflict') {
        ctx.log.warn(
          { entity, field, existingNodeId: result.existingNodeId },
          'memory-store: fact conflicts with existing KG data — surfacing to agent',
        );
        return {
          success: true,
          data: {
            stored: false,
            action: 'conflict',
            reason: result.conflict,
            existing_node_id: result.existingNodeId,
          },
        };
      }

      // action === 'rejected' (rate limit or entity node no longer exists)
      ctx.log.warn({ entity, field, reason: result.conflict }, 'memory-store: fact rejected');
      return {
        success: true,
        data: {
          stored: false,
          action: 'rejected',
          reason: result.conflict,
        },
      };
    } catch (err) {
      ctx.log.error({ err, entity, field }, 'memory-store: unexpected error');
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

// -- Helpers --

type KgNode = import('../../src/memory/types.js').KgNode;

/** Discriminated result from entity resolution. */
type ResolveResult =
  | { kind: 'found'; node: KgNode }
  | { kind: 'ambiguous'; candidates: KgNode[] }
  | { kind: 'not_found' };

/** Resolve an entity by label or direct ID.
 *
 * Returns candidates directly in the ambiguous case so the handler can build
 * the response without a second findEntities call, which would introduce a
 * race window and duplicate DB work.
 */
async function resolveEntity(ctx: SkillContext, entity: string): Promise<ResolveResult> {
  const mem = ctx.entityMemory!;

  const matches = await mem.findEntities(entity);

  if (matches.length === 1) return { kind: 'found', node: matches[0]! };
  if (matches.length > 1) return { kind: 'ambiguous', candidates: matches };

  // Zero label matches — try interpreting `entity` as a direct node ID.
  // This handles callers that have a UUID from a previous KG query and
  // want to attach a fact without doing another findEntities round-trip.
  const byId = await mem.getEntity(entity);
  if (byId) return { kind: 'found', node: byId };

  return { kind: 'not_found' };
}
