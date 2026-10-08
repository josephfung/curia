import { describe, it, expect } from 'vitest';
import { buildLlmArchiveResponse } from '../../../src/audit/llm-archive-response.js';

const toolCall = { id: 'call_1', name: 'email-send', input: { to: 'a@b.test' } };

describe('buildLlmArchiveResponse', () => {
  it('keeps text written alongside tool calls, plus reasoning and its token count', () => {
    expect(buildLlmArchiveResponse({
      type: 'tool_use',
      toolCalls: [toolCall],
      content: 'Checking the thread.',
      reasoning: 'The sender asked for a reply.',
      usage: { reasoningTokens: 12 },
    })).toEqual({
      type: 'tool_use',
      toolCalls: [toolCall],
      content: 'Checking the thread.',
      reasoning: 'The sender asked for a reply.',
      reasoningTokens: 12,
    });
  });

  it('omits empty tool-call text and absent reasoning', () => {
    expect(buildLlmArchiveResponse({
      type: 'tool_use',
      toolCalls: [toolCall],
    })).toEqual({
      type: 'tool_use',
      toolCalls: [toolCall],
    });
  });

  it('stores a text response, including a message_end event', () => {
    expect(buildLlmArchiveResponse({
      type: 'message_end',
      content: 'hello',
      reasoningOmitted: 'encrypted',
      usage: { reasoningTokens: 4 },
    })).toEqual({
      type: 'text',
      content: 'hello',
      reasoningOmitted: 'encrypted',
      reasoningTokens: 4,
    });
  });

  it('records a zero reasoning-token count when the provider reported one', () => {
    expect(buildLlmArchiveResponse({
      type: 'text',
      content: 'ok',
      usage: { reasoningTokens: 0 },
    })).toEqual({ type: 'text', content: 'ok', reasoningTokens: 0 });
  });
});
