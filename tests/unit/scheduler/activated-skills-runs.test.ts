// Job-learned skill activations (#2764): last-three-runs ring + fire-time union.
import { describe, it, expect } from 'vitest';
import {
  appendActivatedSkillsRun,
  learnedSkillsFromRuns,
} from '../../../src/scheduler/activated-skills-runs.js';

describe('appendActivatedSkillsRun', () => {
  it('starts a ring from an empty context', () => {
    expect(appendActivatedSkillsRun(undefined, ['mailbox', 'tasks'])).toEqual([
      ['mailbox', 'tasks'],
    ]);
  });

  it('keeps only the last three runs', () => {
    const prev = [['a'], ['b'], ['c']];
    expect(appendActivatedSkillsRun(prev, ['d'])).toEqual([['b'], ['c'], ['d']]);
  });

  it('ignores blank names and non-array prior entries', () => {
    // Prior runs: valid, garbage string, empty-after-clean, mixed types → then append email.
    // Ring keeps the last three after append: [], ['web'], ['email'].
    expect(appendActivatedSkillsRun([['ok'], 'nope', [''], [1, 'web']], ['  ', 'email'])).toEqual([
      [],
      ['web'],
      ['email'],
    ]);
  });
});

describe('learnedSkillsFromRuns', () => {
  it('unions the last three runs in first-seen order', () => {
    expect(
      learnedSkillsFromRuns([['mailbox'], ['tasks', 'mailbox'], ['digest', 'tasks']]),
    ).toEqual(['mailbox', 'tasks', 'digest']);
  });

  it('returns [] for missing or malformed history', () => {
    expect(learnedSkillsFromRuns(undefined)).toEqual([]);
    expect(learnedSkillsFromRuns('x')).toEqual([]);
    expect(learnedSkillsFromRuns([[], null, ['  ']])).toEqual([]);
  });

  it('ignores runs older than the last three', () => {
    expect(
      learnedSkillsFromRuns([['old'], ['a'], ['b'], ['c']]),
    ).toEqual(['a', 'b', 'c']);
  });
});
