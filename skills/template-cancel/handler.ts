// handler.ts — template-cancel skill implementation.
//
// Returns email composing guidelines for cancellation emails.
//
// KG storage model:
//   - Anchor node: type=concept, label="template:cancel"
//   - Custom policy stored as a fact node with label="email policy"
//   - decayClass=permanent

import type { SkillHandler, SkillContext, SkillResult, AgentPersona } from '../../src/skills/types.js';

function resolveSignature(persona?: AgentPersona): string {
  if (persona?.emailSignature) return persona.emailSignature;
  if (persona) return `${persona.displayName}, ${persona.title}`;
  return '';
}

const TEMPLATE_LABEL = 'template:cancel';
const MAX_INPUT_LENGTH = 5000;

const DEFAULT_POLICY = {
  required_elements: [
    'Greeting addressing the recipient by name',
    'Reference the specific meeting (subject and time) being canceled',
    'Brief reason for cancellation if provided (keep concise)',
    'Offer to reschedule unless explicitly told not to',
    'Thank them for their understanding',
    'Professional sign-off with the agent signature',
  ],
  tone: 'Respectful and direct. Acknowledge the disruption without excessive apology.',
  structure: 'Greeting → identify the meeting → cancellation statement → reason (if any) → reschedule offer (if applicable) → thanks → sign-off',
  constraints: [
    'Keep the body to 3-5 sentences',
    'Subject line should include "Cancellation" and the meeting topic',
    'Do not over-explain or justify excessively',
    'One apology is enough — do not repeat it',
  ],
  example: `Subject: Cancellation — Q3 Planning

Hi Alice,

I'm writing on behalf of Joseph regarding your meeting scheduled for Monday, April 7 at 10:00 AM (Q3 Planning).

Unfortunately, we need to cancel this meeting. If you'd like to reschedule, please let me know your availability and I'll find a time that works.

Thank you for your understanding.

Best regards,
Nathan Curia, Agent Chief of Staff`,
};

export class TemplateCancelHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const { action } = ctx.input as { action?: string };
    if (!action || !['generate', 'save', 'reset'].includes(action)) {
      return { success: false, error: "Missing or invalid 'action' — must be 'generate', 'save', or 'reset'" };
    }
    if (action === 'save') return this.savePolicy(ctx);
    if (action === 'reset') return this.resetPolicy(ctx);
    return this.generate(ctx);
  }

  private async generate(ctx: SkillContext): Promise<SkillResult> {
    const { recipient_name, sender_name, meeting_subject, meeting_time, reason, offer_reschedule } =
      ctx.input as {
        recipient_name?: string; sender_name?: string; meeting_subject?: string;
        meeting_time?: string; reason?: string; offer_reschedule?: boolean;
      };

    if (!recipient_name || typeof recipient_name !== 'string') return { success: false, error: 'Missing required input: recipient_name' };
    if (!sender_name || typeof sender_name !== 'string') return { success: false, error: 'Missing required input: sender_name' };
    if (!meeting_subject || typeof meeting_subject !== 'string') return { success: false, error: 'Missing required input: meeting_subject' };
    if (!meeting_time || typeof meeting_time !== 'string') return { success: false, error: 'Missing required input: meeting_time' };

    if (recipient_name.length > MAX_INPUT_LENGTH) return { success: false, error: `recipient_name must be ${MAX_INPUT_LENGTH} characters or fewer` };
    if (sender_name.length > MAX_INPUT_LENGTH) return { success: false, error: `sender_name must be ${MAX_INPUT_LENGTH} characters or fewer` };
    if (meeting_subject.length > MAX_INPUT_LENGTH) return { success: false, error: `meeting_subject must be ${MAX_INPUT_LENGTH} characters or fewer` };
    if (meeting_time.length > MAX_INPUT_LENGTH) return { success: false, error: `meeting_time must be ${MAX_INPUT_LENGTH} characters or fewer` };

    const { policy, source } = await this.resolvePolicy(ctx);

    const context: Record<string, string | boolean> = {
      recipient_name, sender_name, meeting_subject, meeting_time,
      offer_reschedule: offer_reschedule !== false,
      agent_signature: resolveSignature(ctx.agentPersona),
    };
    if (reason) context.reason = reason;

    ctx.log.info({ recipient_name, source }, 'Retrieved cancellation email policy');
    return {
      success: true,
      data: {
        guidelines: policy, context, source,
        instructions: 'Use the guidelines to compose a cancellation email. Adapt naturally to the provided context — do not copy the example verbatim. If offer_reschedule is false, omit the reschedule offer.',
      },
    };
  }

  private async savePolicy(ctx: SkillContext): Promise<SkillResult> {
    const { custom_policy } = ctx.input as { custom_policy?: string };
    if (!custom_policy || typeof custom_policy !== 'string') return { success: false, error: 'Missing required input: custom_policy' };
    if (custom_policy.length > 10000) return { success: false, error: 'custom_policy must be 10000 characters or fewer' };
    if (!ctx.entityMemory) return { success: false, error: 'Knowledge graph not available — cannot save custom policy' };

    try {
      const existing = await ctx.entityMemory.findEntities(TEMPLATE_LABEL);
      const anchorId = existing.length > 0
        ? existing[0]!.id
        : (await ctx.entityMemory.createEntity({ type: 'concept', label: TEMPLATE_LABEL, properties: { category: 'email-policy', templateName: 'cancel' }, source: 'skill:template-cancel' })).id;
      await ctx.entityMemory.storeFact({ entityNodeId: anchorId, label: 'email policy', properties: { policy: custom_policy }, confidence: 1.0, decayClass: 'permanent', source: 'skill:template-cancel' });
      ctx.log.info('Saved custom cancellation email policy');
      return { success: true, data: { saved: true } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err }, 'Failed to save custom policy');
      return { success: false, error: `Failed to save policy: ${message}` };
    }
  }

  private async resetPolicy(ctx: SkillContext): Promise<SkillResult> {
    if (!ctx.entityMemory) return { success: true, data: { reset: true } };
    try {
      const existing = await ctx.entityMemory.findEntities(TEMPLATE_LABEL);
      if (existing.length > 0) {
        const facts = await ctx.entityMemory.getFacts(existing[0]!.id);
        if (facts.length > 0) {
          await ctx.entityMemory.storeFact({ entityNodeId: existing[0]!.id, label: 'email policy', properties: { policy: '', cleared: true }, confidence: 1.0, decayClass: 'permanent', source: 'skill:template-cancel' });
        }
      }
      ctx.log.info('Reset cancellation email policy to default');
      return { success: true, data: { reset: true } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err }, 'Failed to reset policy');
      return { success: false, error: `Failed to reset policy: ${message}` };
    }
  }

  private async resolvePolicy(ctx: SkillContext): Promise<{ policy: unknown; source: 'default' | 'custom' }> {
    if (!ctx.entityMemory) return { policy: DEFAULT_POLICY, source: 'default' };
    try {
      const nodes = await ctx.entityMemory.findEntities(TEMPLATE_LABEL);
      if (nodes.length === 0) return { policy: DEFAULT_POLICY, source: 'default' };
      const facts = await ctx.entityMemory.getFacts(nodes[0]!.id);
      const policyFact = facts.filter((f) => f.label === 'email policy').sort((a, b) => b.temporal.lastConfirmedAt.getTime() - a.temporal.lastConfirmedAt.getTime())[0];
      if (!policyFact) return { policy: DEFAULT_POLICY, source: 'default' };
      const rawPolicy = policyFact.properties.policy;
      if (typeof rawPolicy === 'string' && rawPolicy.length > 0 && !policyFact.properties.cleared) {
        try { return { policy: JSON.parse(rawPolicy) as unknown, source: 'custom' }; } catch { return { policy: { custom_guidelines: rawPolicy, note: 'Custom guidelines that override the default policy.' }, source: 'custom' }; }
      }
      return { policy: DEFAULT_POLICY, source: 'default' };
    } catch (err) {
      ctx.log.warn({ err }, 'Failed to look up custom policy, using default');
      return { policy: DEFAULT_POLICY, source: 'default' };
    }
  }
}
