// token-estimator.ts — rough token count estimation for context budgeting.
//
// Uses the industry-standard approximation of 3.5 characters per token, which
// works well for English prose and JSON payloads. This is deliberately a fast,
// allocation-free estimate — not a tiktoken/cl100k call — because it runs on
// every message in the context window assembly loop.
//
// Accuracy: within ~10% for typical mixed English+JSON content. Good enough
// for deciding whether to prune history; the actual token count comes from the
// API response after the call.

import type { ContentBlock, Message } from './provider.js';

/** Characters-per-token ratio used for all estimates. */
const CHARS_PER_TOKEN = 3.5;

/**
 * Estimates the token count for a plain string or an array of ContentBlocks.
 *
 * For strings: ceil(charCount / 3.5)
 * For ContentBlock arrays: sums the text representation of each block, then
 * applies the same ceil formula.
 *
 * Returns 0 for empty input.
 */
export function estimateTokens(content: string | ContentBlock[]): number {
  if (typeof content === 'string') {
    if (content.length === 0) return 0;
    return Math.ceil(content.length / CHARS_PER_TOKEN);
  }

  let totalChars = 0;
  for (const block of content) {
    switch (block.type) {
      case 'text':
        totalChars += block.text.length;
        break;
      case 'tool_use':
        // Include the tool name and serialised input — both show up in the prompt.
        totalChars += block.name.length + JSON.stringify(block.input).length;
        break;
      case 'tool_result':
        totalChars += block.content.length;
        break;
      default: {
        // Exhaustiveness guard — if ContentBlock union is extended, this line
        // becomes a compile error, prompting the developer to handle the new type.
        // At runtime, fall back to JSON.stringify as a conservative estimate.
        const _exhaustive: never = block;
        totalChars += JSON.stringify(_exhaustive).length;
        break;
      }
    }
  }

  if (totalChars === 0) return 0;
  return Math.ceil(totalChars / CHARS_PER_TOKEN);
}

// Per-message overhead: role token + structural delimiters.
const MESSAGE_OVERHEAD_TOKENS = 4;

/**
 * Estimates the total token count for an array of messages.
 *
 * Each message contributes estimateTokens(content) + MESSAGE_OVERHEAD_TOKENS
 * to account for the role name and structural delimiters that the API adds
 * around each turn in the conversation.
 *
 * Returns 0 for an empty array.
 */
export function estimateMessagesTokens(messages: Message[]): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateTokens(msg.content) + MESSAGE_OVERHEAD_TOKENS;
  }
  return total;
}

// -- Context window map --
// Maps model name prefixes to their advertised context window sizes (in tokens).
// Sorted by descending key length so that more-specific prefixes match first
// (e.g. "claude-haiku-4-5-20251001" matches "claude-haiku-4-5" before "claude").
const CONTEXT_WINDOWS: Record<string, number> = {
  'claude-opus-4-6': 200_000,
  'claude-sonnet-4-6': 200_000,
  'claude-haiku-4-5': 200_000,
};

const SORTED_WINDOW_ENTRIES = Object.entries(CONTEXT_WINDOWS)
  .sort(([a], [b]) => b.length - a.length);

const FALLBACK_WINDOW_MODEL = 'claude-sonnet-4-6';

/**
 * Returns the context window size for the given model identifier.
 *
 * Matches by prefix so versioned model names (e.g. "claude-haiku-4-5-20251001")
 * resolve correctly. Falls back to the sonnet window for unrecognised models.
 */
export function getContextWindow(model: string): number {
  const entry = SORTED_WINDOW_ENTRIES.find(([prefix]) => model.startsWith(prefix));
  return entry ? entry[1] : CONTEXT_WINDOWS[FALLBACK_WINDOW_MODEL]!;
}

/** Returns true if the model is in the known context window map (not using fallback). */
export function isKnownContextWindowModel(model: string): boolean {
  return SORTED_WINDOW_ENTRIES.some(([prefix]) => model.startsWith(prefix));
}

/** Safety margin (5%) subtracted from the context window before budgeting. */
export const DEFAULT_SAFETY_MARGIN = 0.05;

/** Default model used when agent YAML doesn't specify one. Kept alongside the
 *  context window map so the default and the lookup stay in lockstep. */
export const DEFAULT_MODEL_NAME = 'claude-sonnet-4-6';
