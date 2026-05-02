// pii/scrubber.ts — synchronous PII scrubber for error strings and log output.
//
// Uses regex patterns extracted from openredaction at module-load time. Keeping
// the scrubber synchronous is a deliberate choice — it plugs into
// sanitizeOutput() and sanitizeMessage(), which are both sync. Making those async
// would cascade through the entire error normalization path.
//
// The library is used as a pattern source, not as a runtime dependency on hot paths.
// Regexes are compiled once at startup; scrub() itself is a plain string loop.
//
// UUID protection: several PII patterns (especially CREDIT_CARD and PHONE_US) can
// false-positive on UUID segments (e.g. "0000-0000-0000-0001" looks like a card
// number). We protect UUIDs before scrubbing and restore them after.

import { allPatterns as _allPatterns } from 'openredaction';

/** A compiled PII pattern ready for synchronous scrubbing. */
export interface PiiPattern {
  /** Human-readable name used in logs and config (e.g. "email", "phone_us"). */
  name: string;
  /** The compiled regex — must have the global flag. */
  regex: RegExp;
  /** Replacement string, e.g. "[EMAIL]". */
  replacement: string;
}

/** A single PII match found by detectPii(). */
export interface PiiMatch {
  /** Pattern name in lowercase (e.g. "email", "credit_card", "extra_0"). */
  label: string;
  /** Start index in the original text. */
  start: number;
  /** End index (exclusive). */
  end: number;
  /** The matched substring from the original text. */
  matched: string;
}

// Standard RFC 4122 UUID pattern. UUIDs are extremely common in Curia log
// output (conversation IDs, task IDs, contact IDs) and must be shielded from
// PII pattern matching — some patterns (credit card, phone) false-positive on
// UUID hex digit segments.
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/**
 * Extract a pattern from the openredaction allPatterns list by type name.
 * Returns null if the type is not found (library version drift).
 */
function extractPattern(typeName: string): RegExp | null {
  const patterns = _allPatterns as Array<{ type: string; regex: unknown }>;
  const entry = patterns.find((p) => p.type === typeName);
  if (!entry || !(entry.regex instanceof RegExp)) return null;

  let source = entry.regex.source;

  // The library's PHONE_US regex uses \b (word boundary) anchors, which don't
  // match before '(' in the common "(NXX) NXX-XXXX" format — \b requires a
  // word/non-word transition, but space-then-paren is non-word to non-word.
  // Replace \b with digit-boundary assertions so parenthesized numbers match.
  if (typeName === 'PHONE_US') {
    source = source.replace(/^\\b/, '(?<!\\d)').replace(/\\b$/, '(?!\\d)');
  }

  // Clone with explicit global flag — the library's regexes use global already,
  // but we clone to avoid shared lastIndex state across concurrent calls.
  const flags = entry.regex.flags.includes('g') ? entry.regex.flags : entry.regex.flags + 'g';
  try {
    return new RegExp(source, flags);
  } catch {
    // The regex fixup (or a library change) produced an invalid pattern.
    // Return null so buildBuiltInPatterns() records this in missingPatternTypes
    // and index.ts logs the failure at error level once the logger is available.
    return null;
  }
}

/**
 * Built-in PII patterns sourced from openredaction.
 *
 * Deliberately narrow: only include patterns with low false-positive risk
 * in the context of structured application logs and error messages.
 *
 * Intentionally excluded:
 *   - PHONE_INTERNATIONAL: too broad, matches many numeric IDs
 *   - PHONE_UK: the openredaction v1.1 regex makes the +44/0 prefix optional,
 *     matching arbitrary 9-12 digit sequences (order IDs, reference numbers).
 *     PHONE_UK_MOBILE (requires 7xxx prefix) is specific enough for UK coverage.
 *   - CANADIAN_SIN: `\d{3}[-\s]?\d{3}[-\s]?\d{3}` matches too many 9-digit
 *     sequences in application data (order IDs, reference numbers, etc.)
 *   - ADDRESS_*: high false-positive rate in log strings
 *   - NAME: extremely high false-positive rate
 *
 * CREDIT_CARD is listed before PHONE patterns to prevent partial matches —
 * a phone regex could eat part of a card number if it ran first.
 *
 * All built-in patterns are applied with UUID protection (see scrubPii).
 */
function buildBuiltInPatterns(): PiiPattern[] {
  const entries: Array<{ typeName: string; replacement: string }> = [
    { typeName: 'EMAIL',           replacement: '[EMAIL]'       },
    { typeName: 'CREDIT_CARD',     replacement: '[CREDIT_CARD]' },
    { typeName: 'PHONE_US',        replacement: '[PHONE]'       },
    { typeName: 'PHONE_UK_MOBILE', replacement: '[PHONE]'       },
    // SSN: the library's pattern requires an "SSN" / "social security" keyword
    // prefix, making it safe from false positives on bare digit sequences.
    { typeName: 'SSN',             replacement: '[SSN]'         },
  ];

  const result: PiiPattern[] = [];
  for (const { typeName, replacement } of entries) {
    const regex = extractPattern(typeName);
    if (regex) {
      result.push({ name: typeName.toLowerCase(), regex, replacement });
    } else {
      // Library version drift — pattern not found. Record in missingPatternTypes
      // so index.ts can log the failure via pino after the logger is initialized.
      // We never call console.warn here — the project's lint rule prohibits it and
      // this module is loaded before pino exists.
      missingPatternTypes.push(typeName);
    }
  }
  return result;
}

// Names of built-in patterns that failed to load from openredaction.
// Populated during module init; read by index.ts via getMissingBuiltInPatterns().
const missingPatternTypes: string[] = [];

/**
 * Returns the names of any built-in PII patterns that failed to load due to
 * library version drift. Empty array means all patterns loaded successfully.
 * Called by index.ts to log failures via pino after the logger is available.
 */
export function getMissingBuiltInPatterns(): string[] {
  return missingPatternTypes;
}

/** Number of built-in patterns that loaded successfully. Used for startup logging. */
export function getBuiltInPatternCount(): number {
  return BUILT_IN_PATTERNS.length;
}

// Compiled once at module load — avoids per-call regex compilation.
const BUILT_IN_PATTERNS: PiiPattern[] = buildBuiltInPatterns();

/**
 * Detect PII in text and return an array of matches with position information.
 *
 * UUID protection: UUIDs are replaced in the scan buffer with null bytes of
 * the same length so indices are preserved. Matches overlapping a shielded
 * UUID region (containing \x00) are skipped. Matched text is always sliced
 * from the original (unshielded) text so callers get the real characters.
 *
 * Results are sorted by start position (ascending).
 *
 * This is the shared detection core used by both scrubPii() (for replacement)
 * and PiiRedactor (for annotation/reporting).
 *
 * @param text          The string to scan.
 * @param extraPatterns Additional patterns from operator config.
 */
export function detectPii(text: string, extraPatterns: PiiPattern[] = []): PiiMatch[] {
  // Shield UUIDs by replacing them with null bytes of the same length. This
  // preserves byte indices for all text after the UUID, unlike the token
  // approach used by scrubPii (which changes string length). Matches that
  // overlap a shielded region will contain \x00 and are skipped below.
  const shielded = text.replace(UUID_RE, (match) => '\x00'.repeat(match.length));

  const matches: PiiMatch[] = [];
  const allPatterns = [...BUILT_IN_PATTERNS, ...extraPatterns];
  // Overlap guard: returns true if [start, end) intersects any already-accepted match.
  // Pattern order in allPatterns is precedence — the first pattern to claim a region wins.
  // This prevents, e.g., a PHONE pattern from consuming part of an already-matched CREDIT_CARD.
  const overlapsExisting = (start: number, end: number): boolean =>
    matches.some((m) => start < m.end && end > m.start);

  for (const { name, regex } of allPatterns) {
    // Reset lastIndex — global regexes retain state across calls if reused.
    regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(shielded)) !== null) {
      // Skip any match that covers shielded UUID territory.
      if (m[0].includes('\x00')) continue;
      const start = m.index;
      const end = m.index + m[0].length;
      // Skip if this span overlaps an already-accepted match.
      if (overlapsExisting(start, end)) continue;
      matches.push({
        label: name,
        start,
        end,
        // Slice from original text — shielded only used for position tracking.
        matched: text.slice(start, end),
      });
    }
  }

  matches.sort((a, b) => a.start - b.start);
  return matches;
}

/**
 * Scrub PII from a string using the built-in patterns plus any caller-supplied
 * extra patterns (from config/default.yaml).
 *
 * Delegates detection to detectPii() for shared logic, then applies replacements
 * end-to-start so that earlier match indices remain valid as the string shrinks.
 *
 * This function is intentionally synchronous — it is called on every error
 * message that enters LLM context and must not introduce async overhead.
 *
 * @param text          The string to scrub.
 * @param extraPatterns Additional patterns from operator config (loaded once
 *                      at startup and passed through the call chain).
 */
export function scrubPii(text: string, extraPatterns: PiiPattern[] = []): string {
  const matches = detectPii(text, extraPatterns);
  if (matches.length === 0) return text;

  // Build a lookup so we can find each pattern's replacement string by name.
  const allPatterns = [...BUILT_IN_PATTERNS, ...extraPatterns];
  const replacementByName = new Map(allPatterns.map((p) => [p.name, p.replacement]));

  // Apply replacements end-to-start so earlier indices stay valid as the
  // string length changes with each substitution.
  let result = text;
  for (let i = matches.length - 1; i >= 0; i--) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const match = matches[i]!;  // safe: i is a valid index (0 ≤ i < matches.length)
    const replacement = replacementByName.get(match.label) ?? `[${match.label.toUpperCase()}]`;
    result = result.slice(0, match.start) + replacement + result.slice(match.end);
  }
  return result;
}

/**
 * Parse operator-supplied PII patterns from config/default.yaml.
 *
 * Each entry specifies a raw regex string and a replacement label.
 * Called once at startup; the resulting PiiPattern[] is passed into scrubPii()
 * at each call site.
 *
 * Throws on invalid regex so startup fails loudly rather than silently
 * running with broken PII config.
 */
export function parseExtraPiiPatterns(
  entries: Array<{ regex: string; replacement: string }>,
  configPath: string,
): PiiPattern[] {
  return entries.map((entry, i) => {
    if (typeof entry.regex !== 'string' || !entry.regex) {
      throw new Error(`pii.extra_patterns[${i}] is missing a valid 'regex' string in ${configPath}`);
    }
    if (typeof entry.replacement !== 'string' || !entry.replacement) {
      throw new Error(`pii.extra_patterns[${i}] is missing a valid 'replacement' string in ${configPath}`);
    }

    let compiled: RegExp;
    try {
      // Always global + case-insensitive, matching built-in pattern behavior.
      compiled = new RegExp(entry.regex, 'gi');
    } catch (regexErr) {
      throw new Error(
        `pii.extra_patterns[${i}] has invalid regex '${entry.regex}' in ${configPath}`,
        { cause: regexErr },
      );
    }

    return {
      name: `extra_${i}`,
      regex: compiled,
      replacement: entry.replacement,
    };
  });
}
