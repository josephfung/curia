// Smoke's tool stubs (#1956): a matching stub answers any agent's call; anything else
// runs for real (smoke runs on a throwaway database copy). Stubs belong to the case the
// call was made in (#1980), so concurrent cases never answer or record each other's calls.
import { describe, expect, it, vi } from 'vitest';
import type { ExecutionLayer } from '../../../src/skills/execution.js';
import { createCaseContext } from '../../shared/case-scope.js';
import { createSmokeStubs as createStubsIn, mergeStubs, newSmokeCase, type SmokeCaseState } from '../../smoke/stub-layer.js';

/**
 * Stubs bound to a context, with one case already entered for the rest of the test, so
 * the single-case tests below read as before. The concurrency tests make their own.
 */
function createSmokeStubs(): ReturnType<typeof createStubsIn> {
  const context = createCaseContext<SmokeCaseState>();
  const state = newSmokeCase('test case');
  const stubs = createStubsIn(context);
  // Each method runs inside the case. The async body runs synchronously up to its first
  // await (there is none), so `result` is set before run() returns.
  const inCase = <A extends unknown[], R>(fn: (...args: A) => R) => (...args: A): R => {
    let result!: R;
    void context.run(state, async () => { result = fn(...args); });
    return result;
  };
  return {
    wrap: (layer) => {
      const wrapped = stubs.wrap(layer);
      return new Proxy(wrapped, {
        get(target, prop, receiver) {
          if (prop === 'invoke') {
            return (...args: Parameters<ExecutionLayer['invoke']>) => context.run(state, () => target.invoke(...args));
          }
          return Reflect.get(target, prop, receiver);
        },
      });
    },
    set: inCase(stubs.set),
    answer: inCase(stubs.answer),
    clear: inCase(stubs.clear),
    get orphanCalls() { return stubs.orphanCalls; },
  };
}

function realLayer(): { layer: ExecutionLayer; invoke: ReturnType<typeof vi.fn> } {
  const invoke = vi.fn(async () => ({ success: true, data: 'real' }));
  const layer = { invoke, describe: () => 'real layer' } as unknown as ExecutionLayer;
  return { layer, invoke };
}

const opts = (agentId: string) => ({ agentId, conversationId: 'c', parentEventId: 'e' });

describe('createSmokeStubs', () => {
  it('answers a matching call from any agent without running the real tool', async () => {
    const { layer, invoke } = realLayer();
    const stubs = createSmokeStubs();
    const wrapped = stubs.wrap(layer);
    stubs.set({ 'calendar-list-calendars': [{ match: { contactId: 'p1' }, return: { calendars: ['work'] } }] });

    const result = await wrapped.invoke('calendar-list-calendars', { contactId: 'p1' }, undefined as never, opts('calendar') as never);
    expect(result).toEqual({ success: true, data: { calendars: ['work'] } });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('returns a stubbed error in the skill_error envelope', async () => {
    const stubs = createSmokeStubs();
    const wrapped = stubs.wrap(realLayer().layer);
    stubs.set({ 'scheduler-list': [{ match: {}, error: 'down' }] });
    expect(await wrapped.invoke('scheduler-list', {}, undefined as never, opts('coordinator') as never))
      .toEqual({ success: false, error: '<skill_error>down</skill_error>' });
  });

  it('runs an unstubbed call for real', async () => {
    const { layer, invoke } = realLayer();
    const stubs = createSmokeStubs();
    const wrapped = stubs.wrap(layer);
    stubs.set({ 'calendar-list-events': [{ match: { date: 'other' }, return: [] }] });
    expect(await wrapped.invoke('calendar-list-events', { date: 'x' }, undefined as never, opts('calendar') as never))
      .toEqual({ success: true, data: 'real' });
    expect(invoke).toHaveBeenCalledOnce();
  });

  // The harness answers reads of a targeted case's thread at call time (#1977).
  it('tries call-time answers before the stubs, across set(), until clear()', async () => {
    const { layer, invoke } = realLayer();
    const stubs = createSmokeStubs();
    const wrapped = stubs.wrap(layer);
    // Answers see the calling agent, so they can decline another agent's call.
    stubs.answer('bullpen', async (input, agentId) =>
      input['thread_id'] === 't1' && agentId === 'ceo-inbox' ? { success: true, data: { thread_id: 't1' } } : undefined);
    stubs.set({ bullpen: [{ match: {}, return: 'stubbed' }] });

    expect(await wrapped.invoke('bullpen', { action: 'get_thread', thread_id: 't1' }, undefined as never, opts('ceo-inbox') as never))
      .toEqual({ success: true, data: { thread_id: 't1' } });
    // An answer that passes leaves the call to the stubs: another thread, or another agent.
    expect(await wrapped.invoke('bullpen', { action: 'get_thread', thread_id: 't2' }, undefined as never, opts('ceo-inbox') as never))
      .toEqual({ success: true, data: 'stubbed' });
    expect(await wrapped.invoke('bullpen', { action: 'get_thread', thread_id: 't1' }, undefined as never, opts('calendar') as never))
      .toEqual({ success: true, data: 'stubbed' });
    expect(stubs.clear().map(c => c.disposition)).toEqual(['stubbed', 'stubbed', 'stubbed']);

    await wrapped.invoke('bullpen', { action: 'get_thread', thread_id: 't1' }, undefined as never, opts('ceo-inbox') as never);
    expect(invoke).toHaveBeenCalledOnce();
  });

  it('records every call and clears the record and the stubs', async () => {
    const stubs = createSmokeStubs();
    const wrapped = stubs.wrap(realLayer().layer);
    stubs.set({ a: [{ match: {}, return: 1 }] });
    await wrapped.invoke('a', { x: 1 }, undefined as never, opts('calendar') as never);
    await wrapped.invoke('b', {}, undefined as never, opts('coordinator') as never);

    expect(stubs.clear()).toEqual([
      { agentId: 'calendar', toolName: 'a', input: { x: 1 }, disposition: 'stubbed', success: true },
      { agentId: 'coordinator', toolName: 'b', input: {}, disposition: 'real', success: true },
    ]);
    // Stubs are gone too: the next case starts from nothing.
    await wrapped.invoke('a', {}, undefined as never, opts('calendar') as never);
    expect(stubs.clear()[0]!.disposition).toBe('real');
  });

  it('hands out a copy of the fixture, so a mutation cannot leak into a later call', async () => {
    const stubs = createSmokeStubs();
    const wrapped = stubs.wrap(realLayer().layer);
    stubs.set({ a: [{ match: {}, return: { list: [1] } }] });
    const first = await wrapped.invoke('a', {}, undefined as never, opts('x') as never);
    ((first as { data: { list: number[] } }).data.list).push(2);
    expect(await wrapped.invoke('a', {}, undefined as never, opts('x') as never)).toEqual({ success: true, data: { list: [1] } });
  });

  it('delegates everything other than invoke to the real layer', () => {
    const stubs = createSmokeStubs();
    expect((stubs.wrap(realLayer().layer) as unknown as { describe(): string }).describe()).toBe('real layer');
  });
});

describe('mergeStubs', () => {
  it('tries the turn\'s stubs before the case\'s for the same tool', () => {
    const merged = mergeStubs(
      { a: [{ match: {}, return: 'turn' }] },
      { a: [{ match: {}, return: 'case' }], b: [{ match: {}, return: 'b' }] },
    );
    expect(merged['a']!.map(s => s.return)).toEqual(['turn', 'case']);
    expect(merged['b']!.map(s => s.return)).toEqual(['b']);
  });

  it('uses the case\'s stubs when the turn has none, then the shared defaults', () => {
    const merged = mergeStubs(undefined, { a: [{ match: {}, return: 'case' }] }, { a: [{ match: {}, return: 'office' }], b: [{ match: {}, return: 'office' }] });
    expect(merged['a']!.map(s => s.return)).toEqual(['case', 'office']);
    expect(merged['b']!.map(s => s.return)).toEqual(['office']);
  });

  it('shapes a stubbed result for the call (time range, echoed inputs)', async () => {
    const stubs = createSmokeStubs();
    const wrapped = stubs.wrap(realLayer().layer);
    stubs.set({ 'calendar-create-event': [{ match: {}, return: { event: { title: '{{input:title}}' } } }] });
    expect(await wrapped.invoke('calendar-create-event', { title: 'Roadmap' }, undefined as never, opts('calendar') as never))
      .toEqual({ success: true, data: { event: { id: 'evt-created-1', title: 'Roadmap' } } });
  });
});

describe('calendar writes within a case', () => {
  it('are visible to later reads in the same case, and forgotten after clear()', async () => {
    const stubs = createSmokeStubs();
    const wrapped = stubs.wrap(realLayer().layer);
    const fixture = {
      'calendar-create-event': [{ match: {}, return: { event: { title: '{{input:title}}', startTime: '{{input:start}}', endTime: '{{input:end}}' } } }],
      'calendar-list-events': [{ match: {}, return: { events: [] } }],
    };
    stubs.set(fixture);
    await wrapped.invoke('calendar-create-event', { title: 'Block', start: '2026-10-07T06:30:00-04:00', end: '2026-10-07T08:00:00-04:00' }, undefined as never, opts('calendar') as never);
    const read = await wrapped.invoke('calendar-list-events', {}, undefined as never, opts('calendar') as never) as { data: { count: number } };
    expect(read.data.count).toBe(1);

    stubs.clear();
    stubs.set(fixture);
    const next = await wrapped.invoke('calendar-list-events', {}, undefined as never, opts('calendar') as never) as { data: { count: number } };
    expect(next.data.count).toBe(0);
  });
});

describe('scheduler, task and draft writes within a case', () => {
  const JOB = '0f0f0f0f-0000-4000-8000-000000000001';

  it('replays an edit onto a turn listing, and forgets it after clear()', async () => {
    const { layer, invoke } = realLayer();
    const stubs = createSmokeStubs();
    const wrapped = stubs.wrap(layer);
    const office = {
      'scheduler-create': [{ match: {}, return: { jobId: JOB } }],
      'scheduler-update': [{ match: {}, return: { jobId: '{{input:job_id}}', action: '{{input:action}}' } }],
      'scheduler-list': [{ match: {}, return: { jobs: [], count: 0, truncated: false, limit: 50 } }],
      'ceo-inbox-read': [{ match: {}, error: 'Message not found in this mailbox.' }],
      'ceo-inbox-draft-compose': [{ match: {}, return: { draft_id: 'draft-0002', subject: '{{input:subject}}', to: '{{input:to}}', cc: [] } }],
      'ceo-inbox-draft-edit': [{ match: {}, return: { draft_id: '{{input:draft_id}}' } }],
    };
    stubs.set(office);
    await wrapped.invoke('scheduler-create', { task: 'Scan investor mail', cron_expr: '0 9 * * 1-5' }, undefined as never, opts('coordinator') as never);

    // The next turn scripts the job at 9am. That listing is the base; the edit replays onto it.
    stubs.set({
      ...office,
      'scheduler-list': [{
        match: {},
        return: { jobs: [{ id: JOB, status: 'active', cronExpr: '0 9 * * 1-5', taskTitle: 'Investor check' }], count: 1, truncated: false, limit: 50 },
      }],
    });
    const before = await wrapped.invoke('scheduler-list', {}, undefined as never, opts('coordinator') as never) as { data: { jobs: Array<{ cronExpr: string }> } };
    expect(before.data.jobs.map(job => job.cronExpr)).toEqual(['0 9 * * 1-5']);
    await wrapped.invoke('scheduler-update', { job_id: JOB, action: 'edit', cron_expr: '0 10 * * 1-5' }, undefined as never, opts('coordinator') as never);
    const after = await wrapped.invoke('scheduler-list', {}, undefined as never, opts('coordinator') as never) as { data: { jobs: Array<{ cronExpr: string; status: string; taskTitle: string }> } };
    expect(after.data.jobs).toEqual([expect.objectContaining({ cronExpr: '0 10 * * 1-5', status: 'active', taskTitle: 'Investor check' })]);

    // A turn stub with no jobs array is the scripted answer. The replay does not rewrite it.
    stubs.set({ ...office, 'scheduler-list': [{ match: {}, return: { note: 'frozen' } }] });
    expect(await wrapped.invoke('scheduler-list', {}, undefined as never, opts('coordinator') as never))
      .toEqual({ success: true, data: { note: 'frozen' } });

    await wrapped.invoke('ceo-inbox-draft-compose', { subject: 'Hello', to: ['maya@techto.example'], body: 'Tuesday.' }, undefined as never, opts('ceo-inbox') as never);
    await wrapped.invoke('ceo-inbox-draft-edit', { draft_id: 'draft-0002', body: 'Wednesday.' }, undefined as never, opts('ceo-inbox') as never);
    expect(await wrapped.invoke('ceo-inbox-read', { draft_id: 'draft-0002' }, undefined as never, opts('ceo-inbox') as never))
      .toEqual({ success: true, data: expect.objectContaining({ id: 'draft-0002', is_draft: true, body_plain: 'Wednesday.', subject: 'Hello' }) });
    expect(invoke).not.toHaveBeenCalled();

    // A turn stub that names draft_id overrides the recorded draft.
    stubs.set({
      ...office,
      'ceo-inbox-read': [{ match: { draft_id: 'draft-0002' }, return: { id: 'draft-0002', body_plain: 'scripted' } }],
    });
    expect(await wrapped.invoke('ceo-inbox-read', { draft_id: 'draft-0002' }, undefined as never, opts('ceo-inbox') as never))
      .toEqual({ success: true, data: { id: 'draft-0002', body_plain: 'scripted' } });

    stubs.clear();
    stubs.set(office);
    expect(await wrapped.invoke('scheduler-list', {}, undefined as never, opts('coordinator') as never))
      .toEqual({ success: true, data: { jobs: [], count: 0, truncated: false, limit: 50 } });
    expect(await wrapped.invoke('ceo-inbox-read', { draft_id: 'draft-0002' }, undefined as never, opts('ceo-inbox') as never))
      .toEqual({ success: false, error: '<skill_error>Message not found in this mailbox.</skill_error>' });
  });

  it('keeps each case\'s scheduler writes to itself', async () => {
    const context = createCaseContext<SmokeCaseState>();
    const stubs = createStubsIn(context);
    const wrapped = stubs.wrap(realLayer().layer);
    const fixture = {
      'scheduler-create': [{ match: {}, return: { jobId: JOB } }],
      'scheduler-list': [{ match: {}, return: { jobs: [], count: 0 } }],
    };
    const call = (tool: string, input: Record<string, unknown>) => wrapped.invoke(tool, input, undefined as never, { agentId: 'coordinator' } as never);
    const a = newSmokeCase('A');
    const b = newSmokeCase('B');
    await context.run(a, async () => { stubs.set(fixture); await call('scheduler-create', { task: 'A only', cron_expr: '0 9 * * 1' }); });
    await context.run(b, async () => { stubs.set(fixture); });
    const titles = (state: SmokeCaseState) => context.run(state, async () =>
      (await call('scheduler-list', {}) as { data: { jobs: Array<{ taskPreview: string | null }> } }).data.jobs.map(job => job.taskPreview));
    expect(await titles(a)).toEqual(['A only']);
    expect(await titles(b)).toEqual([]);
  });
});

describe('concurrent cases (#1980)', () => {
  const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 1));

  it('answer and record each call from its own case\'s stubs, interleaved', async () => {
    const { layer } = realLayer();
    const context = createCaseContext<SmokeCaseState>();
    const stubs = createStubsIn(context);
    const wrapped = stubs.wrap(layer);
    const a = newSmokeCase('A');
    const b = newSmokeCase('B');

    const run = (state: SmokeCaseState, who: string) => context.run(state, async () => {
      stubs.set({ 'scheduler-list': [{ match: {}, return: { jobs: [who] } }] });
      const answers: unknown[] = [];
      for (let i = 0; i < 3; i++) {
        // Yield between calls so the two cases' calls interleave.
        await tick();
        const agent = i === 1 ? 'calendar' : 'coordinator'; // a delegated specialist too
        answers.push(await wrapped.invoke('scheduler-list', {}, undefined as never, { agentId: agent, conversationId: `${who}-${i}` } as never));
      }
      return { answers, calls: stubs.clear() };
    });

    const [ra, rb] = await Promise.all([run(a, 'A'), run(b, 'B')]);
    expect(ra.answers.every(r => JSON.stringify(r) === JSON.stringify({ success: true, data: { jobs: ['A'] } }))).toBe(true);
    expect(rb.answers.every(r => JSON.stringify(r) === JSON.stringify({ success: true, data: { jobs: ['B'] } }))).toBe(true);
    expect(ra.calls).toHaveLength(3);
    expect(rb.calls).toHaveLength(3);
    expect(ra.calls.map(c => c.agentId)).toEqual(['coordinator', 'calendar', 'coordinator']);
  });

  it('keep each case\'s calendar writes to itself', async () => {
    const context = createCaseContext<SmokeCaseState>();
    const stubs = createStubsIn(context);
    const wrapped = stubs.wrap(realLayer().layer);
    const fixture = {
      'calendar-create-event': [{ match: {}, return: { event: { title: '{{input:title}}' } } }],
      'calendar-list-events': [{ match: {}, return: { events: [] } }],
    };
    const call = (tool: string, input: Record<string, unknown>) => wrapped.invoke(tool, input, undefined as never, { agentId: 'calendar' } as never);
    const a = newSmokeCase('A');
    const b = newSmokeCase('B');
    await context.run(a, async () => { stubs.set(fixture); await call('calendar-create-event', { title: 'A only' }); });
    await context.run(b, async () => { stubs.set(fixture); });

    const listed = (state: SmokeCaseState) => context.run(state, async () =>
      (await call('calendar-list-events', {}) as { data: { events: Array<{ title: string }> } }).data.events.map(e => e.title));
    expect(await listed(a)).toEqual(['A only']);
    expect(await listed(b)).toEqual([]);
  });

  it('refuse a cancelled case\'s calls without running or recording them', async () => {
    const { layer, invoke } = realLayer();
    const context = createCaseContext<SmokeCaseState>();
    const stubs = createStubsIn(context);
    const wrapped = stubs.wrap(layer);
    const state = newSmokeCase('timed out');
    state.cancelled = true;
    const result = await context.run(state, () => wrapped.invoke('web-fetch', {}, undefined as never, { agentId: 'research' } as never));
    expect(result).toEqual({ success: false, error: expect.stringContaining('passed its timeout') });
    expect(invoke).not.toHaveBeenCalled();
    expect(state.calls).toEqual([]);
  });

  it('run a call made outside every case for real, and count it', async () => {
    const { layer, invoke } = realLayer();
    const stubs = createStubsIn(createCaseContext<SmokeCaseState>());
    await stubs.wrap(layer).invoke('a', {}, undefined as never, { agentId: 'x' } as never);
    expect(invoke).toHaveBeenCalledOnce();
    expect(stubs.orphanCalls).toBe(1);
    expect(() => stubs.set({})).toThrow(/outside a case/);
  });
});
