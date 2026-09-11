import { describe, it, expect } from 'vitest';
import {
  LLM_FAILURE_TURN_CONTENT,
  isLlmFailureTurn,
  isLlmFailureTurnContent,
  omitLlmFailurePairs,
  historyForLlm,
} from '../../../src/memory/llm-failure-turn.js';
import type { ConversationTurn } from '../../../src/memory/working-memory.js';

describe('llm-failure-turn helpers', () => {
  it('identifies only the exact assistant marker', () => {
    expect(isLlmFailureTurnContent(LLM_FAILURE_TURN_CONTENT)).toBe(true);
    expect(isLlmFailureTurn({ role: 'assistant', content: LLM_FAILURE_TURN_CONTENT })).toBe(true);
    expect(isLlmFailureTurn({ role: 'user', content: LLM_FAILURE_TURN_CONTENT })).toBe(false);
    expect(isLlmFailureTurn({ role: 'assistant', content: 'sorry, try again' })).toBe(false);
    expect(isLlmFailureTurnContent(`${LLM_FAILURE_TURN_CONTENT} `)).toBe(false);
  });

  it('omits user + marker pairs and stray markers', () => {
    const turns: ConversationTurn[] = [
      { role: 'user', content: 'kept question' },
      { role: 'assistant', content: 'kept answer' },
      { role: 'user', content: 'failed question' },
      { role: 'assistant', content: LLM_FAILURE_TURN_CONTENT },
      { role: 'assistant', content: LLM_FAILURE_TURN_CONTENT },
    ];
    expect(omitLlmFailurePairs(turns)).toEqual([
      { role: 'user', content: 'kept question' },
      { role: 'assistant', content: 'kept answer' },
    ]);
  });

  it('historyForLlm drops failed pairs and trailing orphaned user turns', () => {
    const turns: ConversationTurn[] = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'stale failed prompt' },
      { role: 'assistant', content: LLM_FAILURE_TURN_CONTENT },
      { role: 'user', content: 'orphan from a crash before the marker' },
    ];
    expect(historyForLlm(turns)).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
    ]);
  });
});
