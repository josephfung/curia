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

// JSON Schema keyword classification. Schema transforms must recurse only into
// positions that actually hold subschemas — never into instance-valued keywords,
// whose literal contents may legitimately contain a `type` array that is real data,
// not a union to expand (#1508 review). Names are matched only as keywords of a
// schema object; a property *named* `default` inside `properties` is still a schema.
const SUBSCHEMA_KEYWORDS = new Set([
  'items', 'additionalItems', 'additionalProperties', 'contains', 'propertyNames',
  'not', 'if', 'then', 'else', 'unevaluatedItems', 'unevaluatedProperties',
]);
const SUBSCHEMA_LIST_KEYWORDS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
const SUBSCHEMA_MAP_KEYWORDS = new Set([
  'properties', 'patternProperties', 'definitions', '$defs', 'dependentSchemas',
]);
const INSTANCE_KEYWORDS = new Set(['default', 'const', 'examples', 'enum']);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Recursively rewrite JSON Schema `type: [...]` arrays to `anyOf` branches.
 * Gemini's function-calling API rejects type-arrays (#1508); Anthropic/OpenAI
 * accept either form. Used for MCP-sourced schemas that may still emit arrays.
 *
 * Recurses only into schema-bearing keywords (properties, items, anyOf, $defs, …),
 * never into instance-valued keywords (default/const/examples/enum) — a `type`
 * array inside those is literal data and must be preserved verbatim.
 */
export function expandTypeArraysToAnyOf(schema: unknown): unknown {
  if (!isPlainObject(schema)) return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    out[key] = expandKeyword(key, value);
  }
  if (!Array.isArray(out['type'])) return out;

  const types = out['type'] as unknown[];
  const items = out['items'];
  const existingAnyOf = out['anyOf'];
  delete out['type'];
  delete out['items'];
  delete out['anyOf'];
  const anyOf = types.map((t) =>
    t === 'array'
      ? (items !== undefined ? { type: 'array', items } : { type: 'array' })
      : { type: t },
  );
  // Compose with any pre-existing anyOf via allOf rather than clobbering it —
  // overwriting would drop the original constraint and widen accepted inputs (#1508 review).
  return existingAnyOf === undefined
    ? { ...out, anyOf }
    : { ...out, allOf: [{ anyOf }, { anyOf: existingAnyOf }] };
}

/** Transform one keyword's value, recursing only where the value holds subschema(s). */
function expandKeyword(key: string, value: unknown): unknown {
  if (INSTANCE_KEYWORDS.has(key)) return value;
  if (SUBSCHEMA_LIST_KEYWORDS.has(key) && Array.isArray(value)) {
    return value.map((s) => expandTypeArraysToAnyOf(s));
  }
  if (SUBSCHEMA_MAP_KEYWORDS.has(key) && isPlainObject(value)) {
    const mapped: Record<string, unknown> = {};
    for (const [name, sub] of Object.entries(value)) mapped[name] = expandTypeArraysToAnyOf(sub);
    return mapped;
  }
  if (SUBSCHEMA_KEYWORDS.has(key)) {
    if (Array.isArray(value)) return value.map((s) => expandTypeArraysToAnyOf(s)); // `items` tuple form
    if (isPlainObject(value)) return expandTypeArraysToAnyOf(value);
    return value; // boolean (e.g. additionalProperties: false) or absent
  }
  return value; // type/required/description/format/numeric bounds — scalars or string[]
}

/**
 * Gemini-style strictness check: reject any schema position whose `type` is an array.
 * Mirrors expandTypeArraysToAnyOf's traversal — only schema-bearing keywords are
 * inspected, so a `type` array living inside instance data (default/const/examples/
 * enum) is not a false violation. Used by regression tests (#1508).
 */
export function assertNoUnionTypeArrays(schema: unknown, path = '$'): void {
  if (!isPlainObject(schema)) return;
  if (Array.isArray(schema['type'])) {
    throw new Error(
      `Strict provider schema violation at ${path}: type-array ${JSON.stringify(schema['type'])} ` +
      '(Gemini rejects these; use anyOf)',
    );
  }
  for (const [key, value] of Object.entries(schema)) {
    assertKeyword(key, value, path);
  }
}

function assertKeyword(key: string, value: unknown, path: string): void {
  if (INSTANCE_KEYWORDS.has(key)) return;
  if (SUBSCHEMA_LIST_KEYWORDS.has(key) && Array.isArray(value)) {
    value.forEach((s, i) => assertNoUnionTypeArrays(s, `${path}.${key}[${i}]`));
    return;
  }
  if (SUBSCHEMA_MAP_KEYWORDS.has(key) && isPlainObject(value)) {
    for (const [name, sub] of Object.entries(value)) assertNoUnionTypeArrays(sub, `${path}.${key}.${name}`);
    return;
  }
  if (SUBSCHEMA_KEYWORDS.has(key)) {
    if (Array.isArray(value)) value.forEach((s, i) => assertNoUnionTypeArrays(s, `${path}.${key}[${i}]`));
    else if (isPlainObject(value)) assertNoUnionTypeArrays(value, `${path}.${key}`);
  }
}

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
          // Normalize type-arrays → anyOf so MCP schemas are Gemini-safe too (#1508).
          input_schema: expandTypeArraysToAnyOf(skill.mcpInputSchema) as ToolDefinition['input_schema'],
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
        //   "string|null?" → type ["string","null"], optional (explicit null to clear)
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

        const VALID_PRIMITIVE_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'null']);

        // Pipe unions → JSON Schema `anyOf` (NOT `type: [...]` arrays).
        // Anthropic/OpenAI/DeepSeek accept type-arrays; Google Gemini's
        // function-calling API does not — OpenRouter drops those properties
        // but leaves them in `required`, and Gemini then 400s (#1508 /
        // contacts outage 2026-07-23). `anyOf` is accepted by both families.
        // Covers "string|null" and polymorphic inputs like checkpoint's
        // `cursor` (string|object|null) or `accumulator` (object[]|object).
        if (baseType.includes('|')) {
          const members = baseType.split('|').map((m) => m.trim());
          const anyOf: Array<Record<string, unknown>> = [];
          const seen = new Set<string>();
          for (const member of members) {
            if (member.endsWith('[]')) {
              const itemType = member.slice(0, -2);
              if (!itemType || !VALID_PRIMITIVE_TYPES.has(itemType)) {
                throw new Error(
                  `Tool '${name}' input '${key}': invalid array item type '${itemType}' in union '${typeStr}'. ` +
                  `Expected one of: ${[...VALID_PRIMITIVE_TYPES].join(', ')}.`,
                );
              }
              const branchKey = `array:${itemType}`;
              if (seen.has(branchKey)) continue;
              seen.add(branchKey);
              anyOf.push({ type: 'array', items: { type: itemType } });
            } else {
              if (!VALID_PRIMITIVE_TYPES.has(member)) {
                throw new Error(
                  `Tool '${name}' input '${key}': invalid union member type '${member}' in '${typeStr}'. ` +
                  `Expected one of: ${[...VALID_PRIMITIVE_TYPES].join(', ')}, or an array type (e.g. object[]).`,
                );
              }
              if (seen.has(member)) continue;
              seen.add(member);
              anyOf.push({ type: member });
            }
          }
          properties[key] = {
            anyOf,
            ...(description ? { description } : {}),
          };
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
          if (!itemType || !VALID_PRIMITIVE_TYPES.has(itemType)) {
            throw new Error(
              `Tool '${name}' input '${key}': invalid array item type '${itemType}' in '${typeStr}'. ` +
              `Expected one of: ${[...VALID_PRIMITIVE_TYPES].join(', ')}.`,
            );
          }
          properties[key] = { type: 'array', items: { type: itemType }, ...(description ? { description } : {}) };
        } else {
          // Validate against JSON Schema primitive types so a manifest typo like
          // "string — description" fails loudly at startup rather than silently
          // emitting an invalid schema that causes an opaque API 400 at call time.
          // (This is the same pattern as the array-item validation above.)
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
