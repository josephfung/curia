// sensitivity.ts — content-based sensitivity classification for KG nodes.
//
// The SensitivityClassifier inspects a node's label and properties at creation
// time and assigns a Sensitivity level. Rules are loaded from config/default.yaml
// at startup so they can be tuned without code changes.
//
// Classification is keyword-based: the label and all string property values are
// concatenated into a single lowercase search string and checked against each
// rule's pattern list. The most restrictive matching rule wins.
//
// When no rule matches, the default is 'internal' — callers that don't specify
// sensitivity get a conservative default that still allows normal operations.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
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
const SENSITIVITY_ORDER: Record<Sensitivity, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
};

/**
 * Classifies KG node content into a Sensitivity level.
 *
 * Instantiate once at startup via SensitivityClassifier.fromYaml() or
 * SensitivityClassifier.fromRules() (for tests). The instance is stateless
 * and safe to share across concurrent requests.
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

  /**
   * Load rules from a YAML config file.
   *
   * Expects the YAML to contain a top-level `sensitivity_rules` array where each
   * entry has `category`, `sensitivity`, and `patterns` fields.
   *
   * Validates that all sensitivity values are known levels and throws if any are
   * unrecognised — misconfigured rules would silently under-protect data otherwise.
   *
   * @param configPath Absolute path to the YAML file (e.g. resolve('config/default.yaml'))
   */
  static fromYaml(configPath: string): SensitivityClassifier {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = yaml.load(raw) as Record<string, unknown>;

    const rulesRaw = parsed['sensitivity_rules'];
    if (!Array.isArray(rulesRaw)) {
      throw new Error(`SensitivityClassifier: 'sensitivity_rules' missing or not an array in ${configPath}`);
    }

    const rules: SensitivityRule[] = rulesRaw.map((entry: unknown, i: number) => {
      const e = entry as Record<string, unknown>;
      const category = String(e['category'] ?? '');
      const sensitivity = e['sensitivity'] as string;
      const patterns = e['patterns'];

      if (!category) throw new Error(`sensitivity_rules[${i}]: missing 'category'`);
      if (!(SENSITIVITY_LEVELS as readonly string[]).includes(sensitivity)) {
        throw new Error(`sensitivity_rules[${i}]: unknown sensitivity '${sensitivity}'`);
      }
      if (!Array.isArray(patterns) || patterns.length === 0) {
        throw new Error(`sensitivity_rules[${i}]: 'patterns' must be a non-empty array`);
      }

      return {
        category,
        sensitivity: sensitivity as Sensitivity,
        // Normalise to lowercase at load time so classify() never needs to lowercase patterns.
        patterns: patterns.map((p: unknown) => String(p).toLowerCase()),
      };
    });

    return new SensitivityClassifier(rules);
  }

  /** Construct directly from a rules array. Useful in tests. */
  static fromRules(rules: SensitivityRule[]): SensitivityClassifier {
    return new SensitivityClassifier(rules);
  }
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
