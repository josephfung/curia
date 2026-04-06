// registry.ts — the skill registry indexes all available skills (local + MCP).
//
// At startup, the bootstrap orchestrator loads skill manifests from the
// skills/ directory and registers them here. Agents access skills through
// this registry — either by name (pinned skills) or by search (discovery).
//
// The registry also converts skill manifests to LLM tool definitions so
// the agent runtime can pass them to the LLM's tool-use API.

import type { SkillManifest, SkillHandler, RegisteredSkill, ToolDefinition } from './types.js';
import { describeTimestampInput } from '../time/timestamp.js';

// Valid named action_risk labels — used for runtime validation since manifests
// are loaded from JSON via a bare cast and TypeScript cannot enforce this at runtime.
const ACTION_RISK_LABELS = new Set(['none', 'low', 'medium', 'high', 'critical']);

export class SkillRegistry {
  private skills = new Map<string, RegisteredSkill>();
  /** IANA timezone name used to populate timestamp input descriptions in tool schemas. */
  private timezone: string;

  constructor(timezone = 'UTC') {
    this.timezone = timezone;
  }

  /**
   * Register a skill with its manifest and handler.
   * Throws if a skill with the same name is already registered —
   * duplicate names indicate a configuration error that should surface
   * at startup, not silently overwrite.
   *
   * Also validates action_risk at runtime — manifests are loaded from JSON via
   * a bare `as SkillManifest` cast, so TypeScript cannot enforce enum correctness.
   * Invalid values fail closed at skill load time rather than silently producing
   * undefined thresholds later when autonomy gates are evaluated.
   */
  register(manifest: SkillManifest, handler: SkillHandler): void {
    if (this.skills.has(manifest.name)) {
      throw new Error(`Skill '${manifest.name}' is already registered`);
    }
    if (manifest.action_risk !== undefined) {
      const risk = manifest.action_risk;
      if (typeof risk === 'number') {
        if (!Number.isInteger(risk) || risk < 0 || risk > 100) {
          throw new Error(
            `Skill '${manifest.name}' has invalid action_risk: ${risk}. ` +
            `Numeric action_risk must be an integer between 0 and 100.`,
          );
        }
      } else if (!ACTION_RISK_LABELS.has(risk as string)) {
        throw new Error(
          `Skill '${manifest.name}' has invalid action_risk label: "${String(risk)}". ` +
          `Expected one of: ${[...ACTION_RISK_LABELS].join(', ')}.`,
        );
      }
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

      const properties: ToolDefinition['input_schema']['properties'] = {};
      const required: string[] = [];

      for (const [key, typeStr] of Object.entries(skill.manifest.inputs)) {
        // Skill manifests use a shorthand notation with parenthetical descriptions
        // and trailing "?" for optionality. The "?" may appear before or after the
        // parenthetical, so we strip the parenthetical first:
        //   "string (generate | update | save | reset)" → type "string", desc "generate | update | save | reset"
        //   "string? (required for generate)" → type "string", optional, desc "required for generate"
        //   "boolean?" → type "boolean", optional, no desc
        //   "string[]?" → array of strings, optional
        const parenMatch = typeStr.match(/^(.+?)\s*\((.+)\)$/);
        // When the regex matches, groups [1] and [2] are always present
        const typePart = parenMatch ? parenMatch[1]! : typeStr;
        const description = parenMatch ? parenMatch[2]! : undefined;

        const isOptional = typePart.endsWith('?');
        const baseType = isOptional ? typePart.slice(0, -1) : typePart;

        // "timestamp" → string schema with canonical timezone-aware description.
        // The centralized description tells the LLM to emit UTC-offset ISO strings
        // and explains that offset-less strings are treated as Curia's local time.
        // Any parenthetical description in the manifest is appended as extra context.
        if (baseType === 'timestamp') {
          const canonicalDesc = describeTimestampInput(this.timezone);
          const fullDesc = description ? `${canonicalDesc} ${description}` : canonicalDesc;
          properties[key] = { type: 'string', description: fullDesc };
          if (!isOptional) {
            required.push(key);
          }
          continue;
        }

        // "string[]", "object[]", etc. → JSON Schema array type with items.
        // itemType is validated against the JSON Schema primitive type allowlist so
        // a manifest typo like "foo[]" fails loudly at startup rather than silently
        // emitting an invalid schema that causes an opaque API error at call time.
        if (baseType.endsWith('[]')) {
          const itemType = baseType.slice(0, -2);
          const VALID_ITEM_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'null']);
          if (!itemType || !VALID_ITEM_TYPES.has(itemType)) {
            throw new Error(
              `Skill '${name}' input '${key}': invalid array item type '${itemType}' in '${typeStr}'. ` +
              `Expected one of: ${[...VALID_ITEM_TYPES].join(', ')}.`,
            );
          }
          properties[key] = { type: 'array', items: { type: itemType }, ...(description ? { description } : {}) };
        } else {
          // Validate against JSON Schema primitive types so a manifest typo like
          // "string — description" fails loudly at startup rather than silently
          // emitting an invalid schema that causes an opaque API 400 at call time.
          // (This is the same pattern as the array-item validation above.)
          const VALID_PRIMITIVE_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'null']);
          if (!VALID_PRIMITIVE_TYPES.has(baseType)) {
            throw new Error(
              `Skill '${name}' input '${key}': invalid type '${baseType}' in '${typeStr}'. ` +
              `Expected one of: ${[...VALID_PRIMITIVE_TYPES].join(', ')}, or an array type (e.g. string[]).`,
            );
          }
          properties[key] = { type: baseType, ...(description ? { description } : {}) };
        }

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
