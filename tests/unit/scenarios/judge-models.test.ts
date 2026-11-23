import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { caseJudgeModel } from '../../scenarios/judge-models.js';
import { loadScenarioCase } from '../../scenarios/loader.js';

describe('caseJudgeModel (#2556)', () => {
  const tags = { finesse: 'vendor/strong-judge', style: 'vendor/other-judge' };

  it('uses the suite default when neither the case nor a tag names one', () => {
    expect(caseJudgeModel({ name: 'c', tags: ['routing'] }, tags)).toBeUndefined();
  });

  it("uses a tag's judge, and the case's own over it", () => {
    expect(caseJudgeModel({ name: 'c', tags: ['finesse', 'routing'] }, tags)).toBe('vendor/strong-judge');
    expect(caseJudgeModel({ name: 'c', tags: ['finesse'], judgeModel: 'vendor/own' }, tags)).toBe('vendor/own');
  });

  it('refuses tags that name different judges, rather than picking by tag order', () => {
    expect(() => caseJudgeModel({ name: 'c', tags: ['finesse', 'style'] }, tags)).toThrow(/different judge models/);
    // The case's own judge settles it.
    expect(caseJudgeModel({ name: 'c', tags: ['finesse', 'style'], judgeModel: 'vendor/own' }, tags)).toBe('vendor/own');
  });
});

describe('judge_model in a case file', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'scenarios-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const CASE = `
name: judged
tags: [routing]
inbound: { from: principal, content: hi }
expected_behaviors:
  - { id: greets, description: says hello }
`;

  it('loads it, and refuses an empty one', () => {
    const file = path.join(dir, 'a.yaml');
    writeFileSync(file, `${CASE}judge_model: vendor/own\n`);
    expect(loadScenarioCase(file).judgeModel).toBe('vendor/own');
    writeFileSync(file, `${CASE}judge_model: " "\n`);
    expect(() => loadScenarioCase(file)).toThrow(/'judge_model' must name a model/);
    writeFileSync(file, CASE);
    expect(Object.hasOwn(loadScenarioCase(file), 'judgeModel')).toBe(false);
  });
});
