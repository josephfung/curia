// prompt-exfiltration-markers.ts — markers for Stage 1 system-prompt-fragment detection.
//
// These phrases signal the LLM echoed its own instructions into outbound prose.
// Markers come from two places, both derived at boot from the *actual* deployed
// configuration (never hardcoded guesses that could drift from reality):
//
//   1. OfficeIdentity fields (name, constraints, behavioralPreferences) — the
//      identity block is injected into the prompt via ${office_identity_block}
//      at runtime, so its verbatim text is NOT present in the raw prompt template
//      and must be pulled from OfficeIdentity directly.
//   2. Distinctive instruction lines extracted from the agent's system prompt
//      template itself — the provenance rules, "never name internals" directives,
//      and transfer-ownership contract. This is the highest-value exfiltration
//      target (the material an attacker running a prompt-extraction injection is
//      after) and, because it is read from the live prompt, it automatically
//      tracks any operator customization of that prompt.

import type { OfficeIdentity } from '../identity/types.js';

/**
 * Minimum length for identity-derived markers (constraints, preferences). These
 * are short, user-written invariants that are inherently distinctive, so a modest
 * gate is enough to skip trivial fragments.
 */
export const MIN_EXFILTRATION_MARKER_LENGTH = 15;

/**
 * Minimum length for lines extracted from the system prompt template. Prompt
 * prose is longer and less unique per-word than a hand-written constraint, so a
 * higher gate is required: a verbatim run of this many characters appearing in
 * outbound content is overwhelmingly likely to be leaked instruction text rather
 * than coincidence. Measured after markdown/whitespace normalization.
 */
export const MIN_PROMPT_MARKER_LENGTH = 40;

/**
 * Normalize a phrase for whitespace- and markdown-insensitive substring matching.
 *
 * A leaking LLM reproduces the *words* of its prompt but re-wraps the lines and
 * frequently drops markdown decoration (`**bold**`, `` `code` ``). Raw verbatim
 * matching against the hard-wrapped YAML source would therefore miss real leaks.
 * Collapsing whitespace and stripping light markdown keeps the match deterministic
 * while making it robust to re-wrapping. Applied identically to every marker and
 * to the outbound content, so both sides are compared on the same footing.
 */
export function normalizeFragmentText(text: string): string {
  return text
    .toLowerCase()
    // Strip markdown emphasis / inline-code markers so `**never**` matches `never`.
    .replace(/[*`_]/g, '')
    // Collapse every whitespace run (including newlines from re-wrapping) to one space.
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract distinctive instruction lines from an agent system prompt template.
 *
 * Each qualifying line becomes a tripwire: if it appears verbatim (modulo
 * whitespace/markdown, see {@link normalizeFragmentText}) in outbound content,
 * the agent has echoed its own instructions. These lines are meta-instructions
 * about how to behave — they never legitimately appear in business prose — so a
 * length-gated verbatim match is high-precision.
 *
 * Lines containing unresolved `${...}` interpolation tokens are skipped: those
 * tokens are replaced at runtime, so the template text never appears verbatim in
 * output and would only ever be a dead marker. Lines shorter than
 * MIN_PROMPT_MARKER_LENGTH after normalization are skipped as too generic to
 * match safely (this also drops headings and structural fragments).
 *
 * Note: extracting whole lines (rather than the quoted example sub-phrases inside
 * them) is deliberate — it keeps encouraged example phrases like "I have it on
 * file" from becoming standalone markers that would false-positive on legitimate
 * output, because the marker includes the surrounding instruction text.
 */
export function extractSystemPromptLineMarkers(systemPrompt: string): string[] {
  const markers: string[] = [];

  for (const rawLine of systemPrompt.split('\n')) {
    // Unresolved interpolation token — never emitted verbatim, so useless as a marker.
    if (rawLine.includes('${')) continue;

    // Strip a leading markdown list/blockquote marker (bullet, ordered-list
    // numeral, or `>`) so the length gate reflects instruction text, not decoration.
    // The marker must be followed by whitespace to count — this avoids clipping a
    // single `*` off `**bold**` emphasis, which is not a list marker. (Any residual
    // markdown is normalized away at match time by normalizeFragmentText.)
    const cleaned = rawLine.replace(/^\s*(?:[-*>]|\d+\.)\s+/, '').trim();

    if (normalizeFragmentText(cleaned).length < MIN_PROMPT_MARKER_LENGTH) continue;

    markers.push(cleaned);
  }

  return markers;
}

/**
 * Extract marker phrases that indicate system-prompt exfiltration if they appear
 * verbatim in outbound content.
 *
 * @param identity     Office identity — supplies name and user-written constraints/
 *                     preferences that are injected into the prompt at runtime.
 * @param systemPrompt Optional raw system prompt template (e.g. the coordinator's
 *                     `system_prompt`). When provided, its distinctive instruction
 *                     lines are extracted — this is the primary exfiltration target.
 *                     The parameter is generic so the same extractor can cover any
 *                     agent whose output is filtered.
 *
 * Deliberately excludes "${name}, ${title}" — that is the standard email signature
 * and would false-positive on every outbound message.
 */
export function extractPromptExfiltrationMarkers(
  identity: OfficeIdentity,
  systemPrompt?: string,
): string[] {
  const markers: string[] = [];

  // "You are [name]" echoes the identity header instruction form — never normal prose.
  if (identity.assistant.name) {
    markers.push(`You are ${identity.assistant.name}`);
  }

  // Constraints and behavioral preferences are injected via ${office_identity_block}
  // at runtime, so they are not present in the raw prompt template and must be
  // pulled from the identity directly.
  //
  // Gate on the *normalized* length (not the raw length): a marker that is all
  // markdown/punctuation would pass a raw-length gate yet normalize to an empty or
  // near-empty string — which contributes no live matcher (so the empty-marker
  // canary in index.ts would stay silent while detection is effectively off) and,
  // at length 0, would match every message. Normalized gating rules both out.
  for (const constraint of identity.constraints) {
    if (normalizeFragmentText(constraint).length >= MIN_EXFILTRATION_MARKER_LENGTH) {
      markers.push(constraint);
    }
  }
  for (const pref of identity.behavioralPreferences) {
    if (normalizeFragmentText(pref).length >= MIN_EXFILTRATION_MARKER_LENGTH) {
      markers.push(pref);
    }
  }

  // The static defensive instructions (provenance rules, "never name internals",
  // transfer-ownership contract) live in the prompt template itself. Extract them
  // from the live prompt so the highest-value exfiltration target is covered and
  // the markers track any operator customization of the prompt.
  if (systemPrompt) {
    markers.push(...extractSystemPromptLineMarkers(systemPrompt));
  }

  // Deduplicate while preserving order (a constraint may also appear as a prompt line).
  return [...new Set(markers)];
}
