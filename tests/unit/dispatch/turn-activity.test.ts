// Turn activity registry (#2588). The registry answers "which other conversations' turns
// touched the same target recently", so these tests pin root resolution, the window, and the
// one-pause-per-pair rule.

import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import type { Logger } from '../../../src/logger.js';
import {
  TurnActivityRegistry,
  TURN_ACTIVITY_WINDOW_MS,
  MAX_TRACKED_ROOTS,
  type ActionTarget,
  type TaskStartInput,
} from '../../../src/dispatch/turn-activity.js';

const MIN = 60_000;
const T0 = 1_700_000_000_000;
const X: ActionTarget = { kind: 'contact', value: 'contact-x' };
const Y: ActionTarget = { kind: 'contact', value: 'contact-y' };

function setup(logger?: Logger) {
  let t = T0;
  const registry = new TurnActivityRegistry({
    logger: logger ?? pino({ level: 'silent' }),
    now: () => t,
  });
  return {
    registry,
    now: () => t,
    set: (v: number) => {
      t = v;
    },
  };
}

function start(
  registry: TurnActivityRegistry,
  id: string,
  over: Partial<TaskStartInput> = {},
) {
  return registry.taskStarted({
    taskEventId: id,
    agentId: 'coordinator',
    conversationId: `conv-${id}`,
    channelId: 'email',
    parentEventId: undefined,
    metadata: undefined,
    content: `request ${id}`,
    startedAt: T0,
    originatorContactId: null,
    originatorResolved: false,
    ...over,
  });
}

describe('TurnActivityRegistry root resolution', () => {
  it('delegated specialist maps to its coordinator root', () => {
    const { registry } = setup();
    start(registry, 'coord');
    start(registry, 'spec', {
      agentId: 'calendar',
      parentEventId: 'coord',
      metadata: { delegationOrigin: { taskEventId: 'coord' } },
    });
    expect(registry.rootOf('spec')!.rootId).toBe('coord');
    // A specialist is not a coordinator, so it never takes the coordinator slot.
    expect(registry.rootOf('coord')!.runningCoordinatorTaskId).toBe('coord');
  });

  it('late-delegation wake continues the original root', () => {
    const { registry } = setup();
    start(registry, 'coord');
    start(registry, 'spec', {
      agentId: 'calendar',
      parentEventId: 'coord',
      metadata: { delegationOrigin: { taskEventId: 'coord' } },
    });
    registry.taskEnded('coord');
    start(registry, 'wake', {
      parentEventId: 'spec',
      metadata: { lateDelegation: { specialistTaskEventId: 'spec' } },
    });
    const root = registry.rootOf('wake')!;
    expect(root.rootId).toBe('coord');
    expect(root.runningCoordinatorTaskId).toBe('wake');
    registry.taskEnded('wake');
    expect(registry.rootOf('coord')!.runningCoordinatorTaskId).toBeNull();
  });

  it('an unknown parent makes the task its own root', () => {
    const { registry } = setup();
    start(registry, 'wake', {
      parentEventId: 'gone',
      metadata: { lateDelegation: {} },
    });
    expect(registry.rootOf('wake')!.rootId).toBe('wake');
  });

  it('root stays running while a detached specialist runs', () => {
    const { registry, set } = setup();
    start(registry, 'coord');
    start(registry, 'spec', {
      agentId: 'calendar',
      parentEventId: 'coord',
      metadata: { delegationOrigin: { taskEventId: 'coord' } },
    });
    registry.taskEnded('coord');
    expect(registry.rootOf('coord')!.endedAt).toBeNull();
    set(T0 + 5_000);
    registry.taskEnded('spec');
    expect(registry.rootOf('coord')!.endedAt).toBe(T0 + 5_000);
  });

  it('stores the request text for a root only, stripped and clipped by code points', () => {
    const { registry } = setup();
    const preamble = '[ACTIVE OUTBOUND CONTEXT]\nblock\n---\n\n';
    const root = start(registry, 'coord', { content: `${preamble}hello` });
    expect(root.requestText).toBe('hello');
    const long = start(registry, 'long', { content: '😀'.repeat(600) });
    expect(Array.from(long.requestText!)).toHaveLength(500);
    start(registry, 'spec', {
      agentId: 'calendar',
      parentEventId: 'coord',
      metadata: { delegationOrigin: { taskEventId: 'coord' } },
      content: 'specialist payload',
    });
    expect(registry.rootOf('coord')!.requestText).toBe('hello');
  });

  it('unresolved originator is stored unresolved', () => {
    const { registry } = setup();
    const root = start(registry, 'a', {
      originatorContactId: 'raw-sender',
      originatorResolved: false,
    });
    expect(root.originatorResolved).toBe(false);
    expect(root.originatorContactId).toBe('raw-sender');
    expect(root.audienceOneToOne).toBe(false);
    expect(root.inboundScanFindings).toBeNull();
  });

  it('public snapshots cannot mutate registry state', () => {
    const { registry } = setup();
    const root = start(registry, 'a');
    (root.runningTaskIds as Set<string>).add('forged');
    expect(registry.rootOf('a')!.runningTaskIds.has('forged')).toBe(false);
  });
});

describe('TurnActivityRegistry.checkAndRecord', () => {
  function overlapping() {
    const ctx = setup();
    start(ctx.registry, 'A');
    start(ctx.registry, 'B');
    return ctx;
  }

  it('first caller wins on a shared target', () => {
    const { registry } = overlapping();
    expect(registry.checkAndRecord('A', 'email-send', [X])).toEqual({ held: false });
    const decision = registry.checkAndRecord('B', 'email-send', [X]);
    expect(decision.held).toBe(true);
    if (decision.held) {
      expect(decision.matches).toHaveLength(1);
      expect(decision.matches[0]!.action.rootId).toBe('A');
      expect(decision.matches[0]!.other.rootId).toBe('A');
      expect(decision.matches[0]!.target).toEqual(X);
    }
    expect(registry.actionsOf('B')).toHaveLength(0);
  });

  it('re-issued call proceeds', () => {
    const { registry } = overlapping();
    registry.checkAndRecord('A', 'email-send', [X]);
    registry.checkAndRecord('B', 'email-send', [X]);
    expect(registry.checkAndRecord('B', 'email-send', [X])).toEqual({ held: false });
    expect(registry.actionsOf('B')).toHaveLength(1);
  });

  it('one pause per pair', () => {
    const { registry } = overlapping();
    registry.checkAndRecord('A', 'email-send', [X]);
    expect(registry.checkAndRecord('B', 'email-send', [X]).held).toBe(true);
    registry.checkAndRecord('A', 'email-send', [X]);
    expect(registry.checkAndRecord('B', 'email-send', [X])).toEqual({ held: false });
  });

  it('different targets never hold', () => {
    const { registry } = overlapping();
    expect(registry.checkAndRecord('A', 'email-send', [X])).toEqual({ held: false });
    expect(registry.checkAndRecord('B', 'email-send', [Y])).toEqual({ held: false });
  });

  it('same value with a different kind is a different target', () => {
    const { registry } = overlapping();
    registry.checkAndRecord('A', 'email-send', [{ kind: 'contact', value: 'v' }]);
    expect(registry.checkAndRecord('B', 'x', [{ kind: 'id', value: 'v' }])).toEqual({ held: false });
  });

  it('a task never matches its own root', () => {
    const { registry } = setup();
    start(registry, 'A');
    registry.checkAndRecord('A', 'email-send', [X]);
    expect(registry.checkAndRecord('A', 'email-send', [X])).toEqual({ held: false });
  });

  it('finished root within 15 minutes still counts', () => {
    const { registry, set } = setup();
    start(registry, 'A');
    registry.checkAndRecord('A', 'email-send', [X]);
    set(T0 + 1_000);
    registry.taskEnded('A');
    const endedAt = T0 + 1_000;

    set(endedAt + 14 * MIN);
    start(registry, 'B', { startedAt: endedAt + 14 * MIN });
    expect(registry.checkAndRecord('B', 'email-send', [X]).held).toBe(true);

    set(endedAt + 16 * MIN);
    start(registry, 'C', { startedAt: endedAt + 16 * MIN });
    expect(registry.checkAndRecord('C', 'email-send', [X])).toEqual({ held: false });
  });

  it('root that started after mine counts', () => {
    const { registry } = setup();
    start(registry, 'B');
    start(registry, 'A', { startedAt: T0 + 1_000 });
    registry.checkAndRecord('A', 'email-send', [X]);
    expect(registry.checkAndRecord('B', 'email-send', [X]).held).toBe(true);
  });

  it('unknown task id records nothing', () => {
    const { registry } = overlapping();
    expect(registry.checkAndRecord('nope', 'email-send', [X])).toEqual({ held: false });
    expect(registry.actionsOf('nope')).toHaveLength(0);
    expect(registry.actionsOf('A')).toHaveLength(0);
  });

  it('ensureRoot registers an auto root that counts and is idempotent', () => {
    const { registry } = setup();
    start(registry, 'A');
    const seed = {
      conversationId: 'voice-1',
      channelId: 'voice',
      agentId: 'coordinator',
      originatorContactId: null,
      originatorResolved: false,
    };
    const root = registry.ensureRoot('voice-1', seed);
    expect(root.autoRegistered).toBe(true);
    expect(root.endedAt).toBeNull();
    expect(registry.ensureRoot('voice-1', seed).rootId).toBe('voice-1');
    registry.checkAndRecord('voice-1', 'email-send', [X]);
    expect(registry.checkAndRecord('A', 'email-send', [X]).held).toBe(true);
    expect(registry.otherRootsInWindow('A').map((r) => r.rootId)).toEqual(['voice-1']);
  });

  it('prunes an auto root a window after its last action', () => {
    const { registry, set } = setup();
    registry.ensureRoot('voice-1', {
      conversationId: 'v', channelId: 'voice', agentId: 'coordinator',
      originatorContactId: null, originatorResolved: false,
    });
    registry.checkAndRecord('voice-1', 'email-send', [X]);
    set(T0 + TURN_ACTIVITY_WINDOW_MS + 1);
    start(registry, 'B', { startedAt: T0 + TURN_ACTIVITY_WINDOW_MS + 1 });
    expect(registry.rootOf('voice-1')).toBeUndefined();
    expect(registry.actionsOf('voice-1')).toHaveLength(0);
  });

  it('caps evict oldest ended roots with a warn', () => {
    const warn = vi.fn();
    const logger = { warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() } as unknown as Logger;
    const { registry, set } = setup(logger);
    for (let i = 0; i < MAX_TRACKED_ROOTS; i++) {
      set(T0 + i);
      start(registry, `r${i}`, { startedAt: T0 + i });
      registry.taskEnded(`r${i}`);
    }
    expect(warn).not.toHaveBeenCalled();
    set(T0 + MAX_TRACKED_ROOTS);
    start(registry, 'extra', { startedAt: T0 + MAX_TRACKED_ROOTS });
    expect(registry.rootOf('r0')).toBeUndefined();
    expect(registry.rootOf('r1')).toBeDefined();
    expect(registry.rootOf('extra')).toBeDefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatchObject({ evicted: 1 });
  });
});
