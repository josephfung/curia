import { describe, it, expect } from 'vitest';
import {
  LLM_FAILURE_TURN_CONTENT,
  LLM_FAILURE_USER_MESSAGE,
  isLlmFailureTurn,
  parseLlmFailureTurn,
  rewriteLlmFailureTurns,
  historyForLlm,
} from '../../../src/memory/llm-failure-turn.js';
import type { ConversationTurn } from '../../../src/memory/working-memory.js';

describe('llm-failure-turn helpers', () => {
  it('identifies only the exact assistant marker', () => {
    expect(parseLlmFailureTurn(LLM_FAILURE_TURN_CONTENT)).toEqual({ message: LLM_FAILURE_USER_MESSAGE });
    expect(isLlmFailureTurn({ role: 'assistant', content: LLM_FAILURE_TURN_CONTENT })).toBe(true);
    expect(isLlmFailureTurn({ role: 'user', content: LLM_FAILURE_TURN_CONTENT })).toBe(false);
    expect(isLlmFailureTurn({ role: 'assistant', content: 'sorry, try again' })).toBe(false);
    expect(isLlmFailureTurn({ role: 'assistant', content: '{"_curia_protocol":"clarification_request"}' })).toBe(false);
  });

  it('rewrites marker assistant content to the user-facing error text and keeps the question', () => {
    const turns: ConversationTurn[] = [
      { role: 'user', content: 'kept question' },
      { role: 'assistant', content: 'kept answer' },
      { role: 'user', content: 'failed question' },
      { role: 'assistant', content: LLM_FAILURE_TURN_CONTENT },
    ];
    expect(rewriteLlmFailureTurns(turns)).toEqual([
      { role: 'user', content: 'kept question' },
      { role: 'assistant', content: 'kept answer' },
      { role: 'user', content: 'failed question' },
      { role: 'assistant', content: LLM_FAILURE_USER_MESSAGE },
    ]);
  });

  it('historyForLlm keeps the failed question paired with the error text and drops trailing orphans', () => {
    const turns: ConversationTurn[] = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'failed prompt' },
      { role: 'assistant', content: LLM_FAILURE_TURN_CONTENT },
      { role: 'user', content: 'orphan from a crash before the marker' },
    ];
    expect(historyForLlm(turns)).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'failed prompt' },
      { role: 'assistant', content: LLM_FAILURE_USER_MESSAGE },
    ]);
  });

  it('historyForLlm collapses a mid-history orphaned user turn (#1767)', () => {
    const turns: ConversationTurn[] = [
      { role: 'user', content: 'orphan' },
      { role: 'user', content: 'later question' },
      { role: 'assistant', content: 'later answer' },
      { role: 'user', content: 'current — dropped as trailing' },
    ];
    expect(historyForLlm(turns)).toEqual([
      { role: 'user', content: 'later question' },
      { role: 'assistant', content: 'later answer' },
    ]);
  });
});
