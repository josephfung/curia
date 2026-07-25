// secret-patterns.ts — shared credential-shape regexes for redaction / blocking.
//
// Single source of truth for patterns that match known secret *formats*
// (Anthropic/OpenAI keys, AWS access keys, Bearer JWTs, long hex tokens).
// Callers that need mutable /g regexes should use {@link createSecretPatterns}
// so concurrent scans do not share lastIndex state.
//
// Policy for what to *do* with a match (block vs redact vs skip) stays at the
// call site — outbound-filter blocks, sanitize/archive redact.

/** Broad catch for 32+ lowercase-hex runs. Over-matches dash-less UUIDs, git
 *  blob SHAs, and other high-entropy hex the user may legitimately paste —
 *  accepted for lossy redaction paths; do not "tighten" without an explicit
 *  allowlist strategy. */
export const GENERIC_LONG_HEX_PATTERN_SOURCE =
  '(?<![a-zA-Z0-9])[a-f0-9]{32,}(?![a-zA-Z0-9])';

/** Pattern sources in match-precedence order (more specific first). */
export const SECRET_PATTERN_SOURCES: readonly string[] = [
  'sk-ant-[a-zA-Z0-9\\-_]{20,}',
  'sk-[a-zA-Z0-9]{20,}',
  'AKIA[0-9A-Z]{16}',
  'Bearer\\s+[A-Za-z0-9\\-_=]+\\.[A-Za-z0-9\\-_=]+\\.[A-Za-z0-9\\-_.+/=]*',
  GENERIC_LONG_HEX_PATTERN_SOURCE,
];

/** Fresh `/g` RegExp instances — safe to reuse within a single synchronous scan. */
export function createSecretPatterns(options?: {
  /** When true, omit the broad long-hex catch (capability-token opt-out). */
  skipGenericLongHex?: boolean;
}): RegExp[] {
  const sources = options?.skipGenericLongHex
    ? SECRET_PATTERN_SOURCES.filter((s) => s !== GENERIC_LONG_HEX_PATTERN_SOURCE)
    : SECRET_PATTERN_SOURCES;
  return sources.map((source) => new RegExp(source, 'g'));
}
