// handler.ts — knowledge-travel-preferences skill implementation.
//
// Stores and retrieves travel preferences (airline, seat, hotel, dietary, etc.)
// in the knowledge graph.
//
// KG storage model:
//   - Anchor node: type=concept, label="travel-preferences"
//   - Each preference stored as a fact node with label=field name,
//     properties: { value, field }
//   - decayClass=slow_decay (travel preferences change occasionally)

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

const ANCHOR_LABEL = 'travel-preferences';

export class KnowledgeTravelPreferencesHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const { action } = ctx.input as { action?: string };

    if (!action || !['store', 'retrieve'].includes(action)) {
      return { success: false, error: "Missing or invalid 'action' — must be 'store' or 'retrieve'" };
    }

    if (!ctx.entityMemory) {
      return { success: false, error: 'Knowledge graph not available — cannot store or retrieve travel preferences' };
    }

    if (action === 'store') {
      return this.store(ctx);
    }
    return this.retrieve(ctx);
  }

  private async store(ctx: SkillContext): Promise<SkillResult> {
    const { field, value } = ctx.input as { field?: string; value?: string };

    if (!field || typeof field !== 'string') {
      return { success: false, error: 'Missing required input: field' };
    }
    if (!value || typeof value !== 'string') {
      return { success: false, error: 'Missing required input: value' };
    }
    if (field.length > 200) {
      return { success: false, error: 'field must be 200 characters or fewer' };
    }
    if (value.length > 5000) {
      return { success: false, error: 'value must be 5000 characters or fewer' };
    }

    try {
      const anchor = await this.findOrCreateAnchor(ctx);

      await ctx.entityMemory!.storeFact({
        entityNodeId: anchor.id,
        label: field,
        properties: { value, field },
        confidence: 1.0,
        decayClass: 'slow_decay',
        source: 'skill:knowledge-travel-preferences',
      });

      ctx.log.info({ field }, 'Stored travel preference');
      return { success: true, data: { stored: true, field } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, field }, 'Failed to store travel preference');
      return { success: false, error: `Failed to store: ${message}` };
    }
  }

  private async retrieve(ctx: SkillContext): Promise<SkillResult> {
    try {
      const nodes = await ctx.entityMemory!.findEntities(ANCHOR_LABEL);
      if (nodes.length === 0) {
        return {
          success: true,
          data: { preferences: [], message: 'No travel preferences stored yet.' },
        };
      }

      const allFacts = await Promise.all(nodes.map((n) => ctx.entityMemory!.getFacts(n.id)));
      const preferences = allFacts.flat().map((f) => ({
        field: f.properties.field ?? f.label,
        value: f.properties.value,
        last_updated: f.temporal.lastConfirmedAt.toISOString(),
      }));

      ctx.log.info({ prefCount: preferences.length }, 'Retrieved travel preferences');
      return { success: true, data: { preferences } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err }, 'Failed to retrieve travel preferences');
      return { success: false, error: `Failed to retrieve: ${message}` };
    }
  }

  private async findOrCreateAnchor(ctx: SkillContext) {
    const existing = await ctx.entityMemory!.findEntities(ANCHOR_LABEL);
    if (existing.length > 0) {
      return existing[0]!;
    }

    return ctx.entityMemory!.createEntity({
      type: 'concept',
      label: ANCHOR_LABEL,
      properties: { category: 'travel-knowledge' },
      source: 'skill:knowledge-travel-preferences',
    });
  }
}
