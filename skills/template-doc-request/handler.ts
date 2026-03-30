// handler.ts — template-doc-request skill implementation.
//
// Returns email composing guidelines for pre-meeting document requests.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { resolveSignature, savePolicy, updatePolicy, resetPolicy, resolvePolicy } from '../_shared/template-base.js';

const TEMPLATE_LABEL = 'template:doc-request';
const SKILL_SOURCE = 'skill:template-doc-request';
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
    if (!action || !['generate', 'save', 'update', 'reset'].includes(action)) {
      return { success: false, error: "Missing or invalid 'action' — must be 'generate', 'save', 'update', or 'reset'" };
    }
    if (action === 'save') return savePolicy(ctx, TEMPLATE_LABEL, SKILL_SOURCE);
    if (action === 'update') return updatePolicy(ctx, TEMPLATE_LABEL, SKILL_SOURCE);
    if (action === 'reset') return resetPolicy(ctx, TEMPLATE_LABEL, SKILL_SOURCE);
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

    const { policy, source } = await resolvePolicy(ctx, TEMPLATE_LABEL, DEFAULT_POLICY);

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
        instructions: 'Use the guidelines to compose a document request email. Adapt naturally to the provided context. If refinements are present, apply them.',
      },
    };
  }
}
