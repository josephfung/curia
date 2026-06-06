// handler.ts — compose-reply skill.
//
// Allows the coordinator to partition a reply into an external-facing body
// and a principal-only status update. The handler validates inputs and
// returns the trimmed values. The runtime detects this skill by name, short-
// circuits the tool-use loop, and emits an agent.response with the external
// text as `content` and the internal text as `sidebar`. The dispatcher then
// routes each piece as a separate outbound message.
//
// No side effects — pure shape. action_risk: "none".

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

export class ComposeReplyHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const { external, internal } = ctx.input as {
      external?: unknown;
      internal?: unknown;
    };

    if (!external || typeof external !== 'string') {
      return { success: false, error: 'Missing required input: external (string)' };
    }
    const externalTrimmed = external.trim();
    if (externalTrimmed === '') {
      return { success: false, error: 'external must not be empty' };
    }

    if (internal !== undefined) {
      if (typeof internal !== 'string') {
        return { success: false, error: 'internal must be a string when provided' };
      }
      const internalTrimmed = internal.trim();
      if (internalTrimmed === '') {
        return { success: false, error: 'internal must not be empty when provided' };
      }
      return {
        success: true,
        data: { external: externalTrimmed, internal: internalTrimmed },
      };
    }

    return {
      success: true,
      data: { external: externalTrimmed },
    };
  }
}
