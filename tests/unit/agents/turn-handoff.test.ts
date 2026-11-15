// Cross-conversation hand-off (#2588). A person's new turn passes a correction to their own
// turn still running on another one-to-one conversation, or holds it for that turn's wake when
// only a detached specialist is still working. Everything else tells the model to do it itself.

import { describe, it, expect, vi, afterEach } from 'vitest';
import pino from 'pino';
import {
  HANDOFF_DRAIN_WAIT_MS,
  handoffOutcomeText,
  performHandoff,
  type HandoffOutcome,
} from '../../../src/agents/turn-handoff.js';
import { TurnActivityRegistry, type TaskStartInput } from '../../../src/dispatch/turn-activity.js';
import { TurnLanes, type LaneHolder } from '../../../src/dispatch/turn-lanes.js';
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
const TARGET_CONVERSATION = 'sms:+15550001';
const REQUEST = 'actually make it Tuesday';

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
    channelId: 'sms',
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
    metadata: { inboundSenderText: REQUEST, inboundScanFindingCount: 0, ...metadata },
    ...over,
  });
}

/** The target: the same person's coordinator turn on a one-to-one SMS conversation. */
function startTarget(registry: TurnActivityRegistry, over: Partial<TaskStartInput> = {}): void {
  startTask(registry, {
    taskEventId: 'other-root',
    channelId: 'sms',
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
    liveTurn: true,
    synthetic: false,
    ...over,
  };
}

function setup() {
  const spy = spyLogger();
  const registry = new TurnActivityRegistry({ logger: spy.logger });
  const lanes = newLanes(spy.logger);
  const run = (over: { targetRootId?: string; senderLabel?: string } = {}) => performHandoff({
    registry,
    lanes,
    logger: spy.logger,
    fromTaskEventId: 'mine',
    targetRootId: over.targetRootId ?? 'other-root',
    ...(over.senderLabel !== undefined && { senderLabel: over.senderLabel }),
  });
  return { ...spy, registry, lanes, run };
}

/** A specialist delegated from the target, still running after its coordinator ended. */
function detachSpecialist(registry: TurnActivityRegistry): void {
  startTask(registry, {
    taskEventId: 'spec-1',
    agentId: 'research',
    conversationId: 'delegate-1',
    channelId: 'internal',
    metadata: { delegationOrigin: { taskEventId: 'other-root', conversationId: TARGET_CONVERSATION } },
  });
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

    const pending = run({ senderLabel: 'Ada' });
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

  it('a drain past the wait is queued, and a later return is held for the wake', async () => {
    vi.useFakeTimers();
    const { registry, lanes, run } = setup();
    startTarget(registry);
    startMine(registry);
    await lanes.acquire(targetHolder());

    const pending = run();
    await vi.advanceTimersByTimeAsync(HANDOFF_DRAIN_WAIT_MS);
    expect(await pending).toEqual({ kind: 'queued' });

    // The target's coordinator ends without draining; a specialist still runs under the root.
    detachSpecialist(registry);
    lanes.release('other-root');
    await vi.runAllTimersAsync();
    expect(registry.takeHeldForWake('other-root').map((i) => i.content)).toEqual([REQUEST]);
  });

  it('a late return with nothing left running logs the lost correction at error', async () => {
    vi.useFakeTimers();
    const { registry, lanes, run, error } = setup();
    startTarget(registry);
    startMine(registry);
    await lanes.acquire(targetHolder());

    const pending = run();
    await vi.advanceTimersByTimeAsync(HANDOFF_DRAIN_WAIT_MS);
    expect(await pending).toEqual({ kind: 'queued' });
    registry.taskEnded('other-root');
    lanes.release('other-root');
    await vi.runAllTimersAsync();
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ targetRootId: 'other-root', fromTaskEventId: 'mine' }),
      expect.any(String),
    );
  });

  it('a return inside the wait is held when the root still runs, else finished', async () => {
    const first = setup();
    startTarget(first.registry);
    startMine(first.registry);
    await first.lanes.acquire(targetHolder());
    const pending = first.run();
    detachSpecialist(first.registry);
    first.lanes.release('other-root');
    expect(await pending).toEqual({ kind: 'held_for_wake' });

    const second = setup();
    startTarget(second.registry);
    startMine(second.registry);
    await second.lanes.acquire(targetHolder());
    const pending2 = second.run();
    second.registry.taskEnded('other-root');
    second.lanes.release('other-root');
    expect(await pending2).toEqual({ kind: 'do_it_yourself', reason: 'finished' });
  });

  it('holds for wake when only a specialist is running', async () => {
    const { registry, run } = setup();
    startTarget(registry);
    detachSpecialist(registry);
    startMine(registry);
    expect(await run()).toEqual({ kind: 'held_for_wake' });
    const held = registry.takeHeldForWake('other-root');
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ content: REQUEST, handedOverFrom: { channelId: 'signal', conversationLabel: 'Signal' } });
  });

  it('refuses a multi-participant target', async () => {
    const { registry, lanes, run } = setup();
    // A Signal group is not one-to-one.
    startTarget(registry, { channelId: 'signal', conversationId: 'signal:group=abc' });
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

  it('an unknown turn id is finished', async () => {
    const { registry, run } = setup();
    startMine(registry);
    expect(await run({ targetRootId: 'no-such-turn' })).toEqual({ kind: 'do_it_yourself', reason: 'finished' });
  });

  it('a target outside the window is finished, or not the same person', async () => {
    const { registry, run } = setup();
    // Started and ended well before my window opened.
    startTarget(registry, { startedAt: Date.now() - 60 * 60_000 });
    registry.taskEnded('other-root');
    // Ended now, but my turn's window looks back from my own start: start mine far later.
    startMine(registry, {}, { startedAt: Date.now() + 60 * 60_000 });
    expect(await run()).toEqual({ kind: 'do_it_yourself', reason: 'finished' });

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

  it('an exception fails open to do_it_yourself and logs at error', async () => {
    const { registry, run, error } = setup();
    startTarget(registry);
    startMine(registry);
    vi.spyOn(registry, 'otherRootsInWindow').mockImplementation(() => {
      throw new Error('registry down');
    });
    expect(await run()).toEqual({ kind: 'do_it_yourself', reason: 'ineligible' });
    expect(error).toHaveBeenCalled();
  });
});

describe('handoffOutcomeText', () => {
  it('uses the fixed copy for each outcome', () => {
    const passed = "Passed on to the turn already doing that work. Tell them briefly you've passed it on; don't do the work here.";
    expect(handoffOutcomeText({ kind: 'delivered' })).toBe(passed);
    expect(handoffOutcomeText({ kind: 'queued' })).toBe(passed);
    expect(handoffOutcomeText({ kind: 'held_for_wake' })).toBe(
      "That work is still finishing in the background; the change will be applied when it lands. Tell them so briefly; don't do the work here.",
    );
    const reasons: Extract<HandoffOutcome, { kind: 'do_it_yourself' }>['reason'][] = [
      'finished', 'not_same_person', 'not_one_to_one', 'cap', 'closing', 'ineligible',
    ];
    for (const reason of reasons) {
      const textOut = handoffOutcomeText({ kind: 'do_it_yourself', reason });
      expect(textOut).toMatch(/^Couldn't hand this over \([^)]+\)\. Do the work here yourself; the other turn's actions are listed above, so adjust them rather than repeat them\.$/);
    }
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

const ORIGINATOR = { contactId: CONTACT, channel: 'signal', systemRole: null, tier: 'known' };

function myTask(over: Partial<AgentTaskEvent['payload']> = {}): AgentTaskEvent {
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
}) {
  const logger = createLogger('error');
  const bus = new EventBus(logger);
  bus.subscribe('agent.response', 'dispatch', () => {});
  const tools = ['signal-send', 'turn-handoff'].map(toolDef);
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
    const chat = vi.fn(async (params: { messages: Array<{ role: string; content: unknown }> }) => {
      prompts.push(JSON.stringify(params.messages));
      return textResponse('applied');
    });
    const inject = vi.spyOn(lanes, 'tryInjectIntoTask');
    const { bus } = buildRuntime({ registry, lanes, chat });
    const wake = createAgentTask({
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
    });
    await bus.publish('system', wake);

    expect(inject).toHaveBeenCalledWith(wake.id, expect.objectContaining({ content: REQUEST }));
    expect(prompts[0]).toContain(REQUEST);
    expect(prompts[0]).toContain('Handed over from');
    expect(registry.takeHeldForWake('other-root')).toEqual([]);
  });
});
