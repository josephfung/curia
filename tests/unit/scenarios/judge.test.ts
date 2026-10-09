import { describe, expect, it, vi } from 'vitest';
import { emptyBreakdown, UsageLedger } from '../../shared/usage.js';
import { createJudge, extractJsonObject, formatJudgeInput, judgeRun, meterJudgeResponse, parseJudgeResponse } from '../../scenarios/judge.js';
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

describe('formatJudgeInput', () => {
  const scenario: ScenarioCase = {
    name: 'paused', description: 'Delegate returns paused.', tags: [], delegation: 'stubbed', releaseGate: true, sourceFile: 'x.yaml',
    seed: { contacts: [], outboundContext: [], bullpen: [] },
    inbound: { from: 'principal', content: 'How is the research going?' },
    toolStubs: {}, explicitStubTools: [], expectedBehaviors: behaviors, failureModes: ['Blames an API outage'],
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
  });
});

describe('extractJsonObject', () => {
  it('unwraps a fenced block or surrounding prose', () => {
    expect(extractJsonObject('```json\n{"scores": []}\n```')).toBe('{"scores": []}');
    expect(extractJsonObject('Here you go: {"scores": []} hope that helps')).toBe('{"scores": []}');
    expect(extractJsonObject('{"a": {"b": 1}}')).toBe('{"a": {"b": 1}}');
  });
});

describe('judgeRun', () => {
  const scenario = {
    name: 'x', description: '', tags: [], delegation: 'stubbed', releaseGate: true, sourceFile: 'x.yaml',
    seed: { contacts: [], outboundContext: [], bullpen: [] },
    inbound: { from: 'principal', content: 'hi' },
    toolStubs: {}, explicitStubTools: [], expectedBehaviors: behaviors, failureModes: [],
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
