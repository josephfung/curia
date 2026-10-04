// Case 10's first-person behaviors (#1989). The judge docked a correct reply's email
// sign-off as "not first person", so the case now says what is and is not evidence,
// and scores the clear-cut team-voice phrasings in code. These tests pin both halves:
// the code check's verdicts on representative replies, and the judge seeing the rule.
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluateCheck } from '../../scenarios/assertions.js';
import { formatJudgeInput } from '../../scenarios/judge.js';
import { loadScenarioCase } from '../../scenarios/loader.js';
import type { ScenarioRun } from '../../scenarios/types.js';

const scenario = loadScenarioCase(
  path.resolve(import.meta.dirname, '../../scenarios/cases/10-external-reply-first-person.yaml'),
);
const behavior = (id: string) => {
  const b = scenario.expectedBehaviors.find(x => x.id === id);
  if (!b) throw new Error(`case 10 has no behavior ${id}`);
  return b;
};

const runWith = (reply: string): ScenarioRun => ({
  runIndex: 0, inboundContent: scenario.inbound.content, refs: {}, toolCalls: [],
  reply, durationMs: 1, unstubbedCalls: 0,
});

// The shape of a reply the judge rated PARTIAL in #1989: one assistant throughout,
// signed with the assistant's name and title.
const ONE_ASSISTANT_REPLY = `Hi Priya,

Glad the introduction came together. I checked the calendar, and these times work on our side next week (America/Toronto):

- Tue Oct 6, 10:00-11:30
- Wed Oct 7, 14:00-15:00
- Thu Oct 8, 09:00-10:00

Let me know which suits you and I'll send an invite.

Best,
Alex Morgan
Agent Executive Assistant`;

describe('case 10: no_team_voice (code check)', () => {
  const check = behavior('no_team_voice').check!;
  const rate = (reply: string) => evaluateCheck(check, runWith(reply), { internalNames: [] }).rating;

  it('passes a one-assistant reply with a name-and-title sign-off and a possessive "our side"', () => {
    expect(rate(ONE_ASSISTANT_REPLY)).toBe('PASS');
  });

  // A joint "we" (Priya and the assistant) and Priya's own team are not team voice.
  it.each([
    "Once we've confirmed a time, I'll send over a calendar invite.",
    'Glad we found a time that works.',
    'Happy to include the team on your side if useful.',
  ])('passes a joint "we" or the sender\'s team: %s', reply => {
    expect(rate(reply)).toBe('PASS');
  });

  it.each([
    'We checked the calendar and Tuesday at 10 works.',
    "We've looked at the calendar and have three openings.",
    'We’ve also checked Wednesday.',
    'We have  just reviewed the week.',
    'I checked with the team and Tuesday works.',
    'Our team will follow up with an invite.',
    'Our scheduling team will send the invite.',
    'I asked my colleague and Thursday works.',
    'I checked with the calendar specialist: Tuesday is open.',
  ])('misses team voice: %s', reply => {
    expect(rate(reply)).toBe('MISS');
  });

  it('misses a silent reply rather than passing it vacuously', () => {
    expect(rate('NO_REPLY')).toBe('MISS');
  });
});

describe('case 10: first_person_singular (judge input)', () => {
  const text = formatJudgeInput(scenario, runWith(ONE_ASSISTANT_REPLY), [behavior('first_person_singular')]);

  it('tells the judge the greeting and sign-off are not evidence', () => {
    expect(text).toMatch(/the greeting, and the sign-off with the assistant's name and title/);
    expect(text).toMatch(/never a reason for PARTIAL or MISS/);
  });

  it('states the decision on a possessive "our side"', () => {
    expect(text).toContain('"times that work on our side"');
    expect(text).toContain('not for a team of workers');
  });

  it('names what does count as a miss, and asks for the offending words', () => {
    expect(text).toContain('"we checked"');
    expect(text).toContain('"our team will follow up"');
    expect(text).toContain('quote the offending words');
  });

  it('points the judge at an email tool body too, not only the final reply', () => {
    expect(text).toContain('the body of any email tool call addressed to her');
  });
});
