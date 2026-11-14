import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  contrastMessage,
  formatBlindIdLines,
  parseBlindIdResponse,
  runBlindId,
  seededShuffle,
} from '../../scenarios/blind-id.js';
import { scoreCase } from '../../scenarios/gate.js';
import type { Judge } from '../../scenarios/judge.js';
import { loadScenarioCase, loadScenarioCases } from '../../scenarios/loader.js';
import type { CaseResult, ContrastMessageSource, ScenarioCase, ScenarioRun } from '../../scenarios/types.js';
import { emptyBreakdown } from '../../shared/usage.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'scenarios-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function caseYaml(name: string, recipient: string, extra = ''): string {
  return `
name: ${name}
tags: [finesse]
seed:
  contacts:
    - { key: them, display_name: Someone, channel: email, identifier: them@example.test }
inbound: { from: principal, content: Tell them I'm running late. }
tool_stubs:
  email-send:
    - { match: {}, return: { sent: true } }
contrast:
  group: late
  recipient: ${recipient}
  message: [{ tool: email-send, arg: body, with: { contact_id: "{{contact:them}}" } }, reply]
expected_behaviors:
  - { id: tells, layer: decision, description: tells them }
${extra}`;
}

function run(i: number, body: string | null, extra: Partial<ScenarioRun> = {}): ScenarioRun {
  return {
    runIndex: i, inboundContent: '', refs: { 'contact:them': 'c-1' }, reply: 'Done.', durationMs: 1, unstubbedCalls: 0,
    usage: emptyBreakdown(), providerRetries: [],
    toolCalls: body === null ? [] : [{ name: 'email-send', input: { contact_id: 'c-1', body }, result: { success: true, data: {} }, disposition: 'stubbed' }],
    ...extra,
  };
}

function result(scenario: ScenarioCase, runs: ScenarioRun[]): CaseResult {
  return scoreCase(scenario.name, scenario.expectedBehaviors, runs, new Map([['tells', runs.map(() => ({ rating: 'PASS' as const, justification: '' }))]]));
}

/** A judge that reads the recipient letters and the messages and answers through `answer`. */
function fakeJudge(answer: (recipients: string[], messages: string[]) => string): Judge & { calls: string[] } {
  const calls: string[] = [];
  const provider = {
    chat: async (req: { messages: Array<{ content: string }> }) => {
      const input = req.messages[1]!.content;
      calls.push(input);
      const recipients = [...input.matchAll(/^([A-Z])\. (.*)$/gm)].map(m => m[2]!);
      const messages = [...input.matchAll(/### Message \d+\n(.*)\n/g)].map(m => m[1]!);
      return { type: 'text', content: answer(recipients, messages) };
    },
  };
  return { provider, model: 'fake/judge', calls } as unknown as Judge & { calls: string[] };
}

describe('contrastMessage', () => {
  const sources: ContrastMessageSource[] = [{ tool: 'email-send', arg: 'body', with: { contact_id: '{{contact:them}}' } }, 'reply'];

  it("takes the last matching call's argument, with placeholders resolved per run", () => {
    const r = run(0, 'first');
    r.toolCalls.push({ name: 'email-send', input: { contact_id: 'c-1', body: 'second' }, result: { success: true, data: {} }, disposition: 'stubbed' });
    r.toolCalls.push({ name: 'email-send', input: { contact_id: 'someone-else', body: 'not theirs' }, result: { success: true, data: {} }, disposition: 'stubbed' });
    expect(contrastMessage(sources, r)).toBe('second');
  });

  it('falls back to the reply, and finds nothing for a silent or errored run', () => {
    expect(contrastMessage(sources, run(0, null))).toBe('Done.');
    expect(contrastMessage(sources, run(0, null, { reply: 'NO_REPLY' }))).toBeUndefined();
    expect(contrastMessage(sources, run(0, 'hi', { error: 'timed out' }))).toBeUndefined();
  });
});

describe('seededShuffle', () => {
  it('is deterministic per seed and keeps every item', () => {
    const items = ['a', 'b', 'c', 'd', 'e'];
    expect(seededShuffle(items, 'late#0')).toEqual(seededShuffle(items, 'late#0'));
    expect([...seededShuffle(items, 'late#1')].sort()).toEqual(items);
  });
});

describe('parseBlindIdResponse', () => {
  it('reads matches, and says why a reply is unreadable', () => {
    const ok = parseBlindIdResponse('```json\n{"matches": [{"message": 1, "recipient": "b"}, {"message": "2", "recipient": "A"}]}\n```');
    expect('matches' in ok && [...ok.matches]).toEqual([[1, 'B'], [2, 'A']]);
    expect(parseBlindIdResponse('no idea')).toMatchObject({ error: expect.stringMatching(/unparseable/) });
    expect(parseBlindIdResponse('{"answer": 1}')).toEqual({ error: 'reply has no matches array' });
  });
});

describe('runBlindId (#2556)', () => {
  function members(): Array<{ scenario: ScenarioCase; result: CaseResult }> {
    writeFileSync(path.join(dir, 'chair.yaml'), caseYaml('chair', 'The board chair'));
    writeFileSync(path.join(dir, 'report.yaml'), caseYaml('report', 'A direct report'));
    writeFileSync(path.join(dir, 'friend.yaml'), caseYaml('friend', 'A close friend'));
    const cases = loadScenarioCases(dir);
    const bodies: Record<string, Array<string | null>> = {
      chair: ['Dear Chair, my apologies', 'Dear Chair, sincere apologies'],
      report: ['Running 10 late', null],
      friend: ['Hey! Late, sorry', 'Ugh, late, save me a seat'],
    };
    // A run that wrote nothing stays silent too, or its reply would stand in as its message.
    return cases.map(scenario => ({ scenario, result: result(scenario, bodies[scenario.name]!.map((b, i) => run(i, b, b === null ? { reply: 'NO_REPLY' } : {}))) }));
  }
  const truth: Record<string, string> = { 'The board chair': 'Dear', 'A direct report': 'Running', 'A close friend': 'H|U' };

  it('asks each trial in two orders and scores a judge that can tell them apart', async () => {
    const judge = fakeJudge((recipients, messages) => JSON.stringify({
      matches: messages.map((m, i) => ({
        message: i + 1,
        recipient: String.fromCharCode(65 + recipients.findIndex(r => new RegExp(`^(${truth[r]})`).test(m))),
      })),
    }));
    const r = await runBlindId('late', members(), [], judge);
    // Run 0: three messages; run 1: the report wrote nothing, so two. Two orders each.
    expect(r.judgeCalls).toBe(4);
    expect(judge.calls[0]).not.toBe(judge.calls[1]);
    expect(r).toMatchObject({ correct: 10, total: 10, accuracy: 1, skippedTrials: 0, judgeErrors: 0 });
    expect(r.chance).toBeCloseTo((1 / 3 + 1 / 3 + 1 / 2 + 1 / 2) / 4);
    expect(r.byCase).toEqual({ chair: { correct: 4, total: 4 }, friend: { correct: 4, total: 4 }, report: { correct: 2, total: 2 } });
    expect(formatBlindIdLines([r])[0]).toBe('late: 10/10 matched (100%; chance 42%)');
  });

  it('counts a judge that always answers A as mostly wrong, and an unreadable reply as a judge error', async () => {
    const lazy = await runBlindId('late', members(), ['absent'], fakeJudge((_r, messages) => JSON.stringify({ matches: messages.map((_m, i) => ({ message: i + 1, recipient: 'A' })) })));
    expect(lazy.accuracy).toBeLessThan(0.5);
    expect(formatBlindIdLines([lazy])[0]).toMatch(/not in this run: absent/);

    const broken = await runBlindId('late', members(), [], fakeJudge(() => 'I cannot say'));
    expect(broken).toMatchObject({ judgeErrors: 4, total: 0, accuracy: null });
    expect(formatBlindIdLines([broken])[0]).toMatch(/^late: not measured/);
  });
});

describe('contrast groups in case files', () => {
  it('refuses a group of one, and two cases describing the same recipient', () => {
    writeFileSync(path.join(dir, 'a.yaml'), caseYaml('a', 'The board chair'));
    expect(() => loadScenarioCases(dir)).toThrow(/has one case \(a\)/);
    writeFileSync(path.join(dir, 'b.yaml'), caseYaml('b', 'the board chair '));
    expect(() => loadScenarioCases(dir)).toThrow(/a and b describe the same recipient/);
  });

  it('refuses a placeholder in the message source that names no seeded contact', () => {
    writeFileSync(path.join(dir, 'a.yaml'), caseYaml('a', 'x').replace('{{contact:them}}', '{{contact:nobody}}'));
    expect(() => loadScenarioCase(path.join(dir, 'a.yaml'))).toThrow(/names no seeded contact/);
  });
});
