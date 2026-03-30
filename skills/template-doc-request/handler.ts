// handler.ts — template-doc-request skill implementation.
//
// Returns email composing guidelines for pre-meeting document requests.
//
// KG storage model:
//   - Anchor node: type=concept, label="template:doc-request"
//   - Custom policy stored as a fact node with label="email policy"
//   - decayClass=permanent

import type { SkillHandler, SkillContext, SkillResult, AgentPersona } from '../../src/skills/types.js';

function resolveSignature(persona?: AgentPersona): string {
  if (persona?.emailSignature) return persona.emailSignature;
  if (persona) return `${persona.displayName}, ${persona.title}`;
  return '';
}

const TEMPLATE_LABEL = 'template:doc-request';
const MAX_INPUT_LENGTH = 5000;

const DEFAULT_POLICY = {
  required_elements: [
    'Greeting addressing the recipient by name',
    'Reference the upcoming meeting (topic and time)',
    'Explain the purpose — helping the sender prepare for the meeting',
    'List the requested documents/materials as bullet points',
    'Include a deadline if provided',
    'Offer to clarify what is needed',
    'Professional sign-off with the agent signature',
  ],
  tone: 'Polite and helpful. Frame the request as enabling a productive meeting, not as a demand.',
  structure: 'Greeting → meeting reference → purpose → document list → deadline (if any) → offer to clarify → sign-off',
  constraints: [
    'Keep the body to 4-6 sentences plus the materials list',
    'Subject line should include "Materials Needed" and the meeting topic',
    'List documents as bullet points, not inline',
    'Frame the deadline politely ("If possible, by...") not as an ultimatum',
  ],
  example: `Subject: Materials Needed — Board Meeting (April 15)

Hi Sarah,

I'm reaching out on behalf of Joseph ahead of your upcoming Board Meeting on Tuesday, April 15 at 9:00 AM.

To help Joseph prepare, could you please share the following materials?

  • Q1 financial summary
  • Updated headcount projections
  • Draft board slide deck

If possible, please share these by Friday, April 11 so there's time to review before the meeting.

If you have any questions or need clarification on what's needed, please don't hesitate to reach out.

Thank you in advance.

Best regards,
Nathan Curia, Agent Chief of Staff`,
};

export class TemplateDocRequestHandler implements SkillHandler {
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
    const { recipient_name, sender_name, meeting_subject, meeting_time, documents_requested, deadline } =
      ctx.input as {
        recipient_name?: string; sender_name?: string; meeting_subject?: string;
        meeting_time?: string; documents_requested?: string; deadline?: string;
      };

    if (!recipient_name || typeof recipient_name !== 'string') return { success: false, error: 'Missing required input: recipient_name' };
    if (!sender_name || typeof sender_name !== 'string') return { success: false, error: 'Missing required input: sender_name' };
    if (!meeting_subject || typeof meeting_subject !== 'string') return { success: false, error: 'Missing required input: meeting_subject' };
    if (!meeting_time || typeof meeting_time !== 'string') return { success: false, error: 'Missing required input: meeting_time' };
    if (!documents_requested || typeof documents_requested !== 'string') return { success: false, error: 'Missing required input: documents_requested' };

    if (recipient_name.length > MAX_INPUT_LENGTH) return { success: false, error: `recipient_name must be ${MAX_INPUT_LENGTH} characters or fewer` };
    if (sender_name.length > MAX_INPUT_LENGTH) return { success: false, error: `sender_name must be ${MAX_INPUT_LENGTH} characters or fewer` };
    if (meeting_subject.length > MAX_INPUT_LENGTH) return { success: false, error: `meeting_subject must be ${MAX_INPUT_LENGTH} characters or fewer` };
    if (meeting_time.length > MAX_INPUT_LENGTH) return { success: false, error: `meeting_time must be ${MAX_INPUT_LENGTH} characters or fewer` };
    if (documents_requested.length > MAX_INPUT_LENGTH) return { success: false, error: `documents_requested must be ${MAX_INPUT_LENGTH} characters or fewer` };

    const { policy, source } = await this.resolvePolicy(ctx);

    const context: Record<string, string> = {
      recipient_name, sender_name, meeting_subject, meeting_time, documents_requested,
      agent_signature: resolveSignature(ctx.agentPersona),
    };
    if (deadline) context.deadline = deadline;

    ctx.log.info({ recipient_name, source }, 'Retrieved doc request email policy');
    return {
      success: true,
      data: {
        guidelines: policy, context, source,
        instructions: 'Use the guidelines to compose a document request email. Adapt naturally to the provided context — do not copy the example verbatim.',
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
        : (await ctx.entityMemory.createEntity({ type: 'concept', label: TEMPLATE_LABEL, properties: { category: 'email-policy', templateName: 'doc-request' }, source: 'skill:template-doc-request' })).id;
      await ctx.entityMemory.storeFact({ entityNodeId: anchorId, label: 'email policy', properties: { policy: custom_policy }, confidence: 1.0, decayClass: 'permanent', source: 'skill:template-doc-request' });
      ctx.log.info('Saved custom doc request email policy');
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
          await ctx.entityMemory.storeFact({ entityNodeId: existing[0]!.id, label: 'email policy', properties: { policy: '', cleared: true }, confidence: 1.0, decayClass: 'permanent', source: 'skill:template-doc-request' });
        }
      }
      ctx.log.info('Reset doc request email policy to default');
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
