import { describe, expect, it } from 'vitest';
import { evaluateCheck, internalNamesFor } from '../../scenarios/assertions.js';
import type { CapturedToolCall, ScenarioRun } from '../../scenarios/types.js';

function call(name: string, input: Record<string, unknown> = {}): CapturedToolCall {
  return { name, input, disposition: 'stubbed', result: { success: true, data: {} } };
}

function run(toolCalls: CapturedToolCall[], reply: string | null = 'ok'): ScenarioRun {
  return { runIndex: 0, inboundContent: 'hi', toolCalls, reply, durationMs: 1, unstubbedCalls: 0 };
}

const ctx = { internalNames: [] as string[] };

describe('evaluateCheck: called', () => {
  const r = run([
    call('delegate', { agent: 'ceo-inbox', task: 'Reply to entry 1234-abcd: Yes, Thursday works' }),
  ]);

  it('passes on a matching call', () => {
    expect(evaluateCheck({ kind: 'called', tool: 'delegate', with: { agent: 'ceo-inbox' } }, r, ctx).rating).toBe('PASS');
  });

  it('matches a substring case-insensitively', () => {
    expect(evaluateCheck({ kind: 'called', tool: 'delegate', contains: { task: 'ENTRY 1234-ABCD' } }, r, ctx).rating).toBe('PASS');
    expect(evaluateCheck({ kind: 'called', tool: 'delegate', contains: { task: '9999' } }, r, ctx).rating).toBe('MISS');
  });

  it('misses on the wrong arguments or no call', () => {
    expect(evaluateCheck({ kind: 'called', tool: 'delegate', with: { agent: 'calendar' } }, r, ctx).rating).toBe('MISS');
    expect(evaluateCheck({ kind: 'called', tool: 'bullpen' }, r, ctx).rating).toBe('MISS');
  });

  it('enforces min and max counts', () => {
    const twice = run([call('delegate'), call('delegate')]);
    expect(evaluateCheck({ kind: 'called', tool: 'delegate', max: 1 }, twice, ctx).rating).toBe('MISS');
    expect(evaluateCheck({ kind: 'called', tool: 'delegate', min: 2, max: 2 }, twice, ctx).rating).toBe('PASS');
  });

  it('stringifies non-string arguments for contains', () => {
    const r2 = run([call('context-bridge-release', { meta: { entry_id: 'abc' } })]);
    expect(evaluateCheck({ kind: 'called', tool: 'context-bridge-release', contains: { meta: 'abc' } }, r2, ctx).rating).toBe('PASS');
  });
});

describe('evaluateCheck: not_called', () => {
  it('passes when none of the tools were called', () => {
    expect(evaluateCheck({ kind: 'not_called', tools: ['email-send', 'email-reply'] }, run([call('delegate')]), ctx).rating).toBe('PASS');
  });

  it('misses and names the offending call', () => {
    const result = evaluateCheck({ kind: 'not_called', tools: ['email-send', 'email-reply'] }, run([call('email-reply')]), ctx);
    expect(result.rating).toBe('MISS');
    expect(result.justification).toContain('email-reply');
  });

  it('counts a refused call as called — the model still tried', () => {
    const refused: CapturedToolCall = { name: 'signal-send', input: {}, disposition: 'refused' };
    expect(evaluateCheck({ kind: 'not_called', tools: ['signal-send'] }, run([refused]), ctx).rating).toBe('MISS');
  });

  it('only counts calls matching `with` when given', () => {
    const r = run([call('delegate', { agent: 'calendar' })]);
    expect(evaluateCheck({ kind: 'not_called', tools: ['delegate'], with: { agent: 'ceo-inbox' } }, r, ctx).rating).toBe('PASS');
  });
});

describe('evaluateCheck: order', () => {
  it('passes when the tools appear in that order (other calls in between are fine)', () => {
    const r = run([call('delegate'), call('memory-query'), call('context-bridge-release')]);
    expect(evaluateCheck({ kind: 'order', tools: ['delegate', 'context-bridge-release'] }, r, ctx).rating).toBe('PASS');
    expect(evaluateCheck({ kind: 'order', tools: ['context-bridge-release', 'delegate'] }, r, ctx).rating).toBe('MISS');
  });
});

describe('evaluateCheck: reply', () => {
  it('recognises an exact NO_REPLY (surrounding whitespace allowed)', () => {
    expect(evaluateCheck({ kind: 'reply', is: 'no_reply' }, run([], '  NO_REPLY\n'), ctx).rating).toBe('PASS');
    expect(evaluateCheck({ kind: 'reply', is: 'no_reply' }, run([], 'NO_REPLY — automated notice'), ctx).rating).toBe('MISS');
    expect(evaluateCheck({ kind: 'reply', is: 'not_no_reply' }, run([], 'Done.'), ctx).rating).toBe('PASS');
    expect(evaluateCheck({ kind: 'reply', is: 'not_no_reply' }, run([], 'NO_REPLY'), ctx).rating).toBe('MISS');
  });

  it('misses when there was no reply at all', () => {
    expect(evaluateCheck({ kind: 'reply', is: 'no_reply' }, run([], null), ctx).rating).toBe('MISS');
  });

  it('reply_excludes matches patterns case-insensitively', () => {
    const r = run([], 'I have asked the Calendar Specialist.');
    expect(evaluateCheck({ kind: 'reply_excludes', patterns: ['calendar specialist'] }, r, ctx).rating).toBe('MISS');
    expect(evaluateCheck({ kind: 'reply_excludes', patterns: ['\\bdelegat'] }, r, ctx).rating).toBe('PASS');
  });
});

describe('internal names', () => {
  it('collects hyphenated tool and agent identifiers and @-mentions', () => {
    const names = internalNamesFor({ tools: ['delegate', 'email-send', 'memory_query'], agents: ['calendar', 'ceo-inbox'] });
    expect(names).toEqual(expect.arrayContaining(['email-send', 'memory_query', 'ceo-inbox', '@calendar', '@ceo-inbox']));
    // Plain words would flag ordinary English ("I'll delegate", "your calendar").
    expect(names).not.toContain('delegate');
    expect(names).not.toContain('calendar');
  });

  it('flags a reply that names one', () => {
    const c = { internalNames: internalNamesFor({ tools: ['email-send'], agents: ['research-analyst'] }) };
    expect(evaluateCheck({ kind: 'reply_excludes_internal_names' }, run([], 'I asked research-analyst.'), c).rating).toBe('MISS');
    expect(evaluateCheck({ kind: 'reply_excludes_internal_names' }, run([], 'I asked my research team.'), c).rating).toBe('PASS');
  });
});
