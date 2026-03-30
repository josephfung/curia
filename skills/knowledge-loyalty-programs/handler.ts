// handler.ts — knowledge-loyalty-programs skill implementation.
//
// Stores and retrieves loyalty program information (frequent flyer numbers,
// hotel rewards, etc.) in the knowledge graph.
//
// KG storage model:
//   - Anchor node: type=concept, label="loyalty-programs"
//   - Each program stored as a fact node with label=program name,
//     properties: { program_name, member_number, tier, notes }
//   - decayClass=permanent (loyalty numbers don't change often)

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

const ANCHOR_LABEL = 'loyalty-programs';

export class KnowledgeLoyaltyProgramsHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const { action } = ctx.input as { action?: string };

    if (!action || !['store', 'retrieve'].includes(action)) {
      return { success: false, error: "Missing or invalid 'action' — must be 'store' or 'retrieve'" };
    }

    if (!ctx.entityMemory) {
      return { success: false, error: 'Knowledge graph not available — cannot store or retrieve loyalty programs' };
    }

    if (action === 'store') {
      return this.store(ctx);
    }
    return this.retrieve(ctx);
  }

  private async store(ctx: SkillContext): Promise<SkillResult> {
    const { program_name, member_number, tier, notes } = ctx.input as {
      program_name?: string;
      member_number?: string;
      tier?: string;
      notes?: string;
    };

    if (!program_name || typeof program_name !== 'string') {
      return { success: false, error: 'Missing required input: program_name' };
    }
    if (!member_number || typeof member_number !== 'string') {
      return { success: false, error: 'Missing required input: member_number' };
    }
    if (program_name.length > 500) {
      return { success: false, error: 'program_name must be 500 characters or fewer' };
    }
    if (member_number.length > 200) {
      return { success: false, error: 'member_number must be 200 characters or fewer' };
    }
    if (tier && tier.length > 100) {
      return { success: false, error: 'tier must be 100 characters or fewer' };
    }
    if (notes && notes.length > 2000) {
      return { success: false, error: 'notes must be 2000 characters or fewer' };
    }

    try {
      const anchor = await this.findOrCreateAnchor(ctx);

      // Label is the program name so dedup detects updates to the same program
      await ctx.entityMemory!.storeFact({
        entityNodeId: anchor.id,
        label: program_name,
        properties: {
          program_name,
          member_number,
          ...(tier ? { tier } : {}),
          ...(notes ? { notes } : {}),
        },
        confidence: 1.0,
        decayClass: 'permanent',
        source: 'skill:knowledge-loyalty-programs',
      });

      ctx.log.info({ program_name }, 'Stored loyalty program');
      return { success: true, data: { stored: true, program_name } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, program_name }, 'Failed to store loyalty program');
      return { success: false, error: `Failed to store: ${message}` };
    }
  }

  private async retrieve(ctx: SkillContext): Promise<SkillResult> {
    try {
      const nodes = await ctx.entityMemory!.findEntities(ANCHOR_LABEL);
      if (nodes.length === 0) {
        return {
          success: true,
          data: { programs: [], message: 'No loyalty programs stored yet.' },
        };
      }

      const factNodes = await ctx.entityMemory!.getFacts(nodes[0]!.id);
      const programs = factNodes.map((f) => ({
        program_name: f.properties.program_name ?? f.label,
        member_number: f.properties.member_number,
        tier: f.properties.tier ?? null,
        notes: f.properties.notes ?? null,
        last_updated: f.temporal.lastConfirmedAt.toISOString(),
      }));

      ctx.log.info({ programCount: programs.length }, 'Retrieved loyalty programs');
      return { success: true, data: { programs } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err }, 'Failed to retrieve loyalty programs');
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
      properties: { category: 'loyalty-knowledge' },
      source: 'skill:knowledge-loyalty-programs',
    });
  }
}
