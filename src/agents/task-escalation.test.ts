// task-escalation.test.ts — structured, principal-facing escalation payloads (#1267).

import { describe, it, expect } from 'vitest';
import {
  buildCircuitBreachEscalation,
  buildDelegationEscalation,
  renderEscalation,
} from './task-escalation.js';
import type { CircuitBreach } from './resumable-circuit-breaker.js';
import type { TaskRow } from '../db/queries/tasks.js';

const NOW = new Date('2026-06-01T01:00:00.000Z');

function makeTask(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: 'task-1',
    agentId: 'social-media',
    intentAnchor: 'audit follows',
    status: 'in_progress',
    progress: {},
    errorBudget: {},
    conversationId: null,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    title: 'Audit 1300 follows',
    description: null,
    owner: 'curia',
    waitingOnContactId: null,
    waitingOnText: null,
    parentTaskId: null,
    blockedByTaskId: null,
    priority: 50,
    dueAt: null,
    source: 'coordinator',
    sourceAgentId: 'social-media',
    createdBy: 'coordinator',
    tags: ['resumable'],
    originator: null,
    ...overrides,
  };
}

const RESUMABLE_BLOCK = {
  cursor: 'page:3',
  done: 25,
  total: 1300,
  accumulator: [],
  lastSliceUnits: 12,
  next: 'Review page 4',
};

const PLAN_BLOCK = {
  steps: [
    { id: 's1', taskId: '11111111-1111-1111-1111-111111111111' },
    { id: 's2', taskId: null },
    { id: 's3', taskId: null },
  ],
  deliverableStepId: null,
  done: 1,
  total: 3,
  next: 'kick off s2',
};

function breach(reason: CircuitBreach['reason'], overrides: Partial<CircuitBreach['state']> = {}): CircuitBreach {
  return {
    reason,
    message: `circuit breach: ${reason}`,
    state: {
      stallCount: 3,
      iterationCount: 8,
      startedAt: '2026-06-01T00:00:00.000Z',
      totalCostUsd: 10.5432,
      lastProgress: { done: 25, cursor: 'page:3' },
      ...overrides,
    },
  };
}

describe('buildCircuitBreachEscalation (#1267)', () => {
  it('maps a resumable-leaf stall to failureMode=stalled with throughput + progress', () => {
    const task = makeTask({ progress: { resumable: RESUMABLE_BLOCK } });
    const e = buildCircuitBreachEscalation(task, breach('stall_limit'), NOW);

    expect(e.failureMode).toBe('stalled');
    expect(e.reason).toBe('stall_limit');
    expect(e.source).toBe('resumable_leaf');
    expect(e.progress).toEqual({ done: 25, total: 1300 });
    expect(e.throughput?.estimateAvailable).toBe(true);
    expect(e.throughput?.unitsPerSlice).toBeCloseTo(25 / 8);
    expect(e.costUsd).toBeCloseTo(10.5432);
    expect(e.suggestedActions.length).toBeGreaterThan(0);
  });

  it('maps any ceiling breach (cost/time/attempts) to failureMode=ceiling', () => {
    const task = makeTask({ progress: { resumable: RESUMABLE_BLOCK } });
    expect(buildCircuitBreachEscalation(task, breach('max_cost'), NOW).failureMode).toBe('ceiling');
    expect(buildCircuitBreachEscalation(task, breach('max_wallclock'), NOW).failureMode).toBe('ceiling');
    expect(buildCircuitBreachEscalation(task, breach('max_iterations'), NOW).failureMode).toBe('ceiling');
  });

  it('maps a planned parent (progress.plan present) to source=planned_parent with X-of-Y and no throughput', () => {
    const task = makeTask({ progress: { plan: PLAN_BLOCK } });
    const e = buildCircuitBreachEscalation(task, breach('stall_limit'), NOW);

    expect(e.source).toBe('planned_parent');
    expect(e.progress).toEqual({ done: 1, total: 3 });
    expect(e.throughput).toBeUndefined();
  });

  it('degrades gracefully on cold start (done=0): throughput omitted, no divide-by-zero', () => {
    const task = makeTask({
      progress: { resumable: { ...RESUMABLE_BLOCK, done: 0, lastSliceUnits: 0 } },
    });
    const e = buildCircuitBreachEscalation(task, breach('stall_limit', { lastProgress: { done: 0, cursor: null } }), NOW);

    expect(e.progress).toEqual({ done: 0, total: 1300 });
    expect(e.throughput).toBeUndefined();
  });
});

describe('buildDelegationEscalation (#1267)', () => {
  it('maps reason=blocked to failureMode=blocked_on_human', () => {
    const e = buildDelegationEscalation({
      agent: 'research',
      reason: 'blocked',
      retryable: false,
      message: 'needs the CEO to pick a vendor',
      task: 'choose a CRM vendor',
    });

    expect(e.failureMode).toBe('blocked_on_human');
    expect(e.source).toBe('delegation');
    expect(e.progress).toBeUndefined();
    expect(e.throughput).toBeUndefined();
    expect(e.suggestedActions.length).toBeGreaterThan(0);
  });

  it('maps any other non-retryable reason to failureMode=agent_incomplete with the agent as blocker', () => {
    const e = buildDelegationEscalation({
      agent: 'research',
      reason: 'maxTurns',
      retryable: false,
      message: 'ran out of turns mid-audit',
      task: 'audit 1300 follows',
    });

    expect(e.failureMode).toBe('agent_incomplete');
    expect(e.reason).toBe('maxTurns');
    expect(e.blocker).toBe('research');
  });
});

describe('renderEscalation (#1267)', () => {
  it('renders a stalled leaf: progress note carries X-of-Y, throughput, and suggested actions', () => {
    const task = makeTask({ progress: { resumable: RESUMABLE_BLOCK } });
    const r = renderEscalation(buildCircuitBreachEscalation(task, breach('stall_limit'), NOW));

    expect(r.progressNote).toContain('25 of 1300');
    expect(r.progressNote.toLowerCase()).toContain('stall');
    expect(r.progressNote).toMatch(/units\/slice|ETA/);
    expect(r.progressNote.toLowerCase()).toContain('suggested');
    // Coordinator poke must keep the no-blind-retry instruction.
    expect(r.notifyContent).toContain('Do not re-delegate');
  });

  it('renders a cost-ceiling breach: mentions the cost and a resume-or-cancel action', () => {
    const task = makeTask({ progress: { resumable: RESUMABLE_BLOCK } });
    const r = renderEscalation(buildCircuitBreachEscalation(task, breach('max_cost'), NOW));

    expect(r.progressNote.toLowerCase()).toContain('cost');
    expect(r.progressNote).toContain('$10.54');
    expect(r.description.toLowerCase()).toMatch(/resume|cancel/);
  });

  it('renders a blocked-on-human escalation: names the person-wait and suggests a nudge/answer', () => {
    const r = renderEscalation(
      buildDelegationEscalation({
        agent: 'research',
        reason: 'blocked',
        retryable: false,
        message: 'needs the CEO to pick a vendor',
        task: 'choose a CRM vendor',
      }),
    );

    expect(r.progressNote.toLowerCase()).toContain('blocked');
    expect(r.description.toLowerCase()).toMatch(/nudge|answer|cancel/);
  });

  it('renders an agent-incomplete escalation: names the agent and the reason', () => {
    const r = renderEscalation(
      buildDelegationEscalation({
        agent: 'research',
        reason: 'maxTurns',
        retryable: false,
        message: 'ran out of turns mid-audit',
        task: 'audit 1300 follows',
      }),
    );

    expect(r.progressNote).toContain('research');
    expect(r.description).toContain('maxTurns');
  });

  it('omits the throughput line when no estimate is available (cold start)', () => {
    const task = makeTask({
      progress: { resumable: { ...RESUMABLE_BLOCK, done: 0, lastSliceUnits: 0 } },
    });
    const r = renderEscalation(
      buildCircuitBreachEscalation(task, breach('stall_limit', { lastProgress: { done: 0, cursor: null } }), NOW),
    );

    expect(r.progressNote).not.toContain('units/slice');
  });

  it('states each figure exactly once — no headline/dedicated-line duplication', () => {
    const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;
    const task = makeTask({ progress: { resumable: RESUMABLE_BLOCK } });

    // max_cost is the worst case — the old headline + Cost-so-far + blocker said "$10.54" thrice.
    const cost = renderEscalation(buildCircuitBreachEscalation(task, breach('max_cost'), NOW));
    expect(occurrences(cost.progressNote, '$10.54')).toBe(1);
    expect(occurrences(cost.progressNote, '25 of 1300')).toBe(1);
    expect(occurrences(cost.description, '$10.54')).toBe(1);
    expect(occurrences(cost.description, '25 of 1300')).toBe(1);

    // Stalled leaf — the X-of-Y must not appear in both the headline and the Progress line.
    const stalled = renderEscalation(buildCircuitBreachEscalation(task, breach('stall_limit'), NOW));
    expect(occurrences(stalled.progressNote, '25 of 1300')).toBe(1);
  });
});
