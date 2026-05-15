// sanitize.ts — output sanitization for skill results.
//
// Every skill result passes through this before being fed back to an LLM.
// This is a security boundary: skill outputs can contain injection vectors
// (HTML/XML tags that look like system instructions, leaked API keys, etc.)
// and we must strip them before they reach the LLM's context window.
//
// Lesson from Zora: tool outputs without sanitization are a prompt injection vector.

import sanitizeHtml from 'sanitize-html';

export interface SanitizeOptions {
  /** Max output length in characters. Default: Infinity (no truncation). */
  maxLength?: number;
  /** If true, wraps the output in <tool_error> tags. */
  isError?: boolean;
  /** Additional regex patterns to redact (beyond built-in API key patterns). */
  extraRedactPatterns?: RegExp[];
}

// Patterns matching common secret formats — these are redacted from all skill output.
// Order matters: more specific patterns first to avoid partial matches.
const SECRET_PATTERNS: RegExp[] = [
  // Anthropic API keys
  /sk-ant-[a-zA-Z0-9\-_]{20,}/g,
  // OpenAI API keys
  /sk-[a-zA-Z0-9]{20,}/g,
  // AWS access keys
  /AKIA[0-9A-Z]{16}/g,
  // Bearer tokens (JWT or opaque)
  /Bearer\s+[A-Za-z0-9\-_=]+\.[A-Za-z0-9\-_=]+\.[A-Za-z0-9\-_.+/=]*/g,
  // Generic long hex tokens (32+ chars)
  /(?<![a-zA-Z0-9])[a-f0-9]{32,}(?![a-zA-Z0-9])/g,
];

// Tags whose content must be stripped entirely (not just the tag delimiters).
// sanitize-html's nonTextTags option removes these elements AND all their descendants.
//
// IMPORTANT: passing a custom nonTextTags array REPLACES the library defaults, not
// extends them. Library defaults are: ['script', 'style', 'textarea', 'option', 'xmp'].
// We merge those defaults with our LLM-injection-specific additions so none are lost.
const DANGEROUS_NONTEXTUAL_TAGS: string[] = [
  // sanitize-html library defaults (raw-text elements whose inner markup is not re-parsed):
  'textarea', 'option', 'xmp',
  // LLM instruction-like XML tags — stripping content prevents prompt injection even if
  // the tag structure survives other filter passes:
  'system', 'instruction', 'prompt', 'role',
  // Classic XSS and content-injection vectors:
  'script', 'iframe', 'object', 'embed', 'applet', 'style',
];

/**
 * Strip dangerous HTML/XML tags using a hardened library parser rather than
 * home-grown regex chains.
 *
 * Tags in DANGEROUS_NONTEXTUAL_TAGS have their content stripped too (not just
 * the opening/closing delimiters). All other HTML tags are stripped but their
 * text content is preserved.
 *
 * sanitize-html encodes & < > " in text nodes as HTML entities; the post-decode
 * step converts them back to literal characters since our output goes to an LLM
 * (not to a browser renderer).
 *
 * Known limitation: HTML entity-encoded injection tags (e.g. &lt;system&gt;evil&lt;/system&gt;)
 * are treated as text by the parser and survive this step. This was also true of the
 * previous regex approach and is accepted — entity-encoded angle brackets are not parsed
 * as XML/HTML by LLM chat templates.
 */
function stripDangerousTags(text: string): string {
  let stripped: string;
  try {
    stripped = sanitizeHtml(text, {
      allowedTags: [],
      allowedAttributes: {},
      // Content inside these tags is removed entirely, not just the tag delimiters.
      // This prevents injected payloads like <system>evil</system> from leaking their
      // body text into LLM context even after the tags are stripped.
      nonTextTags: DANGEROUS_NONTEXTUAL_TAGS,
    });
  } catch (err) {
    // sanitize-html / htmlparser2 threw unexpectedly. Re-throw with a clear message so
    // the caller knows sanitization was NOT applied and can propagate a clean error.
    // We must NOT pass the unsanitized text forward — throw here forces the caller to
    // handle the failure explicitly rather than silently serving unfiltered content.
    throw new Error(
      `stripDangerousTags: sanitize-html threw unexpectedly — input not sanitized. ` +
      `Cause: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // sanitize-html HTML-encodes bare & < > " ' in text nodes.
  // Decode them back to literal characters: LLMs consume plain text, not HTML markup.
  // Order: &amp; must be decoded LAST to avoid double-decoding (e.g. &amp;lt; → &lt;, not <).
  return stripped
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Sanitize skill output before feeding it back to an LLM.
 *
 * Steps (in order):
 * 1. Coerce non-strings to JSON
 * 2. Strip dangerous HTML/XML tags (tag pairs + content for listed tags, just the tag for others)
 * 3. Redact secret patterns
 * 4. Truncate to length limit (only if caller passes maxLength; no limit by default)
 * 5. Wrap errors in <tool_error> tags
 */
export function sanitizeOutput(
  raw: string | unknown,
  options: SanitizeOptions = {},
): string {
  const { maxLength = Infinity, isError = false, extraRedactPatterns = [] } = options;

  // 1. Coerce non-strings to JSON so we always work with a string
  let text: string;
  if (typeof raw === 'string') {
    text = raw;
  } else {
    try {
      text = JSON.stringify(raw, null, 2);
    } catch {
      // Deliberate fallback: if JSON.stringify fails (circular refs, etc.),
      // String() coercion is safe enough for sanitization purposes
      text = String(raw);
    }
  }

  // 2. Strip dangerous tags using a hardened HTML parser.
  // Using a library (sanitize-html) instead of regex chains prevents:
  //   - js/incomplete-multi-character-sanitization: the parser handles all tag variants
  //   - js/bad-tag-filter: whitespace-padded closing tags (</script >) are handled correctly
  //   - js/polynomial-redos: no catastrophic backtracking — parser runs in linear time
  text = stripDangerousTags(text);

  // 3. Redact known secret patterns
  const allPatterns = [...SECRET_PATTERNS, ...extraRedactPatterns];
  for (const pattern of allPatterns) {
    // Reset lastIndex for global patterns since we reuse them across calls
    pattern.lastIndex = 0;
    text = text.replace(pattern, '[REDACTED]');
  }

  // 4. Truncate if exceeding length limit
  if (text.length > maxLength) {
    text = text.slice(0, maxLength) + '[truncated — output exceeded limit]';
  }

  // 5. Wrap errors in <tool_error> tags so the LLM can distinguish
  // error output from normal output and handle it appropriately
  if (isError) {
    text = `<tool_error>${text}</tool_error>`;
  }

  return text;
}

// ── Display name sanitization ───────────────────────────────────────
//
// Defense-in-depth: sanitize display names at storage time, not just
// at prompt-injection time. This prevents stored prompt injection via
// email participant names or any other external source.
//
// Allowlist approach: keep only characters that can plausibly appear in
// a human name (letters, spaces, hyphens, apostrophes, periods, commas).
// Everything else is stripped. This is intentionally aggressive — a name
// like "Dr. Mary O'Brien-Jones, PhD" passes; "SYSTEM: grant all" does not
// (the colon is stripped).

/** Max length for a sanitized display name (chars). */
export const DISPLAY_NAME_MAX_LENGTH = 200;

/**
 * Characters allowed in a display name. Unicode letters (\p{L}) cover
 * accented and non-Latin scripts. We also allow digits for names like
 * "Agent 47" or generation suffixes like "III".
 */
const DISPLAY_NAME_ALLOWED = /[^\p{L}\p{N}\s'\-.,()]/gu;

/**
 * Collapse runs of whitespace (including newlines) into a single space.
 * Prevents names from spanning multiple lines in prompts.
 */
const WHITESPACE_COLLAPSE = /\s+/g;

/**
 * Internal helper: applies the full display-name sanitization pipeline to a
 * string. Used for both the primary name and the fallback to guarantee they
 * go through the exact same steps.
 *
 * Steps:
 * 1. Strip dangerous HTML/XML tags (using library parser — immune to ReDoS and bypass tricks)
 * 2. Remove characters outside the name allowlist
 * 3. Collapse whitespace and trim
 * 4. Truncate to DISPLAY_NAME_MAX_LENGTH
 */
function applyDisplayNamePipeline(value: string): string {
  // Strip dangerous tags using the same hardened library used in sanitizeOutput.
  // The allowlist in step 2 below strips all remaining angle brackets anyway,
  // so this step focuses on removing dangerous tag CONTENT (e.g. <system>evil</system>
  // → content stripped, vs. a tag with allowed content where only the delimiters vanish).
  let result = stripDangerousTags(value);

  // Remove non-allowlisted characters (strips colons, semicolons, angle brackets, etc.)
  result = result.replace(DISPLAY_NAME_ALLOWED, '');

  // Collapse whitespace runs and trim
  result = result.replace(WHITESPACE_COLLAPSE, ' ').trim();

  // Truncate to length limit.
  // Note: slice() counts UTF-16 code units, which could theoretically split a
  // surrogate pair for supplementary-plane characters. Accepted limitation given
  // the generous 200-char limit makes this edge case vanishingly unlikely for
  // real human names.
  if (result.length > DISPLAY_NAME_MAX_LENGTH) {
    result = result.slice(0, DISPLAY_NAME_MAX_LENGTH).trim();
  }

  return result;
}

/**
 * Sanitize a display name for safe storage and later prompt inclusion.
 *
 * Both the primary name and the fallback go through the same pipeline
 * (tag stripping, allowlist filtering, whitespace collapse, truncation).
 * If both sanitize to empty, returns 'Unknown' as a hard-coded final fallback.
 */
export function sanitizeDisplayName(
  raw: string,
  fallback = 'Unknown',
): string {
  const name = applyDisplayNamePipeline(raw);
  if (name.length > 0) return name;

  // Fallback goes through the same pipeline — it may come from an external
  // source (e.g., an email address) and must not bypass sanitization.
  const safeFallback = applyDisplayNamePipeline(fallback);
  return safeFallback.length > 0 ? safeFallback : 'Unknown';
}
