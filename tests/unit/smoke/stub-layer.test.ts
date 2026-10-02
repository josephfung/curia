// Smoke's tool stubs (#1956): a matching stub answers any agent's call; anything else
// runs for real (smoke runs on a throwaway database copy).
import { describe, expect, it, vi } from 'vitest';
import type { ExecutionLayer } from '../../../src/skills/execution.js';
import { createSmokeStubs, mergeStubs } from '../../smoke/stub-layer.js';

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
      .toEqual({ success: true, data: { event: { title: 'Roadmap' } } });
  });
});
