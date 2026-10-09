import { describe, expect, it } from 'vitest';
import { emptyBreakdown } from '../../shared/usage.js';
import { evaluateCheck, internalNamesFor } from '../../scenarios/assertions.js';
import type { CapturedToolCall, ScenarioRun } from '../../scenarios/types.js';

function call(name: string, input: Record<string, unknown> = {}): CapturedToolCall {
  return { name, input, disposition: 'stubbed', result: { success: true, data: {} } };
}

function run(toolCalls: CapturedToolCall[], reply: string | null = 'ok'): ScenarioRun {
  return { runIndex: 0, inboundContent: 'hi', refs: {}, toolCalls, reply, durationMs: 1, unstubbedCalls: 0, usage: emptyBreakdown(), providerRetries: [] };
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

  it('can require the call to have succeeded', () => {
    const failed: CapturedToolCall = {
      name: 'email-send',
      input: { to: 'kevin', attachments: [{ file_url: 'file:///tmp/5b1e7c3a.pdf' }] },
      disposition: 'stubbed',
      result: { success: false, error: 'Attachment error: outside the store' },
    };
    const ok = call('email-send', { to: 'kevin', attachments: [{ file_url: 'file:///run/curia-tempfiles/5b1e7c3a.pdf' }] });
    const check = { kind: 'called' as const, tool: 'email-send', contains: { attachments: '5b1e7c3a' }, success: true };
    const missed = evaluateCheck(check, run([failed]), ctx);
    expect(missed.rating).toBe('MISS');
    expect(missed.justification).toContain('"success":true');
    expect(missed.justification).toContain('email-send [failed]');
    expect(evaluateCheck(check, run([failed, ok]), ctx).rating).toBe('PASS');
    // A refused attempt is still an attempt. not_called does not grow a success filter.
    expect(evaluateCheck({ kind: 'not_called', tools: ['email-send'], contains: { attachments: '5b1e7c3a' } }, run([failed]), ctx).rating).toBe('MISS');
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

describe('evaluateCheck: any_of (#1972)', () => {
  // The delegate links an entry either from outbound_entry_id or from its id quoted in
  // the brief; a routing check should pass on either.
  const linked = {
    kind: 'any_of' as const,
    checks: [
      { kind: 'called' as const, tool: 'delegate', with: { agent: 'ceo-inbox', outbound_entry_id: 'e-1' } },
      { kind: 'called' as const, tool: 'delegate', with: { agent: 'ceo-inbox' }, contains: { task: 'e-1' } },
    ],
  };

  it('passes when any alternative passes, naming it', () => {
    const byParam = evaluateCheck(linked, run([call('delegate', { agent: 'ceo-inbox', task: 'go', outbound_entry_id: 'e-1' })]), ctx);
    expect(byParam.rating).toBe('PASS');
    const byText = evaluateCheck(linked, run([call('delegate', { agent: 'ceo-inbox', task: 'answer to e-1' })]), ctx);
    expect(byText.rating).toBe('PASS');
  });

  it('misses only when every alternative misses, with each reason', () => {
    const result = evaluateCheck(linked, run([call('delegate', { agent: 'calendar', task: 'e-1' })]), ctx);
    expect(result.rating).toBe('MISS');
    expect(result.justification.match(/expected delegate/g)).toHaveLength(2);
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

describe('reply-content checks need a reply', () => {
  it.each([[null], ['NO_REPLY'], ['  ']])('miss on a silent reply (%j)', (reply) => {
    const r = run([], reply);
    expect(evaluateCheck({ kind: 'reply_excludes', patterns: ['x'] }, r, ctx).rating).toBe('MISS');
    expect(evaluateCheck({ kind: 'reply_excludes_internal_names' }, r, ctx).rating).toBe('MISS');
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

describe('real delegation checks (#2027)', () => {
  const by = (agentId: string | undefined, name: string, input: Record<string, unknown> = {}, data: unknown = {}): CapturedToolCall => ({
    ...(agentId ? { agentId } : {}), name, input, disposition: 'stubbed', result: { success: true, data },
  });
  const r = {
    ...run([
      by('coordinator', 'delegate', { agent: 'calendar' }, { agent: 'calendar', outbound_entry: { id: 'e-1', status: 'released' } }),
      by('calendar', 'calendar-list-events'),
      by('calendar', 'signal-send', { recipient: 'principal' }),
      // A transcript saved before #2027 has no agentId: the coordinator's.
      by(undefined, 'email-send', { to: 'principal' }),
    ]),
    delegations: [{ agentId: 'calendar', conversationId: 'scenario-delegate-1', brief: 'Message ID: m-1\nAccount: ops\n\nFind a slot.', response: 'Tuesday 2pm', outcome: 'answered' as const }],
  };

  it('reads the coordinator\'s calls unless the check names an agent', () => {
    expect(evaluateCheck({ kind: 'called', tool: 'calendar-list-events' }, r, ctx).rating).toBe('MISS');
    expect(evaluateCheck({ kind: 'called', tool: 'calendar-list-events', agent: 'calendar' }, r, ctx).rating).toBe('PASS');
    expect(evaluateCheck({ kind: 'called', tool: 'email-send' }, r, ctx).rating).toBe('PASS');
    expect(evaluateCheck({ kind: 'not_called', tools: ['signal-send'] }, r, ctx).rating).toBe('PASS');
    expect(evaluateCheck({ kind: 'not_called', tools: ['signal-send'], agent: 'any' }, r, ctx).rating).toBe('MISS');
    expect(evaluateCheck({ kind: 'order', tools: ['delegate', 'email-send'] }, r, ctx).rating).toBe('PASS');
    expect(evaluateCheck({ kind: 'order', tools: ['delegate', 'calendar-list-events'], agent: 'any' }, r, ctx).rating).toBe('PASS');
  });

  it('counts the tools of a multi-tool called check together', () => {
    const sends = ['signal-send', 'email-send', 'sms-send'];
    expect(evaluateCheck({ kind: 'called', tool: sends, agent: 'any', min: 2, max: 2 }, r, ctx).rating).toBe('PASS');
    expect(evaluateCheck({ kind: 'called', tool: sends, agent: 'any', max: 1 }, r, ctx).rating).toBe('MISS');
  });

  it('matches a call\'s result data as a nested subset with returns', () => {
    expect(evaluateCheck({ kind: 'called', tool: 'delegate', returns: { outbound_entry: { status: 'released' } } }, r, ctx).rating).toBe('PASS');
    expect(evaluateCheck({ kind: 'called', tool: 'delegate', returns: { outbound_entry: { status: 'kept' } } }, r, ctx).rating).toBe('MISS');
    expect(evaluateCheck({ kind: 'not_called', tools: ['delegate'], returns: { declined: true } }, r, ctx).rating).toBe('PASS');
    expect(evaluateCheck({ kind: 'not_called', tools: ['delegate'], returns: { agent: 'calendar' } }, r, ctx).rating).toBe('MISS');
  });

  it('reads the brief a real specialist received with briefed', () => {
    expect(evaluateCheck({ kind: 'briefed', agent: 'calendar', contains: ['message id: m-1', 'Account: ops'] }, r, ctx).rating).toBe('PASS');
    const missing = evaluateCheck({ kind: 'briefed', agent: 'calendar', contains: ['Message ID: m-1', 'Account: curia'] }, r, ctx);
    expect(missing).toMatchObject({ rating: 'MISS', justification: expect.stringContaining('none has Account: curia') });
    expect(evaluateCheck({ kind: 'briefed', agent: 'ceo-inbox', contains: ['x'] }, r, ctx).justification).toMatch(/no real ceo-inbox run/);
    // A stubbed-delegation run has no specialist runs at all.
    expect(evaluateCheck({ kind: 'briefed', agent: 'calendar', contains: ['x'] }, run([]), ctx).rating).toBe('MISS');
  });
});
