import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scoreCase } from '../../scenarios/gate.js';
import { loadScenarioCase } from '../../scenarios/loader.js';
import { rescoreCase, rescoreRefusal, type JudgeRunFn } from '../../scenarios/rescore.js';
import { caseSetupHash, stableStringify } from '../../scenarios/setup-hash.js';
import type { CaseResult, RunRating, ScenarioCase, ScenarioRun } from '../../scenarios/types.js';
import { emptyBreakdown } from '../../shared/usage.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'scenarios-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function load(body: string, name = 'a.yaml'): ScenarioCase {
  const file = path.join(dir, name);
  writeFileSync(file, body);
  return loadScenarioCase(file);
}

const CASE = `
name: sick attendee
description: Tomás is sick
tags: [finesse]
seed:
  contacts:
    - { key: tomas, display_name: Tomás Reyes, channel: email, identifier: tomas@example.test }
inbound: { from: tomas, channel: email, content: I'm sick and can't make the board update. }
tool_stubs:
  calendar-delete-event:
    - { match: {}, return: { deleted: true } }
expected_behaviors:
  - id: keeps-meeting
    weight: critical
    layer: decision
    description: does not cancel the meeting
    check: { not_called: [calendar-delete-event] }
  - id: warm-reply
    weight: important
    layer: voice
    description: replies warmly to Tomás
`;

function run(i: number, extra: Partial<ScenarioRun> = {}): ScenarioRun {
  return {
    runIndex: i, inboundContent: '', refs: {}, toolCalls: [], reply: 'Feel better!', durationMs: 1,
    unstubbedCalls: 0, usage: emptyBreakdown(), providerRetries: [], clock: { now: '2026-11-14T12:00:00Z', timezone: 'America/Toronto' },
    ...extra,
  };
}

const P: RunRating = { rating: 'PASS', justification: 'ok' };
const M: RunRating = { rating: 'MISS', justification: 'no' };

function saved(scenario: ScenarioCase, runs: ScenarioRun[], ratings: Record<string, RunRating[]>): CaseResult {
  return { ...scoreCase(scenario.name, scenario.expectedBehaviors, runs, new Map(Object.entries(ratings))), setupHash: caseSetupHash(scenario) };
}

describe('caseSetupHash (#2556)', () => {
  it('ignores the rubric and bookkeeping', () => {
    const base = load(CASE);
    const rubric = load(CASE
      .replace('description: Tomás is sick', 'description: Tomás is very sick')
      .replace('tags: [finesse]', 'tags: [finesse, extra]')
      .replace('replies warmly to Tomás', 'replies kindly to Tomás')
      .replace('weight: important', 'weight: critical'), 'b.yaml');
    expect(caseSetupHash(rubric)).toBe(caseSetupHash(base));
  });

  it('moves when what the agents see changes', () => {
    const base = caseSetupHash(load(CASE));
    expect(caseSetupHash(load(CASE.replace("can't make the board update", "can't make the deep dive"), 'b.yaml'))).not.toBe(base);
    expect(caseSetupHash(load(CASE.replace('display_name: Tomás Reyes', 'display_name: Tomás Reyes, title: VP Product'), 'c.yaml'))).not.toBe(base);
    expect(caseSetupHash(load(CASE.replace('{ deleted: true }', '{ deleted: false }'), 'd.yaml'))).not.toBe(base);
  });

  it('does not depend on key order', () => {
    expect(stableStringify({ b: 1, a: { d: [2, { f: 1, e: 0 }], c: undefined } })).toBe('{"a":{"d":[2,{"e":0,"f":1}]},"b":1}');
  });
});

describe('rescoreRefusal', () => {
  it('refuses a run without a hash, or whose setup moved, and names the case', () => {
    const scenario = load(CASE);
    const s = saved(scenario, [run(0)], { 'keeps-meeting': [P], 'warm-reply': [P] });
    expect(rescoreRefusal(s, scenario)).toBeUndefined();
    expect(rescoreRefusal({ ...s, setupHash: undefined }, scenario)).toMatch(/^sick attendee: saved without a setup hash/);
    const edited = load(CASE.replace("can't make", 'cannot make'), 'b.yaml');
    expect(rescoreRefusal(s, edited)).toMatch(/^sick attendee: its setup changed since this run \(hash \w+ → \w+\)/);
  });
});

describe('rescoreCase', () => {
  it('scores saved runs against the current behaviors, checks in code and the rest by the judge', async () => {
    const original = load(CASE);
    const runs = [
      run(0),
      run(1, { toolCalls: [{ name: 'calendar-delete-event', input: {}, result: { success: true, data: {} }, disposition: 'stubbed' }] }),
      run(2, { error: 'timed out' }),
    ];
    const s = saved(original, runs, { 'keeps-meeting': [P, M, M], 'warm-reply': [M, M, M] });

    // The review rewrote the voice behavior, dropped nothing, and added one.
    const revised = load(CASE
      .replace('replies warmly to Tomás', 'replies warmly and briefly to Tomás')
      .concat(`  - id: informs-principal\n    layer: decision\n    description: tells Avery Tomás is out\n`), 'b.yaml');
    const judged: string[][] = [];
    const judge: JudgeRunFn = async (_s, _run, behaviors) => {
      judged.push(behaviors.map(b => b.id));
      return new Map(behaviors.map(b => [b.id, P]));
    };
    const r = await rescoreCase(s, revised, judge, []);

    // The errored run is not judged; the other two are, on the judged behaviors only.
    expect(judged).toEqual([['warm-reply', 'informs-principal'], ['warm-reply', 'informs-principal']]);
    expect(r.result.behaviors.find(b => b.behavior.id === 'keeps-meeting')!.ratings.map(x => x.rating)).toEqual(['PASS', 'MISS', 'MISS']);
    expect(r.result.behaviors.find(b => b.behavior.id === 'warm-reply')!.ratings.map(x => x.rating)).toEqual(['PASS', 'PASS', 'MISS']);
    expect(r.added).toEqual(['informs-principal']);
    expect(r.removed).toEqual([]);
    expect(r.edited).toEqual(['warm-reply']);
    expect(r.result.setupHash).toBe(s.setupHash);
    expect(r.result.layers?.voice?.weightedScore).toBeCloseTo(2 / 3);
  });
});
