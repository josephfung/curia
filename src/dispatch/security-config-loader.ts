// security-config-loader.ts — parses the security.extra_injection_patterns block.
//
// Provides the extra_injection_patterns list to InboundScanner at startup.
// Operators can add patterns here without code changes; changes take effect on restart.

import type { Logger } from '../logger.js';
import { InboundScanner } from './inbound-scanner.js';

export interface ExtraInjectionPattern {
  regex: RegExp;
  label: string;
}

interface RawPatternEntry {
  regex: string;
  label: string;
}

/**
 * Parse and validate a raw `security.extra_injection_patterns` value, as
 * produced by yaml.load() on the merged config (config/default.yaml +
 * config/local.yaml — see config.ts#loadYamlConfig). Each entry must have
 * `regex` and `label` string fields, and `regex` must compile.
 *
 * Throws on malformed YAML shape or invalid regex strings so a broken entry
 * is loud rather than silently running with broken security config (#1397).
 *
 * @param entries Parsed YAML value of `security.extra_injection_patterns`.
 * @param source  Human-readable origin for error messages (e.g. a file path
 *                or "merged config").
 */
export function parseExtraInjectionPatterns(entries: unknown, source: string): ExtraInjectionPattern[] {
  // Explicit array check: a YAML typo like `extra_injection_patterns: {}` produces
  // an object, not an array. Silently treating it as "no patterns" would disable
  // all org-specific detection without any feedback to the operator.
  if (!Array.isArray(entries)) {
    throw new Error(`security.extra_injection_patterns must be a list (in ${source})`);
  }

  return entries.map((entry: unknown, i: number) => {
    // Guard against null entries or primitives — e.g. a bare `-` in YAML produces null.
    if (!entry || typeof entry !== 'object') {
      throw new Error(
        `security.extra_injection_patterns[${i}] must be an object with 'regex' and 'label' fields (in ${source})`,
      );
    }
    const e = entry as Partial<RawPatternEntry>;
    if (typeof e.regex !== 'string' || !e.regex) {
      throw new Error(`security.extra_injection_patterns[${i}] is missing a valid 'regex' string (in ${source})`);
    }
    if (typeof e.label !== 'string' || !e.label) {
      throw new Error(`security.extra_injection_patterns[${i}] is missing a valid 'label' string (in ${source})`);
    }

    let compiled: RegExp;
    try {
      // Case-insensitive matching applied automatically, consistent with built-in patterns.
      compiled = new RegExp(e.regex, 'i');
    } catch (regexErr) {
      // Chain the original SyntaxError so callers (and the pino logger) can see
      // the engine's position-specific diagnostic — e.g., "Unterminated character class".
      throw new Error(
        `security.extra_injection_patterns[${i}] has invalid regex '${e.regex}' (in ${source})`,
        { cause: regexErr },
      );
    }

    return { regex: compiled, label: e.label };
  });
}

/**
 * The scanner production and the test stacks hand to Dispatcher (#2018).
 * One construction site, so the context label and the next option cannot
 * drift between `src/index.ts` and a harness.
 *
 * `onParseError: 'warn'` (the default, production) logs and keeps the built-in
 * patterns. `'throw'` is for a test stack: a broken custom pattern must fail
 * the suite rather than quietly score runs against a weaker scanner.
 * The try covers parsing only. Constructing the scanner and the info log are
 * not config errors and are not swallowed.
 */
export function createInboundScanner(
  yamlConfig: { security?: { extra_injection_patterns?: unknown } },
  logger: Logger,
  options?: { onParseError?: 'warn' | 'throw' },
): InboundScanner {
  const onParseError = options?.onParseError ?? 'warn';
  let extraPatterns: ExtraInjectionPattern[] = [];
  try {
    extraPatterns = parseExtraInjectionPatterns(
      yamlConfig.security?.extra_injection_patterns ?? [],
      'security.extra_injection_patterns (config/default.yaml merged with config/local.yaml)',
    );
  } catch (err) {
    if (onParseError === 'throw') throw err;
    // Warn and fall back to zero extra patterns — built-in defaults still protect.
    // A misconfigured extra pattern entry should not block startup entirely.
    logger.warn({ err }, 'Failed to parse extra injection patterns from config — using built-in defaults only');
  }
  const scanner = new InboundScanner({ extraPatterns });
  logger.info(
    { builtInPatterns: InboundScanner.DEFAULT_PATTERN_COUNT, extraPatterns: extraPatterns.length },
    'Inbound injection scanner initialized',
  );
  return scanner;
}
