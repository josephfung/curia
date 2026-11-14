// Turn activity registry (#2588). The registry answers "which other turns touched the same
// target recently" (in my own conversation, only those not ended when I started), so these
// tests pin root resolution, the window, and the one-pause-per-pair rule.

import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import type { Logger } from '../../../src/logger.js';
import {
  TurnActivityRegistry,
  TURN_ACTIVITY_WINDOW_MS,
  MAX_TRACKED_ROOTS,
  MAX_TRACKED_ACTIONS,
  MAX_ACTIONS_PER_ROOT,
  MAX_RUNNING_ROOT_AGE_MS,
  isAuthenticatedRoot,
  INBOUND_SENDER_TEXT_KEY,
  INBOUND_SCAN_FINDING_COUNT_KEY,
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
    startedAt: T0,
    // Resolved by default: an unresolved root's actions hold no one (see the disclosure tests).
    originatorContactId: 'contact-p',
    originatorResolved: true,
    originatorIsSystem: false,
    ...over,
  });
}

/** A resolved voice seed for ensureRoot. */
const VOICE_SEED = {
  channelId: 'voice',
  agentId: 'coordinator',
  originatorContactId: 'contact-p',
  originatorResolved: true,
  originatorIsSystem: false,
  // Voice stamps every originator unauthenticated (stamp-originator.ts).
  originatorAuthenticated: false,
};

describe('TurnActivityRegistry audience flag', () => {
  it('a root started from a one-to-one Signal DM has audienceOneToOne true', () => {
    const { registry } = setup();
    const dm = start(registry, 'dm', { channelId: 'signal', conversationId: 'signal:+15551234567' });
    const group = start(registry, 'grp', { channelId: 'signal', conversationId: 'signal:group=abc' });
    expect(dm.audienceOneToOne).toBe(true);
    expect(group.audienceOneToOne).toBe(false);
  });
});

describe('TurnActivityRegistry originator authentication', () => {
  const originator = (authenticated: unknown) => ({
    originator: { contactId: 'contact-p', channel: 'email', systemRole: 'principal', initiatedAt: null, authenticated },
  });

  it('is read from the root task\'s stamped originator, fail-closed', () => {
    const { registry } = setup();
    expect(start(registry, 'yes', { metadata: originator(true) }).originatorAuthenticated).toBe(true);
    expect(start(registry, 'no', { metadata: originator(false) }).originatorAuthenticated).toBe(false);
    // Only exactly true counts: a truthy non-boolean, a missing flag or no originator is false.
    expect(start(registry, 'str', { metadata: originator('true') }).originatorAuthenticated).toBe(false);
    expect(start(registry, 'none', { metadata: undefined }).originatorAuthenticated).toBe(false);
  });

  it('an auto root takes its seed\'s flag, and the root task\'s own stamp fills it in later', () => {
    const { registry } = setup();
    expect(registry.ensureRoot('v', { ...VOICE_SEED, conversationId: 'call-v' }).originatorAuthenticated).toBe(false);
    expect(registry.ensureRoot('a', { ...VOICE_SEED, conversationId: 'call-a', originatorAuthenticated: true }).originatorAuthenticated).toBe(true);
    // ensureRoot first, then the same id starts as a task carrying an authenticated stamp.
    registry.ensureRoot('m', { ...VOICE_SEED, conversationId: 'conv-m' });
    expect(start(registry, 'm', { metadata: originator(true) }).originatorAuthenticated).toBe(true);
  });

  it('isAuthenticatedRoot counts an authenticated stamp, and SMS, web and CLI by channel', () => {
    const { registry } = setup();
    expect(isAuthenticatedRoot(start(registry, 'sig', { channelId: 'signal', metadata: originator(true) }))).toBe(true);
    expect(isAuthenticatedRoot(start(registry, 'forged', { channelId: 'email', metadata: originator(false) }))).toBe(false);
    for (const channelId of ['sms', 'web', 'cli']) {
      expect(isAuthenticatedRoot(start(registry, `c-${channelId}`, { channelId, metadata: originator(false) }))).toBe(true);
    }
    expect(isAuthenticatedRoot(registry.ensureRoot('voice', { ...VOICE_SEED, conversationId: 'call-x' }))).toBe(false);
  });
});

describe('TurnActivityRegistry email audience flag', () => {
  it('a one-to-one email root gets the flag when selfEmails is passed', () => {
    const registry = new TurnActivityRegistry({
      logger: pino({ level: 'silent' }),
      now: () => T0,
      selfEmails: ['curia@example.com'],
    });
    const metadata = {
      curiaRole: 'to',
      primaryRecipientEmails: [],
      participants: [
        { email: 'boss@example.com', role: 'from' },
        { email: 'curia@example.com', role: 'to' },
      ],
    };
    const root = start(registry, 'em', { channelId: 'email', conversationId: 'email:t1', metadata });
    expect(root.audienceOneToOne).toBe(true);
    const bare = new TurnActivityRegistry({ logger: pino({ level: 'silent' }), now: () => T0 });
    expect(start(bare, 'em2', { channelId: 'email', conversationId: 'email:t1', metadata }).audienceOneToOne).toBe(false);
  });
});

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

  it('stores the trusted sender text for a root only, clipped by code points', () => {
    const { registry } = setup();
    const root = start(registry, 'coord', {
      metadata: { [INBOUND_SENDER_TEXT_KEY]: 'hello', [INBOUND_SCAN_FINDING_COUNT_KEY]: 0 },
    });
    expect(root.requestText).toBe('hello');
    expect(root.inboundScanFindings).toBe(0);
    const long = start(registry, 'long', { metadata: { [INBOUND_SENDER_TEXT_KEY]: '😀'.repeat(600) } });
    expect(Array.from(long.requestText!)).toHaveLength(500);
    start(registry, 'spec', {
      agentId: 'calendar',
      parentEventId: 'coord',
      metadata: { delegationOrigin: { taskEventId: 'coord' }, [INBOUND_SENDER_TEXT_KEY]: 'specialist payload' },
    });
    expect(registry.rootOf('coord')!.requestText).toBe('hello');
  });

  it('an email root with no stamp has no request text: content is never read', () => {
    const { registry } = setup();
    // Without the dispatcher's stamp there is nothing trustworthy to show, whatever the
    // task's content held (participants, outbound previews of other people's messages).
    const root = start(registry, 'em', { channelId: 'email', metadata: { participants: [] } });
    expect(root.requestText).toBeNull();
    expect(root.inboundScanFindings).toBeNull();
  });

  it('takes the scan count only when it is a non-negative integer', () => {
    const { registry } = setup();
    for (const [id, value] of [['neg', -1], ['frac', 1.5], ['str', '0'], ['nan', Number.NaN]] as const) {
      expect(start(registry, id, { metadata: { [INBOUND_SCAN_FINDING_COUNT_KEY]: value } }).inboundScanFindings).toBeNull();
    }
    expect(start(registry, 'two', { metadata: { [INBOUND_SCAN_FINDING_COUNT_KEY]: 2 } }).inboundScanFindings).toBe(2);
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

  describe('same conversation', () => {
    /** Root A acts on X in `conv`, then its coordinator task ends at T0 + 1s. */
    function earlierTurn(opts: { detachedSpecialist: boolean }) {
      const ctx = setup();
      start(ctx.registry, 'A', { conversationId: 'conv' });
      if (opts.detachedSpecialist) {
        start(ctx.registry, 'spec', {
          agentId: 'calendar',
          conversationId: 'delegate-1',
          metadata: { delegationOrigin: { taskEventId: 'A' } },
        });
      }
      ctx.registry.checkAndRecord('A', 'email-send', [X]);
      ctx.set(T0 + 1_000);
      ctx.registry.taskEnded('A');
      ctx.set(T0 + 5 * MIN);
      return ctx;
    }

    it('a finished root in my conversation does not hold me: its work is in my history', () => {
      const { registry } = earlierTurn({ detachedSpecialist: false });
      expect(registry.rootOf('A')!.endedAt).not.toBeNull();
      start(registry, 'B', { conversationId: 'conv', startedAt: T0 + 5 * MIN });
      expect(registry.checkAndRecord('B', 'email-send', [X])).toMatchObject({ held: false });
    });

    it("a root in my conversation still running a detached specialist holds me", () => {
      const { registry } = earlierTurn({ detachedSpecialist: true });
      expect(registry.rootOf('A')!.endedAt).toBeNull();
      start(registry, 'B', { conversationId: 'conv', startedAt: T0 + 5 * MIN });
      const decision = registry.checkAndRecord('B', 'email-send', [X]);
      expect(decision.held).toBe(true);
      if (decision.held) expect(decision.matches[0]!.other.rootId).toBe('A');
    });

    it('a root in my conversation that ends after I started still holds me: my model never saw it', () => {
      // A's detached specialist acts and finishes while B's first model call is in flight.
      const ctx = setup();
      start(ctx.registry, 'A', { conversationId: 'conv' });
      start(ctx.registry, 'spec', {
        agentId: 'calendar',
        conversationId: 'delegate-1',
        metadata: { delegationOrigin: { taskEventId: 'A' } },
      });
      ctx.registry.taskEnded('A');
      ctx.set(T0 + 2 * MIN);
      start(ctx.registry, 'B', { conversationId: 'conv', startedAt: T0 + 2 * MIN });
      ctx.set(T0 + 3 * MIN);
      ctx.registry.checkAndRecord('spec', 'email-send', [X]);
      ctx.registry.taskEnded('spec');
      expect(ctx.registry.rootOf('A')!.endedAt).toBe(T0 + 3 * MIN);
      ctx.set(T0 + 4 * MIN);
      const decision = ctx.registry.checkAndRecord('B', 'email-send', [X]);
      expect(decision.held).toBe(true);
      if (decision.held) expect(decision.matches[0]!.other.rootId).toBe('A');
    });

    it('a finished root in a different conversation, inside the window, still holds me', () => {
      const { registry } = earlierTurn({ detachedSpecialist: false });
      start(registry, 'B', { conversationId: 'other-conv', startedAt: T0 + 5 * MIN });
      expect(registry.checkAndRecord('B', 'email-send', [X]).held).toBe(true);
    });
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
      originatorContactId: null, originatorResolved: false, originatorIsSystem: false, originatorAuthenticated: false,
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

  it.each(['scheduler', 'internal', 'bullpen', 'email'])("a %s root with no originator is system and holds others", (channelId) => {
    const { registry } = setup();
    start(registry, 'J', { channelId, originatorContactId: null, originatorResolved: false, originatorIsSystem: true });
    start(registry, 'P');
    registry.checkAndRecord('J', 'email-send', [X]);
    expect(registry.checkAndRecord('P', 'email-send', [X]).held).toBe(true);
  });

  it.each(['scheduler', 'internal', 'bullpen'])('a %s root carrying an unresolved person originator holds no one', (channelId) => {
    // Classified by originator, not channel: a wake carrying a stranger's stamp is the stranger's.
    const { registry } = setup();
    start(registry, 'J', { channelId, originatorContactId: '+15550001111', originatorResolved: false });
    start(registry, 'P');
    registry.checkAndRecord('J', 'email-send', [X]);
    expect(registry.checkAndRecord('P', 'email-send', [X])).toMatchObject({ held: false });
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
    registry.ensureRoot('voice-1', { ...VOICE_SEED, conversationId: 'v', originatorContactId: '+15550001111', originatorResolved: false });
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
      originatorContactId: null, originatorResolved: false, originatorIsSystem: false, originatorAuthenticated: false,
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

  it("an idle auto root inside a running turn's window is kept, not pruned a window after its last action", () => {
    // Voice root V acts on X at minute 0; B starts at minute 10 and calls X at minute 20.
    const { registry, set } = setup();
    registry.ensureRoot('V', { ...VOICE_SEED, conversationId: 'v' });
    registry.checkAndRecord('V', 'email-send', [X]);
    set(T0 + 10 * MIN);
    start(registry, 'B', { startedAt: T0 + 10 * MIN });
    set(T0 + 20 * MIN);
    // A start runs a full prune: minute 20 is past V's last action plus a window.
    start(registry, 'other', { startedAt: T0 + 20 * MIN });
    expect(registry.rootOf('V')).toBeDefined();
    const decision = registry.checkAndRecord('B', 'email-send', [X]);
    expect(decision.held).toBe(true);
    if (decision.held) expect(decision.matches[0]!.other.rootId).toBe('V');
  });

  it('an idle auto root outside every live window is pruned', () => {
    const { registry, set } = setup();
    registry.ensureRoot('V', { ...VOICE_SEED, conversationId: 'v' });
    registry.checkAndRecord('V', 'email-send', [X]);
    set(T0 + 20 * MIN);
    start(registry, 'B', { startedAt: T0 + 20 * MIN });
    expect(registry.rootOf('V')).toBeUndefined();
    expect(registry.checkAndRecord('B', 'email-send', [X]).held).toBe(false);
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
      originatorContactId: null, originatorResolved: false, originatorIsSystem: false, originatorAuthenticated: false,
    });
    set(T0 + 5_000);
    const root = start(registry, 'a', { startedAt: T0 + 5_000, metadata: { [INBOUND_SENDER_TEXT_KEY]: 'hello' } });
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

describe('TurnActivityRegistry voice-originated tasks', () => {
  const voiceDelegation = (sessionId: string) => ({
    delegationOrigin: { taskEventId: sessionId, conversationId: 'voice-conv-1', channelId: 'voice', agentId: 'coordinator' },
  });

  it('specialists delegated from an unregistered voice session share one auto root', () => {
    const { registry } = setup();
    start(registry, 'spec-1', { agentId: 'calendar', channelId: 'internal', conversationId: 'delegate-1', metadata: voiceDelegation('session-1') });
    start(registry, 'spec-2', { agentId: 'email', channelId: 'internal', conversationId: 'delegate-2', metadata: voiceDelegation('session-1') });
    const root = registry.rootOf('spec-1')!;
    expect(root.rootId).toBe('session-1');
    expect(registry.rootOf('spec-2')!.rootId).toBe('session-1');
    expect(root.autoRegistered).toBe(true);
    expect(root.channelId).toBe('voice');
    expect(root.conversationId).toBe('voice-conv-1');
    expect(root.originatorContactId).toBe('contact-p');
    expect(root.originatorIsSystem).toBe(false);
    // The call's own later tool calls land on the same root.
    expect(registry.rootOf('session-1')!.rootId).toBe('session-1');
    // Two specialists of one call never hold each other.
    registry.checkAndRecord('spec-1', 'calendar-create-event', [X]);
    expect(registry.checkAndRecord('spec-2', 'email-send', [X])).toMatchObject({ held: false });
  });

  it('a delegation from a session already registered by a tool call joins it', () => {
    const { registry } = setup();
    registry.ensureRoot('session-1', { ...VOICE_SEED, conversationId: 'voice-conv-1' });
    start(registry, 'spec-1', { agentId: 'calendar', metadata: voiceDelegation('session-1') });
    expect(registry.rootOf('spec-1')!.rootId).toBe('session-1');
  });

  it('an async-offramp task maps under its voice session, and its forward task follows it', () => {
    const { registry } = setup();
    start(registry, 'offramp-1', {
      channelId: 'internal',
      conversationId: 'voice-offramp:abc',
      parentEventId: 'session-1',
      metadata: { voiceOfframp: true, sourceVoiceSessionId: 'session-1', sourceVoiceConversationId: 'voice-conv-1' },
    });
    const root = registry.rootOf('offramp-1')!;
    expect(root.rootId).toBe('session-1');
    expect(root.channelId).toBe('voice');
    expect(root.conversationId).toBe('voice-conv-1');
    start(registry, 'forward-1', {
      channelId: 'internal',
      conversationId: 'voice-offramp-forward:abc',
      metadata: { voiceOfframp: true, offrampForwardOf: 'offramp-1' },
    });
    expect(registry.rootOf('forward-1')!.rootId).toBe('session-1');
  });

  it('a delegation with no origin task id becomes its own root, with a warn', () => {
    const warn = vi.fn();
    const logger = { warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() } as unknown as Logger;
    const { registry } = setup(logger);
    start(registry, 'spec-1', { agentId: 'calendar', metadata: { delegationOrigin: { conversationId: 'c' } } });
    expect(registry.rootOf('spec-1')!.rootId).toBe('spec-1');
    expect(warn).toHaveBeenCalledWith({ taskEventId: 'spec-1' }, expect.any(String));
  });

  it('a late-delegation wake whose parent is gone warns', () => {
    const warn = vi.fn();
    const logger = { warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() } as unknown as Logger;
    const { registry } = setup(logger);
    start(registry, 'wake', { parentEventId: 'gone', metadata: { lateDelegation: {} } });
    expect(warn).toHaveBeenCalledWith({ taskEventId: 'wake' }, expect.any(String));
  });
});

describe('TurnActivityRegistry silent-failure logging and staleness', () => {
  function spyLogger() {
    const warn = vi.fn();
    const info = vi.fn();
    const debug = vi.fn();
    const error = vi.fn();
    return { warn, info, debug, error, logger: { warn, info, debug, error } as unknown as Logger };
  }

  it('checkAndRecord for an unknown task warns with the tool and task id', () => {
    const { warn, logger } = spyLogger();
    const { registry } = setup(logger);
    registry.checkAndRecord('nope', 'email-send', [X]);
    expect(warn).toHaveBeenCalledWith({ toolName: 'email-send', taskEventId: 'nope' }, expect.any(String));
  });

  it('taskEnded for an unknown task logs at debug', () => {
    const { debug, warn, logger } = spyLogger();
    const { registry } = setup(logger);
    registry.taskEnded('nope');
    expect(debug).toHaveBeenCalledWith({ taskEventId: 'nope' }, expect.any(String));
    expect(warn).not.toHaveBeenCalled();
  });

  it("an unresolved person's recorded action is logged once per root at info", () => {
    const { info, logger } = spyLogger();
    const { registry } = setup(logger);
    start(registry, 'S', { originatorContactId: '+15550001111', originatorResolved: false });
    start(registry, 'J', { originatorContactId: null, originatorResolved: false, originatorIsSystem: true });
    registry.checkAndRecord('S', 'email-send', [X]);
    registry.checkAndRecord('S', 'email-send', [Y]);
    registry.checkAndRecord('J', 'email-send', [Y]);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]![0]).toMatchObject({ rootId: 'S' });
    expect(JSON.stringify(info.mock.calls[0]![0])).not.toContain('+15550001111');
  });

  it('recordOnly records without checking, and later turns see it', () => {
    const { registry } = setup();
    start(registry, 'A');
    start(registry, 'B');
    start(registry, 'C');
    registry.checkAndRecord('A', 'email-send', [X]);
    const approved = registry.recordOnly('B', 'email-send', [X]);
    expect(approved.held).toBe(false);
    expect(approved.actionId).toBeDefined();
    expect(registry.actionsOf('B')).toHaveLength(1);
    const decision = registry.checkAndRecord('C', 'email-send', [X]);
    expect(decision.held).toBe(true);
    if (decision.held) expect(new Set(decision.matches.map((m) => m.other.rootId))).toEqual(new Set(['A', 'B']));
  });

  it('recordOnly for an unknown task warns and records nothing', () => {
    const { warn, logger } = spyLogger();
    const { registry } = setup(logger);
    expect(registry.recordOnly('nope', 'email-send', [X])).toEqual({ held: false });
    expect(warn).toHaveBeenCalledWith({ toolName: 'email-send', taskEventId: 'nope' }, expect.any(String));
  });

  it('an auto root whose last activity is before my window does not qualify, even unpruned', () => {
    const { registry, set } = setup();
    registry.ensureRoot('voice-1', { ...VOICE_SEED, conversationId: 'v' });
    registry.checkAndRecord('voice-1', 'email-send', [X]);
    // A running root keeps the old auto root from being pruned by taskStarted: it has a task.
    start(registry, 'spec', { agentId: 'calendar', metadata: { delegationOrigin: { taskEventId: 'voice-1' } } });
    set(T0 + TURN_ACTIVITY_WINDOW_MS + 5 * MIN);
    start(registry, 'B', { startedAt: T0 + TURN_ACTIVITY_WINDOW_MS + 5 * MIN });
    expect(registry.rootOf('voice-1')).toBeDefined();
    expect(registry.checkAndRecord('B', 'email-send', [X])).toMatchObject({ held: false });
  });

  it('checkAndRecord prunes stale roots without a task start, at most every interval', () => {
    const { registry, set } = setup();
    start(registry, 'A');
    registry.checkAndRecord('A', 'email-send', [X]);
    registry.taskEnded('A');
    // Long after A ended, a voice call registers (ensureRoot does not prune) and calls a tool:
    // no task has started since, so only checkAndRecord can prune A.
    set(T0 + 3 * TURN_ACTIVITY_WINDOW_MS);
    registry.ensureRoot('voice-1', { ...VOICE_SEED, conversationId: 'v' });
    expect(registry.rootOf('A')).toBeDefined();
    registry.checkAndRecord('voice-1', 'email-send', [Y]);
    expect(registry.rootOf('A')).toBeUndefined();
    expect(registry.rootOf('voice-1')).toBeDefined();
  });

  it("checkAndRecord's prune never drops the caller's own root", () => {
    const { registry, set } = setup();
    registry.ensureRoot('voice-1', { ...VOICE_SEED, conversationId: 'v' });
    registry.checkAndRecord('voice-1', 'email-send', [X]);
    // The call's last activity is now past the window: a prune would drop it, but not its own.
    set(T0 + 2 * TURN_ACTIVITY_WINDOW_MS);
    expect(registry.checkAndRecord('voice-1', 'email-send', [Y])).toMatchObject({ held: false });
    expect(registry.rootOf('voice-1')).toBeDefined();
    expect(registry.actionsOf('voice-1')).toHaveLength(2);
  });

  it('a root running past the maximum age is treated as ended, with one warn', () => {
    const { warn, logger } = spyLogger();
    const { registry, set } = setup(logger);
    start(registry, 'stuck');
    registry.checkAndRecord('stuck', 'email-send', [X]);
    const late = T0 + MAX_RUNNING_ROOT_AGE_MS + TURN_ACTIVITY_WINDOW_MS + MIN;
    set(late);
    start(registry, 'B', { startedAt: late });
    // Its effective end is start + max age, a window before B: B is not held, and it was pruned.
    expect(registry.checkAndRecord('B', 'email-send', [X])).toMatchObject({ held: false });
    expect(registry.rootOf('stuck')).toBeUndefined();
    const stuckWarns = warn.mock.calls.filter((c) => (c[0] as { rootId?: string }).rootId === 'stuck');
    expect(stuckWarns).toHaveLength(1);
  });

  it('a root past its per-root action cap warns once', () => {
    const { warn, logger } = spyLogger();
    const { registry } = setup(logger);
    start(registry, 'A');
    for (let i = 0; i < MAX_ACTIONS_PER_ROOT + 5; i++) {
      registry.checkAndRecord('A', 't', [{ kind: 'id', value: `a-${i}` }]);
    }
    const capWarns = warn.mock.calls.filter((c) => (c[0] as { cap?: number }).cap === MAX_ACTIONS_PER_ROOT);
    expect(capWarns).toHaveLength(1);
    expect(capWarns[0]![0]).toMatchObject({ rootId: 'A' });
  });

  it('losing a live auto root to the global action cap is an error', () => {
    const { error, logger } = spyLogger();
    const { registry } = setup(logger);
    const rootsNeeded = MAX_TRACKED_ACTIONS / MAX_ACTIONS_PER_ROOT;
    for (let i = 0; i < rootsNeeded; i++) {
      // Unresolved, so the fill skips matching and stays fast.
      registry.ensureRoot(`v${i}`, { ...VOICE_SEED, conversationId: `v${i}`, originatorContactId: null, originatorResolved: false });
      for (let j = 0; j < MAX_ACTIONS_PER_ROOT; j++) {
        registry.checkAndRecord(`v${i}`, 't', [{ kind: 'id', value: `v${i}-${j}` }]);
      }
    }
    expect(error).not.toHaveBeenCalled();
    registry.ensureRoot('vx', { ...VOICE_SEED, conversationId: 'vx', originatorContactId: null, originatorResolved: false });
    registry.checkAndRecord('vx', 't', [{ kind: 'id', value: 'extra' }]);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]![0]).toMatchObject({ evictedFromLive: 1 });
  });
});
