// prompt-exfiltration-markers.ts — markers for Stage 1 system-prompt-fragment detection.
//
// These phrases signal the LLM echoed its own instructions into outbound prose.
// Identity-specific strings (name, constraints, preferences) are extracted from
// OfficeIdentity; static instruction-prefix patterns complement them.

import type { OfficeIdentity } from '../identity/types.js';

/** Skip very short strings — unlikely to be innocent verbatim matches. */
export const MIN_EXFILTRATION_MARKER_LENGTH = 15;

/**
 * Instruction-framing phrases from agent system prompts. Their verbatim appearance
 * in outbound email is a strong signal of prompt leakage, not normal business prose.
 * Only patterns meeting MIN_EXFILTRATION_MARKER_LENGTH are included.
 */
export const PROMPT_INSTRUCTION_PREFIX_MARKERS: readonly string[] = [
  'Your role is to',
  'When you receive a task',
  'Hard constraints (non-negotiable)',
  'Identity & Communication Contract',
];

/**
 * Extract marker phrases that indicate system-prompt exfiltration if they appear
 * verbatim in outbound content.
 *
 * Signals:
 * - "You are [name]" — echoes the identity header instruction form
 * - constraints[] and behavioralPreferences[] — user-written, length-gated
 * - instruction-prefix patterns — static framing phrases from system prompts
 *
 * Deliberately excludes "${name}, ${title}" — that is the standard email signature
 * and would false-positive on every outbound message.
 */
export function extractPromptExfiltrationMarkers(identity: OfficeIdentity): string[] {
  const markers: string[] = [];

  if (identity.assistant.name) {
    markers.push(`You are ${identity.assistant.name}`);
  }

  for (const constraint of identity.constraints) {
    if (constraint.length >= MIN_EXFILTRATION_MARKER_LENGTH) {
      markers.push(constraint);
    }
  }

  for (const pref of identity.behavioralPreferences) {
    if (pref.length >= MIN_EXFILTRATION_MARKER_LENGTH) {
      markers.push(pref);
    }
  }

  markers.push(...PROMPT_INSTRUCTION_PREFIX_MARKERS);

  // Deduplicate while preserving order (constraints may overlap with prefixes).
  return [...new Set(markers)];
}
