// handler.ts — skill-registry built-in skill.
//
// Thin wrapper around SkillRegistry.search() that lets discovery-enabled agents
// find capabilities not in their pinned skill list.
//
// The registry reference is injected by the execution layer as ctx.skillSearch —
// a closure scoped to this skill by name, following the same name-gated pattern
// used for autonomyService and browserService. No infrastructure: true needed.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

export class SkillRegistryHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    if (!ctx.skillSearch) {
      // Guard against misconfiguration — should never happen in normal operation
      // since the execution layer always injects skillSearch for this skill name.
      return { success: false, error: 'skill-registry: skillSearch not available in context' };
    }

    const query = (ctx.input.query as string) ?? '';
    const skills = ctx.skillSearch(query);

    return { success: true, data: { skills } };
  }
}

export default new SkillRegistryHandler();
