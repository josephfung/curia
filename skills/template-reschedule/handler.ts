// handler.ts — template-reschedule skill implementation.
//
// Returns email composing guidelines for rescheduling emails.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { resolveSignature, savePolicy, updatePolicy, resetPolicy, resolvePolicy } from '../_shared/template-base.js';

const TEMPLATE_LABEL = 'template:reschedule';
const SKILL_SOURCE = 'skill:template-reschedule';
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

I'm writing on behalf of the CEO regarding your meeting originally scheduled for Monday, April 7 at 10:00 AM. Unfortunately, a scheduling conflict has come up and we need to reschedule.

The CEO is available at the following alternative times:

  • Wednesday, April 9 at 2:00 PM ET
  • Thursday, April 10 at 10:00 AM ET
  • Friday, April 11 at 11:00 AM ET

Would any of these work for you? If not, please suggest a time that's convenient and I'll do my best to accommodate.

Apologies for the inconvenience, and thank you for your flexibility.

Best regards,
Curia, Agent Chief of Staff`,
};

export class TemplateRescheduleHandler implements SkillHandler {
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

    const { policy, source } = await resolvePolicy(ctx, TEMPLATE_LABEL, DEFAULT_POLICY);

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
        instructions: 'Use the guidelines to compose a rescheduling email. Adapt naturally to the provided context — do not copy the example verbatim. If refinements are present, apply them.',
      },
    };
  }
}
