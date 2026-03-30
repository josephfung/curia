// handler.ts — template-reschedule skill implementation.
//
// Returns email composing guidelines for rescheduling emails — NOT a pre-filled
// email. The LLM uses these guidelines to compose naturally while following
// organizational policy.
//
// KG storage model:
//   - Anchor node: type=concept, label="template:reschedule"
//   - Custom policy stored as a fact node with label="email policy"
//   - decayClass=permanent (policies don't decay)

import type { SkillHandler, SkillContext, SkillResult, AgentPersona } from '../../src/skills/types.js';

function resolveSignature(persona?: AgentPersona): string {
  if (persona?.emailSignature) return persona.emailSignature;
  if (persona) return `${persona.displayName}, ${persona.title}`;
  return '';
}

const TEMPLATE_LABEL = 'template:reschedule';
const MAX_INPUT_LENGTH = 5000;

const DEFAULT_POLICY = {
  required_elements: [
    'Greeting addressing the recipient by name',
    'Reference the original meeting time so they know which meeting is affected',
    'Brief reason for rescheduling if provided (keep it concise, no over-explaining)',
    'List new proposed times as bullet points',
    'Invite the recipient to suggest alternatives',
    'Apologize for the inconvenience (once, briefly — not excessively)',
    'Professional sign-off with the agent signature',
  ],
  tone: 'Apologetic but confident. Acknowledge the inconvenience without being overly sorry.',
  structure: 'Greeting → reference original meeting → reason (if any) → new times → flexibility offer → apology → sign-off',
  constraints: [
    'Keep the body to 4-6 sentences plus the time list',
    'Subject line should include "Rescheduling" and the meeting topic',
    'Do not blame anyone for the reschedule',
    'Do not use exclamation marks',
  ],
  example: `Subject: Rescheduling — Q3 Planning

Hi Alice,

I'm writing on behalf of Joseph regarding your meeting originally scheduled for Monday, April 7 at 10:00 AM. Unfortunately, a scheduling conflict has come up and we need to reschedule.

Joseph is available at the following alternative times:

  • Wednesday, April 9 at 2:00 PM ET
  • Thursday, April 10 at 10:00 AM ET
  • Friday, April 11 at 11:00 AM ET

Would any of these work for you? If not, please suggest a time that's convenient and I'll do my best to accommodate.

Apologies for the inconvenience, and thank you for your flexibility.

Best regards,
Nathan Curia, Agent Chief of Staff`,
};

export class TemplateRescheduleHandler implements SkillHandler {
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
    const { recipient_name, sender_name, original_time, proposed_times, meeting_subject, reason } =
      ctx.input as {
        recipient_name?: string; sender_name?: string; original_time?: string;
        proposed_times?: string; meeting_subject?: string; reason?: string;
      };

    if (!recipient_name || typeof recipient_name !== 'string') return { success: false, error: 'Missing required input: recipient_name' };
    if (!sender_name || typeof sender_name !== 'string') return { success: false, error: 'Missing required input: sender_name' };
    if (!original_time || typeof original_time !== 'string') return { success: false, error: 'Missing required input: original_time' };
    if (!proposed_times || typeof proposed_times !== 'string') return { success: false, error: 'Missing required input: proposed_times' };

    if (recipient_name.length > MAX_INPUT_LENGTH) return { success: false, error: `recipient_name must be ${MAX_INPUT_LENGTH} characters or fewer` };
    if (sender_name.length > MAX_INPUT_LENGTH) return { success: false, error: `sender_name must be ${MAX_INPUT_LENGTH} characters or fewer` };
    if (original_time.length > MAX_INPUT_LENGTH) return { success: false, error: `original_time must be ${MAX_INPUT_LENGTH} characters or fewer` };
    if (proposed_times.length > MAX_INPUT_LENGTH) return { success: false, error: `proposed_times must be ${MAX_INPUT_LENGTH} characters or fewer` };

    const { policy, source } = await this.resolvePolicy(ctx);

    const context: Record<string, string> = {
      recipient_name, sender_name, original_time, proposed_times,
      agent_signature: resolveSignature(ctx.agentPersona),
    };
    if (meeting_subject) context.meeting_subject = meeting_subject;
    if (reason) context.reason = reason;

    ctx.log.info({ recipient_name, source }, 'Retrieved rescheduling email policy');
    return {
      success: true,
      data: {
        guidelines: policy, context, source,
        instructions: 'Use the guidelines to compose a rescheduling email. The guidelines define required elements, tone, structure, and constraints. The example shows the expected quality and format. Adapt naturally to the provided context — do not copy the example verbatim.',
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
        : (await ctx.entityMemory.createEntity({ type: 'concept', label: TEMPLATE_LABEL, properties: { category: 'email-policy', templateName: 'reschedule' }, source: 'skill:template-reschedule' })).id;

      await ctx.entityMemory.storeFact({ entityNodeId: anchorId, label: 'email policy', properties: { policy: custom_policy }, confidence: 1.0, decayClass: 'permanent', source: 'skill:template-reschedule' });
      ctx.log.info('Saved custom reschedule email policy to knowledge graph');
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
          await ctx.entityMemory.storeFact({ entityNodeId: existing[0]!.id, label: 'email policy', properties: { policy: '', cleared: true }, confidence: 1.0, decayClass: 'permanent', source: 'skill:template-reschedule' });
        }
      }
      ctx.log.info('Reset reschedule email policy to default');
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
