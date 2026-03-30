// handler.ts — template-meeting-request skill implementation.
//
// Generates meeting request emails from a template. The built-in default
// template is used unless the user has stored a custom version in the
// knowledge graph. Users can save, retrieve, and reset custom templates.
//
// KG storage model:
//   - Anchor node: type=concept, label="template:meeting-request"
//   - Template body stored in the anchor node's properties.body field
//   - decayClass=permanent (templates don't decay)

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

const TEMPLATE_LABEL = 'template:meeting-request';

const DEFAULT_TEMPLATE = `Subject: Meeting Request — {{meeting_purpose}}

Hi {{recipient_name}},

I'm reaching out on behalf of {{sender_name}} to schedule a meeting{{purpose_clause}}.

{{sender_name}} is available at the following times:

{{proposed_times}}

{{duration_line}}{{location_line}}Please let me know which time works best for you, or suggest an alternative if none of these work.

Looking forward to connecting.

Best regards,
Nathan Curia
Agent Chief of Staff`;

/**
 * Fill template placeholders with provided variables.
 * Placeholders use {{variable_name}} syntax.
 */
function fillTemplate(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}

export class TemplateMeetingRequestHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const { action } = ctx.input as { action?: string };

    if (!action || !['generate', 'save', 'reset'].includes(action)) {
      return { success: false, error: "Missing or invalid 'action' — must be 'generate', 'save', or 'reset'" };
    }

    if (action === 'save') {
      return this.saveTemplate(ctx);
    }
    if (action === 'reset') {
      return this.resetTemplate(ctx);
    }
    return this.generate(ctx);
  }

  private async generate(ctx: SkillContext): Promise<SkillResult> {
    const { recipient_name, sender_name, proposed_times, meeting_purpose, meeting_duration, meeting_location } =
      ctx.input as {
        recipient_name?: string;
        sender_name?: string;
        proposed_times?: string;
        meeting_purpose?: string;
        meeting_duration?: string;
        meeting_location?: string;
      };

    if (!recipient_name || typeof recipient_name !== 'string') {
      return { success: false, error: 'Missing required input: recipient_name' };
    }
    if (!sender_name || typeof sender_name !== 'string') {
      return { success: false, error: 'Missing required input: sender_name' };
    }
    if (!proposed_times || typeof proposed_times !== 'string') {
      return { success: false, error: 'Missing required input: proposed_times' };
    }

    // Look up custom template from KG, fall back to built-in default
    const { template, source } = await this.resolveTemplate(ctx);

    // Build conditional clause fragments so the template reads naturally
    // whether optional fields are provided or not.
    const purposeClause = meeting_purpose ? ` to discuss ${meeting_purpose}` : '';
    const durationLine = meeting_duration ? `Duration: ${meeting_duration}\n` : '';
    const locationLine = meeting_location ? `Location: ${meeting_location}\n\n` : '\n';

    // Format proposed times as a bulleted list
    const formattedTimes = proposed_times
      .split(',')
      .map((t) => `  • ${t.trim()}`)
      .join('\n');

    const filled = fillTemplate(template, {
      recipient_name,
      sender_name,
      proposed_times: formattedTimes,
      meeting_purpose: meeting_purpose ?? 'Meeting',
      purpose_clause: purposeClause,
      duration_line: durationLine,
      location_line: locationLine,
    });

    // Split subject from body (first line is the subject)
    const lines = filled.split('\n');
    const subjectLine = lines[0] ?? '';
    const subject = subjectLine.replace(/^Subject:\s*/i, '').trim();
    // Skip the blank line after the subject
    const body = lines.slice(2).join('\n').trim();

    ctx.log.info({ recipient_name, source }, 'Generated meeting request email');
    return {
      success: true,
      data: { subject, body, template_source: source },
    };
  }

  private async saveTemplate(ctx: SkillContext): Promise<SkillResult> {
    const { custom_template } = ctx.input as { custom_template?: string };
    if (!custom_template || typeof custom_template !== 'string') {
      return { success: false, error: 'Missing required input: custom_template' };
    }
    if (custom_template.length > 10000) {
      return { success: false, error: 'custom_template must be 10000 characters or fewer' };
    }

    if (!ctx.entityMemory) {
      return { success: false, error: 'Knowledge graph not available — cannot save custom template' };
    }

    try {
      // Check if a custom template node already exists
      const existing = await ctx.entityMemory.findEntities(TEMPLATE_LABEL);
      if (existing.length > 0) {
        // Update the existing node's body — storeFact would create a child fact,
        // but we want to update the anchor node's properties directly.
        // Use search + create pattern: delete old, create new (KG doesn't expose
        // direct property updates on entity nodes through EntityMemory).
        // Actually, we store the template as a fact on the anchor node so we can
        // use storeFact's dedup/update logic.
        await ctx.entityMemory.storeFact({
          entityNodeId: existing[0]!.id,
          label: 'template body',
          properties: { body: custom_template },
          confidence: 1.0,
          decayClass: 'permanent',
          source: 'skill:template-meeting-request',
        });
      } else {
        // Create the anchor concept node, then store the template as a fact
        const anchor = await ctx.entityMemory.createEntity({
          type: 'concept',
          label: TEMPLATE_LABEL,
          properties: { category: 'email-template', templateName: 'meeting-request' },
          source: 'skill:template-meeting-request',
        });
        await ctx.entityMemory.storeFact({
          entityNodeId: anchor.id,
          label: 'template body',
          properties: { body: custom_template },
          confidence: 1.0,
          decayClass: 'permanent',
          source: 'skill:template-meeting-request',
        });
      }

      ctx.log.info('Saved custom meeting request template to knowledge graph');
      return { success: true, data: { saved: true } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err }, 'Failed to save custom template');
      return { success: false, error: `Failed to save template: ${message}` };
    }
  }

  private async resetTemplate(ctx: SkillContext): Promise<SkillResult> {
    if (!ctx.entityMemory) {
      // No KG means no custom template could exist — reset is a no-op
      return { success: true, data: { reset: true } };
    }

    try {
      const existing = await ctx.entityMemory.findEntities(TEMPLATE_LABEL);
      if (existing.length > 0) {
        // Remove all fact nodes linked to the anchor, then the anchor itself.
        // getFacts returns fact nodes; we need the KG store to delete them.
        // Since EntityMemory doesn't expose deleteNode, we clear by removing
        // the facts. The anchor node remains but with no template body fact,
        // so resolveTemplate will fall back to the default.
        const facts = await ctx.entityMemory.getFacts(existing[0]!.id);
        // We can't delete nodes through EntityMemory — but we can store a
        // "cleared" marker so resolveTemplate knows to use the default.
        // Simpler: just store a fact with body="" to signal "use default".
        if (facts.length > 0) {
          await ctx.entityMemory.storeFact({
            entityNodeId: existing[0]!.id,
            label: 'template body',
            properties: { body: '', cleared: true },
            confidence: 1.0,
            decayClass: 'permanent',
            source: 'skill:template-meeting-request',
          });
        }
      }

      ctx.log.info('Reset meeting request template to default');
      return { success: true, data: { reset: true } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err }, 'Failed to reset template');
      return { success: false, error: `Failed to reset template: ${message}` };
    }
  }

  /**
   * Look up a custom template from the knowledge graph.
   * Returns the custom template if found and non-empty, otherwise the built-in default.
   */
  private async resolveTemplate(ctx: SkillContext): Promise<{ template: string; source: 'default' | 'custom' }> {
    if (!ctx.entityMemory) {
      return { template: DEFAULT_TEMPLATE, source: 'default' };
    }

    try {
      const nodes = await ctx.entityMemory.findEntities(TEMPLATE_LABEL);
      if (nodes.length === 0) {
        return { template: DEFAULT_TEMPLATE, source: 'default' };
      }

      const facts = await ctx.entityMemory.getFacts(nodes[0]!.id);
      // Find the most recent template body fact (by lastConfirmedAt)
      const templateFact = facts
        .filter((f) => f.label === 'template body')
        .sort((a, b) => b.temporal.lastConfirmedAt.getTime() - a.temporal.lastConfirmedAt.getTime())[0];

      if (!templateFact) {
        return { template: DEFAULT_TEMPLATE, source: 'default' };
      }

      const body = templateFact.properties.body;
      if (typeof body === 'string' && body.length > 0 && !templateFact.properties.cleared) {
        return { template: body, source: 'custom' };
      }

      return { template: DEFAULT_TEMPLATE, source: 'default' };
    } catch (err) {
      // KG lookup failure is non-fatal — fall back to default
      ctx.log.warn({ err }, 'Failed to look up custom template, using default');
      return { template: DEFAULT_TEMPLATE, source: 'default' };
    }
  }
}
