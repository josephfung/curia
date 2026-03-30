// handler.ts — template-cancel skill implementation.
//
// Returns email composing guidelines for cancellation emails.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { resolveSignature, savePolicy, updatePolicy, resetPolicy, resolvePolicy } from '../_shared/template-base.js';

const TEMPLATE_LABEL = 'template:cancel';
const SKILL_SOURCE = 'skill:template-cancel';
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
    if (!action || !['generate', 'save', 'update', 'reset'].includes(action)) {
      return { success: false, error: "Missing or invalid 'action' — must be 'generate', 'save', 'update', or 'reset'" };
    }
    if (action === 'save') return savePolicy(ctx, TEMPLATE_LABEL, SKILL_SOURCE);
    if (action === 'update') return updatePolicy(ctx, TEMPLATE_LABEL, SKILL_SOURCE);
    if (action === 'reset') return resetPolicy(ctx, TEMPLATE_LABEL, SKILL_SOURCE);
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

    const { policy, source } = await resolvePolicy(ctx, TEMPLATE_LABEL, DEFAULT_POLICY);

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
        instructions: 'Use the guidelines to compose a cancellation email. Adapt naturally to the provided context. If offer_reschedule is false, omit the reschedule offer. If refinements are present, apply them.',
      },
    };
  }
}
