// security-config-loader.ts — loads the security section from config/default.yaml.
//
// Provides the extra_injection_patterns list to InboundScanner at startup.
// Operators can add patterns here without code changes; changes take effect on restart.

import { readFileSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import yaml from 'js-yaml';

export interface ExtraInjectionPattern {
  regex: RegExp;
  label: string;
}

interface RawPatternEntry {
  regex: string;
  label: string;
}

interface RawSecurityConfig {
  extra_injection_patterns?: RawPatternEntry[];
}

interface RawDefaultYaml {
  security?: RawSecurityConfig;
}

/**
 * Load extra injection patterns from the `security.extra_injection_patterns`
 * section of config/default.yaml.
 *
 * Returns an empty array if:
 * - The file does not exist
 * - The security section is absent
 * - The extra_injection_patterns list is empty
 *
 * Throws on malformed YAML or invalid regex strings so startup fails loudly
 * rather than silently running with broken security config.
 */
export function loadExtraInjectionPatterns(configDir: string): ExtraInjectionPattern[] {
  const configPath = path.join(configDir, 'default.yaml');

  if (!existsSync(configPath)) {
    return [];
  }

  const raw = yaml.load(readFileSync(configPath, 'utf-8')) as RawDefaultYaml | null;
  const entries = raw?.security?.extra_injection_patterns;

  // Section absent or key missing — no extra patterns configured.
  if (entries === undefined) {
    return [];
  }

  // Explicit array check: a YAML typo like `extra_injection_patterns: {}` produces
  // an object, not an array. Silently treating it as "no patterns" would disable
  // all org-specific detection without any feedback to the operator.
  if (!Array.isArray(entries)) {
    throw new Error(
      `security.extra_injection_patterns must be a list in ${configPath}`,
    );
  }

  if (entries.length === 0) {
    return [];
  }

  return entries.map((entry, i) => {
    // Guard against null entries or primitives — e.g. a bare `-` in YAML produces null.
    if (!entry || typeof entry !== 'object') {
      throw new Error(
        `security.extra_injection_patterns[${i}] must be an object with 'regex' and 'label' fields in ${configPath}`,
      );
    }
    if (typeof entry.regex !== 'string' || !entry.regex) {
      throw new Error(
        `security.extra_injection_patterns[${i}] is missing a valid 'regex' string in ${configPath}`,
      );
    }
    if (typeof entry.label !== 'string' || !entry.label) {
      throw new Error(
        `security.extra_injection_patterns[${i}] is missing a valid 'label' string in ${configPath}`,
      );
    }

    let compiled: RegExp;
    try {
      // Case-insensitive matching applied automatically, consistent with built-in patterns.
      compiled = new RegExp(entry.regex, 'i');
    } catch (regexErr) {
      // Chain the original SyntaxError so callers (and the pino logger) can see
      // the engine's position-specific diagnostic — e.g., "Unterminated character class".
      throw new Error(
        `security.extra_injection_patterns[${i}] has invalid regex '${entry.regex}' in ${configPath}`,
        { cause: regexErr },
      );
    }

    return { regex: compiled, label: entry.label };
  });
}
