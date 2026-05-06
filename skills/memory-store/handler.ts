// handler.ts — memory-store skill.
//
// Writes a named fact about a known entity to the knowledge graph.
//
// Entity resolution:
//   - If `entity` is a UUID → direct getEntity() lookup; returns entity_not_found if gone.
//   - Otherwise → entityMemory.resolveOrCreate() which finds or auto-creates the entity.
//
// Possible outcomes:
//   created       — new fact node created and linked to the entity
//   updated       — near-duplicate found; existing node merged in place
//   conflict      — contradicts an existing attribute fact; agent should surface to CEO
//   entity_not_found — UUID entity no longer exists, or entity gone between resolution and write
//   rate_limited  — write limit (50 per task) exceeded

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { DECAY_CLASSES, SENSITIVITY_LEVELS, NODE_TYPES } from '../../src/memory/types.js';
import type { DecayClass, Sensitivity, NodeType } from '../../src/memory/types.js';

const DECAY_CLASSES_SET: ReadonlySet<string> = new Set(DECAY_CLASSES);
const SENSITIVITY_LEVELS_SET: ReadonlySet<string> = new Set(SENSITIVITY_LEVELS);
// 'fact' is not a valid entity type — entities hold facts as linked nodes, not as themselves.
const ENTITY_NODE_TYPES = NODE_TYPES.filter(t => t !== 'fact');
const ENTITY_NODE_TYPES_SET: ReadonlySet<string> = new Set(ENTITY_NODE_TYPES);

// UUID pattern — used to detect when the caller is passing a node ID directly.
// Matches any UUID-shaped string (all versions/variants), not just v4.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
      entity_type,
    } = ctx.input as {
      entity?: string;
      field?: string;
      value?: string;
      source?: string;
      confidence?: number;
      decay_class?: string;
      sensitivity?: string;
      sensitivity_category?: string;
      entity_type?: string;
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

    if (entity_type !== undefined && !ENTITY_NODE_TYPES_SET.has(entity_type)) {
      return {
        success: false,
        error: `Unknown entity_type: "${entity_type}". Valid values: ${ENTITY_NODE_TYPES.join(', ')}`,
      };
    }

    if (!ctx.entityMemory) {
      ctx.log.error('memory-store: entity memory not available');
      return { success: false, error: 'Entity memory not available — database not configured' };
    }

    try {
      // --- Entity resolution ---
      //
      // UUID → direct getEntity() lookup (caller has a specific node ID).
      // Plain name → resolveOrCreate() which finds or auto-creates the entity.
      //
      // This means callers can pass either a human-readable name or a UUID obtained
      // from contact-lookup / a previous KG query. Names always succeed (auto-create
      // if not found); UUIDs return entity_not_found if the node was deleted.

      const resolvedEntityType = (entity_type as NodeType | undefined) ?? 'concept';
      let entityNode: KgNode;

      if (UUID_PATTERN.test(entity)) {
        // entity_type has no effect when a UUID is supplied — the node type is already
        // determined by the existing KG node. Log a warning so LLM callers notice the mismatch.
        if (entity_type !== undefined) {
          ctx.log.debug(
            { entity, entity_type },
            'memory-store: entity_type hint is ignored when entity is a UUID — type is fixed by the existing KG node',
          );
        }
        const byId = await ctx.entityMemory.getEntity(entity);
        if (!byId) {
          ctx.log.debug({ entity }, 'memory-store: entity UUID not found in KG');
          return {
            success: true,
            data: {
              stored: false,
              action: 'entity_not_found',
              reason: `Entity node not found: "${entity}". The entity may have been deleted — retry with the entity name to auto-create it.`,
            },
          };
        }
        entityNode = byId;
      } else {
        const resolved = await ctx.entityMemory.resolveOrCreate({
          label: entity,
          type: resolvedEntityType,
          source,
          confidence: 0.6,
        });

        if (resolved.kind === 'ambiguous') {
          ctx.log.debug({ entity, count: resolved.candidates.length }, 'memory-store: ambiguous entity label');
          return {
            success: true,
            data: {
              ambiguous: true,
              candidates: resolved.candidates.map(n => ({ id: n.id, label: n.label, type: n.type })),
            },
          };
        }

        entityNode = resolved.node;
      }

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

      if (result.action === 'entity_not_found') {
        // Validator race guard — entity existed at resolution time but was deleted before write.
        ctx.log.warn({ entity, field }, 'memory-store: entity node gone at write time — validator race');
        return {
          success: true,
          data: {
            stored: false,
            action: 'entity_not_found',
            reason: result.conflict,
          },
        };
      }

      // action === 'rate_limited'
      ctx.log.warn({ entity, field, reason: result.conflict }, 'memory-store: write rate limit reached');
      return {
        success: true,
        data: {
          stored: false,
          action: 'rate_limited',
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
