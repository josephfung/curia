// reasoning-blocks.ts — shared handling of passed-back reasoning (ADR-048 §1).
//
// Providers capture the reasoning a model returned beside its tool calls as
// ReasoningContent blocks, and the tool loop carries them into the next request.
// This module holds what more than one place needs: which blocks a request may
// send back, the archive marker that replaces them, their size estimate, and the
// prefix hash behind Anthropic's prefix guard.

import { createHash, type Hash } from 'node:crypto';
import type { ContentBlock, ReasoningContent } from './provider.js';
import type { Logger } from '../../logger.js';

export function isReasoningBlock(block: ContentBlock): block is ReasoningContent {
  return block.type === 'reasoning';
}

/**
 * The reasoning blocks in an assistant turn that this request may send back:
 * written by this provider for this model. Anything else (a tier fallback to
 * another model, #813, or another provider) is dropped, because the receiving
 * model cannot use it and some providers reject it.
 */
export function sendableReasoningBlocks(
  blocks: readonly ContentBlock[],
  provider: ReasoningContent['provider'],
  model: string,
  logger: Logger,
): ReasoningContent[] {
  const reasoning = blocks.filter(isReasoningBlock);
  const sendable = reasoning.filter((block) => block.provider === provider && block.model === model);
  if (sendable.length < reasoning.length) {
    logger.debug(
      {
        provider,
        model,
        dropped: reasoning.length - sendable.length,
        from: [...new Set(reasoning.filter((b) => !sendable.includes(b)).map((b) => `${b.provider}:${b.model}`))],
      },
      'Dropping passed-back reasoning written by another model or provider',
    );
  }
  return sendable;
}

/** What the prompt archive stores in place of a reasoning block. */
export interface ArchivedReasoningMarker {
  type: 'reasoning';
  provider: ReasoningContent['provider'];
  model: string;
  omitted: true;
}

function isReasoningBlockShape(value: Record<string, unknown>): boolean {
  return value.type === 'reasoning'
    && (value.provider === 'openrouter' || value.provider === 'anthropic')
    && typeof value.model === 'string'
    && 'data' in value;
}

/**
 * Replace every reasoning block in an archive prompt with a marker. Encrypted
 * reasoning and signatures must never reach llm_call_archive, and the readable
 * text is already in the response row of the call that produced it. Returns a
 * new value; the input is not mutated.
 */
export function markReasoningBlocksForArchive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(markReasoningBlocksForArchive);
  if (value === null || typeof value !== 'object') return value;
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;
  const record = value as Record<string, unknown>;
  if (isReasoningBlockShape(record)) {
    const marker: ArchivedReasoningMarker = {
      type: 'reasoning',
      provider: record.provider as ReasoningContent['provider'],
      model: record.model as string,
      omitted: true,
    };
    return marker;
  }
  const copy: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) copy[key] = markReasoningBlocksForArchive(child);
  return copy;
}

// Fields that carry reasoning the model reads back. Signatures are opaque
// verification tokens, not reasoning, so they are not counted.
const COUNTED_REASONING_FIELDS = new Set(['text', 'summary', 'thinking', 'reasoning', 'data']);

function countReasoningChars(value: unknown): number {
  if (Array.isArray(value)) return value.reduce<number>((sum, item) => sum + countReasoningChars(item), 0);
  if (value === null || typeof value !== 'object') return 0;
  let total = 0;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (typeof child === 'string') {
      if (COUNTED_REASONING_FIELDS.has(key)) total += child.length;
    } else {
      total += countReasoningChars(child);
    }
  }
  return total;
}

/**
 * Characters a reasoning block adds to the next prompt, for the context budget.
 * Readable text counts by length; encrypted data counts by length too, as an
 * upper bound on its token cost.
 */
export function reasoningBlockChars(block: ReasoningContent): number {
  if (typeof block.data === 'string') return block.data.length;
  return countReasoningChars(block.data);
}

/**
 * Incremental SHA-256 over a provider request's prefix: its system and tools,
 * then its messages one at a time. `digestNow()` gives the hash of everything
 * fed so far without ending the stream, so one pass yields the hash of every
 * prefix (Anthropic's prefix guard, ADR-048 §1).
 */
export class PrefixHasher {
  private readonly hash: Hash;

  constructor(system: unknown, tools: unknown) {
    this.hash = createHash('sha256');
    this.hash.update(JSON.stringify(system ?? null));
    this.hash.update('\u0000');
    this.hash.update(JSON.stringify(tools ?? null));
  }

  addMessage(message: unknown): void {
    this.hash.update('\u0000');
    this.hash.update(JSON.stringify(message));
  }

  digestNow(): string {
    return this.hash.copy().digest('hex');
  }
}
