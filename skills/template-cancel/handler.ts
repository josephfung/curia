// handler.ts — template-cancel skill implementation.
//
// Generates meeting cancellation emails from a template. Built-in default
// template is used unless the user has stored a custom version in the KG.
//
// KG storage model:
//   - Anchor node: type=concept, label="template:cancel"
//   - Template body stored as a fact node with label="template body"
//   - decayClass=permanent (templates don't decay)

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

const TEMPLATE_LABEL = 'template:cancel';

const DEFAULT_TEMPLATE = `Subject: Cancellation — {{meeting_subject}}

Hi {{recipient_name}},

I'm writing on behalf of {{sender_name}} regarding your meeting scheduled for {{meeting_time}} ({{meeting_subject}}).

Unfortunately, we need to cancel this meeting.{{reason_clause}}

{{reschedule_clause}}Thank you for your understanding.

Best regards,
Nathan Curia
Agent Chief of Staff`;

const MAX_INPUT_LENGTH = 5000;

function fillTemplate(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  result = result.replace(/\{\{[^}]+\}\}/g, '');
  return result;
}

export class TemplateCancelHandler implements SkillHandler {
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
    const { recipient_name, sender_name, meeting_subject, meeting_time, reason, offer_reschedule } =
      ctx.input as {
        recipient_name?: string;
        sender_name?: string;
        meeting_subject?: string;
        meeting_time?: string;
        reason?: string;
        offer_reschedule?: boolean;
      };

    if (!recipient_name || typeof recipient_name !== 'string') {
      return { success: false, error: 'Missing required input: recipient_name' };
    }
    if (!sender_name || typeof sender_name !== 'string') {
      return { success: false, error: 'Missing required input: sender_name' };
    }
    if (!meeting_subject || typeof meeting_subject !== 'string') {
      return { success: false, error: 'Missing required input: meeting_subject' };
    }
    if (!meeting_time || typeof meeting_time !== 'string') {
      return { success: false, error: 'Missing required input: meeting_time' };
    }

    if (recipient_name.length > MAX_INPUT_LENGTH) {
      return { success: false, error: `recipient_name must be ${MAX_INPUT_LENGTH} characters or fewer` };
    }
    if (sender_name.length > MAX_INPUT_LENGTH) {
      return { success: false, error: `sender_name must be ${MAX_INPUT_LENGTH} characters or fewer` };
    }
    if (meeting_subject.length > MAX_INPUT_LENGTH) {
      return { success: false, error: `meeting_subject must be ${MAX_INPUT_LENGTH} characters or fewer` };
    }
    if (meeting_time.length > MAX_INPUT_LENGTH) {
      return { success: false, error: `meeting_time must be ${MAX_INPUT_LENGTH} characters or fewer` };
    }

    const { template, source } = await this.resolveTemplate(ctx);

    const reasonClause = reason ? ` ${reason}` : '';
    // Default to offering reschedule unless explicitly set to false
    const shouldOfferReschedule = offer_reschedule !== false;
    const rescheduleClause = shouldOfferReschedule
      ? `If you'd like to reschedule, please let me know your availability and I'll find a time that works.\n\n`
      : '';

    const filled = fillTemplate(template, {
      recipient_name,
      sender_name,
      meeting_subject,
      meeting_time,
      reason_clause: reasonClause,
      reschedule_clause: rescheduleClause,
    });

    const lines = filled.split('\n');
    const subjectLine = lines[0] ?? '';
    const subject = subjectLine.replace(/^Subject:\s*/i, '').trim();
    const body = lines.slice(2).join('\n').trim();

    ctx.log.info({ recipient_name, source }, 'Generated cancellation email');
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
      const existing = await ctx.entityMemory.findEntities(TEMPLATE_LABEL);
      if (existing.length > 0) {
        await ctx.entityMemory.storeFact({
          entityNodeId: existing[0]!.id,
          label: 'template body',
          properties: { body: custom_template },
          confidence: 1.0,
          decayClass: 'permanent',
          source: 'skill:template-cancel',
        });
      } else {
        const anchor = await ctx.entityMemory.createEntity({
          type: 'concept',
          label: TEMPLATE_LABEL,
          properties: { category: 'email-template', templateName: 'cancel' },
          source: 'skill:template-cancel',
        });
        await ctx.entityMemory.storeFact({
          entityNodeId: anchor.id,
          label: 'template body',
          properties: { body: custom_template },
          confidence: 1.0,
          decayClass: 'permanent',
          source: 'skill:template-cancel',
        });
      }

      ctx.log.info('Saved custom cancellation template to knowledge graph');
      return { success: true, data: { saved: true } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err }, 'Failed to save custom template');
      return { success: false, error: `Failed to save template: ${message}` };
    }
  }

  private async resetTemplate(ctx: SkillContext): Promise<SkillResult> {
    if (!ctx.entityMemory) {
      return { success: true, data: { reset: true } };
    }

    try {
      const existing = await ctx.entityMemory.findEntities(TEMPLATE_LABEL);
      if (existing.length > 0) {
        const facts = await ctx.entityMemory.getFacts(existing[0]!.id);
        if (facts.length > 0) {
          await ctx.entityMemory.storeFact({
            entityNodeId: existing[0]!.id,
            label: 'template body',
            properties: { body: '', cleared: true },
            confidence: 1.0,
            decayClass: 'permanent',
            source: 'skill:template-cancel',
          });
        }
      }

      ctx.log.info('Reset cancellation template to default');
      return { success: true, data: { reset: true } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err }, 'Failed to reset template');
      return { success: false, error: `Failed to reset template: ${message}` };
    }
  }

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
      ctx.log.warn({ err }, 'Failed to look up custom template, using default');
      return { template: DEFAULT_TEMPLATE, source: 'default' };
    }
  }
}
