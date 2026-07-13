// sensitivity.ts — content-based sensitivity classification for KG nodes.
//
// The SensitivityClassifier inspects a node's label and properties at creation
// time and assigns a Sensitivity level. Rules come from the `sensitivity_rules`
// block of the merged config (config/default.yaml + config/local.yaml, see
// config.ts#loadYamlConfig) so they can be tuned without code changes.
//
// Classification is keyword-based: the label and all string property values are
// concatenated into a single lowercase search string and checked against each
// rule's pattern list. The most restrictive matching rule wins.
//
// When no rule matches, the default is 'internal' — callers that don't specify
// sensitivity get a conservative default that still allows normal operations.

import type { Sensitivity } from './types.js';
import { SENSITIVITY_LEVELS } from './types.js';

// -- Rule shape (mirrors config/default.yaml structure) --

export interface SensitivityRule {
  /** Human-readable category name, e.g. 'financial', 'hr'. Used for logging only. */
  category: string;
  /** Sensitivity level to assign when any pattern matches. */
  sensitivity: Sensitivity;
  /** Lowercase keywords to search for in the combined label + property text. */
  patterns: string[];
}

// Precedence order: higher index = higher sensitivity (restricted wins over confidential, etc.)
export const SENSITIVITY_RANK: Record<Sensitivity, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
};

/** @deprecated internal alias — use SENSITIVITY_RANK */
const SENSITIVITY_ORDER = SENSITIVITY_RANK;

/** Numeric rank for comparing sensitivity levels (higher = more restrictive). */
export function sensitivityRank(level: Sensitivity): number {
  return SENSITIVITY_RANK[level];
}

/** True when level is `confidential` or `restricted`. */
export function isConfidentialOrAbove(level: Sensitivity): boolean {
  return sensitivityRank(level) >= sensitivityRank('confidential');
}

/** True when level is `restricted`. */
export function isRestricted(level: Sensitivity): boolean {
  return level === 'restricted';
}

/**
 * Return whichever sensitivity level is more restrictive.
 * Used when merging nodes to ensure content can only ratchet sensitivity upward.
 */
export function maxSensitivity(a: Sensitivity, b: Sensitivity): Sensitivity {
  return SENSITIVITY_ORDER[a] >= SENSITIVITY_ORDER[b] ? a : b;
}

/**
 * Classifies KG node content into a Sensitivity level.
 *
 * Instantiate once at startup via SensitivityClassifier.fromRules(), passing
 * the validated `sensitivity_rules` from the merged config (see
 * parseSensitivityRules() below, consumed by config.ts#loadYamlConfig). The
 * instance is stateless and safe to share across concurrent requests.
 */
export class SensitivityClassifier {
  // Rules sorted highest-sensitivity-first so we can return on first match
  // when two rules would match the same text.
  private readonly rules: SensitivityRule[];

  private constructor(rules: SensitivityRule[]) {
    // Sort descending by sensitivity level so more restrictive rules win.
    this.rules = [...rules].sort(
      (a, b) => SENSITIVITY_ORDER[b.sensitivity] - SENSITIVITY_ORDER[a.sensitivity],
    );
  }

  /**
   * Classify a node's content. Returns the highest-sensitivity matching rule,
   * or 'internal' if no rule matches.
   *
   * @param label     The KG node label (fact text, entity name, etc.)
   * @param properties The node's structured properties
   * @param overrideCategory Optional category hint from the caller (e.g. 'financial').
   *                         Checked against rule.category for an exact match before
   *                         running keyword analysis, allowing skills to opt in to
   *                         category-based classification without embedding all keywords.
   */
  classify(
    label: string,
    properties: Record<string, unknown>,
    overrideCategory?: string,
  ): Sensitivity {
    // Build a single searchable text blob from the label and all string property values.
    // Properties like { value: 'Q3 salary plan' } contribute their text to the search.
    const searchText = buildSearchText(label, properties);

    for (const rule of this.rules) {
      // Category hint: exact match against rule.category (e.g. a skill that knows it's
      // storing financial data can pass category:'financial' to skip keyword scanning).
      if (overrideCategory && rule.category === overrideCategory) {
        return rule.sensitivity;
      }

      if (rule.patterns.some((p) => searchText.includes(p))) {
        return rule.sensitivity;
      }
    }

    return 'internal';
  }

  /** Construct directly from a validated rules array (see parseSensitivityRules()). */
  static fromRules(rules: SensitivityRule[]): SensitivityClassifier {
    return new SensitivityClassifier(rules);
  }
}

/**
 * Parse and validate a raw `sensitivity_rules` value, as produced by yaml.load()
 * on the merged config (config/default.yaml + config/local.yaml — see
 * config.ts#loadYamlConfig). Each entry must have `category`, `sensitivity`, and
 * `patterns` fields; `sensitivity` must be a known level.
 *
 * Normalises patterns to lowercase/trim at parse time so classify() never needs
 * to. Rejects blank pattern entries: searchText.includes('') is always true,
 * which would make the rule match unconditionally and override every other
 * classification.
 *
 * Throws on any malformed entry — misconfigured rules would silently
 * under-protect data otherwise, so a bad override must fail startup loudly
 * rather than being ignored (#1369).
 *
 * @param rulesRaw Parsed YAML value of the `sensitivity_rules` key.
 * @param source   Human-readable origin for error messages (e.g. a file path
 *                 or "merged config").
 */
export function parseSensitivityRules(rulesRaw: unknown, source: string): SensitivityRule[] {
  if (!Array.isArray(rulesRaw)) {
    throw new Error(`sensitivity_rules must be an array (in ${source})`);
  }

  return rulesRaw.map((entry: unknown, i: number) => {
    const e = entry as Record<string, unknown>;
    const category = String(e['category'] ?? '');
    const sensitivity = e['sensitivity'] as string;
    const patterns = e['patterns'];

    if (!category) throw new Error(`sensitivity_rules[${i}]: missing 'category' (in ${source})`);
    if (!(SENSITIVITY_LEVELS as readonly string[]).includes(sensitivity)) {
      throw new Error(`sensitivity_rules[${i}]: unknown sensitivity '${sensitivity}' (in ${source})`);
    }
    if (!Array.isArray(patterns) || patterns.length === 0) {
      throw new Error(`sensitivity_rules[${i}]: 'patterns' must be a non-empty array (in ${source})`);
    }

    const normalizedPatterns = patterns.map((p: unknown) => String(p).trim().toLowerCase());
    if (normalizedPatterns.some((p) => p.length === 0)) {
      throw new Error(`sensitivity_rules[${i}]: patterns must not contain empty values (in ${source})`);
    }

    return {
      category,
      sensitivity: sensitivity as Sensitivity,
      patterns: normalizedPatterns,
    };
  });
}

// -- Internal helpers --

/**
 * Flatten a node's label and all string-typed property values into a single
 * lowercase string for keyword matching.
 *
 * Only string values are included — numeric IDs, booleans, and nested objects
 * are not part of the human-readable content and shouldn't trigger keyword rules.
 */
function buildSearchText(label: string, properties: Record<string, unknown>): string {
  const parts: string[] = [label];

  for (const val of Object.values(properties)) {
    if (typeof val === 'string') {
      parts.push(val);
    }
  }

  return parts.join(' ').toLowerCase();
}
