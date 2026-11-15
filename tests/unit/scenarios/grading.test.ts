import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scoreCase } from '../../scenarios/gate.js';
import {
  agreementWith,
  formatAgreementLine,
  asText,
  gradingSheet,
  parseCsv,
  parseGrades,
  runMessages,
  sampleGradingItems,
  toCsv,
  type HumanGrade,
} from '../../scenarios/grading.js';
import { loadScenarioCase } from '../../scenarios/loader.js';
import type { RunRating, ScenarioCase, ScenarioRun, SuiteResult } from '../../scenarios/types.js';
import { emptyBreakdown } from '../../shared/usage.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'grading-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function caseFile(name: string, recipient: string): ScenarioCase {
  const file = path.join(dir, `${name.replace(/\W+/g, '-')}.yaml`);
  writeFileSync(file, `
name: ${name}
description: Avery is running late.
tags: [finesse]
seed:
  contacts:
    - { key: them, display_name: Catherine Whitfield, channel: email, identifier: c@example.test }
inbound: { from: principal, content: Running ten minutes late. }
contrast: { group: late, recipient: ${recipient}, message: [reply] }
expected_behaviors:
  - { id: tells, layer: decision, description: tells them, check: { reply: not_no_reply } }
  - { id: voice, layer: voice, description: the message is apologetic }
  - { id: decides, layer: decision, description: tells them before the start }
`);
  return loadScenarioCase(file);
}

function run(i: number, extra: Partial<ScenarioRun> = {}): ScenarioRun {
  return {
    runIndex: i, inboundContent: 'Running ten minutes late.', refs: { 'contact:them': 'c-1' }, reply: 'Done.', durationMs: 1,
    unstubbedCalls: 0, usage: emptyBreakdown(), providerRetries: [], toolCalls: [], ...extra,
  };
}

const P: RunRating = { rating: 'PASS', justification: 'ok' };
const J: RunRating = { rating: 'MISS', justification: 'judge error: no score returned' };

function suiteOf(entries: Array<{ scenario: ScenarioCase; runs: ScenarioRun[]; voice: RunRating[] }>): SuiteResult {
  return {
    cases: entries.map(e => scoreCase(e.scenario.name, e.scenario.expectedBehaviors, e.runs, new Map([
      ['tells', e.runs.map(() => P)], ['voice', e.voice], ['decides', e.runs.map(() => P)],
    ]))),
    judge: 'openai/gpt-4o',
  } as unknown as SuiteResult;
}

describe('runMessages', () => {
  it('lists what came in, then each message Curia wrote, labelled with where it went', () => {
    const scenario = caseFile('finesse 52b late', 'The board chair.');
    const text = runMessages(scenario, run(0, {
      toolCalls: [
        { name: 'sms-send', input: { recipient: 'c-1', message: 'Catherine, Avery is ten minutes late.' }, result: { success: true, data: {} }, disposition: 'stubbed' },
        { name: 'email-send', input: { to: 'principal', subject: 'FYI', body: 'Told Catherine.' }, result: { success: false, error: 'no' }, disposition: 'stubbed' },
        { name: 'calendar-list-events', input: {}, result: { success: true, data: {} }, disposition: 'stubbed' },
      ],
      reply: 'Done.',
    }));
    expect(text).toBe([
      '[WHAT CAME IN, from Avery]\nRunning ten minutes late.',
      '[Text to Catherine Whitfield]\nCatherine, Avery is ten minutes late.',
      '[Email to Avery, subject "FYI" (not sent: the tool refused it)]\nTold Catherine.',
      '[Reply to Avery]\nDone.',
    ].join('\n\n'));
    expect(runMessages(scenario, run(0, { reply: 'NO_REPLY' }))).toMatch(/\(Curia wrote nothing in this run\)$/);
  });
});

describe('runMessages and the reply lock', () => {
  it("marks the turn's reply undelivered once Curia replied on the sender's thread, as production drops it", () => {
    const file = path.join(dir, 'beer.yaml');
    writeFileSync(file, `
name: finesse 59a beer
description: David asks for a beer.
tags: [finesse]
seed:
  contacts:
    - { key: david, display_name: David Okonkwo, channel: email, identifier: d@example.test }
inbound:
  from: david
  channel: email
  content: Beer next week?
  email: { nylas_message_id: msg-59a, to: [principal], cc: [curia] }
expected_behaviors:
  - { id: voice, layer: voice, description: matches David }
`);
    const scenario = loadScenarioCase(file);
    const reply = { name: 'email-reply', input: { reply_to_message_id: 'msg-59a', body: 'Hi David, let me check.' }, result: { success: true, data: {} }, disposition: 'stubbed' } as const;
    const text = runMessages(scenario, run(0, { toolCalls: [reply], reply: 'Hi David, let me check.' }));
    expect(text).toContain("[Email reply on the sender's thread]\nHi David, let me check.");
    expect(text).toContain('[Reply to David Okonkwo (not delivered: Curia had already replied on the thread)]');
    // A reply on another thread, or a refused one, leaves the turn's reply as delivered.
    const other = runMessages(scenario, run(0, { toolCalls: [{ ...reply, input: { ...reply.input, reply_to_message_id: 'msg-other' } }], reply: 'Hi.' }));
    expect(other).toContain('[Reply to David Okonkwo]\nHi.');
    const refused = runMessages(scenario, run(0, { toolCalls: [{ ...reply, result: { success: false, error: 'no' } }], reply: 'Hi.' }));
    expect(refused).toContain('[Reply to David Okonkwo]\nHi.');
  });
});

describe('sampleGradingItems', () => {
  it('samples judged voice ratings only, across tasks, deterministically, skipping judge errors and errored runs', () => {
    const a = caseFile('finesse 52b late chair', 'The board chair.');
    const b = caseFile('finesse 52d late friend', 'A close friend.');
    const c = caseFile('finesse 53a ask report', 'A direct report.');
    const suite = suiteOf([
      { scenario: a, runs: [run(0), run(1)], voice: [P, J] },
      { scenario: b, runs: [run(0, { error: 'timed out' }), run(1)], voice: [P, P] },
      { scenario: c, runs: [run(0), run(1)], voice: [P, P] },
    ]);
    const all = sampleGradingItems(suite, [a, b, c], { n: 10, seed: 's' });
    expect(all.map(i => i.id).sort()).toEqual([
      'finesse 52b late chair#1#voice', 'finesse 52d late friend#2#voice', 'finesse 53a ask report#1#voice', 'finesse 53a ask report#2#voice',
    ]);
    expect(all.every(i => i.behaviorId === 'voice')).toBe(true);
    // Two picks span both tasks; the same seed gives the same sheet.
    const two = sampleGradingItems(suite, [a, b, c], { n: 2, seed: 's' });
    expect(new Set(two.map(i => i.task))).toEqual(new Set(['52', '53']));
    expect(sampleGradingItems(suite, [a, b, c], { n: 2, seed: 's' })).toEqual(two);
    expect(sampleGradingItems(suite, [a, b, c], { n: 10, seed: 's', layer: 'decision' }).map(i => i.behaviorId)).toContain('decides');
  });
});

describe('the sheet', () => {
  it('round-trips fields with commas, quotes and newlines', () => {
    const rows = [['a', 'b, c', 'say "hi"\nthen go'], ['', 'x', '']];
    expect(parseCsv(toCsv(rows))).toEqual([['a', 'b, c', 'say "hi"\nthen go'], ['', 'x', '']]);
    expect(() => parseCsv('"open')).toThrow(/unterminated/);
  });

  it('keeps every cell as text in a spreadsheet: nothing starts like a formula', () => {
    expect(asText('=== hi')).toBe("'=== hi");
    for (const c of ['+1', '-x', '@me']) expect(asText(c)).toBe(`'${c}`);
    expect(asText('[Reply to Avery]')).toBe('[Reply to Avery]');
    const sheet = gradingSheet([{ id: 'x#1#voice', caseName: 'x', task: '52', runIndex: 0, behaviorId: 'voice', recipient: '- a friend', situation: 's', whatToGrade: 'w', messages: 'm' }]);
    expect(parseCsv(sheet)[1]![2]).toBe("'- a friend");
  });

  it('reads grades back, skipping blanks and refusing anything else', () => {
    const sheet = gradingSheet([{ id: 'x#1#voice', caseName: 'x', task: '52', runIndex: 0, behaviorId: 'voice', recipient: 'r', situation: 's', whatToGrade: 'w', messages: 'm' }]);
    const rows = parseCsv(sheet);
    expect(rows[0]).toEqual(['item_id', 'task', 'recipient', 'situation', 'what_to_grade', 'messages', 'grade', 'notes']);
    const filled = toCsv([rows[0]!, ['x#1#voice', '', '', '', '', '', ' partial ', 'too long'], ['y#1#voice', '', '', '', '', '', '', '']]);
    expect([...parseGrades(filled)]).toEqual([['x#1#voice', { rating: 'PARTIAL', notes: 'too long' }]]);
    expect(() => parseGrades(toCsv([rows[0]!, ['x#1#voice', '', '', '', '', '', 'good', '']]))).toThrow(/row 2 \(x#1#voice\): grade 'good'/);
    expect(() => parseGrades(toCsv([['id', 'grade']]))).toThrow(/needs item_id and grade/);
  });
});

describe('agreementWith', () => {
  const human = new Map<string, HumanGrade>([
    ['a', { rating: 'PASS', notes: '' }], ['b', { rating: 'MISS', notes: '' }],
    ['c', { rating: 'PARTIAL', notes: '' }], ['d', { rating: 'PASS', notes: '' }], ['e', { rating: 'MISS', notes: '' }],
  ]);

  it('counts exact and pass/fail agreement and kappa, leaving judge errors out', () => {
    const judged = new Map<string, RunRating>([
      ['a', P], ['b', { rating: 'MISS', justification: '' }], ['c', { rating: 'MISS', justification: 'too stiff' }],
      ['d', P], ['e', J],
    ]);
    const a = agreementWith('j', human, judged);
    expect(a).toMatchObject({ n: 4, exact: 3, passFail: 4, judgeErrors: 1 });
    // po = 3/4; marginals human P 2, M 1, Pa 1 vs judge P 2, M 2: pe = (2·2 + 1·2 + 1·0) / 16 = 0.375.
    expect(a.kappa).toBeCloseTo((0.75 - 0.375) / 0.625);
    expect(a.disagreements).toEqual([{ id: 'c', human: 'PARTIAL', judge: 'MISS', justification: 'too stiff' }]);
    expect(formatAgreementLine(a)).toBe('j: 3/4 exact (75%), 4/4 pass/fail (100%), κ 0.60; 1 judge error(s) left out');
  });

  it('has no kappa when every rating is the same and no figures without overlap', () => {
    const allPass = new Map<string, HumanGrade>([['a', { rating: 'PASS', notes: '' }]]);
    expect(agreementWith('j', allPass, new Map([['a', P]])).kappa).toBeNull();
    expect(formatAgreementLine(agreementWith('j', allPass, new Map()))).toBe('j: 0/0 exact (n/a), 0/0 pass/fail (n/a), κ n/a');
  });
});
