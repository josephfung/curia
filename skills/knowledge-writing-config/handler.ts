// handler.ts — knowledge-writing-config skill implementation.
//
// Stores and retrieves writing workflow configuration (writing guide URL,
// essays index URL, etc.) in the knowledge graph.
//
// KG storage model:
//   - Anchor node: type=concept, label="writing-config"
//   - Each value stored as a fact node with label=field name,
//     properties: { value, field }
//   - decayClass=permanent (config URLs are intentionally stable)

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

const ANCHOR_LABEL = 'writing-config';

export class KnowledgeWritingConfigHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const { action } = ctx.input as { action?: string };

    if (!action || !['store', 'retrieve'].includes(action)) {
      return { success: false, error: "Missing or invalid 'action' — must be 'store' or 'retrieve'" };
    }

    if (!ctx.entityMemory) {
      return { success: false, error: 'Knowledge graph not available — cannot store or retrieve writing config' };
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
    if (value.length > 2000) {
      return { success: false, error: 'value must be 2000 characters or fewer' };
    }

    try {
      const anchor = await this.findOrCreateAnchor(ctx);

      await ctx.entityMemory!.storeFact({
        entityNodeId: anchor.id,
        label: field,
        properties: { value, field },
        confidence: 1.0,
        // Config values are permanent — URLs Joseph provides are stable by design
        decayClass: 'permanent',
        source: 'skill:knowledge-writing-config',
      });

      ctx.log.info({ field }, 'Stored writing config value');
      return { success: true, data: { stored: true, field } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, field }, 'Failed to store writing config value');
      return { success: false, error: `Failed to store: ${message}` };
    }
  }

  private async retrieve(ctx: SkillContext): Promise<SkillResult> {
    try {
      const nodes = await ctx.entityMemory!.findEntities(ANCHOR_LABEL);
      if (nodes.length === 0) {
        return {
          success: true,
          data: { config: [], message: 'No writing config stored yet. Ask the CEO to provide the Writing Guide URL and Essays Index URL.' },
        };
      }

      const allFacts = await Promise.all(nodes.map((n) => ctx.entityMemory!.getFacts(n.id)));
      const config = allFacts.flat().map((f) => ({
        field: f.properties.field ?? f.label,
        value: f.properties.value,
      }));

      ctx.log.info({ fieldCount: config.length }, 'Retrieved writing config');
      return { success: true, data: { config } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err }, 'Failed to retrieve writing config');
      return { success: false, error: `Failed to retrieve: ${message}` };
    }
  }

  private async findOrCreateAnchor(ctx: SkillContext) {
    const existing = await ctx.entityMemory!.findEntities(ANCHOR_LABEL);
    if (existing.length > 0) {
      return existing[0]!;
    }

    const { entity } = await ctx.entityMemory!.createEntity({
      type: 'concept',
      label: ANCHOR_LABEL,
      properties: { category: 'writing-knowledge' },
      source: 'skill:knowledge-writing-config',
    });
    return entity;
  }
}
