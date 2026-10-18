// Case 18's filing stubs (#2150). In the v0.44 gate the coordinator updated the task the
// case's own task-create returns, and filed a brief under /projects/; both were refused,
// so the case failed on the harness. Ten live runs after the fix made neither call, so
// these tests replay the two calls from that gate against the case's merged stubs.
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { emptyBreakdown } from '../../shared/usage.js';
import { evaluateCheck } from '../../scenarios/assertions.js';
import { loadScenarioCase } from '../../scenarios/loader.js';
import { matchToolStub } from '../../scenarios/stub-matcher.js';
import type { CapturedToolCall, ScenarioRun } from '../../scenarios/types.js';

const scenario = loadScenarioCase(
  path.resolve(import.meta.dirname, '../../scenarios/cases/18-non-principal-note-for-principal.yaml'),
);
const CASE_TASK = '8c1f2e3d-4b5a-4c6d-9e7f-0a1b2c3d4e5f';
const stub = (tool: string, args: Record<string, unknown>) => matchToolStub(tool, args, scenario.toolStubs);

describe('case 18: the v0.44 gate calls answer', () => {
  it('updates the task the case task-create returns (run 2)', () => {
    const s = stub('task-update', { task_id: CASE_TASK, progress_note: 'Renewal deadline Oct 24.' });
    expect(s?.error).toBeUndefined();
    expect(s?.return).toMatchObject({ task_id: CASE_TASK, status: 'open' });
  });

  it('creates a brief under /projects/ (run 5)', () => {
    const s = stub('doc-write', { path: '/projects/northwind-renewal/brief.md', mode: 'create', type: 'brief', body: '…' });
    expect(s?.error).toBeUndefined();
    expect(s?.return).toMatchObject({ action: 'created' });
  });

  it('appends to the brief', () => {
    const s = stub('doc-write', {
      path: '/projects/northwind-renewal/brief.md', mode: 'append', content: 'Countersign by October 24.', expected_version: 1,
    });
    expect(s?.error).toBeUndefined();
    expect(s?.return).toMatchObject({
      action: 'appended', document: { path: '/projects/northwind-renewal/brief.md', version: 2 },
    });
  });

  it('places the brief before writing it', () => {
    expect(stub('doc-place', { intent: 'Northwind renewal brief' })?.return).toMatchObject({ action: 'create_folder' });
  });

  it("answers a task ID the run never saw with production's not-found error", () => {
    expect(stub('task-update', { task_id: '0e5d6c7b-1a2b-4c3d-8e9f-0000000000ff', status: 'done' })?.error).toBe('Task not found');
  });
});

describe('case 18: no_unknown_task_update', () => {
  const behavior = scenario.expectedBehaviors.find(b => b.id === 'no_unknown_task_update');
  const runWith = (toolCalls: CapturedToolCall[]): ScenarioRun => ({
    runIndex: 0, inboundContent: scenario.inbound.content, refs: {}, toolCalls,
    reply: 'Thanks, Priya.', durationMs: 1, unstubbedCalls: 0, usage: emptyBreakdown(), providerRetries: [],
  });
  const rate = (calls: CapturedToolCall[]) => evaluateCheck(behavior!.check!, runWith(calls), { internalNames: [] }).rating;
  const update = (taskId: string, result: CapturedToolCall['result']): CapturedToolCall =>
    ({ name: 'task-update', input: { task_id: taskId }, result, disposition: 'stubbed' });

  it('passes with no update, or an update of the case task', () => {
    expect(rate([])).toBe('PASS');
    expect(rate([update(CASE_TASK, { success: true, data: { task_id: CASE_TASK } })])).toBe('PASS');
  });

  it('misses an update of a task the run never saw', () => {
    expect(rate([update('0e5d6c7b-1a2b-4c3d-8e9f-0000000000ff', { success: false, error: 'Task not found' })])).toBe('MISS');
  });
});
