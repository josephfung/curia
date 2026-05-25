// handler.ts — request-clarification skill.
//
// Allows any specialist to pause mid-task and request clarification from
// the CEO. The handler is deliberately thin: it validates inputs and returns
// a structured protocol marker. The runtime detects this marker in the tool
// result, short-circuits the tool-use loop, constructs a resume_token from
// the task context, and emits a deterministic JSON response that the
// DelegateHandler parses to return a typed result to the coordinator.
//
// No side effects, no capabilities required. Scratchpad storage, resume
// construction, and format encoding all happen in the runtime and
// DelegateHandler — not here.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

/** Protocol marker used by the runtime to detect clarification requests. */
export const CLARIFICATION_PROTOCOL = 'clarification_request' as const;

export class RequestClarificationHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const { question, partial_findings } = ctx.input as {
      question?: string;
      partial_findings?: string;
    };

    if (!question || typeof question !== 'string') {
      return { success: false, error: 'Missing required input: question (string)' };
    }
    if (question.trim() === '') {
      return { success: false, error: 'question must not be empty' };
    }

    if (!partial_findings || typeof partial_findings !== 'string') {
      return { success: false, error: 'Missing required input: partial_findings (string)' };
    }
    if (partial_findings.trim() === '') {
      return { success: false, error: 'partial_findings must not be empty' };
    }

    ctx.log.info('request-clarification: specialist requesting CEO clarification');

    return {
      success: true,
      data: {
        _curia_protocol: CLARIFICATION_PROTOCOL,
        question: question.trim(),
        partial_findings: partial_findings.trim(),
      },
    };
  }
}
