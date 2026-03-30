// handler.ts — template-meeting-request skill implementation.
//
// Returns email composing guidelines for meeting requests — NOT a pre-filled
// email. The LLM uses these guidelines (required elements, tone, structure,
// example) to compose the actual email, combining organizational consistency
// with natural language fluency.
//
// This is better than both rigid templates (can't adapt) and bare LLM behavior
// (no organizational consistency). The skill enforces policy; the LLM provides
// fluency.
//
// KG storage model:
//   - Anchor node: type=concept, label="template:meeting-request"
//   - Custom policy stored as a fact node with label="email policy"
//   - decayClass=permanent (policies don't decay)

import type { SkillHandler, SkillContext, SkillResult, AgentPersona } from '../../src/skills/types.js';

/** Build the email signature from the agent persona, or a safe fallback. */
function resolveSignature(persona?: AgentPersona): string {
  if (persona?.emailSignature) return persona.emailSignature;
  if (persona) return `${persona.displayName}, ${persona.title}`;
  return '';
}

const TEMPLATE_LABEL = 'template:meeting-request';

const MAX_INPUT_LENGTH = 5000;

/**
 * Built-in default policy for meeting request emails. Stored as structured
 * guidelines so the LLM knows what to include, how to structure it, and
 * what tone to use — then composes naturally.
 */
const DEFAULT_POLICY = {
  required_elements: [
    'Greeting addressing the recipient by name',
    'State who is requesting the meeting (the sender) and the purpose',
    'List proposed times as bullet points (at least 2-3 options)',
    'Include meeting duration if provided',
    'Include meeting location/format if provided (Zoom, in-person, etc.)',
    'Offer flexibility — invite the recipient to suggest alternatives if none of the times work',
    'Professional sign-off with the agent signature',
  ],
  tone: 'Professional, warm, and concise. Not stiff or overly formal.',
  structure: 'Greeting → purpose → proposed times → logistics → flexibility offer → sign-off',
  constraints: [
    'Keep the body to 4-6 sentences plus the time list',
    'Do not use exclamation marks',
    'Subject line should include the meeting purpose',
    'Times should be formatted as a bulleted list, not inline',
  ],
  example: `Subject: Meeting Request — Q3 Planning

Hi Alice,

I'm reaching out on behalf of Joseph to schedule a meeting to discuss Q3 Planning.

Joseph is available at the following times:

  • Monday, April 7 at 10:00 AM ET
  • Tuesday, April 8 at 2:00 PM ET
  • Wednesday, April 9 at 11:00 AM ET

The meeting would be approximately 45 minutes via Zoom.

Please let me know which time works best for you, or suggest an alternative if none of these are convenient.

Best regards,
Nathan Curia, Agent Chief of Staff`,
};

export class TemplateMeetingRequestHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const { action } = ctx.input as { action?: string };

    if (!action || !['generate', 'save', 'reset'].includes(action)) {
      return { success: false, error: "Missing or invalid 'action' — must be 'generate', 'save', or 'reset'" };
    }

    if (action === 'save') {
      return this.savePolicy(ctx);
    }
    if (action === 'reset') {
      return this.resetPolicy(ctx);
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

    // Length caps prevent oversized inputs from producing enormous output
    if (recipient_name.length > MAX_INPUT_LENGTH) {
      return { success: false, error: `recipient_name must be ${MAX_INPUT_LENGTH} characters or fewer` };
    }
    if (sender_name.length > MAX_INPUT_LENGTH) {
      return { success: false, error: `sender_name must be ${MAX_INPUT_LENGTH} characters or fewer` };
    }
    if (proposed_times.length > MAX_INPUT_LENGTH) {
      return { success: false, error: `proposed_times must be ${MAX_INPUT_LENGTH} characters or fewer` };
    }

    // Look up custom policy from KG, fall back to built-in default
    const { policy, source } = await this.resolvePolicy(ctx);

    // Build the context object the LLM will use to compose the email
    const context: Record<string, string> = {
      recipient_name,
      sender_name,
      proposed_times,
      agent_signature: resolveSignature(ctx.agentPersona),
    };
    if (meeting_purpose) context.meeting_purpose = meeting_purpose;
    if (meeting_duration) context.meeting_duration = meeting_duration;
    if (meeting_location) context.meeting_location = meeting_location;

    ctx.log.info({ recipient_name, source }, 'Retrieved meeting request email policy');
    return {
      success: true,
      data: {
        guidelines: policy,
        context,
        source,
        instructions: 'Use the guidelines to compose a meeting request email. The guidelines define required elements, tone, structure, and constraints. The example shows the expected quality and format. Adapt naturally to the provided context — do not copy the example verbatim.',
      },
    };
  }

  private async savePolicy(ctx: SkillContext): Promise<SkillResult> {
    const { custom_policy } = ctx.input as { custom_policy?: string };
    if (!custom_policy || typeof custom_policy !== 'string') {
      return { success: false, error: 'Missing required input: custom_policy (a JSON string describing the email policy, or plain-text guidelines)' };
    }
    if (custom_policy.length > 10000) {
      return { success: false, error: 'custom_policy must be 10000 characters or fewer' };
    }

    if (!ctx.entityMemory) {
      return { success: false, error: 'Knowledge graph not available — cannot save custom policy' };
    }

    try {
      const existing = await ctx.entityMemory.findEntities(TEMPLATE_LABEL);
      if (existing.length > 0) {
        await ctx.entityMemory.storeFact({
          entityNodeId: existing[0]!.id,
          label: 'email policy',
          properties: { policy: custom_policy },
          confidence: 1.0,
          decayClass: 'permanent',
          source: 'skill:template-meeting-request',
        });
      } else {
        const anchor = await ctx.entityMemory.createEntity({
          type: 'concept',
          label: TEMPLATE_LABEL,
          properties: { category: 'email-policy', templateName: 'meeting-request' },
          source: 'skill:template-meeting-request',
        });
        await ctx.entityMemory.storeFact({
          entityNodeId: anchor.id,
          label: 'email policy',
          properties: { policy: custom_policy },
          confidence: 1.0,
          decayClass: 'permanent',
          source: 'skill:template-meeting-request',
        });
      }

      ctx.log.info('Saved custom meeting request email policy to knowledge graph');
      return { success: true, data: { saved: true } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err }, 'Failed to save custom policy');
      return { success: false, error: `Failed to save policy: ${message}` };
    }
  }

  private async resetPolicy(ctx: SkillContext): Promise<SkillResult> {
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
            label: 'email policy',
            properties: { policy: '', cleared: true },
            confidence: 1.0,
            decayClass: 'permanent',
            source: 'skill:template-meeting-request',
          });
        }
      }

      ctx.log.info('Reset meeting request email policy to default');
      return { success: true, data: { reset: true } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err }, 'Failed to reset policy');
      return { success: false, error: `Failed to reset policy: ${message}` };
    }
  }

  /**
   * Look up a custom email policy from the knowledge graph.
   * Returns the custom policy if found, otherwise the built-in default.
   * Custom policies can be plain text guidelines or structured JSON.
   */
  private async resolvePolicy(ctx: SkillContext): Promise<{ policy: unknown; source: 'default' | 'custom' }> {
    if (!ctx.entityMemory) {
      return { policy: DEFAULT_POLICY, source: 'default' };
    }

    try {
      const nodes = await ctx.entityMemory.findEntities(TEMPLATE_LABEL);
      if (nodes.length === 0) {
        return { policy: DEFAULT_POLICY, source: 'default' };
      }

      const facts = await ctx.entityMemory.getFacts(nodes[0]!.id);
      const policyFact = facts
        .filter((f) => f.label === 'email policy')
        .sort((a, b) => b.temporal.lastConfirmedAt.getTime() - a.temporal.lastConfirmedAt.getTime())[0];

      if (!policyFact) {
        return { policy: DEFAULT_POLICY, source: 'default' };
      }

      const rawPolicy = policyFact.properties.policy;
      if (typeof rawPolicy === 'string' && rawPolicy.length > 0 && !policyFact.properties.cleared) {
        // Try to parse as JSON; if it fails, treat as plain-text guidelines
        try {
          const parsed = JSON.parse(rawPolicy) as unknown;
          return { policy: parsed, source: 'custom' };
        } catch {
          // Plain text guidelines — wrap in a structure for the LLM
          return {
            policy: { custom_guidelines: rawPolicy, note: 'These are custom guidelines that override the default policy. Follow them when composing the email.' },
            source: 'custom',
          };
        }
      }

      return { policy: DEFAULT_POLICY, source: 'default' };
    } catch (err) {
      ctx.log.warn({ err }, 'Failed to look up custom policy, using default');
      return { policy: DEFAULT_POLICY, source: 'default' };
    }
  }
}
