// registry.ts — the skill registry indexes all available skills (local + MCP).
//
// At startup, the bootstrap orchestrator loads skill manifests from the
// skills/ directory and registers them here. Agents access skills through
// this registry — either by name (pinned skills) or by search (discovery).
//
// The registry also converts skill manifests to LLM tool definitions so
// the agent runtime can pass them to the LLM's tool-use API.

import type { SkillManifest, SkillHandler, RegisteredSkill, ToolDefinition } from './types.js';

export class SkillRegistry {
  private skills = new Map<string, RegisteredSkill>();

  /**
   * Register a skill with its manifest and handler.
   * Throws if a skill with the same name is already registered —
   * duplicate names indicate a configuration error that should surface
   * at startup, not silently overwrite.
   */
  register(manifest: SkillManifest, handler: SkillHandler): void {
    if (this.skills.has(manifest.name)) {
      throw new Error(`Skill '${manifest.name}' is already registered`);
    }
    this.skills.set(manifest.name, { manifest, handler });
  }

  /** Look up a skill by exact name. Returns undefined if not found. */
  get(name: string): RegisteredSkill | undefined {
    return this.skills.get(name);
  }

  /** List all registered skills. */
  list(): RegisteredSkill[] {
    return Array.from(this.skills.values());
  }

  /**
   * Search skills by keyword against name and description.
   * Used by the skill-registry built-in skill for discovery.
   * Simple substring match — good enough for a small registry.
   */
  search(query: string): RegisteredSkill[] {
    const lower = query.toLowerCase();
    return this.list().filter(s =>
      s.manifest.name.toLowerCase().includes(lower) ||
      s.manifest.description.toLowerCase().includes(lower),
    );
  }

  /**
   * Convert named skills to LLM tool definitions.
   * The agent runtime calls this with the agent's pinned_skills list
   * to build the tools array for the LLM chat call.
   *
   * Unknown skill names are silently skipped — the agent YAML might
   * reference skills not yet installed, which is a warning, not a crash.
   */
  toToolDefinitions(skillNames: string[]): ToolDefinition[] {
    const tools: ToolDefinition[] = [];

    for (const name of skillNames) {
      const skill = this.skills.get(name);
      if (!skill) continue;

      const properties: Record<string, { type: string; description?: string }> = {};
      const required: string[] = [];

      for (const [key, typeStr] of Object.entries(skill.manifest.inputs)) {
        // Skill manifests use a shorthand notation with parenthetical descriptions
        // and trailing "?" for optionality. The "?" may appear before or after the
        // parenthetical, so we strip the parenthetical first:
        //   "string (generate | update | save | reset)" → type "string", desc "generate | update | save | reset"
        //   "string? (required for generate)" → type "string", optional, desc "required for generate"
        //   "boolean?" → type "boolean", optional, no desc
        const parenMatch = typeStr.match(/^(.+?)\s*\((.+)\)$/);
        // When the regex matches, groups [1] and [2] are always present
        const typePart = parenMatch ? parenMatch[1]! : typeStr;
        const description = parenMatch ? parenMatch[2]! : undefined;

        const isOptional = typePart.endsWith('?');
        const baseType = isOptional ? typePart.slice(0, -1) : typePart;

        properties[key] = { type: baseType, ...(description ? { description } : {}) };
        if (!isOptional) {
          required.push(key);
        }
      }

      tools.push({
        name,
        description: skill.manifest.description,
        input_schema: {
          type: 'object',
          properties,
          required,
        },
      });
    }

    return tools;
  }
}
