import { describe, it, expect } from 'vitest';
import {
  LLM_FAILURE_TURN_CONTENT,
  LLM_FAILURE_USER_MESSAGE,
  isLlmFailureTurn,
  parseLlmFailureTurn,
  rewriteLlmFailureTurns,
  historyForLlm,
  llmFailurePairing,
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

  it('keeps an injected follow-up grouped with the user row it joined (#2018)', () => {
    const turns: ConversationTurn[] = [
      { role: 'user', content: 'u1' },
      { role: 'user', content: 'u2', injected: true },
      { role: 'assistant', content: 'a' },
    ];
    expect(historyForLlm(turns)).toEqual(turns);
  });

  it('keeps several injected follow-ups in order (#2018)', () => {
    const turns: ConversationTurn[] = [
      { role: 'user', content: 'u1' },
      { role: 'user', content: 'u2', injected: true },
      { role: 'user', content: 'u3', injected: true },
      { role: 'assistant', content: 'a' },
    ];
    expect(historyForLlm(turns)).toEqual(turns);
  });

  it('replaces a whole injected group when a later plain user row arrives (#2018)', () => {
    const turns: ConversationTurn[] = [
      { role: 'user', content: 'u1' },
      { role: 'user', content: 'u2', injected: true },
      { role: 'user', content: 'u3' },
      { role: 'assistant', content: 'a3' },
    ];
    expect(historyForLlm(turns)).toEqual([
      { role: 'user', content: 'u3' },
      { role: 'assistant', content: 'a3' },
    ]);
  });

  it('strips a trailing injected group completely (#2018)', () => {
    const turns: ConversationTurn[] = [
      { role: 'user', content: 'earlier' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'u1' },
      { role: 'user', content: 'u2', injected: true },
    ];
    expect(historyForLlm(turns)).toEqual([
      { role: 'user', content: 'earlier' },
      { role: 'assistant', content: 'reply' },
    ]);
  });

  it('rewrites an llm_failure marker inside an injected group (#2018)', () => {
    const turns: ConversationTurn[] = [
      { role: 'user', content: 'u1' },
      { role: 'user', content: 'u2', injected: true },
      { role: 'assistant', content: LLM_FAILURE_TURN_CONTENT },
    ];
    expect(historyForLlm(turns)).toEqual([
      { role: 'user', content: 'u1' },
      { role: 'user', content: 'u2', injected: true },
      { role: 'assistant', content: LLM_FAILURE_USER_MESSAGE },
    ]);
  });
});

describe('llmFailurePairing', () => {
  it('pairs the anchor user row when the tail is an injected follow-up (#2018)', () => {
    expect(llmFailurePairing([
      { role: 'user', content: 'ours' },
      { role: 'user', content: 'use email', injected: true },
    ], 'ours')).toEqual({ ok: true });
  });

  it('does not pair on the injected row even when its text matches (#2018)', () => {
    expect(llmFailurePairing([
      { role: 'user', content: 'ours', injected: true },
    ], 'ours')).toEqual({ ok: false, reason: 'not_user' });
  });

  it('does not walk through a plain user row to find the anchor (#2018)', () => {
    expect(llmFailurePairing([
      { role: 'user', content: 'ours' },
      { role: 'user', content: 'someone else' },
      { role: 'user', content: 'follow-up', injected: true },
    ], 'ours')).toEqual({ ok: false, reason: 'content_mismatch' });
  });

  it('keeps the plain last-user check (#1767)', () => {
    expect(llmFailurePairing([
      { role: 'user', content: 'ours' },
    ], 'ours')).toEqual({ ok: true });
    expect(llmFailurePairing([
      { role: 'user', content: 'ours' },
    ], 'other')).toEqual({ ok: false, reason: 'content_mismatch' });
    expect(llmFailurePairing([
      { role: 'assistant', content: 'reply' },
    ], 'ours')).toEqual({ ok: false, reason: 'not_user' });
  });
});
