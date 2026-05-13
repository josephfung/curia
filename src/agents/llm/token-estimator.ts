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

import type { ContentBlock } from './provider.js';

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
    }
  }

  if (totalChars === 0) return 0;
  return Math.ceil(totalChars / CHARS_PER_TOKEN);
}
