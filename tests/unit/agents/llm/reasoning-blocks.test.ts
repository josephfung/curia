// reasoning-blocks.test.ts — shared handling of passed-back reasoning (ADR-048 §1).

import { describe, it, expect } from 'vitest';
import {
  markReasoningBlocksForArchive,
  PrefixHasher,
  reasoningBlockChars,
  sendableReasoningBlocks,
} from '../../../../src/agents/llm/reasoning-blocks.js';
import { estimateTokens } from '../../../../src/agents/llm/token-estimator.js';
import { createSilentLogger } from '../../../../src/logger.js';
import type { ContentBlock, ReasoningContent } from '../../../../src/agents/llm/provider.js';

const anthropicBlock: ReasoningContent = {
  type: 'reasoning',
  provider: 'anthropic',
  model: 'claude-haiku-5-5',
  data: { type: 'thinking', thinking: 'abcd', signature: 'SIGNATURE-NOT-COUNTED' },
};
const openRouterBlock: ReasoningContent = {
  type: 'reasoning',
  provider: 'openrouter',
  model: 'deepseek/deepseek-v4.1-flash',
  data: { reasoning_details: [{ type: 'reasoning.text', text: 'xyz', signature: null }, { type: 'reasoning.encrypted', data: '12345' }] },
};

describe('sendableReasoningBlocks', () => {
  const blocks: ContentBlock[] = [anthropicBlock, openRouterBlock, { type: 'text', text: 'hi' }];

  it('keeps only blocks this provider wrote for this model', () => {
    expect(sendableReasoningBlocks(blocks, 'anthropic', 'claude-haiku-5-5', createSilentLogger())).toEqual([anthropicBlock]);
    expect(sendableReasoningBlocks(blocks, 'openrouter', 'deepseek/deepseek-v4.1-flash', createSilentLogger())).toEqual([openRouterBlock]);
  });

  it('drops blocks from another model (tier fallback)', () => {
    expect(sendableReasoningBlocks(blocks, 'anthropic', 'claude-sonnet-4-6', createSilentLogger())).toEqual([]);
  });
});

describe('markReasoningBlocksForArchive', () => {
  it('replaces each block with a marker and leaves other content intact', () => {
    const prompt = { messages: [{ role: 'assistant', content: [anthropicBlock, { type: 'text', text: 'keep' }] }] };
    expect(markReasoningBlocksForArchive(prompt)).toEqual({
      messages: [{
        role: 'assistant',
        content: [
          { type: 'reasoning', provider: 'anthropic', model: 'claude-haiku-5-5', omitted: true },
          { type: 'text', text: 'keep' },
        ],
      }],
    });
  });

  it('does not mutate its input', () => {
    const prompt = { messages: [{ role: 'assistant', content: [openRouterBlock] }] };
    markReasoningBlocksForArchive(prompt);
    expect(prompt.messages[0]!.content[0]).toBe(openRouterBlock);
  });

  it('leaves a look-alike without data alone', () => {
    const notABlock = { type: 'reasoning', provider: 'anthropic', model: 'm' };
    expect(markReasoningBlocksForArchive(notABlock)).toEqual(notABlock);
  });
});

describe('reasoning block size', () => {
  it('counts readable and encrypted text, not signatures', () => {
    expect(reasoningBlockChars(anthropicBlock)).toBe(4);
    expect(reasoningBlockChars(openRouterBlock)).toBe(8);
  });

  it('feeds the context budget estimate', () => {
    expect(estimateTokens([anthropicBlock])).toBe(Math.ceil(4 / 3.5));
  });
});

describe('PrefixHasher', () => {
  it('gives the same digest for the same prefix and a different one after a change', () => {
    const a = new PrefixHasher('system', [{ name: 't' }]);
    a.addMessage({ role: 'user', content: 'hi' });
    const b = new PrefixHasher('system', [{ name: 't' }]);
    b.addMessage({ role: 'user', content: 'hi' });
    expect(a.digestNow()).toBe(b.digestNow());

    const changed = new PrefixHasher('system v2', [{ name: 't' }]);
    changed.addMessage({ role: 'user', content: 'hi' });
    expect(changed.digestNow()).not.toBe(a.digestNow());
  });

  it('digestNow does not end the stream', () => {
    const hasher = new PrefixHasher(null, null);
    const before = hasher.digestNow();
    hasher.addMessage('next');
    expect(hasher.digestNow()).not.toBe(before);
  });
});
