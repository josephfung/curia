// resume-token.test.ts — shared encode/decode for delegate resume tokens.
import { describe, it, expect } from 'vitest';
import {
  encodeResumeToken,
  decodeResumeToken,
  RESUME_TOKEN_VERSION,
  MAX_RESUME_TASK_LENGTH,
  MAX_RESUME_CONTEXT_LENGTH,
} from './resume-token.js';

describe('resume-token', () => {
  it('round-trips agent / original_task / context with the version stamp', () => {
    const token = encodeResumeToken({ agent: 'research-analyst', originalTask: 'do X', context: 'progress so far' });
    const decoded = decodeResumeToken(token);
    expect(decoded).toEqual({ v: RESUME_TOKEN_VERSION, agent: 'research-analyst', original_task: 'do X', context: 'progress so far' });
  });

  it('truncates over-budget fields with an ellipsis', () => {
    const token = encodeResumeToken({
      agent: 'a',
      originalTask: 'x'.repeat(MAX_RESUME_TASK_LENGTH + 50),
      context: 'y'.repeat(MAX_RESUME_CONTEXT_LENGTH + 50),
    });
    const decoded = decodeResumeToken(token)!;
    expect(decoded.original_task.endsWith('…')).toBe(true);
    expect(decoded.original_task.length).toBe(MAX_RESUME_TASK_LENGTH + 1);
    expect(decoded.context.endsWith('…')).toBe(true);
    expect(decoded.context.length).toBe(MAX_RESUME_CONTEXT_LENGTH + 1);
  });

  it('returns null for non-base64 / non-JSON input', () => {
    expect(decodeResumeToken('!!!not base64 json!!!')).toBeNull();
  });

  it('returns null when required string fields are missing or wrong-typed', () => {
    const bad = Buffer.from(JSON.stringify({ v: 1, agent: 'a', original_task: 'x' })).toString('base64'); // no context
    expect(decodeResumeToken(bad)).toBeNull();
    const wrongType = Buffer.from(JSON.stringify({ v: 1, agent: 5, original_task: 'x', context: 'y' })).toString('base64');
    expect(decodeResumeToken(wrongType)).toBeNull();
  });
});
