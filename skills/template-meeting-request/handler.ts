// handler.ts — template-meeting-request skill implementation.
//
// Returns email composing guidelines for meeting requests — NOT a pre-filled
// email. The LLM uses these guidelines to compose naturally while following
// organizational policy.
//
// See skills/_shared/template-base.ts for the shared save/update/reset/resolve
// logic that all template skills use.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import {
  resolveSignature,
  savePolicy,
  updatePolicy,
  resetPolicy,
  resolvePolicy,
} from '../_shared/template-base.js';

const TEMPLATE_LABEL = 'template:meeting-request';
const SKILL_SOURCE = 'skill:template-meeting-request';
const MAX_INPUT_LENGTH = 5000;

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

    if (!action || !['generate', 'save', 'update', 'reset'].includes(action)) {
      return { success: false, error: "Missing or invalid 'action' — must be 'generate', 'save', 'update', or 'reset'" };
    }

    if (action === 'save') return savePolicy(ctx, TEMPLATE_LABEL, SKILL_SOURCE);
    if (action === 'update') return updatePolicy(ctx, TEMPLATE_LABEL, SKILL_SOURCE);
    if (action === 'reset') return resetPolicy(ctx, TEMPLATE_LABEL, SKILL_SOURCE);
    return this.generate(ctx);
  }

  private async generate(ctx: SkillContext): Promise<SkillResult> {
    const { recipient_name, sender_name, proposed_times, meeting_purpose, meeting_duration, meeting_location } =
      ctx.input as {
        recipient_name?: string; sender_name?: string; proposed_times?: string;
        meeting_purpose?: string; meeting_duration?: string; meeting_location?: string;
      };

    if (!recipient_name || typeof recipient_name !== 'string') return { success: false, error: 'Missing required input: recipient_name' };
    if (!sender_name || typeof sender_name !== 'string') return { success: false, error: 'Missing required input: sender_name' };
    if (!proposed_times || typeof proposed_times !== 'string') return { success: false, error: 'Missing required input: proposed_times' };

    if (recipient_name.length > MAX_INPUT_LENGTH) return { success: false, error: `recipient_name must be ${MAX_INPUT_LENGTH} characters or fewer` };
    if (sender_name.length > MAX_INPUT_LENGTH) return { success: false, error: `sender_name must be ${MAX_INPUT_LENGTH} characters or fewer` };
    if (proposed_times.length > MAX_INPUT_LENGTH) return { success: false, error: `proposed_times must be ${MAX_INPUT_LENGTH} characters or fewer` };

    const { policy, source } = await resolvePolicy(ctx, TEMPLATE_LABEL, DEFAULT_POLICY);

    const context: Record<string, string> = {
      recipient_name, sender_name, proposed_times,
      agent_signature: resolveSignature(ctx.agentPersona),
    };
    if (meeting_purpose) context.meeting_purpose = meeting_purpose;
    if (meeting_duration) context.meeting_duration = meeting_duration;
    if (meeting_location) context.meeting_location = meeting_location;

    ctx.log.info({ recipient_name, source }, 'Retrieved meeting request email policy');
    return {
      success: true,
      data: {
        guidelines: policy, context, source,
        instructions: 'Use the guidelines to compose a meeting request email. The guidelines define required elements, tone, structure, and constraints. The example shows the expected quality and format. Adapt naturally to the provided context — do not copy the example verbatim. If refinements are present, they are user-requested adjustments that take priority over the base policy.',
      },
    };
  }
}
