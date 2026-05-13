import { describe, it, expect } from 'vitest';
import { estimateTokens } from '../../../../src/agents/llm/token-estimator.js';
import type { ContentBlock } from '../../../../src/agents/llm/provider.js';

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
