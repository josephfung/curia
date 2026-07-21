// registry.ts — the tool registry indexes all available tools (local + MCP).
//
// At startup, the bootstrap orchestrator loads tool manifests from the
// skills/ directory and registers them here. Agents access tools through
// this registry — either by name (pinned_skills) or by search (discovery).
//
// The registry also converts tool manifests to LLM tool definitions so
// the agent runtime can pass them to the LLM's tool-use API.

import type { ToolManifest, ToolHandler, RegisteredTool, ToolDefinition } from './types.js';
import { describeTimestampInput } from '../time/timestamp.js';

// Valid named action_risk labels — used for runtime validation since manifests
// are loaded from JSON via a bare cast and TypeScript cannot enforce this at runtime.
const ACTION_RISK_LABELS = new Set(['none', 'low', 'medium', 'high', 'critical']);

export class ToolRegistry {
  private tools = new Map<string, RegisteredTool>();
  /** IANA timezone name used to populate timestamp input descriptions in tool schemas. */
  private timezone: string;

  constructor(timezone = 'UTC') {
    this.timezone = timezone;
  }

  /**
   * Register a tool with its manifest and handler.
   * Throws if a tool with the same name is already registered —
   * duplicate names indicate a configuration error that should surface
   * at startup, not silently overwrite.
   *
   * Also validates action_risk at runtime — manifests are loaded from JSON via
   * a bare `as ToolManifest` cast, so TypeScript cannot enforce enum correctness.
   * Invalid values fail closed at tool load time rather than silently producing
   * undefined thresholds later when autonomy gates are evaluated.
   */
  /**
   * Register a tool with its manifest and handler.
   *
   * @param mcpInputSchema - Optional raw MCP JSON Schema for the tool's inputs.
   *   When provided, toToolDefinitions() passes it directly to the LLM instead of
   *   parsing the shorthand manifest.inputs notation. Only set for MCP-sourced tools.
   */
  register(manifest: ToolManifest, handler: ToolHandler, mcpInputSchema?: ToolDefinition['input_schema']): void {
    if (this.tools.has(manifest.name)) {
      throw new Error(`Tool '${manifest.name}' is already registered`);
    }
    if (manifest.action_risk === undefined || manifest.action_risk === null) {
      throw new Error(
        `Tool '${manifest.name}' is missing required field 'action_risk'. ` +
        `All tools must declare action_risk. See docs/dev/adding-a-tool.md.`,
      );
    }
    const risk = manifest.action_risk;
    if (typeof risk === 'number') {
      if (!Number.isInteger(risk) || risk < 0 || risk > 100) {
        throw new Error(
          `Tool '${manifest.name}' has invalid action_risk: ${risk}. ` +
          `Numeric action_risk must be an integer between 0 and 100.`,
        );
      }
    } else if (!ACTION_RISK_LABELS.has(risk as string)) {
      throw new Error(
        `Tool '${manifest.name}' has invalid action_risk label: "${String(risk)}". ` +
        `Expected one of: ${[...ACTION_RISK_LABELS].join(', ')}.`,
      );
    }
    // Fail closed: skip_secret_redaction relaxes the output secret scrub, so it is gated to
    // skills that declare the 'secretCapture' capability (the secret-capture family, whose
    // output structurally cannot carry a real secret value). This stops an unrelated or
    // misconfigured tool from silently weakening redaction by setting the flag. (#971)
    if (manifest.skip_secret_redaction === true && !(manifest.capabilities ?? []).includes('secretCapture')) {
      throw new Error(
        `Tool '${manifest.name}' sets skip_secret_redaction but does not declare the ` +
        `'secretCapture' capability. This flag relaxes output secret redaction and is ` +
        `restricted to secret-capture tools — remove the flag or add the capability.`,
      );
    }
    this.tools.set(manifest.name, { manifest, handler, mcpInputSchema });
  }

  /** Look up a skill by exact name. Returns undefined if not found. */
  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  /** List all registered skills. */
  list(): RegisteredTool[] {
    return Array.from(this.tools.values());
  }

  /**
   * Search skills by keyword against name and description.
   * Used by the tool-registry built-in skill for discovery.
   * Simple substring match — good enough for a small registry.
   */
  search(query: string): RegisteredTool[] {
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
  toToolDefinitions(toolNames: string[]): ToolDefinition[] {
    const tools: ToolDefinition[] = [];

    for (const name of toolNames) {
      const skill = this.tools.get(name);
      if (!skill) continue;

      // MCP-sourced tools carry the raw JSON Schema from the server's tools/list response.
      // Pass it through directly — no shorthand parsing needed, and schema fidelity is
      // preserved exactly as the MCP server documented it (enum constraints, formats, etc.).
      if (skill.mcpInputSchema) {
        tools.push({
          name,
          description: skill.manifest.description,
          input_schema: skill.mcpInputSchema,
        });
        continue;
      }

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
              `Tool '${name}' input '${key}': invalid array item type '${itemType}' in '${typeStr}'. ` +
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
              `Tool '${name}' input '${key}': invalid type '${baseType}' in '${typeStr}'. ` +
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
