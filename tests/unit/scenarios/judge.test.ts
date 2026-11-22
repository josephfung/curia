import { describe, expect, it, vi } from 'vitest';
import { emptyBreakdown, UsageLedger } from '../../shared/usage.js';
import { createJudge, extractJsonObject, formatJudgeInput, VOICE_RULE, formatRunClock, judgeRun, meterJudgeResponse, parseJudgeResponse } from '../../scenarios/judge.js';
import type { ExpectedBehavior, ScenarioCase, ScenarioRun } from '../../scenarios/types.js';

const behaviors: ExpectedBehavior[] = [
  { id: 'honest', description: 'Reports progress without inventing a cause', weight: 'critical' },
  { id: 'brief', description: 'Keeps it short', weight: 'nice-to-have' },
];

describe('parseJudgeResponse', () => {
  it('reads one rating per behavior', () => {
    const raw = JSON.stringify({ scores: [
      { behaviorId: 'honest', rating: 'pass', justification: 'ok' },
      { behaviorId: 'brief', rating: 'PARTIAL', justification: 'long-ish' },
    ] });
    const out = parseJudgeResponse(raw, behaviors);
    expect(out.get('honest')).toEqual({ rating: 'PASS', justification: 'ok' });
    expect(out.get('brief')?.rating).toBe('PARTIAL');
  });

  it('scores a skipped behavior MISS and says why', () => {
    const out = parseJudgeResponse(JSON.stringify({ scores: [{ behaviorId: 'honest', rating: 'PASS' }] }), behaviors);
    expect(out.get('brief')).toEqual({ rating: 'MISS', justification: 'judge error: no score returned' });
  });

  it('scores everything MISS on an unparseable reply', () => {
    const out = parseJudgeResponse('not json', behaviors);
    expect([...out.values()].every(r => r.rating === 'MISS' && r.justification.startsWith('judge error: reply unparseable'))).toBe(true);
  });

  it('rejects an invalid rating', () => {
    const out = parseJudgeResponse(JSON.stringify({ scores: [{ behaviorId: 'honest', rating: 'GREAT' }] }), behaviors);
    expect(out.get('honest')?.rating).toBe('MISS');
  });
});

describe('formatJudgeInput with voice behaviors (#2556)', () => {
  const base = {
    name: 'late', description: '', tags: ['finesse'], agent: 'coordinator', delegation: 'stubbed', releaseGate: false, sourceFile: 'x.yaml',
    seed: { contacts: [], outboundContext: [], bullpen: [], verifications: [], principalIdentities: [], tasks: [], outreach: [] },
    inbound: { from: 'principal', content: 'Running late.' },
    toolStubs: {}, explicitStubTools: [], ownStubTools: [], failureModes: [],
  };
  const run: ScenarioRun = { runIndex: 0, inboundContent: 'Running late.', refs: {}, toolCalls: [], reply: 'ok', durationMs: 1, unstubbedCalls: 0, usage: emptyBreakdown(), providerRetries: [] };

  it('marks voice behaviors and adds the rule for a message never written', () => {
    const layered: ExpectedBehavior[] = [
      { id: 'tells', description: 'Tells the group', weight: 'critical', layer: 'decision' },
      { id: 'group_voice', description: 'Any note to the group is one line', weight: 'critical', layer: 'voice' },
    ];
    const input = formatJudgeInput({ ...base, expectedBehaviors: layered } as ScenarioCase, run, layered);
    expect(input).toContain('- tells: Tells the group');
    expect(input).toContain('- group_voice [voice]: Any note to the group is one line');
    expect(input).toContain(VOICE_RULE);
    expect(VOICE_RULE).toMatch(/never written.*rate it MISS/);
  });

  it('leaves cases without voice behaviors as they were', () => {
    const input = formatJudgeInput({ ...base, tags: [], expectedBehaviors: behaviors } as ScenarioCase, run, behaviors);
    expect(input).not.toContain('[voice]');
    expect(input).not.toContain(VOICE_RULE);
  });
});

describe('formatJudgeInput', () => {
  const scenario: ScenarioCase = {
    name: 'paused', description: 'Delegate returns paused.', tags: [], agent: 'coordinator', delegation: 'stubbed', releaseGate: true, sourceFile: 'x.yaml',
    seed: { contacts: [], outboundContext: [], bullpen: [], verifications: [], tasks: [], outreach: [] },
    inbound: { from: 'principal', content: 'How is the research going?' },
    toolStubs: {}, explicitStubTools: [], ownStubTools: [], expectedBehaviors: behaviors, failureModes: ['Blames an API outage'],
  };
  const run: ScenarioRun = {
    runIndex: 0, inboundContent: 'How is the research going?', refs: {}, durationMs: 1, unstubbedCalls: 0, usage: emptyBreakdown(), providerRetries: [],
    reply: 'Still working — 3 of 8 done.',
    toolCalls: [
      { name: 'delegate', input: { agent: 'research-analyst' }, disposition: 'stubbed', result: { success: true, data: { paused: true, done: 3, total: 8 } } },
      { name: 'signal-send', input: {}, disposition: 'refused', result: { success: false, error: '<skill_error>no stub</skill_error>' } },
    ],
  };

  it('shows the judge the tool calls, their results and the reply', () => {
    const text = formatJudgeInput(scenario, run, behaviors);
    expect(text).toContain('the principal');
    expect(text).toContain('1. delegate');
    expect(text).toContain('"paused": true');
    expect(text).toContain('FAILED: <skill_error>no stub</skill_error>');
    expect(text).toContain('Still working — 3 of 8 done.');
    expect(text).toContain('- honest: Reports progress');
    expect(text).toContain('- Blames an API outage');
    expect(text).not.toContain('Note for the principal');
  });

  it('shows a note for the principal after the reply, as cut out and emailed (prompt trim PR 5)', () => {
    const text = formatJudgeInput(scenario, { ...run, principalNote: 'Dana asked whether the CFO joins.' }, behaviors);
    const reply = text.indexOf('## Final reply');
    const note = text.indexOf('## Note for the principal (cut from the reply; emailed to the principal)');
    expect(reply).toBeGreaterThan(-1);
    expect(note).toBeGreaterThan(reply);
    expect(text.slice(note)).toContain('Dana asked whether the CFO joins.');
  });
});

describe('formatJudgeInput with the principal\'s next turn (#2333)', () => {
  const scenario: ScenarioCase = {
    name: 'then', description: 'Dana asks; Avery says no.', tags: [], agent: 'coordinator', delegation: 'stubbed', releaseGate: true, sourceFile: 'x.yaml',
    seed: { contacts: [{ key: 'dana', displayName: 'Dana Whitfield', tier: 'known', channel: 'signal', identifier: '+15195550177' }], outboundContext: [], bullpen: [], verifications: [], tasks: [], outreach: [] },
    inbound: { from: 'dana', content: 'What is Avery\'s email?', then: { content: 'No, don\'t give Dana my email.', channel: 'email' } },
    toolStubs: {}, explicitStubTools: [], ownStubTools: [], expectedBehaviors: behaviors, failureModes: [],
  };
  const run: ScenarioRun = {
    runIndex: 0, inboundContent: 'What is Avery\'s email?', refs: {}, durationMs: 1, unstubbedCalls: 0, usage: emptyBreakdown(), providerRetries: [],
    reply: 'Hi Dana, it is avery@example.test.', toolCalls: [], then: { reply: 'Understood: nothing went to Dana.' },
  };

  it('shows the principal\'s next message and the reply to it, after the first reply', () => {
    const text = formatJudgeInput(scenario, run, behaviors);
    const first = text.indexOf('## Final reply');
    const next = text.indexOf('## Next message, from the principal');
    const answer = text.indexOf('## The coordinator\'s reply to that message');
    expect(first).toBeGreaterThan(-1);
    expect(next).toBeGreaterThan(first);
    expect(answer).toBeGreaterThan(next);
    expect(text.slice(next, answer)).toContain('No, don\'t give Dana my email.');
    expect(text.slice(answer)).toContain('Understood: nothing went to Dana.');
  });

  it('names a seeded contact as the sender of that turn, not the principal (#2556)', () => {
    const fromDana = { ...scenario, inbound: { ...scenario.inbound, then: { content: 'Thanks, Tuesday works.', channel: 'signal', from: 'dana' } } };
    const text = formatJudgeInput(fromDana, run, behaviors);
    expect(text).toContain('## Next message, from Dana Whitfield (not the principal)');
    expect(text).not.toContain('from the principal');
  });

  it('shows that turn as the run sent it, placeholders resolved, when the run recorded it (#2556)', () => {
    const dated = { ...scenario, inbound: { ...scenario.inbound, then: { content: '{{weekday:today+1}} at 1pm works.', channel: 'email', from: 'dana' } } };
    const text = formatJudgeInput(dated, { ...run, then: { reply: 'Done.', content: 'Tuesday at 1pm works.' } }, behaviors);
    expect(text).toContain('Tuesday at 1pm works.');
    expect(text).not.toContain('{{weekday');
  });

  it('says (none) when that turn has no reply, and adds nothing to a case without one', () => {
    expect(formatJudgeInput(scenario, { ...run, then: { reply: null } }, behaviors)).toContain('reply to that message\n(none)');
    const inbound = { ...scenario.inbound };
    delete inbound.then;
    expect(formatJudgeInput({ ...scenario, inbound }, run, behaviors)).not.toContain('Next message');
  });
});

describe('formatJudgeInput with the run clock', () => {
  const scenario: ScenarioCase = {
    name: 'clock', description: 'Coffee in a week or two.', tags: [], agent: 'coordinator', delegation: 'stubbed', releaseGate: true, sourceFile: 'x.yaml',
    seed: { contacts: [], outboundContext: [], bullpen: [], verifications: [], tasks: [], outreach: [] },
    inbound: { from: 'principal', content: 'Coffee in a week or two?' },
    toolStubs: {}, explicitStubTools: [], ownStubTools: [], expectedBehaviors: behaviors, failureModes: [],
  };
  const run: ScenarioRun = {
    runIndex: 0, inboundContent: 'Coffee in a week or two?', refs: {}, durationMs: 1, unstubbedCalls: 0, usage: emptyBreakdown(), providerRetries: [],
    reply: 'Sent Dana three times.', toolCalls: [],
  };

  it('formats the run clock in its own timezone', () => {
    expect(formatRunClock({ now: '2026-10-21T18:05:00.000Z', timezone: 'America/Toronto' }))
      .toBe('Wednesday, October 21, 2026 at 2:05 PM (America/Toronto)');
  });

  it('tells the judge when the run happened, before the transcript', () => {
    const text = formatJudgeInput(scenario, { ...run, clock: { now: '2026-10-21T18:05:00.000Z', timezone: 'America/Toronto' } }, behaviors);
    const when = text.indexOf('## When it ran');
    expect(when).toBeGreaterThan(-1);
    expect(when).toBeLessThan(text.indexOf('## Tool calls'));
    expect(text.slice(when)).toContain('Wednesday, October 21, 2026');
  });

  it('says nothing about time for a run without a clock', () => {
    expect(formatJudgeInput(scenario, run, behaviors)).not.toContain('## When it ran');
  });
});

describe('formatJudgeInput with an identity fixture (#2143)', () => {
  const scenario: ScenarioCase = {
    name: 'style', description: 'A brief reply.', tags: ['style'], agent: 'coordinator', delegation: 'stubbed', releaseGate: false, sourceFile: 'x.yaml',
    seed: { contacts: [], outboundContext: [], bullpen: [], verifications: [], tasks: [], outreach: [] },
    inbound: { from: 'principal', content: 'Did Dana confirm?' },
    toolStubs: {}, explicitStubTools: [], ownStubTools: [], expectedBehaviors: behaviors, failureModes: [],
  };
  const run: ScenarioRun = {
    runIndex: 0, inboundContent: 'Did Dana confirm?', refs: {}, durationMs: 1, unstubbedCalls: 0, usage: emptyBreakdown(), providerRetries: [],
    reply: 'Yes, Thursday at 3.', toolCalls: [],
  };

  it('shows the judge the style the fixture sets, before the transcript', () => {
    const identity = { name: 'style-brief-dry', judgeBrief: 'Dry and brief. No exclamation marks.', config: {} as never };
    const text = formatJudgeInput({ ...scenario, identity }, run, behaviors);
    const style = text.indexOf("## The office's configured style");
    expect(style).toBeGreaterThan(-1);
    expect(style).toBeLessThan(text.indexOf('## Final reply'));
    expect(text.slice(style)).toContain('Dry and brief. No exclamation marks.');
  });

  it('says nothing about style without a fixture', () => {
    expect(formatJudgeInput(scenario, run, behaviors)).not.toContain('configured style');
  });
});

describe('formatJudgeInput with real delegation (#2027)', () => {
  const scenario: ScenarioCase = {
    name: 'real', description: 'Calendar really runs.', tags: [], agent: 'coordinator', delegation: 'real', releaseGate: true, sourceFile: 'x.yaml',
    seed: { contacts: [], outboundContext: [], bullpen: [], verifications: [], tasks: [], outreach: [] },
    inbound: { from: 'principal', content: "What's on tomorrow?" },
    toolStubs: {}, explicitStubTools: [], ownStubTools: [], expectedBehaviors: behaviors, failureModes: [],
  };
  const base: ScenarioRun = {
    runIndex: 0, inboundContent: "What's on tomorrow?", refs: {}, durationMs: 1, unstubbedCalls: 0, usage: emptyBreakdown(), providerRetries: [],
    reply: 'Three meetings tomorrow.',
    toolCalls: [
      { agentId: 'coordinator', name: 'delegate', input: { agent: 'calendar' }, disposition: 'passthrough', result: { success: true, data: { response: 'Three' } } },
      { agentId: 'calendar', name: 'calendar-list-events', input: {}, disposition: 'stubbed', result: { success: true, data: { count: 3 } } },
    ],
  };

  it('labels the specialists\' calls and shows each brief and response', () => {
    const text = formatJudgeInput(scenario, {
      ...base,
      delegations: [
        { agentId: 'calendar', conversationId: 'c', brief: 'Read tomorrow.', response: 'Three meetings.', outcome: 'answered' },
        { agentId: 'calendar', conversationId: 'c2', brief: 'Again.', response: null, outcome: 'in_flight' },
      ],
    }, behaviors);
    expect(text).toContain('1. delegate');
    expect(text).toContain('2. [calendar] calendar-list-events');
    expect(text).toContain('## Specialist runs');
    expect(text).toContain('### 1. calendar\nBrief received:\nRead tomorrow.');
    expect(text).toContain('Response:\nThree meetings.');
    expect(text).toContain('Response: (none: still working when the run ended)');
  });

  it('leaves the section out for a stubbed-delegation run', () => {
    expect(formatJudgeInput(scenario, base, behaviors)).not.toContain('## Specialist runs');
  });
});

describe('extractJsonObject', () => {
  it('unwraps a fenced block or surrounding prose', () => {
    expect(extractJsonObject('```json\n{"scores": []}\n```')).toBe('{"scores": []}');
    expect(extractJsonObject('Here you go: {"scores": []} hope that helps')).toBe('{"scores": []}');
    expect(extractJsonObject('{"a": {"b": 1}}')).toBe('{"a": {"b": 1}}');
  });

  it('takes the first complete object when the judge adds more after it', () => {
    // A second object, or a closing remark with braces, used to make JSON.parse fail.
    expect(extractJsonObject('{"scores": []}\n{"note": "second thoughts"}')).toBe('{"scores": []}');
    expect(extractJsonObject('{"scores": []} (ratings use {PASS, MISS})')).toBe('{"scores": []}');
    // Braces and escaped quotes inside strings do not count.
    const tricky = '{"scores": [{"justification": "said \\"hi}\\" and {left"}]}';
    expect(extractJsonObject(`${tricky} trailing }`)).toBe(tricky);
    expect(JSON.parse(extractJsonObject(`${tricky} trailing }`))).toEqual({ scores: [{ justification: 'said "hi}" and {left' }] });
    // A second answer of the same shape is a revision: unknowable which is meant, so unparseable.
    const revised = '{"scores": [{"rating": "PASS"}]} On reflection: {"scores": [{"rating": "PARTIAL"}]}';
    expect(() => JSON.parse(extractJsonObject(revised))).toThrow();
    // No complete object: the old slice, so JSON.parse reports what is wrong.
    expect(extractJsonObject('{"scores": [ }')).toBe('{"scores": [ }');
  });
});

describe('judgeRun', () => {
  const scenario = {
    name: 'x', description: '', tags: [], agent: 'coordinator', delegation: 'stubbed', releaseGate: true, sourceFile: 'x.yaml',
    seed: { contacts: [], outboundContext: [], bullpen: [], verifications: [], tasks: [], outreach: [] },
    inbound: { from: 'principal', content: 'hi' },
    toolStubs: {}, explicitStubTools: [], ownStubTools: [], expectedBehaviors: behaviors, failureModes: [],
  } as ScenarioCase;
  const run: ScenarioRun = { runIndex: 0, inboundContent: 'hi', refs: {}, toolCalls: [], reply: 'ok', durationMs: 1, unstubbedCalls: 0, usage: emptyBreakdown(), providerRetries: [] };
  const error = (type: string) => ({ type: 'error' as const, error: { type, source: 'openrouter', message: 'x', retryable: false, context: {}, timestamp: new Date() } });

  it('throws on an error that would repeat every run', async () => {
    const provider = { id: 'openrouter', chat: async () => error('NOT_FOUND') } as never;
    await expect(judgeRun(scenario, run, behaviors, { provider, model: 'm' })).rejects.toThrow(/NOT_FOUND/);
  });

  it('retries a transient error, then marks the ratings as judge errors', async () => {
    let calls = 0;
    const provider = { id: 'openrouter', chat: async () => { calls++; return error('PROVIDER_ERROR'); } } as never;
    const out = await judgeRun(scenario, run, behaviors, { provider, model: 'm' });
    expect(calls).toBe(3);
    expect([...out.values()].every(r => r.justification.startsWith('judge error after 3 attempts'))).toBe(true);
  }, 15_000);

  const text = (content: string) => ({ type: 'text' as const, content, provenance: { actualModel: 'm' } });
  const good = JSON.stringify({ scores: [{ behaviorId: 'honest', rating: 'PASS', justification: 'ok' }, { behaviorId: 'brief', rating: 'MISS', justification: 'long' }] });

  it('asks again when a reply has no readable scores, and uses the next good one', async () => {
    const replies = ['I think it went well.', good];
    let calls = 0;
    const provider = { id: 'openrouter', chat: async () => text(replies[calls++]!) } as never;
    const out = await judgeRun(scenario, run, behaviors, { provider, model: 'm' });
    expect(calls).toBe(2);
    expect(out.get('honest')).toEqual({ rating: 'PASS', justification: 'ok' });
  });

  it('keeps the unparseable reason after the last attempt', async () => {
    let calls = 0;
    const provider = { id: 'openrouter', chat: async () => { calls++; return text('no json here'); } } as never;
    const out = await judgeRun(scenario, run, behaviors, { provider, model: 'm' });
    expect(calls).toBe(3);
    expect([...out.values()].every(r => r.justification.startsWith('judge error: reply unparseable'))).toBe(true);
  });

  it('does not retry a readable reply that skipped a behavior', async () => {
    let calls = 0;
    const partial = JSON.stringify({ scores: [{ behaviorId: 'honest', rating: 'PASS', justification: 'ok' }] });
    const provider = { id: 'openrouter', chat: async () => { calls++; return text(partial); } } as never;
    const out = await judgeRun(scenario, run, behaviors, { provider, model: 'm' });
    expect(calls).toBe(1);
    expect(out.get('brief')?.justification).toBe('judge error: no score returned');
  });
});

describe('createJudge', () => {
  const openrouter = new Map([['openrouter', { id: 'openrouter', chat: async () => { throw new Error('no calls expected'); } } as never]]);

  it('needs the OpenRouter provider and says how to get it', () => {
    expect(() => createJudge(new Map())).toThrow(/openrouter_api_key/);
  });

  // #1980: an unpriced judge would throw on its first (already paid) response, and a
  // prefix match would price 'openai/gpt-4o-mini' as 'openai/gpt-4o'.
  it('refuses a judge model without its own registry entry, before any call', () => {
    expect(() => createJudge(openrouter, undefined, { model: 'openai/gpt-4o-mini' })).toThrow(/no entry in src\/agents\/llm\/model-registry.ts/);
    expect(() => createJudge(openrouter, undefined, { model: 'vendor/unknown' })).toThrow(/no entry/);
  });

  it('prices the judge\'s responses from the registry', () => {
    const judge = createJudge(openrouter, undefined, { model: 'openai/gpt-4o' });
    const usage = { inputTokens: 1_000_000, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
    expect(judge.estimateCostUsd!('openai/gpt-4o-2024-08-06', usage)).toBeCloseTo(2.5);
  });
});

describe('meterJudgeResponse', () => {
  it('adds a response\'s tokens and price, and never throws on a pricing failure', () => {
    const ledger = new UsageLedger();
    const usage = { inputTokens: 10, outputTokens: 2, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
    const response = { type: 'text', content: '{}', usage, provenance: { requestedModel: 'm', actualModel: 'm', providerRequestId: 'r' } } as never;
    meterJudgeResponse({ provider: {} as never, model: 'm', estimateCostUsd: () => 0.5 }, response, ledger);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    meterJudgeResponse({ provider: {} as never, model: 'm', estimateCostUsd: () => { throw new Error('no price'); } }, response, ledger);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('could not price a judge call'));
    stderr.mockRestore();
    expect(ledger.snapshot().judge).toMatchObject({ calls: 2, inputTokens: 20, estimatedCostUsd: 0.5 });
  });
});
