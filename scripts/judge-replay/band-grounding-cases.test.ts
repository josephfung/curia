// The grounding set is checked without a model: every case renders as a production brief, every
// labelled sentence is in its message, and the scoring helpers read labels the right way round.

import { describe, it, expect } from 'vitest';
import { buildBriefUserPrompt, type BriefAnswers } from '../../src/autonomy/judge-brief.js';
import { GROUNDING_CASES, SEND_QUESTIONS, groundingMeetsLabel, normalizeSentence, quoted, type GroundingCase } from './band-grounding-cases.js';
import { meetsLabel, parseArgs, sameModel, summarize, wouldSend, type CaseResult } from './band-grounding-replay.js';

const byId = (id: string) => GROUNDING_CASES.find((c) => c.id === id)!;

describe('band grounding cases (#2616)', () => {
  it('have unique ids and both rated labels', () => {
    const ids = GROUNDING_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(GROUNDING_CASES.some((c) => c.expect === 'pass')).toBe(true);
    expect(GROUNDING_CASES.some((c) => c.expect === 'flag')).toBe(true);
  });

  it('ask the questions band review asks for a send to a contact', () => {
    for (const c of GROUNDING_CASES) expect(c.input.questions).toEqual(SEND_QUESTIONS);
  });

  it('render as a production brief', () => {
    for (const c of GROUNDING_CASES) {
      const prompt = buildBriefUserPrompt(c.input);
      expect(prompt, c.id).toContain('<evidence_json>');
      expect(prompt, c.id).toContain('"unsupportedClaims"');
    }
  });

  it('put every labelled sentence verbatim in the message, and give only flag cases any', () => {
    for (const c of GROUNDING_CASES) {
      if (c.expect !== 'flag') {
        expect(c.mustFlag, c.id).toBeUndefined();
        expect(c.mustNotFlag, c.id).toBeUndefined();
        continue;
      }
      expect(c.mustFlag?.length, c.id).toBeGreaterThan(0);
      for (const s of [...(c.mustFlag ?? []), ...(c.mustNotFlag ?? [])]) {
        expect(normalizeSentence(c.input.message), c.id).toContain(normalizeSentence(s));
      }
    }
  });

  it('cover the three production false positives and the adversarial controls', () => {
    const ids = GROUNDING_CASES.map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining([
      'pass-open-own-hold', 'pass-question-own-hold', 'pass-opener-thread-subject',
      'flag-guest-asserts-open', 'flag-dressed-up-event', 'flag-mislabelled-hold', 'flag-tentative-real-event',
    ]));
  });
});

describe('quoted', () => {
  const core = '10:00 AM ET is still open';

  it('matches any quote holding the core: the sentence, a clause, or more, whatever the spacing', () => {
    expect(quoted(core, ['Monday, March 16 at 10:00 AM ET is still open.'])).toBe(true);
    expect(quoted(core, ['Hi Jordan,  Monday, March 16 at 10:00  AM ET is still open.'])).toBe(true);
    expect(quoted('in Toronto that week', ['Avery will be in Toronto that week'])).toBe(true);
  });

  it('does not count a quote of another part of the sentence, or an empty one', () => {
    expect(quoted(core, [''])).toBe(false);
    expect(quoted(core, ['still open'])).toBe(false);
    expect(quoted(core, ['Monday, March 16 at 10:00 AM ET'])).toBe(false);
    expect(quoted('', ['anything'])).toBe(false);
  });
});

describe('groundingMeetsLabel', () => {
  it('needs every mustFlag sentence, and fails when a mustNotFlag sentence is listed too', () => {
    const c = byId('flag-invented-whereabouts');
    const whereabouts = c.mustFlag![0]!;
    expect(groundingMeetsLabel(c, [whereabouts])).toBe(true);
    expect(groundingMeetsLabel(c, [])).toBe(false);
    // The over-flagging #2616 is about: the supported sentence listed beside the real claim.
    expect(groundingMeetsLabel(c, [whereabouts, c.mustNotFlag![0]!])).toBe(false);
  });

  it('reads an observe case as "flagged something", for reporting only', () => {
    // No case in the set is undecided today; the label stays for the next one that is.
    const c: GroundingCase = { ...byId('flag-question-unchecked-slot'), id: 'observe-x', expect: 'observe', mustFlag: undefined };
    expect(groundingMeetsLabel(c, ['x'])).toBe(true);
    expect(groundingMeetsLabel(c, [])).toBe(false);
  });
});

describe('wouldSend and meetsLabel', () => {
  const clean: BriefAnswers = { purpose: 'serving', speaksAsPrincipal: false, stakes: 'routine', unsupportedClaims: [], unnecessaryItems: [], reason: '' };

  it('sends a clean routine answer at the replay score', () => {
    expect(wouldSend(clean)).toBe(true);
  });

  // A false positive moved out of grounding must still count against a must-pass case.
  it.each([
    ['steered', { purpose: 'steered' as const }],
    ['an unsupported claim', { unsupportedClaims: ['x'] }],
    ['an unneeded item', { unnecessaryItems: ['x'] }],
    ['a commitment spoken for the principal below 90', { speaksAsPrincipal: true, stakes: 'commitment' as const }],
    ['a financial or legal statement', { speaksAsPrincipal: true, stakes: 'financial_or_legal' as const }],
  ])('holds an answer with %s', (_label, change) => {
    expect(wouldSend({ ...clean, ...change })).toBe(false);
  });

  it('sends a routine statement for the principal at 80+', () => {
    expect(wouldSend({ ...clean, speaksAsPrincipal: true, stakes: 'routine' })).toBe(true);
  });

  it('scores a pass case by the send, and a flag case by its sentences', () => {
    expect(meetsLabel(byId('pass-open-own-hold'), clean)).toBe(true);
    expect(meetsLabel(byId('pass-open-own-hold'), { ...clean, unnecessaryItems: ['x'] })).toBe(false);
    const flag = byId('flag-unchecked-slot');
    expect(meetsLabel(flag, { ...clean, unsupportedClaims: [...flag.mustFlag!] })).toBe(true);
  });
});

describe('summarize', () => {
  it('reports the two labels separately with their counts, leaves observe cases out, and totals failures', () => {
    const cases: CaseResult[] = [
      { id: 'a', expect: 'flag', runs: 2, met: 2, failures: 0, answers: [] },
      { id: 'b', expect: 'flag', runs: 2, met: 0, failures: 2, answers: [] },
      { id: 'c', expect: 'pass', runs: 2, met: 1, failures: 0, answers: [] },
      { id: 'd', expect: 'observe', runs: 2, met: 2, failures: 1, answers: [] },
    ];
    const s = summarize('m', 2, cases, 0.01);
    expect(s.flag).toEqual({ met: 2, runs: 4, rate: 0.5 });
    expect(s.pass).toEqual({ met: 1, runs: 2, rate: 0.5 });
    expect(s.failures).toBe(3);
    expect(s.estimatedCostUsd).toBe(0.01);
  });

  it('gives a label with no runs a null rate, not NaN', () => {
    expect(summarize('m', 1, []).flag).toEqual({ met: 0, runs: 0, rate: null });
  });
});

describe('parseArgs', () => {
  it('needs a model and bounds the run count', () => {
    expect(() => parseArgs([])).toThrow(/--model/);
    expect(() => parseArgs(['--model', 'x', '--runs', '0'])).toThrow(/--runs/);
    expect(() => parseArgs(['--model', 'x', '--runs', '3abc'])).toThrow(/--runs/);
    expect(parseArgs(['--model', 'x'])).toMatchObject({ model: 'x', runs: 5 });
  });

  // An ignored flag means a run nobody asked for, and paid for.
  it('rejects anything it would otherwise ignore', () => {
    expect(() => parseArgs(['--model', 'x', '--case=pass-open-plain'])).toThrow(/unknown argument/);
    expect(() => parseArgs(['--model', 'x', '--run', '1'])).toThrow(/unknown argument/);
    expect(() => parseArgs(['--model', 'x', '--case'])).toThrow(/needs a value/);
    expect(() => parseArgs(['--model', 'x', '--json', '--runs', '1'])).toThrow(/needs a value/);
    expect(() => parseArgs(['--model', 'x', '--case', 'nope'])).toThrow(/--case/);
    expect(() => parseArgs(['--model', 'x', '--model', 'y'])).toThrow(/twice/);
  });
});

describe('sameModel', () => {
  it('accepts the model asked for or a dated variant, and nothing else', () => {
    expect(sameModel('google/gemini-3.1-flash-lite', 'google/gemini-3.1-flash-lite')).toBe(true);
    expect(sameModel('google/gemini-3.1-flash-lite', 'google/gemini-3.1-flash-lite-2026-01')).toBe(true);
    expect(sameModel('google/gemini-3.1-flash-lite', 'google/gemini-3.1-flash')).toBe(false);
    expect(sameModel('google/gemini-3.1-flash-lite', 'openai/gpt-4o-mini')).toBe(false);
  });
});
