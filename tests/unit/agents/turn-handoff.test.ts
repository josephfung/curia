// Cross-conversation hand-off (#2588). A person's new turn passes a correction to their own
// turn still running on another one-to-one conversation, or holds it for that turn's wake when
// only a detached specialist is still working. Everything else tells the model to do it itself.

import { describe, it, expect, vi, afterEach } from 'vitest';
import pino from 'pino';
import {
  HANDOFF_DRAIN_WAIT_MS,
  HANDOFF_LOST_AFTER_MS,
  handoffInboundEventId,
  handoffOutcomeText,
  performHandoff,
  watchHeldCorrectionTicket,
  type HandoffOutcome,
} from '../../../src/agents/turn-handoff.js';
import { isUuid } from '../../../src/util/uuid.js';
import {
  TurnActivityRegistry,
  type HandoffRecoveryRequest,
  type HeldCorrection,
  type TaskStartInput,
} from '../../../src/dispatch/turn-activity.js';
import { TurnLanes, type LaneHolder, type TicketResult } from '../../../src/dispatch/turn-lanes.js';
import { AgentRuntime } from '../../../src/agents/runtime.js';
import { EventBus } from '../../../src/bus/bus.js';
import { createAgentTask, type AgentTaskEvent } from '../../../src/bus/events.js';
import type { LLMProvider, LLMResponse, ToolDefinition } from '../../../src/agents/llm/provider.js';
import type { ExecutionLayer } from '../../../src/skills/execution.js';
import type { Logger } from '../../../src/logger.js';
import { createLogger } from '../../../src/logger.js';

const CONTACT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const STRANGER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MY_CONVERSATION = 'signal:+15550001';
const TARGET_CONVERSATION = 'web:session-target';
const REQUEST = 'actually make it Tuesday';
const INITIATED_AT = '2026-11-14T15:00:00.000Z';
/** The dispatcher's stamp for the handing turn: a Signal sender, authenticated by the channel. */
const MY_ORIGINATOR = {
  contactId: CONTACT, channel: 'signal', systemRole: null, tier: 'known', initiatedAt: INITIATED_AT, authenticated: true,
};

const USAGE = { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
const PROVENANCE = { requestedModel: 'mock-model', actualModel: 'mock-model', providerRequestId: 'msg_mock_000' } as const;

function spyLogger() {
  const warn = vi.fn();
  const info = vi.fn();
  const debug = vi.fn();
  const error = vi.fn();
  return { warn, info, error, logger: { warn, info, debug, error } as unknown as Logger };
}

function newLanes(logger: Logger): TurnLanes {
  return new TurnLanes({ enabled: true, maxInjectionsPerTurn: 2, extraRoundsPerInjection: 2, laneWaitTimeoutMs: 60_000, logger });
}

function startTask(registry: TurnActivityRegistry, over: Partial<TaskStartInput> & { taskEventId: string }): void {
  registry.taskStarted({
    agentId: 'coordinator',
    conversationId: `conv-${over.taskEventId}`,
    channelId: 'web',
    parentEventId: undefined,
    metadata: undefined,
    startedAt: Date.now(),
    originatorContactId: CONTACT,
    originatorResolved: true,
    originatorIsSystem: false,
    ...over,
  });
}

/** The handing turn: a resolved person on Signal, with their own words and a clean scan. */
function startMine(registry: TurnActivityRegistry, metadata: Record<string, unknown> = {}, over: Partial<TaskStartInput> = {}): void {
  startTask(registry, {
    taskEventId: 'mine',
    channelId: 'signal',
    conversationId: MY_CONVERSATION,
    senderId: '+15550001',
    metadata: { originator: MY_ORIGINATOR, inboundSenderText: REQUEST, inboundScanFindingCount: 0, ...metadata },
    ...over,
  });
}

/** A target's stamp on a channel that authenticates its sender (Signal). */
const SIGNAL_TARGET_METADATA = {
  inboundSenderText: 'book the 9am flight',
  inboundScanFindingCount: 0,
  originator: { ...MY_ORIGINATOR, channel: 'signal', authenticated: true },
};

/** A two-party email thread with Curia's own mailbox: the email audience rule's shape. */
const EMAIL_TARGET_CONVERSATION = 'email:thread-target';
function emailTargetMetadata(authenticated: boolean): Record<string, unknown> {
  return {
    inboundSenderText: 'book the 9am flight',
    inboundScanFindingCount: 0,
    originator: { ...MY_ORIGINATOR, channel: 'email', systemRole: 'principal', tier: 'principal', authenticated },
    curiaRole: 'to',
    primaryRecipientEmails: [],
    participants: [{ email: 'ada@example.com', role: 'from' }, { email: 'curia@example.com', role: 'to' }],
  };
}

/**
 * The target: the same person's coordinator turn on the web app, which is principal-only and
 * one-to-one. (It was SMS until GHSA-p49r-jqh2-v668 stopped counting SMS as authenticated.)
 */
function startTarget(registry: TurnActivityRegistry, over: Partial<TaskStartInput> = {}): void {
  startTask(registry, {
    taskEventId: 'other-root',
    channelId: 'web',
    conversationId: TARGET_CONVERSATION,
    metadata: { inboundSenderText: 'book the 9am flight', inboundScanFindingCount: 0 },
    startedAt: Date.now() - 60_000,
    ...over,
  });
}

function targetHolder(over: Partial<LaneHolder> = {}): LaneHolder {
  return {
    taskEventId: 'other-root',
    conversationId: TARGET_CONVERSATION,
    originatorContactId: CONTACT,
    originatorResolved: true,
    originatorIsPrincipal: false,
    // Not the principal, so not a live turn: only an authenticated principal's turn is live, and
    // a live holder takes only live input (GHSA-p49r-jqh2-v668).
    liveTurn: false,
    synthetic: false,
    // A full tool set: a tool-limited holder (a content-block rewrite) is never injectable (#2615).
    toolLimited: false,
    ...over,
  };
}

function setup(opts: { selfEmails?: string[] } = {}) {
  const spy = spyLogger();
  const recovered: HandoffRecoveryRequest[] = [];
  const registry = new TurnActivityRegistry({
    logger: spy.logger,
    recoverHandoff: (r) => { recovered.push(r); },
    ...(opts.selfEmails && { selfEmails: opts.selfEmails }),
  });
  const lanes = newLanes(spy.logger);
  const run = (over: {
    targetRootId?: string;
    senderLabel?: string;
    drainedFollowUp?: boolean;
    handingLiveTurn?: boolean;
    scrubText?: (text: string) => string;
  } = {}) => performHandoff({
    registry,
    lanes,
    logger: spy.logger,
    fromTaskEventId: 'mine',
    targetRootId: over.targetRootId ?? 'other-root',
    ...(over.senderLabel !== undefined && { senderLabel: over.senderLabel }),
    ...(over.drainedFollowUp !== undefined && { drainedFollowUp: over.drainedFollowUp }),
    ...(over.handingLiveTurn !== undefined && { handingLiveTurn: over.handingLiveTurn }),
    ...(over.scrubText !== undefined && { scrubText: over.scrubText }),
  });
  return { ...spy, registry, lanes, run, recovered };
}

/** A specialist delegated from the target, still running. */
function startSpecialist(registry: TurnActivityRegistry): void {
  startTask(registry, {
    taskEventId: 'spec-1',
    agentId: 'research',
    conversationId: 'delegate-1',
    channelId: 'internal',
    metadata: { delegationOrigin: { taskEventId: 'other-root', conversationId: TARGET_CONVERSATION } },
  });
}

/** A specialist delegated from the target, still running after its coordinator ended. */
function detachSpecialist(registry: TurnActivityRegistry): void {
  startSpecialist(registry);
  registry.taskEnded('other-root');
}

/**
 * The target's coordinator finishing without draining, in production order: it releases its
 * lane (publishAgentResponse) before handleTask's finally records its end.
 */
function finishTarget(registry: TurnActivityRegistry, lanes: TurnLanes): void {
  lanes.release('other-root');
  registry.taskEnded('other-root');
}

afterEach(() => {
  vi.useRealTimers();
});

describe('performHandoff', () => {
  it('delivers into a running coordinator turn', async () => {
    const { registry, lanes, run } = setup();
    startTarget(registry);
    startMine(registry);
    await lanes.acquire(targetHolder());

    const pending = run({ senderLabel: 'Ada', handingLiveTurn: true });
    const [input] = lanes.takeQueued('other-root');
    expect(input).toMatchObject({
      senderContactId: CONTACT,
      senderResolved: true,
      autoGenerated: false,
      injectionFindingCount: 0,
      content: REQUEST,
      originalContent: REQUEST,
      channelId: 'signal',
      liveTurn: true,
      senderLabel: 'Ada',
      handedOverFrom: { channelId: 'signal', conversationLabel: 'Signal' },
    });
    lanes.confirmDrained('other-root', [input!.inboundEventId]);
    expect(await pending).toEqual({ kind: 'delivered' });
  });

  it('receivedAt is when the person sent the message, not the hand-off time', async () => {
    const { registry, lanes, run } = setup();
    const sentAt = Date.now() - 90_000;
    startTarget(registry);
    startMine(registry, {}, { startedAt: sentAt });
    await lanes.acquire(targetHolder());
    void run();
    expect(lanes.takeQueued('other-root')[0]!.receivedAt).toBe(new Date(sentAt).toISOString());
  });

  it('a repeated call is the same inbound: the lane dedupes it, and it is delivered once', async () => {
    const { registry, lanes, run } = setup();
    startTarget(registry);
    startMine(registry);
    await lanes.acquire(targetHolder());
    const first = run();
    const second = run();
    const queued = lanes.takeQueued('other-root');
    expect(queued).toHaveLength(1);
    expect(queued[0]!.inboundEventId).toBe(handoffInboundEventId('mine', 'other-root'));
    expect(isUuid(queued[0]!.inboundEventId)).toBe(true);
    lanes.confirmDrained('other-root', [queued[0]!.inboundEventId]);
    expect(await first).toEqual({ kind: 'delivered' });
    expect(await second).toEqual({ kind: 'delivered' });
    // After the drain, a third call is answered from the registry, not re-queued.
    expect(await run()).toEqual({ kind: 'already_handed_over' });
    expect(lanes.takeQueued('other-root')).toEqual([]);
    // Ids differ per pair.
    expect(handoffInboundEventId('mine', 'x')).not.toBe(handoffInboundEventId('mine', 'other-root'));
  });

  it('a repeat after the target coordinator released its lane is not held for its wake again', async () => {
    const { registry, lanes, run } = setup();
    startTarget(registry);
    startMine(registry);
    await lanes.acquire(targetHolder());
    const first = run();
    const [queued] = lanes.takeQueued('other-root');
    lanes.confirmDrained('other-root', [queued!.inboundEventId]);
    expect(await first).toEqual({ kind: 'delivered' });
    // The coordinator ends while a specialist still runs: the lane (and its drained set) is gone.
    startSpecialist(registry);
    finishTarget(registry, lanes);
    expect(registry.hasDetachedWork('other-root')).toBe(true);

    const repeat = await run();
    expect(repeat).toEqual({ kind: 'already_handed_over' });
    expect(handoffOutcomeText(repeat)).toContain("don't pass it again or do the work here");
    expect(registry.heldCount('other-root')).toBe(0);
  });

  it('a repeat into a later coordinator of the target is not queued again', async () => {
    const { registry, lanes, run } = setup();
    startTarget(registry);
    startMine(registry);
    await lanes.acquire(targetHolder());
    const first = run();
    const [queued] = lanes.takeQueued('other-root');
    lanes.confirmDrained('other-root', [queued!.inboundEventId]);
    await first;
    // A wake coordinator under the same root now holds the target conversation's lane.
    startSpecialist(registry);
    finishTarget(registry, lanes);
    startTask(registry, {
      taskEventId: 'wake-1',
      conversationId: TARGET_CONVERSATION,
      parentEventId: 'other-root',
      metadata: { lateDelegation: { agent: 'research', task: 't' } },
    });
    await lanes.acquire(targetHolder({ taskEventId: 'wake-1', synthetic: true, liveTurn: false }));
    expect(await run()).toEqual({ kind: 'already_handed_over' });
    expect(lanes.takeQueued('wake-1')).toEqual([]);
  });

  it('a follow-up drained after a hand-off is done here, not answered "already passed on"', async () => {
    const { registry, lanes, run } = setup();
    startTarget(registry);
    startMine(registry);
    await lanes.acquire(targetHolder());
    const first = run();
    const [queued] = lanes.takeQueued('other-root');
    lanes.confirmDrained('other-root', [queued!.inboundEventId]);
    expect(await first).toEqual({ kind: 'delivered' });
    // The person then says more on this turn ("actually, make it Wednesday").
    expect(await run({ drainedFollowUp: true })).toEqual({ kind: 'do_it_yourself', reason: 'ineligible' });
    // Nothing more was passed on, and the original stays deduped.
    expect(lanes.takeQueued('other-root')).toEqual([]);
    expect(await run()).toEqual({ kind: 'already_handed_over' });
  });

  it('a declined hand-off is not remembered: the turn may try again', async () => {
    const { registry, lanes, run } = setup();
    startTarget(registry);
    startMine(registry);
    // No lane holder yet: unreachable.
    expect(await run()).toMatchObject({ kind: 'do_it_yourself' });
    expect(registry.wasHandedOff('mine', 'other-root')).toBe(false);
    await lanes.acquire(targetHolder());
    const again = run();
    const [queued] = lanes.takeQueued('other-root');
    expect(queued).toBeDefined();
    lanes.confirmDrained('other-root', [queued!.inboundEventId]);
    expect(await again).toEqual({ kind: 'delivered' });
  });

  it('a drain past the wait is queued, and a later return is held for the wake', async () => {
    vi.useFakeTimers();
    const { registry, lanes, run } = setup();
    startTarget(registry);
    startMine(registry);
    await lanes.acquire(targetHolder());

    const pending = run();
    await vi.advanceTimersByTimeAsync(HANDOFF_DRAIN_WAIT_MS);
    expect(await pending).toEqual({ kind: 'queued' });

    // A specialist still runs under the root; the coordinator finishes without draining.
    startSpecialist(registry);
    finishTarget(registry, lanes);
    await vi.runAllTimersAsync();
    const held = registry.takeHeldForWake('other-root');
    expect(held.map((h) => h.input.content)).toEqual([REQUEST]);
    // A wake is never live (#1126).
    expect(held[0]!.input.liveTurn).toBe(false);
    // The handing turn travels with it, for a recovery.
    expect(held[0]!.from.rootId).toBe('mine');
  });

  it('(a) a late return with nothing left running re-runs the correction on the handing turn', async () => {
    vi.useFakeTimers();
    const { registry, lanes, run, recovered } = setup();
    startTarget(registry);
    startMine(registry);
    await lanes.acquire(targetHolder());

    const pending = run();
    await vi.advanceTimersByTimeAsync(HANDOFF_DRAIN_WAIT_MS);
    expect(await pending).toEqual({ kind: 'queued' });
    finishTarget(registry, lanes);
    await vi.runAllTimersAsync();
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ targetRootId: 'other-root', reason: 'returned', input: { content: REQUEST } });
    expect(recovered[0]!.from).toMatchObject({ rootId: 'mine', conversationId: MY_CONVERSATION, channelId: 'signal' });
    expect(registry.takeHeldForWake('other-root')).toEqual([]);
  });

  it('(b) a passed-on message neither drained nor returned in time is re-run once', async () => {
    vi.useFakeTimers();
    const { registry, lanes, run, recovered } = setup();
    startTarget(registry);
    startMine(registry);
    await lanes.acquire(targetHolder());

    const pending = run();
    await vi.advanceTimersByTimeAsync(HANDOFF_DRAIN_WAIT_MS);
    expect(await pending).toEqual({ kind: 'queued' });
    await vi.advanceTimersByTimeAsync(HANDOFF_LOST_AFTER_MS);
    expect(recovered.map((r) => r.reason)).toEqual(['unresolved']);
    // A later return does not re-run it a second time.
    finishTarget(registry, lanes);
    await vi.runAllTimersAsync();
    expect(recovered).toHaveLength(1);
  });

  it('a return inside the wait is told to the model, not re-run', async () => {
    const { registry, lanes, run, recovered } = setup();
    startTarget(registry);
    startMine(registry);
    await lanes.acquire(targetHolder());
    const pending = run();
    lanes.release('other-root');
    expect(await pending).toEqual({ kind: 'do_it_yourself', reason: 'finished' });
    expect(recovered).toEqual([]);
  });

  it('a return inside the wait is held while a specialist runs', async () => {
    const { registry, lanes, run } = setup();
    startTarget(registry);
    startMine(registry);
    await lanes.acquire(targetHolder());
    const pending = run();
    startSpecialist(registry);
    // Released first: the coordinator task is still listed as running when the ticket returns.
    finishTarget(registry, lanes);
    expect(await pending).toEqual({ kind: 'held_for_wake' });
  });

  it('a host that returns with no specialist (a clarification-like exit) is finished, not held', async () => {
    const { registry, lanes, run } = setup();
    startTarget(registry);
    startMine(registry);
    await lanes.acquire(targetHolder());
    const pending = run();
    // The lane is released while the host coordinator task is still running in the registry.
    lanes.release('other-root');
    expect(await pending).toEqual({ kind: 'do_it_yourself', reason: 'finished' });
    expect(registry.takeHeldForWake('other-root')).toEqual([]);
    registry.taskEnded('other-root');
  });

  it('holds for wake when only a specialist is running', async () => {
    const { registry, run } = setup();
    startTarget(registry);
    detachSpecialist(registry);
    startMine(registry);
    expect(await run({ handingLiveTurn: true })).toEqual({ kind: 'held_for_wake' });
    const held = registry.takeHeldForWake('other-root');
    expect(held).toHaveLength(1);
    expect(held[0]!.input).toMatchObject({
      content: REQUEST,
      liveTurn: false,
      handedOverFrom: { channelId: 'signal', conversationLabel: 'Signal' },
    });
  });

  it("the handed input's liveTurn copies the handing task's, and is false when absent", async () => {
    const { registry, lanes, run } = setup();
    startTarget(registry);
    startMine(registry);
    await lanes.acquire(targetHolder());
    void run();
    expect(lanes.takeQueued('other-root')[0]!.liveTurn).toBe(false);
  });

  it('scrubs a sign-in code the tracker learned after the text was stamped', async () => {
    const { registry, lanes, run } = setup();
    startTarget(registry);
    startMine(registry, { inboundSenderText: 'use 482913 and make it Tuesday' });
    await lanes.acquire(targetHolder());
    void run({ scrubText: (t) => t.replace('482913', '[sign-in code]') });
    const [input] = lanes.takeQueued('other-root');
    expect(input!.content).toBe('use [sign-in code] and make it Tuesday');
    expect(input!.originalContent).toBe('use [sign-in code] and make it Tuesday');
  });

  it('an unauthenticated principal email root is refused (a forged From), an authenticated one is not', async () => {
    const forged = setup();
    startTarget(forged.registry);
    startMine(forged.registry, {
      originator: { ...MY_ORIGINATOR, channel: 'email', systemRole: 'principal', tier: 'principal', authenticated: false },
    }, { channelId: 'email', conversationId: 'email:thread-1' });
    await forged.lanes.acquire(targetHolder());
    expect(await forged.run()).toEqual({ kind: 'do_it_yourself', reason: 'ineligible' });
    expect(forged.lanes.takeQueued('other-root')).toEqual([]);

    // A missing stamp fails closed too.
    const unstamped = setup();
    startTarget(unstamped.registry);
    startMine(unstamped.registry, { originator: { ...MY_ORIGINATOR, authenticated: undefined } });
    expect(await unstamped.run()).toEqual({ kind: 'do_it_yourself', reason: 'ineligible' });

    const verified = setup();
    startTarget(verified.registry);
    startMine(verified.registry, {
      originator: { ...MY_ORIGINATOR, channel: 'email', systemRole: 'principal', tier: 'principal', authenticated: true },
    }, { channelId: 'email', conversationId: 'email:thread-1' });
    await verified.lanes.acquire(targetHolder());
    void verified.run();
    expect(verified.lanes.takeQueued('other-root')).toHaveLength(1);
  });

  // GHSA-p49r-jqh2-v668: SMS caller ids are spoofable; an SMS root no longer counts as authenticated.
  it('an SMS handing root is refused: its channel does not authenticate the sender', async () => {
    const { registry, lanes, run } = setup();
    startTarget(registry, { channelId: 'signal', conversationId: 'signal:+15550001', metadata: SIGNAL_TARGET_METADATA });
    startMine(registry, { originator: { ...MY_ORIGINATOR, channel: 'sms', authenticated: false } }, {
      channelId: 'sms', conversationId: 'sms:+15550009',
    });
    await lanes.acquire(targetHolder({ conversationId: 'signal:+15550001' }));
    expect(await run()).toEqual({ kind: 'do_it_yourself', reason: 'ineligible' });
    expect(lanes.takeQueued('other-root')).toEqual([]);
  });

  describe('the target must be authenticated too (#2588 SEC HIGH)', () => {
    const SELF = ['curia@example.com'];

    it('an unauthenticated email target (a forged From) is refused, and nothing is injected', async () => {
      const { registry, lanes, run, recovered } = setup({ selfEmails: SELF });
      startTarget(registry, { channelId: 'email', conversationId: EMAIL_TARGET_CONVERSATION, metadata: emailTargetMetadata(false) });
      // Everything else would pass: one-to-one, same person, a lane held by its coordinator.
      expect(registry.rootOf('other-root')!.audienceOneToOne).toBe(true);
      startMine(registry);
      await lanes.acquire(targetHolder({ conversationId: EMAIL_TARGET_CONVERSATION }));
      const outcome = await run({ handingLiveTurn: true });
      expect(outcome).toEqual({ kind: 'do_it_yourself', reason: 'unauthenticated' });
      expect(handoffOutcomeText(outcome)).toContain("that turn's sender wasn't verified by its channel");
      expect(lanes.takeQueued('other-root')).toEqual([]);
      expect(recovered).toEqual([]);
    });

    it('nor is a correction held for an unauthenticated target\'s wake', async () => {
      const { registry, run } = setup({ selfEmails: SELF });
      startTarget(registry, { channelId: 'email', conversationId: EMAIL_TARGET_CONVERSATION, metadata: emailTargetMetadata(false) });
      detachSpecialist(registry);
      startMine(registry);
      expect(await run()).toEqual({ kind: 'do_it_yourself', reason: 'unauthenticated' });
      expect(registry.takeHeldForWake('other-root')).toEqual([]);
    });

    it('a missing stamp on a Signal target fails closed', async () => {
      const { registry, lanes, run } = setup();
      startTarget(registry, { channelId: 'signal', conversationId: 'signal:+15550002' });
      startMine(registry);
      await lanes.acquire(targetHolder({ conversationId: 'signal:+15550002' }));
      expect(await run()).toEqual({ kind: 'do_it_yourself', reason: 'unauthenticated' });
      expect(lanes.takeQueued('other-root')).toEqual([]);
    });

    it('an authenticated email target takes the hand-off, live signal and all', async () => {
      const { registry, lanes, run } = setup({ selfEmails: SELF });
      startTarget(registry, { channelId: 'email', conversationId: EMAIL_TARGET_CONVERSATION, metadata: emailTargetMetadata(true) });
      startMine(registry);
      await lanes.acquire(targetHolder({ conversationId: EMAIL_TARGET_CONVERSATION }));
      const pending = run({ handingLiveTurn: true });
      const [input] = lanes.takeQueued('other-root');
      expect(input).toMatchObject({ content: REQUEST, liveTurn: true });
      lanes.confirmDrained('other-root', [input!.inboundEventId]);
      expect(await pending).toEqual({ kind: 'delivered' });
    });

    // GHSA-p49r-jqh2-v668: an SMS target could be a spoofed number's turn; it gets no hand-off.
    it('an SMS target is refused, and nothing is injected', async () => {
      const { registry, lanes, run } = setup();
      startTarget(registry, { channelId: 'sms', conversationId: 'sms:+15550001' });
      expect(registry.rootOf('other-root')!.originatorAuthenticated).toBe(false);
      startMine(registry);
      await lanes.acquire(targetHolder({ conversationId: 'sms:+15550001' }));
      expect(await run({ handingLiveTurn: true })).toEqual({ kind: 'do_it_yourself', reason: 'unauthenticated' });
      expect(lanes.takeQueued('other-root')).toEqual([]);
    });

    it('a running web turn takes a hand-off from Signal: the web app is principal-only and one-to-one', async () => {
      const { registry, lanes, run } = setup();
      const WEB_CONVERSATION = 'web:session-1';
      startTarget(registry, {
        channelId: 'web',
        conversationId: WEB_CONVERSATION,
        metadata: {
          inboundSenderText: 'book the 9am flight',
          inboundScanFindingCount: 0,
          // As the dispatcher stamps the web app: never authenticated by the channel.
          originator: { ...MY_ORIGINATOR, channel: 'web', authenticated: false },
        },
      });
      const target = registry.rootOf('other-root')!;
      expect(target.originatorAuthenticated).toBe(false);
      expect(target.audienceOneToOne).toBe(true);
      startMine(registry);
      await lanes.acquire(targetHolder({ conversationId: WEB_CONVERSATION }));
      const pending = run({ handingLiveTurn: true });
      const [input] = lanes.takeQueued('other-root');
      expect(input).toMatchObject({
        content: REQUEST,
        liveTurn: true,
        handedOverFrom: { channelId: 'signal', conversationLabel: 'Signal' },
      });
      lanes.confirmDrained('other-root', [input!.inboundEventId]);
      expect(await pending).toEqual({ kind: 'delivered' });
    });

    it('a CLI turn may hand off, labelled as the CLI', async () => {
      const { registry, lanes, run } = setup();
      startTarget(registry, { channelId: 'signal', conversationId: 'signal:+15550001', metadata: SIGNAL_TARGET_METADATA });
      startMine(registry, { originator: { ...MY_ORIGINATOR, channel: 'cli', authenticated: false } }, {
        channelId: 'cli', conversationId: 'cli:local',
      });
      await lanes.acquire(targetHolder({ conversationId: 'signal:+15550001' }));
      void run();
      const [input] = lanes.takeQueued('other-root');
      expect(input).toMatchObject({ content: REQUEST, handedOverFrom: { channelId: 'cli', conversationLabel: 'CLI' } });
    });

    it('a voice root is still never a target, even carrying the same person', async () => {
      const { registry, lanes, run } = setup();
      // A call's root is an auto root seeded unauthenticated, and voice is not counted by channel.
      registry.ensureRoot('voice-1', {
        conversationId: 'voice-conv-1', channelId: 'voice', agentId: 'coordinator',
        originatorContactId: CONTACT, originatorResolved: true, originatorIsSystem: false, originatorAuthenticated: false,
      });
      startMine(registry);
      expect(await run({ targetRootId: 'voice-1' })).toEqual({ kind: 'do_it_yourself', reason: 'unauthenticated' });
      expect(lanes.takeQueued('voice-1')).toEqual([]);
      expect(registry.takeHeldForWake('voice-1')).toEqual([]);
    });
  });

  it('refuses when the target task holds a lane on another conversation (defence in depth)', async () => {
    const { registry, lanes, run } = setup();
    startTarget(registry);
    startMine(registry);
    // The registry says the target runs on SMS; its task id holds a lane elsewhere.
    await lanes.acquire(targetHolder({ conversationId: 'sms:+15559999' }));
    expect(await run()).toEqual({ kind: 'do_it_yourself', reason: 'ineligible' });
    expect(lanes.takeQueued('other-root')).toEqual([]);
  });

  it('a running coordinator with no lane holder is unreachable, not finished', async () => {
    const { registry, run } = setup();
    startTarget(registry);
    startMine(registry);
    // No lanes.acquire: the target's coordinator runs but holds no lane.
    const outcome = await run();
    expect(outcome).toEqual({ kind: 'do_it_yourself', reason: 'unreachable' });
    expect(handoffOutcomeText(outcome)).toContain("that turn is busy and can't take messages right now");
    expect(handoffOutcomeText(outcome)).not.toContain('finished');
  });

  it('a clipped request text is ineligible', async () => {
    const { registry, lanes, run } = setup();
    startTarget(registry);
    startMine(registry, { inboundSenderTextClipped: true });
    await lanes.acquire(targetHolder());
    expect(await run()).toEqual({ kind: 'do_it_yourself', reason: 'ineligible' });
    expect(lanes.takeQueued('other-root')).toEqual([]);
  });

  it('a handing turn that has drained a follow-up is ineligible', async () => {
    const { registry, lanes, run } = setup();
    startTarget(registry);
    startMine(registry);
    await lanes.acquire(targetHolder());
    expect(await run({ drainedFollowUp: true })).toEqual({ kind: 'do_it_yourself', reason: 'ineligible' });
    expect(lanes.takeQueued('other-root')).toEqual([]);
  });

  it('refuses a multi-participant target', async () => {
    const { registry, lanes, run } = setup();
    // A Signal group is not one-to-one.
    startTarget(registry, { channelId: 'signal', conversationId: 'signal:group=abc', metadata: SIGNAL_TARGET_METADATA });
    startMine(registry);
    await lanes.acquire(targetHolder({ conversationId: 'signal:group=abc' }));
    expect(await run()).toEqual({ kind: 'do_it_yourself', reason: 'not_one_to_one' });
    expect(lanes.takeQueued('other-root')).toEqual([]);
  });

  it('refuses a different person', async () => {
    const { registry, lanes, run } = setup();
    startTarget(registry, { originatorContactId: STRANGER });
    startMine(registry);
    await lanes.acquire(targetHolder({ originatorContactId: STRANGER }));
    expect(await run()).toEqual({ kind: 'do_it_yourself', reason: 'not_same_person' });
  });

  // A content-block rewrite holds the lane with no tools, so it cannot act on a request (#2615).
  it('does not deliver into a tool-limited target', async () => {
    const { registry, lanes, run } = setup();
    startTarget(registry);
    startMine(registry);
    await lanes.acquire(targetHolder({ toolLimited: true }));
    expect(await run()).toEqual({ kind: 'do_it_yourself', reason: 'ineligible' });
    expect(lanes.takeQueued('other-root')).toEqual([]);
  });

  it("refuses a system target (Curia's own work)", async () => {
    const { registry, run } = setup();
    startTarget(registry, { originatorIsSystem: true });
    startMine(registry);
    expect(await run()).toEqual({ kind: 'do_it_yourself', reason: 'not_same_person' });
  });

  it('finished target tells the model to do it itself', async () => {
    const { registry, run } = setup();
    startTarget(registry);
    registry.taskEnded('other-root');
    startMine(registry);
    const outcome = await run();
    expect(outcome).toEqual({ kind: 'do_it_yourself', reason: 'finished' });
    expect(handoffOutcomeText(outcome)).toContain('Do the work here yourself');
  });

  it('an unknown turn id is no longer active', async () => {
    const { registry, run } = setup();
    startMine(registry);
    const outcome = await run({ targetRootId: 'no-such-turn' });
    expect(outcome).toEqual({ kind: 'do_it_yourself', reason: 'inactive' });
    expect(handoffOutcomeText(outcome)).toContain('that turn is no longer active');
  });

  it('a target outside the window is no longer active, or not the same person', async () => {
    const { registry, run } = setup();
    // Started and ended well before my window opened.
    startTarget(registry, { startedAt: Date.now() - 60 * 60_000 });
    registry.taskEnded('other-root');
    // Ended now, but my turn's window looks back from my own start: start mine far later.
    startMine(registry, {}, { startedAt: Date.now() + 60 * 60_000 });
    expect(await run()).toEqual({ kind: 'do_it_yourself', reason: 'inactive' });

    const other = setup();
    other.registry.taskStarted({
      taskEventId: 'other-root', agentId: 'coordinator', conversationId: TARGET_CONVERSATION, channelId: 'sms',
      parentEventId: undefined, metadata: undefined, startedAt: Date.now() - 60 * 60_000,
      originatorContactId: STRANGER, originatorResolved: true, originatorIsSystem: false,
    });
    other.registry.taskEnded('other-root');
    startMine(other.registry, {}, { startedAt: Date.now() + 60 * 60_000 });
    expect(await other.run()).toEqual({ kind: 'do_it_yourself', reason: 'not_same_person' });
  });

  it('cap and closing map to do_it_yourself', async () => {
    const capped = setup();
    startTarget(capped.registry);
    startMine(capped.registry);
    await capped.lanes.acquire(targetHolder());
    // Fill the lane's cap of two with other follow-ups.
    for (const id of ['f1', 'f2']) {
      expect(capped.lanes.tryInjectIntoTask('other-root', {
        inboundEventId: id, senderContactId: CONTACT, senderResolved: true, autoGenerated: false,
        injectionFindingCount: 0, channelId: 'sms', liveTurn: true, content: id, originalContent: id,
        receivedAt: '2026-11-14T15:00:00.000Z',
      }).kind).toBe('queued');
    }
    expect(await capped.run()).toEqual({ kind: 'do_it_yourself', reason: 'cap' });

    const closing = setup();
    startTarget(closing.registry);
    startMine(closing.registry);
    await closing.lanes.acquire(targetHolder());
    expect(closing.lanes.closeIfIdle('other-root')).toBe(true);
    expect(await closing.run()).toEqual({ kind: 'do_it_yourself', reason: 'closing' });
  });

  it('a handing turn with a non-zero or unknown scan count is ineligible', async () => {
    for (const count of [1, undefined]) {
      const { registry, lanes, run } = setup();
      startTarget(registry);
      startMine(registry, { inboundScanFindingCount: count });
      await lanes.acquire(targetHolder());
      expect(await run()).toEqual({ kind: 'do_it_yourself', reason: 'ineligible' });
      expect(lanes.takeQueued('other-root')).toEqual([]);
    }
  });

  it('a handing turn with no request text is ineligible', async () => {
    const { registry, lanes, run } = setup();
    startTarget(registry);
    startMine(registry, { inboundSenderText: undefined });
    await lanes.acquire(targetHolder());
    expect(await run()).toEqual({ kind: 'do_it_yourself', reason: 'ineligible' });
  });

  it('a system or unresolved handing turn is ineligible', async () => {
    const sys = setup();
    startTarget(sys.registry);
    startMine(sys.registry, {}, { originatorIsSystem: true });
    expect(await sys.run()).toEqual({ kind: 'do_it_yourself', reason: 'ineligible' });

    const unresolved = setup();
    startTarget(unresolved.registry);
    startMine(unresolved.registry, {}, { originatorResolved: false });
    expect(await unresolved.run()).toEqual({ kind: 'do_it_yourself', reason: 'ineligible' });
  });

  it('a task under the root that is not the root itself (a wake) is ineligible', async () => {
    const { registry, logger } = setup();
    startTarget(registry);
    startMine(registry);
    startTask(registry, {
      taskEventId: 'my-wake',
      conversationId: MY_CONVERSATION,
      channelId: 'signal',
      parentEventId: 'mine',
      metadata: { lateDelegation: { agent: 'research', task: 't' } },
    });
    expect(registry.rootOf('my-wake')?.rootId).toBe('mine');
    expect(await performHandoff({
      registry, lanes: newLanes(logger), logger, fromTaskEventId: 'my-wake', targetRootId: 'other-root',
    })).toEqual({ kind: 'do_it_yourself', reason: 'ineligible' });
  });

  it('an exception fails open to do_it_yourself (internal_error) and logs at error', async () => {
    const { registry, run, error } = setup();
    startTarget(registry);
    startMine(registry);
    vi.spyOn(registry, 'otherRootsInWindow').mockImplementation(() => {
      throw new Error('registry down');
    });
    const outcome = await run();
    expect(outcome).toEqual({ kind: 'do_it_yourself', reason: 'internal_error' });
    expect(handoffOutcomeText(outcome)).toContain('something went wrong passing it on');
    expect(error).toHaveBeenCalled();
  });
});

describe('handoffOutcomeText', () => {
  it('uses the fixed copy for each outcome', () => {
    const passed = "Passed on to the turn already doing that work. Tell them briefly you've passed it on; don't do the work here.";
    expect(handoffOutcomeText({ kind: 'delivered' })).toBe(passed);
    expect(handoffOutcomeText({ kind: 'queued' })).toBe(passed);
    expect(handoffOutcomeText({ kind: 'held_for_wake' })).toBe(
      "That work is still finishing in the background; the change will be applied when it lands, or picked up here if it can't be. Tell them so briefly; don't do the work here.",
    );
    expect(handoffOutcomeText({ kind: 'already_handed_over' })).toBe(
      "This message was already passed on to that turn; don't pass it again or do the work here. Tell them briefly it's in hand.",
    );
    const reasons: Extract<HandoffOutcome, { kind: 'do_it_yourself' }>['reason'][] = [
      'finished', 'inactive', 'unreachable', 'not_same_person', 'unauthenticated', 'not_one_to_one', 'cap', 'closing', 'ineligible',
      'tool_error', 'internal_error',
    ];
    const phrases = new Set<string>();
    for (const reason of reasons) {
      const textOut = handoffOutcomeText({ kind: 'do_it_yourself', reason });
      expect(textOut).toMatch(/^Couldn't hand this over \([^)]+\)\. Do the work here yourself; the other turn's actions are listed above, so adjust them rather than repeat them\.$/);
      phrases.add(textOut);
    }
    // Each reason has its own phrase.
    expect(phrases.size).toBe(reasons.length);
  });
});

// ── runtime wiring ─────────────────────────────────────────────────────────

function textResponse(content: string): LLMResponse {
  return { type: 'text', content, usage: USAGE, provenance: PROVENANCE };
}

function toolUse(name: string, input: Record<string, unknown>): LLMResponse {
  return { type: 'tool_use', toolCalls: [{ id: `call-${name}`, name, input }], content: '', usage: USAGE, provenance: PROVENANCE };
}

function toolDef(name: string): ToolDefinition {
  return { name, description: name, input_schema: { type: 'object', properties: {}, required: [] } };
}

const ORIGINATOR = MY_ORIGINATOR;

function myTask(over: Partial<Parameters<typeof createAgentTask>[0]> = {}): AgentTaskEvent {
  return createAgentTask({
    agentId: 'coordinator',
    conversationId: MY_CONVERSATION,
    channelId: 'signal',
    senderId: CONTACT,
    content: REQUEST,
    parentEventId: 'parent-mine',
    metadata: { originator: ORIGINATOR, inboundSenderText: REQUEST, inboundScanFindingCount: 0 },
    ...over,
  });
}

function buildRuntime(opts: {
  registry: TurnActivityRegistry;
  lanes: TurnLanes;
  chat: LLMProvider['chat'];
  invoke?: ReturnType<typeof vi.fn>;
  tools?: string[];
  logger?: Logger;
}) {
  const logger = opts.logger ?? createLogger('error');
  const bus = new EventBus(logger);
  bus.subscribe('agent.response', 'dispatch', () => {});
  const tools = (opts.tools ?? ['signal-send', 'turn-handoff']).map(toolDef);
  const execution = {
    invoke: opts.invoke ?? vi.fn(),
    getToolDefinitions: vi.fn((names: string[]) => tools.filter((t) => names.includes(t.name))),
  } as unknown as ExecutionLayer;
  new AgentRuntime({
    agentId: 'coordinator',
    systemPrompt: 'x',
    provider: { id: 'mock', chat: opts.chat },
    resolvedModel: 'mock-model',
    bus,
    logger,
    executionLayer: execution,
    skillToolDefs: [toolDef('signal-send')],
    turnActivity: opts.registry,
    turnLanes: opts.lanes,
  }).register();
  return { bus };
}

describe('runtime turn-handoff wiring', () => {
  it('tool is offered only when a hand-off is available', async () => {
    const quiet = pino({ level: 'silent' });
    // A running_turn view: the same person's running coordinator turn on one-to-one SMS.
    const withView = new TurnActivityRegistry({ logger: quiet });
    startTarget(withView);
    const seen: string[][] = [];
    const chat = vi.fn(async (params: { tools?: ToolDefinition[] }) => {
      seen.push((params.tools ?? []).map((t) => t.name));
      return textResponse('ok');
    });
    await buildRuntime({ registry: withView, lanes: newLanes(quiet), chat }).bus.publish('dispatch', myTask());
    expect(seen[0]).toContain('turn-handoff');

    // No views at all.
    const empty = new TurnActivityRegistry({ logger: quiet });
    seen.length = 0;
    await buildRuntime({ registry: empty, lanes: newLanes(quiet), chat }).bus.publish('dispatch', myTask());
    expect(seen[0]).not.toContain('turn-handoff');

    // A per-turn allowlist wins.
    const allowlisted = new TurnActivityRegistry({ logger: quiet });
    startTarget(allowlisted);
    seen.length = 0;
    await buildRuntime({ registry: allowlisted, lanes: newLanes(quiet), chat })
      .bus.publish('dispatch', myTask({ toolAllowlist: ['signal-send'] }));
    expect(seen[0]).toEqual(['signal-send']);
  });

  describe('the guidance line and the tool need a turn that may hand over', () => {
    const GUIDANCE = 'use `turn-handoff`';

    async function firstCall(task: AgentTaskEvent, opts: {
      lanesOn?: boolean;
      seed?: (r: TurnActivityRegistry) => void;
      tools?: string[];
      logger?: Logger;
      selfEmails?: string[];
      emailOneToOne?: boolean;
    } = {}) {
      const quiet = pino({ level: 'silent' });
      const registry = new TurnActivityRegistry({ logger: quiet, ...(opts.selfEmails && { selfEmails: opts.selfEmails }) });
      startTarget(registry);
      if (opts.emailOneToOne) {
        // A two-party thread with Curia's own mailbox: the email audience rule's shape.
        task.payload.metadata = {
          ...task.payload.metadata,
          curiaRole: 'to',
          primaryRecipientEmails: [],
          participants: [{ email: 'ada@example.com', role: 'from' }, { email: 'curia@example.com', role: 'to' }],
        };
      }
      opts.seed?.(registry);
      const lanes = new TurnLanes({
        enabled: opts.lanesOn ?? true, maxInjectionsPerTurn: 2, extraRoundsPerInjection: 2, laneWaitTimeoutMs: 60_000, logger: quiet,
      });
      const calls: { tools: string[]; system: string }[] = [];
      const chat = vi.fn(async (params: { tools?: ToolDefinition[]; messages: Array<{ role: string; content: unknown }> }) => {
        const system = params.messages.find((m) => m.role === 'system');
        calls.push({
          tools: (params.tools ?? []).map((t) => t.name),
          system: typeof system?.content === 'string' ? system.content : '',
        });
        return textResponse('ok');
      });
      await buildRuntime({
        registry, lanes, chat, ...(opts.tools && { tools: opts.tools }), ...(opts.logger && { logger: opts.logger }),
      }).bus.publish('dispatch', task);
      return calls[0]!;
    }

    it('eligible: both shown', async () => {
      const call = await firstCall(myTask());
      expect(call.tools).toContain('turn-handoff');
      expect(call.system).toContain(GUIDANCE);
    });

    it('lanes off: neither, but the per-turn hand-off line stays', async () => {
      const call = await firstCall(myTask(), { lanesOn: false });
      expect(call.tools).not.toContain('turn-handoff');
      expect(call.system).not.toContain(GUIDANCE);
      expect(call.system).toContain('hand-off: available');
    });

    it('unscanned, flagged, clipped or missing text: neither', async () => {
      const variants: Record<string, unknown>[] = [
        { originator: ORIGINATOR, inboundSenderText: REQUEST },
        { originator: ORIGINATOR, inboundSenderText: REQUEST, inboundScanFindingCount: 1 },
        { originator: ORIGINATOR, inboundSenderText: REQUEST, inboundScanFindingCount: 0, inboundSenderTextClipped: true },
        { originator: ORIGINATOR, inboundScanFindingCount: 0 },
      ];
      for (const metadata of variants) {
        const call = await firstCall(myTask({ metadata }));
        expect(call.tools).not.toContain('turn-handoff');
        expect(call.system).not.toContain(GUIDANCE);
      }
    });

    it('a wake under the root: no note at all, so no hand-off', async () => {
      const wake = myTask({
        syntheticTurn: true,
        parentEventId: 'mine',
        metadata: { originator: ORIGINATOR, wakeContext: { derived: true }, lateDelegation: { agent: 'research', task: 't' } },
      });
      const call = await firstCall(wake, { seed: (r) => startMine(r, {}, { originatorContactId: CONTACT }) });
      expect(call.system).not.toContain('## Your other recent turns with this person');
      expect(call.tools).not.toContain('turn-handoff');
      expect(call.system).not.toContain(GUIDANCE);
    });

    it('an unauthenticated principal email root: no note, no tool and no guidance line', async () => {
      const email = myTask({
        channelId: 'email',
        conversationId: 'email:thread-1',
        metadata: {
          originator: { ...ORIGINATOR, channel: 'email', systemRole: 'principal', tier: 'principal', authenticated: false },
          inboundSenderText: REQUEST,
          inboundScanFindingCount: 0,
        },
      });
      const call = await firstCall(email, { selfEmails: ['curia@example.com'], emailOneToOne: true });
      // A one-to-one thread, but a forged From could resolve to the principal: the reader must
      // pass the hand-off's sender rule, so the other turns' words and actions are not shown.
      expect(call.system).not.toContain('## Your other recent turns with this person');
      expect(call.tools).not.toContain('turn-handoff');
      expect(call.system).not.toContain(GUIDANCE);

      const verified = await firstCall(myTask({
        channelId: 'email',
        conversationId: 'email:thread-1',
        metadata: {
          originator: { ...ORIGINATOR, channel: 'email', systemRole: 'principal', tier: 'principal', authenticated: true },
          inboundSenderText: REQUEST,
          inboundScanFindingCount: 0,
        },
      }), { selfEmails: ['curia@example.com'], emailOneToOne: true });
      expect(verified.system).toContain('## Your other recent turns with this person');
      expect(verified.tools).toContain('turn-handoff');
      expect(verified.system).toContain(GUIDANCE);
    });

    it('the tool not registered: no guidance line either, and a warning', async () => {
      const warn = vi.fn();
      const logger = { warn, info: vi.fn(), debug: vi.fn(), error: vi.fn(), child: () => logger } as unknown as Logger;
      const call = await firstCall(myTask(), { tools: ['signal-send'], logger });
      expect(call.system).toContain('## Your other recent turns with this person');
      expect(call.system).not.toContain(GUIDANCE);
      expect(call.tools).not.toContain('turn-handoff');
      expect(warn).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('turn-handoff is not registered'));
    });

    // [] means no tools, and a malformed list leaves fewer tools (#2615): neither offers the
    // hand-off, so the guidance line must not say it is there.
    it.each([
      ['an empty allowlist', [] as string[]],
      ['a malformed allowlist', [null] as unknown as string[]],
    ])('%s: no guidance line, no tool, and a warning', async (_label, toolAllowlist) => {
      const warn = vi.fn();
      const logger = { warn, info: vi.fn(), debug: vi.fn(), error: vi.fn(), child: () => logger } as unknown as Logger;
      const call = await firstCall(myTask({ toolAllowlist }), { logger });
      expect(call.system).not.toContain(GUIDANCE);
      expect(call.tools ?? []).not.toContain('turn-handoff');
      expect(warn).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('allowlist'));
    });

    it('a per-turn allowlist: no guidance line either, and a warning', async () => {
      const warn = vi.fn();
      const logger = { warn, info: vi.fn(), debug: vi.fn(), error: vi.fn(), child: () => logger } as unknown as Logger;
      const call = await firstCall(myTask({ toolAllowlist: ['signal-send'] }), { logger });
      expect(call.system).not.toContain(GUIDANCE);
      expect(call.tools).toEqual(['signal-send']);
      expect(warn).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('allowlist'));
    });
  });

  describe('who reads the note (#2588 SEC MEDIUM-1, I4)', () => {
    const HEADING = '## Your other recent turns with this person';

    async function system(task: AgentTaskEvent): Promise<string> {
      const quiet = pino({ level: 'silent' });
      const registry = new TurnActivityRegistry({ logger: quiet });
      startTarget(registry);
      let seen = '';
      const chat = vi.fn(async (params: { messages: Array<{ role: string; content: unknown }> }) => {
        const sys = params.messages.find((m) => m.role === 'system');
        if (seen === '') seen = typeof sys?.content === 'string' ? sys.content : '';
        return textResponse('ok');
      });
      await buildRuntime({ registry, lanes: newLanes(quiet), chat }).bus.publish('dispatch', task);
      return seen;
    }

    it('the same person in a Signal DM gets the note; in a Signal group, none', async () => {
      expect(await system(myTask())).toContain(HEADING);
      expect(await system(myTask({ conversationId: 'signal:group=abc' }))).not.toContain(HEADING);
    });

    it('a scheduled job carrying the principal\'s originator gets no note', async () => {
      expect(await system(myTask({ channelId: 'scheduler', conversationId: 'scheduler:job-1' }))).not.toContain(HEADING);
    });

    it('a synthetic turn gets no note; a hand-off recovery turn does', async () => {
      expect(await system(myTask({ syntheticTurn: true }))).not.toContain(HEADING);
      expect(await system(myTask({
        syntheticTurn: true,
        metadata: { originator: ORIGINATOR, handoffRecovery: { targetRootId: 'other-root', reason: 'returned' } },
      }))).toContain(HEADING);
      // It reads the note on its copied originator's authentication, like any other reader.
      expect(await system(myTask({
        syntheticTurn: true,
        metadata: {
          originator: { ...ORIGINATOR, authenticated: false },
          handoffRecovery: { targetRootId: 'other-root', reason: 'returned' },
        },
      }))).not.toContain(HEADING);
    });

    it('a sender its channel did not authenticate gets no note, SMS included', async () => {
      const unstamped = { contactId: CONTACT, channel: 'signal', systemRole: null, tier: 'known', initiatedAt: INITIATED_AT };
      expect(await system(myTask({ metadata: { originator: unstamped } }))).not.toContain(HEADING);
      expect(await system(myTask({ metadata: { originator: { ...ORIGINATOR, authenticated: false } } }))).not.toContain(HEADING);
      expect(await system(myTask({
        channelId: 'sms',
        conversationId: 'sms:+15550002',
        metadata: { originator: { ...unstamped, channel: 'sms' } },
      }))).not.toContain(HEADING);
    });

    it('the principal on the web app or the CLI gets the note: both are principal-only, never stamped', async () => {
      // The dispatcher stamps web and CLI authenticated: false; isAuthenticatedRoot counts them
      // by channel, as the backstop's hold details do.
      const principal = { ...ORIGINATOR, systemRole: 'principal', tier: 'principal', authenticated: false };
      for (const channelId of ['web', 'cli']) {
        expect(await system(myTask({
          channelId,
          conversationId: `${channelId}:session-1`,
          metadata: { originator: { ...principal, channel: channelId }, inboundSenderText: REQUEST, inboundScanFindingCount: 0 },
        }))).toContain(HEADING);
      }
    });
  });

  it('intercepts a turn-handoff call and gives the model the outcome text', async () => {
    const quiet = pino({ level: 'silent' });
    const registry = new TurnActivityRegistry({ logger: quiet });
    const lanes = newLanes(quiet);
    startTarget(registry);
    await lanes.acquire(targetHolder());
    const toolResults: string[] = [];
    let call = 0;
    const chat = vi.fn(async (params: { messages: Array<{ role: string; content: unknown }> }) => {
      call += 1;
      if (call === 1) return toolUse('turn-handoff', { turn_id: 'other-root' });
      toolResults.push(JSON.stringify(params.messages));
      return textResponse("I've passed that on.");
    });
    const invoke = vi.fn().mockResolvedValue({ success: true, data: { handoff_requested: true, turn_id: 'other-root' } });
    const { bus } = buildRuntime({ registry, lanes, chat, invoke });

    const running = bus.publish('dispatch', myTask({
      senderContext: {
        resolved: true, contactId: CONTACT, displayName: 'Ada', role: null, systemRole: null, tier: 'known',
        kind: 'person', verified: true, kgNodeId: null, knowledgeSummary: '',
        authorization: { allowed: [], denied: [], escalate: [], channelTrust: 'high', trustBlocked: [] },
        contactConfidence: 1,
      },
    }));
    // Play the target turn: drain the handed-over input at its next point.
    let drained: ReturnType<TurnLanes['takeQueued']> = [];
    await vi.waitFor(() => {
      drained = lanes.takeQueued('other-root');
      expect(drained).toHaveLength(1);
    });
    expect(drained[0]).toMatchObject({ content: REQUEST, senderLabel: 'Ada', handedOverFrom: { conversationLabel: 'Signal' } });
    lanes.confirmDrained('other-root', [drained[0]!.inboundEventId]);
    await running;

    expect(toolResults[0]).toContain("Passed on to the turn already doing that work.");
    expect(toolResults[0]).not.toContain('handoff_requested');
  });

  it('a wake under a held root drains the held correction at turn start', async () => {
    const quiet = pino({ level: 'silent' });
    const registry = new TurnActivityRegistry({ logger: quiet });
    const lanes = newLanes(quiet);
    startTarget(registry);
    detachSpecialist(registry);
    startMine(registry);
    expect(await performHandoff({ registry, lanes, logger: quiet, fromTaskEventId: 'mine', targetRootId: 'other-root' }))
      .toEqual({ kind: 'held_for_wake' });

    const prompts: string[] = [];
    let call = 0;
    const chat = vi.fn(async (params: { messages: Array<{ role: string; content: unknown }> }) => {
      call += 1;
      prompts.push(JSON.stringify(params.messages));
      return call === 1 ? toolUse('signal-send', { to: 'principal', message: 'Tuesday it is' }) : textResponse('applied');
    });
    const invoke = vi.fn().mockResolvedValue({ success: true, data: { sent: true } });
    const inject = vi.spyOn(lanes, 'tryInjectIntoTask');
    const { bus } = buildRuntime({ registry, lanes, chat, invoke });
    const wake = createAgentTask({
      agentId: 'coordinator',
      conversationId: TARGET_CONVERSATION,
      channelId: 'sms',
      senderId: CONTACT,
      content: 'The research came back late.',
      syntheticTurn: true,
      parentEventId: 'spec-1',
      metadata: {
        // A principal host: a live input would make the wake's tool calls live.
        originator: { contactId: CONTACT, channel: 'sms', systemRole: 'principal', tier: 'principal' },
        wakeContext: { derived: true },
        lateDelegation: { agent: 'research', task: 'find flights' },
      },
    });
    await bus.publish('system', wake);

    expect(inject).toHaveBeenCalledWith(wake.id, expect.objectContaining({ content: REQUEST, liveTurn: false }), TARGET_CONVERSATION);
    expect(prompts[0]).toContain(REQUEST);
    expect(prompts[0]).toContain('Handed over from');
    expect(registry.takeHeldForWake('other-root')).toEqual([]);
    // The held correction did not make the wake live (#1126).
    const options = invoke.mock.calls[0]![3] as { liveTurn?: boolean };
    expect(options.liveTurn).toBe(false);
  });

  it('a wake on an unlaned channel leaves the correction held', async () => {
    const quiet = pino({ level: 'silent' });
    const registry = new TurnActivityRegistry({ logger: quiet });
    const lanes = newLanes(quiet);
    startTarget(registry);
    detachSpecialist(registry);
    startMine(registry);
    await performHandoff({ registry, lanes, logger: quiet, fromTaskEventId: 'mine', targetRootId: 'other-root' });
    const inject = vi.spyOn(lanes, 'tryInjectIntoTask');
    const { bus } = buildRuntime({ registry, lanes, chat: vi.fn(async () => textResponse('ok')) });
    await bus.publish('system', createAgentTask({
      agentId: 'coordinator',
      conversationId: 'scheduler:job-1',
      channelId: 'scheduler',
      senderId: 'scheduler',
      content: 'late',
      syntheticTurn: true,
      parentEventId: 'spec-1',
      metadata: { lateDelegation: { agent: 'research', task: 'find flights' } },
    }));
    expect(inject).not.toHaveBeenCalled();
    expect(registry.takeHeldForWake('other-root')).toHaveLength(1);
  });

  it('a failed tool call is reported as a tool error, not as "can\'t be passed on"', async () => {
    const quiet = pino({ level: 'silent' });
    const registry = new TurnActivityRegistry({ logger: quiet });
    const lanes = newLanes(quiet);
    startTarget(registry);
    await lanes.acquire(targetHolder());
    const toolResults: string[] = [];
    let call = 0;
    const chat = vi.fn(async (params: { messages: Array<{ role: string; content: unknown }> }) => {
      call += 1;
      if (call === 1) return toolUse('turn-handoff', { turn_id: 'other-root' });
      toolResults.push(JSON.stringify(params.messages));
      return textResponse('doing it here');
    });
    const invoke = vi.fn().mockResolvedValue({ success: false, error: 'skill timed out' });
    const { bus } = buildRuntime({ registry, lanes, chat, invoke });
    await bus.publish('dispatch', myTask());
    expect(toolResults[0]).toContain('the hand-off tool failed');
    expect(toolResults[0]).not.toContain("can't be passed on automatically");
    expect(lanes.takeQueued('other-root')).toEqual([]);
  });

  describe('(e) a wake that cannot take a held correction re-runs it on the handing turn', () => {
    async function wakeWith(inject: (lanes: TurnLanes) => void) {
      const quiet = pino({ level: 'silent' });
      const recovered: HandoffRecoveryRequest[] = [];
      const registry = new TurnActivityRegistry({ logger: quiet, recoverHandoff: (r) => { recovered.push(r); } });
      const lanes = newLanes(quiet);
      startTarget(registry);
      detachSpecialist(registry);
      startMine(registry);
      expect(await performHandoff({ registry, lanes, logger: quiet, fromTaskEventId: 'mine', targetRootId: 'other-root' }))
        .toEqual({ kind: 'held_for_wake' });
      inject(lanes);
      const { bus } = buildRuntime({ registry, lanes, chat: vi.fn(async () => textResponse('ok')) });
      await bus.publish('system', createAgentTask({
        agentId: 'coordinator',
        conversationId: TARGET_CONVERSATION,
        channelId: 'sms',
        senderId: CONTACT,
        content: 'The research came back late.',
        syntheticTurn: true,
        parentEventId: 'spec-1',
        metadata: {
          originator: { contactId: CONTACT, channel: 'sms', systemRole: null, tier: 'known' },
          wakeContext: { derived: true },
          lateDelegation: { agent: 'research', task: 'find flights' },
        },
      }));
      await vi.waitFor(() => expect(recovered.length).toBeGreaterThan(0));
      return { recovered, registry };
    }

    it('not injected', async () => {
      const { recovered, registry } = await wakeWith((lanes) => {
        vi.spyOn(lanes, 'tryInjectIntoTask').mockReturnValue({ kind: 'not_injected', reason: 'cap' });
      });
      expect(recovered).toHaveLength(1);
      expect(recovered[0]).toMatchObject({ reason: 'wake_not_injected', targetRootId: 'other-root', input: { content: REQUEST } });
      expect(recovered[0]!.from.rootId).toBe('mine');
      expect(registry.takeHeldForWake('other-root')).toEqual([]);
    });

    it('queued, then returned undrained', async () => {
      const { recovered } = await wakeWith((lanes) => {
        vi.spyOn(lanes, 'tryInjectIntoTask').mockReturnValue({
          kind: 'queued', ticket: Promise.resolve({ kind: 'returned', reason: 'holder_ended' }),
        });
      });
      expect(recovered.map((r) => r.reason)).toEqual(['wake_returned']);
    });

    it('a correction held for an unauthenticated root never reaches its wake (defence in depth)', async () => {
      const quiet = pino({ level: 'silent' });
      const recovered: HandoffRecoveryRequest[] = [];
      const registry = new TurnActivityRegistry({ logger: quiet, recoverHandoff: (r) => { recovered.push(r); } });
      const lanes = newLanes(quiet);
      startTarget(registry, { channelId: 'signal', conversationId: 'signal:+15550002' });
      detachSpecialist(registry);
      startMine(registry);
      // performHandoff refuses this target; hold directly, as a future path skipping the check would.
      expect(registry.rootOf('other-root')!.originatorAuthenticated).toBe(false);
      expect(registry.holdForWake('other-root', {
        inboundEventId: handoffInboundEventId('mine', 'other-root'), senderContactId: CONTACT, senderResolved: true,
        autoGenerated: false, injectionFindingCount: 0, channelId: 'signal', liveTurn: false,
        content: REQUEST, originalContent: REQUEST, receivedAt: INITIATED_AT,
      }, registry.rootOf('mine')!)).toBe(true);
      const inject = vi.spyOn(lanes, 'tryInjectIntoTask');
      const { bus } = buildRuntime({ registry, lanes, chat: vi.fn(async () => textResponse('ok')) });
      await bus.publish('system', createAgentTask({
        agentId: 'coordinator',
        conversationId: 'signal:+15550002',
        channelId: 'signal',
        senderId: CONTACT,
        content: 'The research came back late.',
        syntheticTurn: true,
        parentEventId: 'spec-1',
        metadata: {
          originator: { contactId: CONTACT, channel: 'signal', systemRole: null, tier: 'known' },
          wakeContext: { derived: true },
          lateDelegation: { agent: 'research', task: 'find flights' },
        },
      }));
      expect(inject).not.toHaveBeenCalled();
      expect(recovered.map((r) => r.reason)).toEqual(['wake_not_injected']);
      expect(recovered[0]!.from.rootId).toBe('mine');
      expect(registry.takeHeldForWake('other-root')).toEqual([]);
    });

    it('a throw on one item is caught per item', async () => {
      const { recovered } = await wakeWith((lanes) => {
        vi.spyOn(lanes, 'tryInjectIntoTask').mockImplementation(() => {
          throw new Error('lane broke');
        });
      });
      expect(recovered.map((r) => r.reason)).toEqual(['wake_not_injected']);
    });

    it('queued, then never settled: re-run once after HANDOFF_LOST_AFTER_MS', async () => {
      vi.useFakeTimers();
      const quiet = pino({ level: 'silent' });
      const recovered: HandoffRecoveryRequest[] = [];
      const registry = new TurnActivityRegistry({ logger: quiet, recoverHandoff: (r) => { recovered.push(r); } });
      const lanes = newLanes(quiet);
      startTarget(registry);
      detachSpecialist(registry);
      startMine(registry);
      expect(await performHandoff({ registry, lanes, logger: quiet, fromTaskEventId: 'mine', targetRootId: 'other-root' }))
        .toEqual({ kind: 'held_for_wake' });
      // A retained follow-up whose audit never flushes: the ticket stays pending.
      vi.spyOn(lanes, 'tryInjectIntoTask').mockReturnValue({ kind: 'queued', ticket: new Promise(() => {}) });
      const { bus } = buildRuntime({ registry, lanes, chat: vi.fn(async () => textResponse('ok')) });
      const published = bus.publish('system', createAgentTask({
        agentId: 'coordinator',
        conversationId: TARGET_CONVERSATION,
        channelId: 'sms',
        senderId: CONTACT,
        content: 'The research came back late.',
        syntheticTurn: true,
        parentEventId: 'spec-1',
        metadata: {
          originator: { contactId: CONTACT, channel: 'sms', systemRole: null, tier: 'known' },
          wakeContext: { derived: true },
          lateDelegation: { agent: 'research', task: 'find flights' },
        },
      }));
      await vi.advanceTimersByTimeAsync(HANDOFF_LOST_AFTER_MS - 1_000);
      await published;
      expect(recovered).toEqual([]);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(recovered.map((r) => r.reason)).toEqual(['unresolved']);
      expect(recovered[0]!.from.rootId).toBe('mine');
      await vi.advanceTimersByTimeAsync(HANDOFF_LOST_AFTER_MS);
      expect(recovered).toHaveLength(1);
    });
  });
});

describe('watchHeldCorrectionTicket (#2588)', () => {
  function watched() {
    const spy = spyLogger();
    const recovered: HandoffRecoveryRequest[] = [];
    const registry = new TurnActivityRegistry({ logger: spy.logger, recoverHandoff: (r) => { recovered.push(r); } });
    startMine(registry);
    let settle!: (result: TicketResult) => void;
    const ticket = new Promise<TicketResult>((resolve) => { settle = resolve; });
    const held: HeldCorrection = {
      from: registry.rootOf('mine')!,
      input: {
        inboundEventId: handoffInboundEventId('mine', 'other-root'), senderContactId: CONTACT, senderResolved: true,
        autoGenerated: false, injectionFindingCount: 0, channelId: 'signal', liveTurn: false,
        content: REQUEST, originalContent: REQUEST, receivedAt: INITIATED_AT,
      },
    };
    watchHeldCorrectionTicket({ registry, logger: spy.logger, ticket, held, targetRootId: 'other-root', logIds: {} });
    return { ...spy, recovered, settle };
  }

  it('a drain in time recovers nothing, and the timer is cleared', async () => {
    vi.useFakeTimers();
    const { recovered, settle } = watched();
    settle({ kind: 'drained', hostTaskEventId: 'wake-1' });
    await vi.advanceTimersByTimeAsync(2 * HANDOFF_LOST_AFTER_MS);
    expect(recovered).toEqual([]);
  });

  it('a return re-runs it once, and the timer never fires a second', async () => {
    vi.useFakeTimers();
    const { recovered, settle } = watched();
    settle({ kind: 'returned', reason: 'holder_ended' });
    await vi.advanceTimersByTimeAsync(2 * HANDOFF_LOST_AFTER_MS);
    expect(recovered.map((r) => r.reason)).toEqual(['wake_returned']);
  });

  it('after the timer recovers, a late return does not recover again and a late drain is logged', async () => {
    vi.useFakeTimers();
    const first = watched();
    await vi.advanceTimersByTimeAsync(HANDOFF_LOST_AFTER_MS);
    expect(first.recovered.map((r) => r.reason)).toEqual(['unresolved']);
    first.settle({ kind: 'returned', reason: 'holder_ended' });
    await vi.advanceTimersByTimeAsync(0);
    expect(first.recovered).toHaveLength(1);

    const second = watched();
    await vi.advanceTimersByTimeAsync(HANDOFF_LOST_AFTER_MS);
    second.settle({ kind: 'drained', hostTaskEventId: 'wake-1' });
    await vi.advanceTimersByTimeAsync(0);
    expect(second.recovered).toHaveLength(1);
    expect(second.warn).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('drained by its wake after it was re-run'));
  });
});
