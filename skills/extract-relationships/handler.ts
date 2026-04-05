import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

export class ExtractRelationshipsHandler implements SkillHandler {
  // _client is accepted here so the constructor signature is compatible with
  // Task 6, which will inject a real (or mock) Anthropic client. The stub
  // ignores it and just returns "not implemented".
  constructor(private readonly _client?: unknown) {}

  async execute(_ctx: SkillContext): Promise<SkillResult> {
    return { success: false, error: 'not implemented' };
  }
}
