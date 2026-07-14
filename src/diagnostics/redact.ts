// redact.ts — shared redaction for diagnostics skill output (#1356).
//
// The diagnostics agent reads internal audit + operational state and hands a
// summary back to the principal. Two things must never surface raw: PII (emails,
// cards, phone numbers) and the unbounded raw content of agent scratch
// (working_memory) or event payloads. This module is the single place that
// bounds and scrubs that content before it leaves a diagnostics skill.
//
// It is a defence-in-depth layer, not the only one: the execution layer already
// runs sanitizeObjectOutput() over every skill result (structured secrets — API
// keys, JWTs, AWS keys, long hex). scrubPii() does NOT run there, so we apply it
// here to the free-text fields we deliberately surface.

import { scrubPii } from '../pii/scrubber.js';

/** Default preview cap for a single free-text field (e.g. working_memory.content). */
export const DEFAULT_TEXT_PREVIEW = 500;

/**
 * Scrub PII from a free-text string and truncate to a bounded preview. Returns
 * null/undefined unchanged so callers can distinguish "absent" from "empty".
 * A truncated string is suffixed with an explicit marker so the agent knows it
 * is reading a preview, not the whole field.
 */
export function redactText(value: string | null | undefined, maxLen = DEFAULT_TEXT_PREVIEW): string | null | undefined {
  if (value === null || value === undefined) return value;
  const scrubbed = scrubPii(value);
  if (scrubbed.length <= maxLen) return scrubbed;
  return `${scrubbed.slice(0, maxLen)}… [truncated ${scrubbed.length - maxLen} chars]`;
}

interface SummarizeOptions {
  /** Max recursion depth before deeper structure is elided. Default 3. */
  maxDepth?: number;
  /** Max string-leaf length before truncation. Default 200. */
  maxStringLen?: number;
  /** Max array elements / object keys retained per level. Default 25. */
  maxEntries?: number;
}

/**
 * Produce a bounded, PII-scrubbed summary of an arbitrary JSONB payload. Keeps
 * the structurally useful keys an investigator needs (skillName, taskId, blockId,
 * result.success, error, recipientId, …) visible while capping depth, breadth,
 * and string length so a large or sensitive payload cannot be dumped wholesale.
 *
 * Structured secrets are additionally scrubbed downstream by the execution
 * layer's sanitizeObjectOutput(); this pass handles PII and size.
 */
export function summarizePayload(value: unknown, options: SummarizeOptions = {}): unknown {
  const maxDepth = options.maxDepth ?? 3;
  const maxStringLen = options.maxStringLen ?? 200;
  const maxEntries = options.maxEntries ?? 25;
  return summarize(value, 0, maxDepth, maxStringLen, maxEntries);
}

function summarize(
  value: unknown,
  depth: number,
  maxDepth: number,
  maxStringLen: number,
  maxEntries: number,
): unknown {
  if (typeof value === 'string') {
    const scrubbed = scrubPii(value);
    return scrubbed.length <= maxStringLen
      ? scrubbed
      : `${scrubbed.slice(0, maxStringLen)}… [+${scrubbed.length - maxStringLen}]`;
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (depth >= maxDepth) {
    return Array.isArray(value) ? '[…]' : '{…}';
  }
  if (Array.isArray(value)) {
    const kept = value.slice(0, maxEntries).map((v) => summarize(v, depth + 1, maxDepth, maxStringLen, maxEntries));
    if (value.length > maxEntries) kept.push(`… [+${value.length - maxEntries} more]`);
    return kept;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>);
    for (const [k, v] of entries.slice(0, maxEntries)) {
      out[k] = summarize(v, depth + 1, maxDepth, maxStringLen, maxEntries);
    }
    if (entries.length > maxEntries) out['…'] = `[+${entries.length - maxEntries} more keys]`;
    return out;
  }
  // Fallback for unexpected types (function, symbol, bigint, undefined).
  return typeof value;
}
