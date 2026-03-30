// handler.ts — knowledge-meeting-links skill implementation.
//
// Stores and retrieves personal meeting links (Zoom, Teams, etc.) in the
// knowledge graph. Each link is associated with a person name and platform.
//
// KG storage model:
//   - Anchor node: type=concept, label="meeting-links"
//   - Each link stored as a fact node with label="{person_name} {platform} link"
//     properties: { person_name, platform, link }
//   - decayClass=slow_decay (links change occasionally)

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

const ANCHOR_LABEL = 'meeting-links';

export class KnowledgeMeetingLinksHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const { action } = ctx.input as { action?: string };

    if (!action || !['store', 'retrieve'].includes(action)) {
      return { success: false, error: "Missing or invalid 'action' — must be 'store' or 'retrieve'" };
    }

    if (!ctx.entityMemory) {
      return { success: false, error: 'Knowledge graph not available — cannot store or retrieve meeting links' };
    }

    if (action === 'store') {
      return this.store(ctx);
    }
    return this.retrieve(ctx);
  }

  private async store(ctx: SkillContext): Promise<SkillResult> {
    const { person_name, platform, link } = ctx.input as {
      person_name?: string;
      platform?: string;
      link?: string;
    };

    if (!person_name || typeof person_name !== 'string') {
      return { success: false, error: 'Missing required input: person_name' };
    }
    if (!platform || typeof platform !== 'string') {
      return { success: false, error: 'Missing required input: platform' };
    }
    if (!link || typeof link !== 'string') {
      return { success: false, error: 'Missing required input: link' };
    }
    if (person_name.length > 500) {
      return { success: false, error: 'person_name must be 500 characters or fewer' };
    }
    if (platform.length > 100) {
      return { success: false, error: 'platform must be 100 characters or fewer' };
    }
    if (link.length > 2000) {
      return { success: false, error: 'link must be 2000 characters or fewer' };
    }

    try {
      const anchor = await this.findOrCreateAnchor(ctx);

      // Label includes person and platform so dedup detects updates to the
      // same person's link on the same platform.
      const factLabel = `${person_name} ${platform} link`;
      await ctx.entityMemory!.storeFact({
        entityNodeId: anchor.id,
        label: factLabel,
        properties: { person_name, platform: platform.toLowerCase(), link },
        confidence: 1.0,
        decayClass: 'slow_decay',
        source: 'skill:knowledge-meeting-links',
      });

      ctx.log.info({ person_name, platform }, 'Stored meeting link');
      return { success: true, data: { stored: true, person_name } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, person_name, platform }, 'Failed to store meeting link');
      return { success: false, error: `Failed to store: ${message}` };
    }
  }

  private async retrieve(ctx: SkillContext): Promise<SkillResult> {
    const { person_name } = ctx.input as { person_name?: string };

    try {
      const nodes = await ctx.entityMemory!.findEntities(ANCHOR_LABEL);
      if (nodes.length === 0) {
        return {
          success: true,
          data: { links: [], message: 'No meeting links stored yet.' },
        };
      }

      const factNodes = await ctx.entityMemory!.getFacts(nodes[0]!.id);
      let links = factNodes.map((f) => ({
        person_name: f.properties.person_name as string,
        platform: f.properties.platform as string,
        link: f.properties.link as string,
        last_updated: f.temporal.lastConfirmedAt.toISOString(),
      }));

      // Filter by person name if provided (case-insensitive partial match)
      if (person_name && typeof person_name === 'string') {
        const lowerName = person_name.toLowerCase();
        links = links.filter((l) => l.person_name?.toLowerCase().includes(lowerName));
      }

      ctx.log.info({ linkCount: links.length, filter: person_name ?? 'none' }, 'Retrieved meeting links');
      return { success: true, data: { links } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err }, 'Failed to retrieve meeting links');
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
      properties: { category: 'meeting-knowledge' },
      source: 'skill:knowledge-meeting-links',
    });
  }
}
