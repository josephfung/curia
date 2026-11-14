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
  MAX_TRACKED_ACTIONS,
  MAX_ACTIONS_PER_ROOT,
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
  return startRoot(registry, id, over);
}

function startRoot(
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
    // Resolved by default: an unresolved root's actions hold no one (see the disclosure tests).
    originatorContactId: 'contact-p',
    originatorResolved: true,
    ...over,
  });
}

/** A resolved voice seed for ensureRoot. */
const VOICE_SEED = {
  channelId: 'voice',
  agentId: 'coordinator',
  originatorContactId: 'contact-p',
  originatorResolved: true,
};

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
    expect(registry.checkAndRecord('A', 'email-send', [X])).toMatchObject({ held: false });
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
    expect(registry.checkAndRecord('B', 'email-send', [X])).toMatchObject({ held: false });
    expect(registry.actionsOf('B')).toHaveLength(1);
  });

  it('one pause per pair', () => {
    const { registry } = overlapping();
    registry.checkAndRecord('A', 'email-send', [X]);
    expect(registry.checkAndRecord('B', 'email-send', [X]).held).toBe(true);
    registry.checkAndRecord('A', 'email-send', [X]);
    expect(registry.checkAndRecord('B', 'email-send', [X])).toMatchObject({ held: false });
  });

  it('different targets never hold', () => {
    const { registry } = overlapping();
    expect(registry.checkAndRecord('A', 'email-send', [X])).toMatchObject({ held: false });
    expect(registry.checkAndRecord('B', 'email-send', [Y])).toMatchObject({ held: false });
  });

  it('same value with a different kind is a different target', () => {
    const { registry } = overlapping();
    registry.checkAndRecord('A', 'email-send', [{ kind: 'contact', value: 'v' }]);
    expect(registry.checkAndRecord('B', 'x', [{ kind: 'id', value: 'v' }])).toMatchObject({ held: false });
  });

  it('a task never matches its own root', () => {
    const { registry } = setup();
    start(registry, 'A');
    registry.checkAndRecord('A', 'email-send', [X]);
    expect(registry.checkAndRecord('A', 'email-send', [X])).toMatchObject({ held: false });
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
    expect(registry.checkAndRecord('C', 'email-send', [X])).toMatchObject({ held: false });
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
    expect(registry.checkAndRecord('nope', 'email-send', [X])).toMatchObject({ held: false });
    expect(registry.actionsOf('nope')).toHaveLength(0);
    expect(registry.actionsOf('A')).toHaveLength(0);
  });

  it('ensureRoot registers an auto root that counts and is idempotent', () => {
    const { registry } = setup();
    start(registry, 'A');
    const seed = { conversationId: 'voice-1', ...VOICE_SEED };
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

  it('reports the most recent action per pair in a held decision', () => {
    const { registry, set } = setup();
    start(registry, 'A');
    start(registry, 'B');
    registry.checkAndRecord('A', 'first-tool', [X]);
    set(T0 + 1_000);
    registry.checkAndRecord('A', 'second-tool', [X]);
    const decision = registry.checkAndRecord('B', 'email-send', [X]);
    expect(decision.held).toBe(true);
    if (decision.held) {
      expect(decision.matches).toHaveLength(1);
      expect(decision.matches[0]!.action.toolName).toBe('second-tool');
    }
  });

  it('warns once when live roots exceed the cap and nothing can be evicted', () => {
    const warn = vi.fn();
    const logger = { warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() } as unknown as Logger;
    const { registry } = setup(logger);
    for (let i = 0; i < MAX_TRACKED_ROOTS; i++) start(registry, `r${i}`);
    expect(warn).not.toHaveBeenCalled();
    start(registry, 'extra');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatchObject({ size: MAX_TRACKED_ROOTS + 1 });
    expect(registry.rootOf('r0')).toBeDefined();
  });
});

describe('TurnActivityRegistry unresolved originators', () => {
  it("an unresolved stranger root's action holds no one", () => {
    const { registry } = setup();
    start(registry, 'S', { originatorContactId: '+15550001111', originatorResolved: false });
    start(registry, 'P');
    expect(registry.checkAndRecord('S', 'email-send', [X])).toMatchObject({ held: false });
    expect(registry.checkAndRecord('P', 'email-send', [X])).toMatchObject({ held: false });
    expect(registry.actionsOf('P')).toHaveLength(1);
  });

  it.each(['scheduler', 'internal', 'bullpen'])("a %s root's action holds others whatever its originator", (channelId) => {
    const { registry } = setup();
    start(registry, 'J', { channelId, originatorContactId: null, originatorResolved: false });
    start(registry, 'P');
    registry.checkAndRecord('J', 'email-send', [X]);
    expect(registry.checkAndRecord('P', 'email-send', [X]).held).toBe(true);
  });

  it('an unresolved root is still checked against others', () => {
    const { registry } = setup();
    start(registry, 'P');
    start(registry, 'S', { originatorContactId: '+15550001111', originatorResolved: false });
    registry.checkAndRecord('P', 'email-send', [X]);
    expect(registry.checkAndRecord('S', 'email-send', [X]).held).toBe(true);
  });

  it('an unresolved auto root holds no one', () => {
    const { registry } = setup();
    start(registry, 'P');
    registry.ensureRoot('voice-1', { ...VOICE_SEED, conversationId: 'v', originatorContactId: null, originatorResolved: false });
    registry.checkAndRecord('voice-1', 'email-send', [X]);
    expect(registry.checkAndRecord('P', 'email-send', [X])).toMatchObject({ held: false });
  });
});

describe('TurnActivityRegistry pruning', () => {
  it('a live auto root keeps an ended root still inside its window', () => {
    const { registry, set } = setup();
    start(registry, 'R');
    registry.checkAndRecord('R', 'email-send', [X]);
    set(T0 + 1_000);
    registry.taskEnded('R');
    set(T0 + 10 * MIN);
    registry.ensureRoot('V', {
      conversationId: 'v', channelId: 'voice', agentId: 'coordinator',
      originatorContactId: null, originatorResolved: false,
    });
    set(T0 + 20 * MIN);
    start(registry, 'B', { startedAt: T0 + 20 * MIN });
    expect(registry.rootOf('R')).toBeDefined();
    expect(registry.checkAndRecord('V', 'email-send', [X]).held).toBe(true);
  });

  it('the prune cutoff is the oldest running root start, not now', () => {
    const { registry, set } = setup();
    start(registry, 'R');
    registry.checkAndRecord('R', 'email-send', [X]);
    set(T0 + MIN);
    registry.taskEnded('R');
    set(T0 + 10 * MIN);
    start(registry, 'M', { startedAt: T0 + 10 * MIN });
    set(T0 + 40 * MIN);
    start(registry, 'B', { startedAt: T0 + 40 * MIN });
    expect(registry.checkAndRecord('M', 'email-send', [X]).held).toBe(true);
  });
});

describe('TurnActivityRegistry action caps', () => {
  const noopLogger = () => {
    const error = vi.fn();
    const warn = vi.fn();
    return { error, warn, logger: { warn, error, info: vi.fn(), debug: vi.fn() } as unknown as Logger };
  };

  it('a root past its per-root cap drops its own oldest action only', () => {
    const { registry } = setup();
    start(registry, 'A');
    start(registry, 'B');
    registry.checkAndRecord('B', 'b-tool', [{ kind: 'tool', value: 'b-only' }]);
    for (let i = 0; i <= MAX_ACTIONS_PER_ROOT; i++) {
      registry.checkAndRecord('A', `tool-${i}`, [{ kind: 'id', value: `a-${i}` }]);
    }
    const a = registry.actionsOf('A');
    expect(a).toHaveLength(MAX_ACTIONS_PER_ROOT);
    expect(a[0]!.toolName).toBe('tool-1');
    expect(registry.actionsOf('B')).toHaveLength(1);
  });

  it('the global cap evicts ended roots first, then logs an error for live ones', () => {
    const { error, warn, logger } = noopLogger();
    const { registry } = setup(logger);
    // Unresolved roots hold no one, so the 10k-call fill skips matching and stays fast; this
    // test is about eviction, not holds.
    const start = (r: TurnActivityRegistry, id: string) =>
      startRoot(r, id, { originatorContactId: null, originatorResolved: false });
    const rootsNeeded = MAX_TRACKED_ACTIONS / MAX_ACTIONS_PER_ROOT;
    const fill = (id: string) => {
      for (let j = 0; j < MAX_ACTIONS_PER_ROOT; j++) {
        registry.checkAndRecord(id, 't', [{ kind: 'id', value: `${id}-${j}` }]);
      }
    };
    for (let i = 0; i < rootsNeeded; i++) {
      start(registry, `e${i}`);
      fill(`e${i}`);
      registry.taskEnded(`e${i}`);
    }
    start(registry, 'live');
    registry.checkAndRecord('live', 't', [{ kind: 'id', value: 'live-0' }]);
    expect(registry.actionsOf('live')).toHaveLength(1);
    expect(registry.actionsOf('e0')).toHaveLength(MAX_ACTIONS_PER_ROOT - 1);
    expect(error).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();

    // Now only live roots hold actions: the oldest overall goes, and it is an error.
    const live = setup(logger);
    for (let i = 0; i < rootsNeeded; i++) {
      start(live.registry, `l${i}`);
      for (let j = 0; j < MAX_ACTIONS_PER_ROOT; j++) {
        live.registry.checkAndRecord(`l${i}`, 't', [{ kind: 'id', value: `l${i}-${j}` }]);
      }
    }
    expect(error).not.toHaveBeenCalled();
    start(live.registry, 'lx');
    live.registry.checkAndRecord('lx', 't', [{ kind: 'id', value: 'extra' }]);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]![0]).toMatchObject({ evictedFromLive: 1, cap: MAX_TRACKED_ACTIONS });
  });
});

describe('TurnActivityRegistry repeated starts', () => {
  it('a start after ensureRoot for the same id merges instead of overwriting', () => {
    const { registry, set } = setup();
    registry.ensureRoot('a', {
      conversationId: 'conv-a', channelId: 'voice', agentId: 'coordinator',
      originatorContactId: null, originatorResolved: false,
    });
    set(T0 + 5_000);
    const root = start(registry, 'a', { startedAt: T0 + 5_000, content: 'hello' });
    expect(root.autoRegistered).toBe(true);
    expect(root.startedAt).toBe(T0);
    expect(root.requestText).toBe('hello');
    expect(root.runningTaskIds.has('a')).toBe(true);
  });

  it('a repeated start for a root id keeps its running tasks', () => {
    const { registry } = setup();
    start(registry, 'coord');
    start(registry, 'spec', {
      agentId: 'calendar',
      parentEventId: 'coord',
      metadata: { delegationOrigin: { taskEventId: 'coord' } },
    });
    const root = start(registry, 'coord');
    expect(root.runningTaskIds.has('spec')).toBe(true);
    expect(root.runningTaskIds.has('coord')).toBe(true);
  });
});

describe('TurnActivityRegistry scopes', () => {
  function scoped() {
    // The scope is read from the conversation id here; the suites read their attempt instead.
    const registry = new TurnActivityRegistry({
      logger: pino({ level: 'silent' }),
      now: () => T0,
      scopeOf: (conversationId) => conversationId.split('/')[0],
    });
    return registry;
  }

  it('roots in different scopes never hold each other', () => {
    const registry = scoped();
    start(registry, 'A', { conversationId: 'run1/conv' });
    start(registry, 'B', { conversationId: 'run2/conv' });
    expect(registry.checkAndRecord('A', 'email-send', [X]).held).toBe(false);
    expect(registry.checkAndRecord('B', 'email-send', [X]).held).toBe(false);
    expect(registry.otherRootsInWindow('A')).toEqual([]);
  });

  it('roots in the same scope still hold each other', () => {
    const registry = scoped();
    start(registry, 'A', { conversationId: 'run1/conv-a' });
    start(registry, 'B', { conversationId: 'run1/conv-b' });
    registry.checkAndRecord('A', 'email-send', [X]);
    expect(registry.checkAndRecord('B', 'email-send', [X]).held).toBe(true);
  });

  it('an auto root takes the scope of its seed conversation', () => {
    const registry = scoped();
    start(registry, 'A', { conversationId: 'run1/conv-a' });
    registry.ensureRoot('voice-1', { ...VOICE_SEED, conversationId: 'run2/voice' });
    registry.checkAndRecord('voice-1', 'email-send', [X]);
    expect(registry.checkAndRecord('A', 'email-send', [X]).held).toBe(false);
  });

  it('a throwing scope function falls back to the shared scope', () => {
    const warn = vi.fn();
    const logger = { warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() } as unknown as Logger;
    const registry = new TurnActivityRegistry({
      logger,
      now: () => T0,
      scopeOf: () => {
        throw new Error('scope exploded');
      },
    });
    start(registry, 'A');
    start(registry, 'B');
    registry.checkAndRecord('A', 'email-send', [X]);
    expect(registry.checkAndRecord('B', 'email-send', [X]).held).toBe(true);
    expect(warn).toHaveBeenCalled();
  });
});

describe('TurnActivityRegistry overlapping coordinator tasks', () => {
  it('ending one of two coordinator tasks keeps the slot on the other', () => {
    const { registry } = setup();
    start(registry, 'coord');
    start(registry, 'spec', {
      agentId: 'calendar',
      parentEventId: 'coord',
      metadata: { delegationOrigin: { taskEventId: 'coord' } },
    });
    start(registry, 'wake', {
      parentEventId: 'spec',
      metadata: { lateDelegation: {} },
    });
    expect(registry.rootOf('coord')!.runningCoordinatorTaskId).toBe('wake');
    registry.taskEnded('wake');
    expect(registry.rootOf('coord')!.runningCoordinatorTaskId).toBe('coord');
    registry.taskEnded('coord');
    expect(registry.rootOf('coord')!.runningCoordinatorTaskId).toBeNull();
  });
});

describe('TurnActivityRegistry action outcomes', () => {
  function overlapping() {
    const ctx = setup();
    start(ctx.registry, 'A');
    start(ctx.registry, 'B');
    return ctx;
  }

  function recorded(decision: ReturnType<TurnActivityRegistry['checkAndRecord']>): string {
    if (decision.held || decision.actionId === undefined) throw new Error('expected a recorded call');
    return decision.actionId;
  }

  it('a recorded call is pending until settled, and its handle is returned', () => {
    const { registry } = overlapping();
    recorded(registry.checkAndRecord('A', 'email-send', [X]));
    expect(registry.actionsOf('A')[0]!.outcome).toBe('pending');
    const decision = registry.checkAndRecord('B', 'email-send', [X]);
    expect(decision.held).toBe(true);
    if (decision.held) expect(decision.matches[0]!.action.outcome).toBe('pending');
  });

  it('a failed call is removed and holds no one', () => {
    const { registry } = overlapping();
    const id = recorded(registry.checkAndRecord('A', 'email-send', [X]));
    registry.settle(id, 'failed');
    expect(registry.actionsOf('A')).toHaveLength(0);
    expect(registry.checkAndRecord('B', 'email-send', [X])).toMatchObject({ held: false });
  });

  it('a succeeded call stays and holds as succeeded', () => {
    const { registry } = overlapping();
    const id = recorded(registry.checkAndRecord('A', 'email-send', [X]));
    registry.settle(id, 'succeeded');
    const decision = registry.checkAndRecord('B', 'email-send', [X]);
    expect(decision.held).toBe(true);
    if (decision.held) expect(decision.matches[0]!.action.outcome).toBe('succeeded');
  });

  it('a timed-out call stays with an unknown outcome', () => {
    const { registry } = overlapping();
    const id = recorded(registry.checkAndRecord('A', 'email-send', [X]));
    registry.settle(id, 'unknown');
    expect(registry.actionsOf('A')[0]!.outcome).toBe('unknown');
    expect(registry.checkAndRecord('B', 'email-send', [X]).held).toBe(true);
  });

  it('settling an id no longer tracked is a no-op', () => {
    const { registry } = overlapping();
    const id = recorded(registry.checkAndRecord('A', 'email-send', [X]));
    registry.settle(id, 'failed');
    expect(() => registry.settle(id, 'succeeded')).not.toThrow();
    expect(() => registry.settle('action-unknown', 'failed')).not.toThrow();
  });

  it('a snapshot of an action does not change when the action is settled', () => {
    const { registry } = overlapping();
    const id = recorded(registry.checkAndRecord('A', 'email-send', [X]));
    const before = registry.actionsOf('A')[0]!;
    registry.settle(id, 'succeeded');
    expect(before.outcome).toBe('pending');
  });
});
