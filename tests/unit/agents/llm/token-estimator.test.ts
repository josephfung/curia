import { describe, it, expect } from 'vitest';
import { estimateTokens } from '../../../../src/agents/llm/token-estimator.js';
import { estimateMessagesTokens, getContextWindow, DEFAULT_SAFETY_MARGIN } from '../../../../src/agents/llm/token-estimator.js';
import type { ContentBlock } from '../../../../src/agents/llm/provider.js';
import type { Message } from '../../../../src/agents/llm/provider.js';

describe('estimateTokens', () => {
  it('estimates tokens for a plain string', () => {
    // 35 characters / 3.5 = 10 tokens
    const result = estimateTokens('The quick brown fox jumps over dogs');
    expect(result).toBe(10);
  });

  it('rounds up to the next whole token', () => {
    // 4 characters / 3.5 = 1.14... → 2
    const result = estimateTokens('test');
    expect(result).toBe(2);
  });

  it('returns 0 for an empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('estimates tokens for TextContent blocks', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'Hello world' },  // 11 chars
      { type: 'text', text: 'Goodbye' },       // 7 chars
    ];
    // Total 18 chars / 3.5 = 5.14 → 6
    expect(estimateTokens(blocks)).toBe(6);
  });

  it('estimates tokens for ToolUseContent blocks', () => {
    const blocks: ContentBlock[] = [
      { type: 'tool_use', id: 'toolu_1', name: 'web-fetch', input: { url: 'https://example.com' } },
    ];
    const result = estimateTokens(blocks);
    expect(result).toBeGreaterThan(0);
  });

  it('estimates tokens for ToolResultContent blocks', () => {
    const blocks: ContentBlock[] = [
      { type: 'tool_result', tool_use_id: 'toolu_1', content: 'Result data here' },
    ];
    const result = estimateTokens(blocks);
    expect(result).toBeGreaterThan(0);
  });

  it('handles mixed content block types', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'Start' },
      { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { q: 'test' } },
      { type: 'tool_result', tool_use_id: 'toolu_1', content: 'found it' },
    ];
    const result = estimateTokens(blocks);
    expect(result).toBeGreaterThan(0);
  });
});

describe('estimateMessagesTokens', () => {
  it('sums token estimates across messages with per-message overhead', () => {
    const messages: Message[] = [
      { role: 'system', content: 'You are helpful.' },    // 16 chars → ceil(16/3.5)=5, + 4 overhead = 9
      { role: 'user', content: 'Hello' },                  // 5 chars → ceil(5/3.5)=2, + 4 overhead = 6
    ];
    const result = estimateMessagesTokens(messages);
    expect(result).toBe(15);
  });

  it('returns 0 for an empty array', () => {
    expect(estimateMessagesTokens([])).toBe(0);
  });

  it('handles messages with ContentBlock[] content', () => {
    const messages: Message[] = [
      { role: 'assistant', content: [{ type: 'text', text: 'Hello world' }] },
    ];
    const result = estimateMessagesTokens(messages);
    // ceil(11/3.5)=4 + 4 overhead = 8
    expect(result).toBe(8);
  });
});

describe('getContextWindow', () => {
  it('returns 200_000 for claude-sonnet-4-6', () => {
    expect(getContextWindow('claude-sonnet-4-6')).toBe(200_000);
  });

  it('returns 200_000 for claude-opus-4-6', () => {
    expect(getContextWindow('claude-opus-4-6')).toBe(200_000);
  });

  it('returns 200_000 for claude-haiku-4-5', () => {
    expect(getContextWindow('claude-haiku-4-5')).toBe(200_000);
  });

  it('matches versioned model names via prefix', () => {
    expect(getContextWindow('claude-haiku-4-5-20251001')).toBe(200_000);
  });

  it('falls back to sonnet window for unknown models', () => {
    expect(getContextWindow('unknown-model-v1')).toBe(200_000);
  });
});

describe('DEFAULT_SAFETY_MARGIN', () => {
  it('is 0.05 (5%)', () => {
    expect(DEFAULT_SAFETY_MARGIN).toBe(0.05);
  });
});
