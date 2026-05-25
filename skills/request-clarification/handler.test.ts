import { describe, it, expect } from 'vitest';
import pino from 'pino';
import { RequestClarificationHandler, CLARIFICATION_PROTOCOL } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';

function makeCtx(input: Record<string, unknown>): SkillContext {
  return {
    input,
    secret: () => 'test-key',
    log: pino({ level: 'silent' }),
  } as unknown as SkillContext;
}

describe('request-clarification handler', () => {
  const handler = new RequestClarificationHandler();

  it('returns structured clarification result for valid inputs', async () => {
    const result = await handler.execute(makeCtx({
      question: 'Which strategic angle matters most: valuation, talent, or technology?',
      partial_findings: 'Found three acquisition targets across different segments.',
    }));

    expect(result.success).toBe(true);
    const data = (result as { success: true; data: unknown }).data as Record<string, unknown>;
    expect(data._curia_protocol).toBe(CLARIFICATION_PROTOCOL);
    expect(data.question).toBe('Which strategic angle matters most: valuation, talent, or technology?');
    expect(data.partial_findings).toBe('Found three acquisition targets across different segments.');
  });

  it('trims whitespace from inputs', async () => {
    const result = await handler.execute(makeCtx({
      question: '  Which angle?  ',
      partial_findings: '  Found targets.  ',
    }));

    expect(result.success).toBe(true);
    const data = (result as { success: true; data: unknown }).data as Record<string, unknown>;
    expect(data.question).toBe('Which angle?');
    expect(data.partial_findings).toBe('Found targets.');
  });

  it('rejects missing question', async () => {
    const result = await handler.execute(makeCtx({
      partial_findings: 'Some findings.',
    }));

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toContain('question');
  });

  it('rejects empty question', async () => {
    const result = await handler.execute(makeCtx({
      question: '   ',
      partial_findings: 'Some findings.',
    }));

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toContain('empty');
  });

  it('rejects missing partial_findings', async () => {
    const result = await handler.execute(makeCtx({
      question: 'Which angle?',
    }));

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toContain('partial_findings');
  });

  it('rejects empty partial_findings', async () => {
    const result = await handler.execute(makeCtx({
      question: 'Which angle?',
      partial_findings: '',
    }));

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toContain('partial_findings');
  });

  it('rejects whitespace-only partial_findings', async () => {
    const result = await handler.execute(makeCtx({
      question: 'Which angle?',
      partial_findings: '   ',
    }));

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toContain('empty');
  });

  it('rejects non-string question', async () => {
    const result = await handler.execute(makeCtx({
      question: 42,
      partial_findings: 'Some findings.',
    }));

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toContain('question');
  });

  it('rejects non-string partial_findings', async () => {
    const result = await handler.execute(makeCtx({
      question: 'Which angle?',
      partial_findings: ['array', 'not', 'string'],
    }));

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toContain('partial_findings');
  });
});
