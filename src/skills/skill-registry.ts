// skill-registry.ts — in-memory catalog of skills (bundles).
//
// Layer-2 companion to ToolRegistry (Layer-1 atom catalog). Answers
// "what skills are installed/loaded and what tools + instructions do they
// carry?" Pin resolution and unified discovery read from here.
//
// Per-tool authorization stays on ToolManifest / ExecutionLayer — this registry
// never flattens or overrides action_risk.

import type { RegisteredSkill, SkillManifest } from './skill-types.js';

export class SkillRegistry {
  private skills = new Map<string, RegisteredSkill>();

  /** Register a skill. Throws on duplicate names. */
  register(manifest: SkillManifest, dir: string, opts?: { synthetic?: boolean }): void {
    if (this.skills.has(manifest.name)) {
      throw new Error(`Skill '${manifest.name}' is already registered`);
    }
    // Instruction-only skills (Phase 3 imports) may have zero tools; native
    // Phase 2 skills should list tools. Empty tools arrays are allowed for forward compat.
    this.skills.set(manifest.name, {
      manifest: Object.freeze({
        ...manifest,
        tools: Object.freeze([...manifest.tools]) as string[],
      }),
      dir,
      synthetic: opts?.synthetic,
    });
  }

  get(name: string): RegisteredSkill | undefined {
    return this.skills.get(name);
  }

  list(): RegisteredSkill[] {
    return Array.from(this.skills.values());
  }

  /**
   * Search skills by keyword against name and description.
   * Used by unified discovery alongside ToolRegistry.search().
   */
  search(query: string): RegisteredSkill[] {
    const lower = query.toLowerCase();
    return this.list().filter(s =>
      s.manifest.name.toLowerCase().includes(lower) ||
      s.manifest.description.toLowerCase().includes(lower),
    );
  }

  /** True when some registered (non-synthetic) skill claims this tool. */
  toolOwner(toolName: string): RegisteredSkill | undefined {
    for (const skill of this.skills.values()) {
      if (skill.synthetic) continue;
      if (skill.manifest.tools.includes(toolName)) return skill;
    }
    return undefined;
  }
}
