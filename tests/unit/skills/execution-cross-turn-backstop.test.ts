// Cross-conversation pre-action backstop in the execution layer (#2588).
//
// A risky call (action_risk >= medium) whose target another root turn already acted on is
// held once with a message naming that action; the re-issued call runs. Setup follows
// execution.policy.test.ts: a real ToolRegistry, stub handlers, and stub services.

import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { ToolRegistry } from '../../../src/skills/registry.js';
import { ExecutionLayer } from '../../../src/skills/execution.js';
import type { ToolHandler, ToolManifest } from '../../../src/skills/types.js';
import type { ContactService } from '../../../src/contacts/contact-service.js';
import type { ChannelIdentity } from '../../../src/contacts/types.js';
import { TurnActivityRegistry } from '../../../src/dispatch/turn-activity.js';
import type { Logger } from '../../../src/logger.js';

const logger = pino({ level: 'silent' });

const PRINCIPAL = '00000000-0000-4000-8000-000000000001';
const ALICE = '00000000-0000-4000-8000-0000000000a1';
const BOB = '00000000-0000-4000-8000-0000000000b2';

const PRINCIPAL_IDENTITIES: ChannelIdentity[] = [
  {
    id: 'id-signal',
    contactId: PRINCIPAL,
    channel: 'signal',
    channelIdentifier: '+15551234567',
    label: null,
    verified: true,
    verifiedAt: new Date(),
    status: 'active',
    source: 'ceo_stated',
    createdAt: new Date(),
    updatedAt: new Date(),
  },
];

function makeRiskyManifest(name: string, actionRisk: 'none' | 'low' | 'medium' | 'high' | 'critical'): ToolManifest {
  return {
    name,
    description: `${name} description`,
    version: '1.0.0',
    sensitivity: 'normal',
    action_risk: actionRisk,
    inputs: {},
    outputs: {},
    permissions: [],
    secrets: [],
    timeout: 5000,
  };
}

function makeHandler(): ToolHandler & { execute: ReturnType<typeof vi.fn> } {
  return { execute: vi.fn().mockResolvedValue({ success: true, data: 'ok' }) };
}

function makeContacts(): ContactService {
  const contacts: Record<string, { id: string; displayName: string }> = {
    [PRINCIPAL]: { id: PRINCIPAL, displayName: 'Principal' },
    [ALICE]: { id: ALICE, displayName: 'Alice Example' },
    [BOB]: { id: BOB, displayName: 'Bob Example' },
  };
  return {
    getContact: vi.fn(async (id: string) => contacts[id]),
    getContactWithIdentities: vi.fn(async (id: string) => (id === PRINCIPAL
      ? { contact: { ...contacts[PRINCIPAL]!, primaryEmail: null, primaryPhone: null }, identities: PRINCIPAL_IDENTITIES }
      : undefined)),
    getIdentitiesForContact: vi.fn().mockResolvedValue([]),
  } as unknown as ContactService;
}

function setup(opts?: { logger?: Logger }) {
  const registry = new ToolRegistry();
  const turnActivity = new TurnActivityRegistry({ logger });
  const layer = new ExecutionLayer(registry, opts?.logger ?? logger, {
    contactService: makeContacts(),
    principalIdentities: PRINCIPAL_IDENTITIES,
    timezone: 'America/Toronto',
    turnActivity,
  });
  return { registry, layer, turnActivity };
}

function startRoot(
  turnActivity: TurnActivityRegistry,
  taskEventId: string,
  extra?: {
    channelId?: string;
    content?: string;
    originatorContactId?: string | null;
    originatorResolved?: boolean;
    originatorIsSystem?: boolean;
  },
) {
  return turnActivity.taskStarted({
    taskEventId,
    agentId: 'coordinator',
    conversationId: `conv-${taskEventId}`,
    channelId: extra?.channelId ?? 'signal',
    parentEventId: undefined,
    metadata: undefined,
    content: extra?.content ?? 'please do the thing',
    startedAt: Date.now(),
    originatorContactId: extra?.originatorContactId === undefined ? PRINCIPAL : extra.originatorContactId,
    originatorResolved: extra?.originatorResolved ?? extra?.originatorContactId !== null,
    // No originator is Curia's own work, as the runtime classifies it.
    originatorIsSystem: extra?.originatorIsSystem ?? extra?.originatorContactId === null,
  });
}

function opts(taskEventId: string, extra?: { channelId?: string; humanApproved?: boolean; originator?: unknown }) {
  return {
    taskEventId,
    agentId: 'coordinator',
    channelId: extra?.channelId ?? 'signal',
    conversationId: `conv-${taskEventId}`,
    taskMetadata: {
      originator: extra?.originator === undefined
        ? { contactId: PRINCIPAL, systemRole: 'principal', channel: 'signal', initiatedAt: new Date().toISOString() }
        : extra.originator,
    },
    ...(extra?.humanApproved ? { humanApproved: true } : {}),
  };
}

describe('ExecutionLayer cross-turn backstop (#2588)', () => {
  it("second turn's send to the same contact is held once, then runs", async () => {
    const { registry, layer, turnActivity } = setup();
    const handler = makeHandler();
    registry.register(makeRiskyManifest('contact-message', 'medium'), handler);
    startRoot(turnActivity, 'task-a');
    startRoot(turnActivity, 'task-b');

    const first = await layer.invoke('contact-message', { contact_id: ALICE, text: 'hi' }, undefined, opts('task-a'));
    expect(first.success).toBe(true);
    expect(handler.execute).toHaveBeenCalledTimes(1);

    const held = await layer.invoke('contact-message', { contact_id: ALICE, text: 'hi' }, undefined, opts('task-b'));
    expect(held.success).toBe(false);
    if (held.success) throw new Error('expected a held result');
    expect(held.error).toContain('<skill_error>');
    expect(held.error).toContain("another conversation's turn");
    expect(held.error).toContain('contact-message on "Alice Example" at ');
    expect(held.error).toContain('call it again unchanged');
    expect(held).not.toHaveProperty('gate');
    expect(handler.execute).toHaveBeenCalledTimes(1);

    const retried = await layer.invoke('contact-message', { contact_id: ALICE, text: 'hi' }, undefined, opts('task-b'));
    expect(retried.success).toBe(true);
    expect(handler.execute).toHaveBeenCalledTimes(2);
  });

  it('unrelated sends are never held', async () => {
    const { registry, layer, turnActivity } = setup();
    const handler = makeHandler();
    registry.register(makeRiskyManifest('contact-message', 'medium'), handler);
    startRoot(turnActivity, 'task-a');
    startRoot(turnActivity, 'task-b');

    expect((await layer.invoke('contact-message', { contact_id: ALICE }, undefined, opts('task-a'))).success).toBe(true);
    expect((await layer.invoke('contact-message', { contact_id: BOB }, undefined, opts('task-b'))).success).toBe(true);
    expect(handler.execute).toHaveBeenCalledTimes(2);
  });

  it('low-risk tool is not checked', async () => {
    const { registry, layer, turnActivity } = setup();
    const handler = makeHandler();
    registry.register(makeRiskyManifest('contact-note', 'low'), handler);
    startRoot(turnActivity, 'task-a');
    startRoot(turnActivity, 'task-b');

    expect((await layer.invoke('contact-note', { contact_id: ALICE }, undefined, opts('task-a'))).success).toBe(true);
    expect((await layer.invoke('contact-note', { contact_id: ALICE }, undefined, opts('task-b'))).success).toBe(true);
    expect(handler.execute).toHaveBeenCalledTimes(2);
    expect(turnActivity.actionsOf('task-a')).toHaveLength(0);
  });

  it('principal-only send is exempt', async () => {
    const { registry, layer, turnActivity } = setup();
    const handler = makeHandler();
    registry.register(makeRiskyManifest('signal-send', 'medium'), handler);
    startRoot(turnActivity, 'task-a');
    startRoot(turnActivity, 'task-b');

    const input = { recipient: 'principal', message: 'Done.' };
    expect((await layer.invoke('signal-send', { ...input }, undefined, opts('task-a'))).success).toBe(true);
    expect((await layer.invoke('signal-send', { ...input }, undefined, opts('task-b'))).success).toBe(true);
    expect(handler.execute).toHaveBeenCalledTimes(2);
    expect(turnActivity.actionsOf('task-a')).toHaveLength(0);
    expect(turnActivity.actionsOf('task-b')).toHaveLength(0);
  });

  it('human-approved replay is never held, but is recorded for later turns', async () => {
    const { registry, layer, turnActivity } = setup();
    const handler = makeHandler();
    registry.register(makeRiskyManifest('contact-message', 'medium'), handler);
    startRoot(turnActivity, 'task-a');
    startRoot(turnActivity, 'task-b');
    startRoot(turnActivity, 'task-c');

    expect((await layer.invoke('contact-message', { contact_id: ALICE }, undefined, opts('task-a'))).success).toBe(true);
    const approved = await layer.invoke(
      'contact-message', { contact_id: ALICE }, undefined, opts('task-b', { humanApproved: true }),
    );
    expect(approved.success).toBe(true);
    expect(handler.execute).toHaveBeenCalledTimes(2);
    expect(turnActivity.actionsOf('task-b')).toHaveLength(1);
    expect(turnActivity.actionsOf('task-b')[0]!.outcome).toBe('succeeded');

    // With the first turn's action gone, the approved send alone still holds a third turn.
    for (const action of turnActivity.actionsOf('task-a')) turnActivity.settle(action.actionId, 'failed');
    const held = await layer.invoke('contact-message', { contact_id: ALICE }, undefined, opts('task-c'));
    expect(held.success).toBe(false);
    if (held.success) throw new Error('expected a held result');
    expect(held.error).toContain('already did this');
    expect(handler.execute).toHaveBeenCalledTimes(2);
  });

  it('a risky call with no task id is logged at warn and runs unchecked', async () => {
    const childLogger: Logger = pino({ level: 'silent' });
    const warnSpy = vi.spyOn(childLogger, 'warn');
    const parentLogger: Logger = pino({ level: 'silent' });
    vi.spyOn(parentLogger, 'child').mockReturnValue(childLogger as unknown as ReturnType<Logger['child']>);
    const { registry, layer } = setup({ logger: parentLogger });
    const handler = makeHandler();
    registry.register(makeRiskyManifest('contact-message', 'medium'), handler);

    const result = await layer.invoke('contact-message', { contact_id: ALICE }, undefined, { agentId: 'coordinator' });
    expect(result.success).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'contact-message' }), expect.stringContaining('no task id'));
  });

  it('voice session id is auto-rooted and checked', async () => {
    const { registry, layer, turnActivity } = setup();
    const handler = makeHandler();
    registry.register(makeRiskyManifest('contact-message', 'medium'), handler);

    const voice = await layer.invoke(
      'contact-message', { contact_id: ALICE }, undefined, opts('voice-session-1', { channelId: 'voice' }),
    );
    expect(voice.success).toBe(true);
    const root = turnActivity.rootOf('voice-session-1');
    expect(root?.autoRegistered).toBe(true);
    expect(root?.channelId).toBe('voice');
    expect(root?.originatorContactId).toBe(PRINCIPAL);
    expect(root?.originatorResolved).toBe(true);
    expect(turnActivity.actionsOf('voice-session-1')).toHaveLength(1);

    startRoot(turnActivity, 'task-b');
    const held = await layer.invoke('contact-message', { contact_id: ALICE }, undefined, opts('task-b'));
    expect(held.success).toBe(false);
    expect(handler.execute).toHaveBeenCalledTimes(1);
  });

  it('scheduler turn is checked like any other', async () => {
    const { registry, layer, turnActivity } = setup();
    const handler = makeHandler();
    registry.register(makeRiskyManifest('contact-message', 'medium'), handler);
    startRoot(turnActivity, 'task-a');
    startRoot(turnActivity, 'sched-1', { channelId: 'scheduler', originatorContactId: null });

    expect((await layer.invoke('contact-message', { contact_id: ALICE }, undefined, opts('task-a'))).success).toBe(true);
    const held = await layer.invoke(
      'contact-message', { contact_id: ALICE }, undefined, opts('sched-1', { channelId: 'scheduler', originator: null }),
    );
    expect(held.success).toBe(false);
    if (held.success) throw new Error('expected a held result');
    expect(held.error).toContain("another conversation's turn");
    expect(handler.execute).toHaveBeenCalledTimes(1);
  });

  it('held text has no request text', async () => {
    const { registry, layer, turnActivity } = setup();
    const handler = makeHandler();
    registry.register(makeRiskyManifest('contact-message', 'medium'), handler);
    startRoot(turnActivity, 'task-a', { content: 'secret plan' });
    startRoot(turnActivity, 'task-b');

    expect((await layer.invoke('contact-message', { contact_id: ALICE, text: 'body one' }, undefined, opts('task-a'))).success).toBe(true);
    const held = await layer.invoke('contact-message', { contact_id: ALICE, text: 'body two' }, undefined, opts('task-b'));
    expect(held.success).toBe(false);
    if (held.success) throw new Error('expected a held result');
    expect(held.error).not.toContain('secret plan');
    expect(held.error).not.toContain('body one');
  });

  describe('hold disclosure', () => {
    const GENERIC = 'Another conversation already acted on this same target recently.';
    const ISO_TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

    async function holdSeenBy(
      actor: string | null,
      viewer: string | null,
      viewerChannel = 'signal',
      viewerExtra: { originatorIsSystem?: boolean } = {},
    ) {
      const { registry, layer, turnActivity } = setup();
      const handler = makeHandler();
      registry.register(makeRiskyManifest('contact-message', 'medium'), handler);
      startRoot(turnActivity, 'task-a', { originatorContactId: actor });
      startRoot(turnActivity, 'task-b', { originatorContactId: viewer, channelId: viewerChannel, ...viewerExtra });
      expect((await layer.invoke('contact-message', { contact_id: ALICE }, undefined, opts('task-a'))).success).toBe(true);
      const held = await layer.invoke('contact-message', { contact_id: ALICE }, undefined, opts('task-b', { channelId: viewerChannel }));
      expect(held.success).toBe(false);
      if (held.success) throw new Error('expected a held result');
      expect(handler.execute).toHaveBeenCalledTimes(1);
      expect(held.error).toContain("Not run yet: another conversation's turn already acted on the same target.");
      expect(held.error).toContain('call it again unchanged');
      return held.error;
    }

    it("a different person sees no tool, name or time of the principal's action", async () => {
      const text = await holdSeenBy(PRINCIPAL, BOB);
      expect(text).toContain(GENERIC);
      expect(text).not.toContain('contact-message');
      expect(text).not.toContain('Alice Example');
      expect(text).not.toMatch(ISO_TIME);
    });

    it("the principal sees the details of another person's action", async () => {
      const text = await holdSeenBy(BOB, PRINCIPAL);
      expect(text).toContain('contact-message on "Alice Example" at ');
      expect(text).toMatch(ISO_TIME);
      expect(text).not.toContain(GENERIC);
    });

    it('the same resolved contact sees the details', async () => {
      const text = await holdSeenBy(BOB, BOB);
      expect(text).toContain('contact-message on "Alice Example" at ');
    });

    it('a system turn sees the details', async () => {
      const text = await holdSeenBy(BOB, null, 'scheduler');
      expect(text).toContain('contact-message on "Alice Example" at ');
    });

    it('a turn whose originator has the agent role is system and sees the details', async () => {
      const text = await holdSeenBy(BOB, '00000000-0000-4000-8000-00000000a6e7', 'scheduler', { originatorIsSystem: true });
      expect(text).toContain('contact-message on "Alice Example" at ');
    });

    it('an internal turn carrying a non-principal contact gets the generic line', async () => {
      // Channel internal used to mean system; it is the originator that decides now.
      const text = await holdSeenBy(PRINCIPAL, BOB, 'internal');
      expect(text).toContain(GENERIC);
      expect(text).not.toContain('Alice Example');
    });
  });

  it('a call refused by a later gate is not recorded', async () => {
    const { registry, layer, turnActivity } = setup();
    const handler = makeHandler();
    // The executionLayer capability is reserved for approve-action: refused after the targets are read.
    registry.register({ ...makeRiskyManifest('contact-message', 'medium'), capabilities: ['executionLayer'] }, handler);
    startRoot(turnActivity, 'task-a');

    const result = await layer.invoke('contact-message', { contact_id: ALICE }, undefined, opts('task-a'));
    expect(result.success).toBe(false);
    expect(handler.execute).not.toHaveBeenCalled();
    expect(turnActivity.actionsOf('task-a')).toHaveLength(0);
  });

  it('an auto root with an unresolved originator is stored unresolved', async () => {
    const { registry, layer, turnActivity } = setup();
    registry.register(makeRiskyManifest('contact-message', 'medium'), makeHandler());
    const originator = { contactId: '+15550001111', channel: 'signal', systemRole: null, tier: 'unknown' };

    await layer.invoke('contact-message', { contact_id: ALICE }, undefined, opts('voice-session-2', { channelId: 'voice', originator }));
    const root = turnActivity.rootOf('voice-session-2');
    expect(root?.autoRegistered).toBe(true);
    expect(root?.originatorContactId).toBe('+15550001111');
    expect(root?.originatorResolved).toBe(false);
  });

  it('registry failure fails open', async () => {
    const childLogger: Logger = pino({ level: 'silent' });
    const errorSpy = vi.spyOn(childLogger, 'error');
    const parentLogger: Logger = pino({ level: 'silent' });
    // Every skill logger is this child, so the layer's error log lands on errorSpy.
    vi.spyOn(parentLogger, 'child').mockReturnValue(childLogger as unknown as ReturnType<Logger['child']>);
    const { registry, layer, turnActivity } = setup({ logger: parentLogger });
    const handler = makeHandler();
    registry.register(makeRiskyManifest('contact-message', 'medium'), handler);
    startRoot(turnActivity, 'task-a');
    vi.spyOn(turnActivity, 'checkAndRecord').mockImplementation(() => {
      throw new Error('registry exploded');
    });

    const result = await layer.invoke('contact-message', { contact_id: ALICE }, undefined, opts('task-a'));
    expect(result.success).toBe(true);
    expect(handler.execute).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'contact-message', taskEventId: 'task-a' }),
      expect.any(String),
    );
  });
});

describe('ExecutionLayer cross-turn backstop outcomes (#2588)', () => {
  it('a failed call is dropped, so the next turn is not held', async () => {
    const { registry, layer, turnActivity } = setup();
    const handler = makeHandler();
    handler.execute.mockResolvedValueOnce({ success: false, error: 'provider refused' });
    registry.register(makeRiskyManifest('contact-message', 'medium'), handler);
    startRoot(turnActivity, 'task-a');
    startRoot(turnActivity, 'task-b');

    expect((await layer.invoke('contact-message', { contact_id: ALICE }, undefined, opts('task-a'))).success).toBe(false);
    expect(turnActivity.actionsOf('task-a')).toHaveLength(0);
    expect((await layer.invoke('contact-message', { contact_id: ALICE }, undefined, opts('task-b'))).success).toBe(true);
    expect(handler.execute).toHaveBeenCalledTimes(2);
  });

  it('a thrown handler error drops the call too', async () => {
    const { registry, layer, turnActivity } = setup();
    const handler = makeHandler();
    handler.execute.mockRejectedValueOnce(new Error('boom'));
    registry.register(makeRiskyManifest('contact-message', 'medium'), handler);
    startRoot(turnActivity, 'task-a');

    expect((await layer.invoke('contact-message', { contact_id: ALICE }, undefined, opts('task-a'))).success).toBe(false);
    expect(turnActivity.actionsOf('task-a')).toHaveLength(0);
  });

  it('a call still running holds the other turn with "right now"', async () => {
    const { registry, layer, turnActivity } = setup();
    let finish: (r: { success: true; data: string }) => void = () => {};
    const handler = makeHandler();
    handler.execute.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    registry.register(makeRiskyManifest('contact-message', 'medium'), handler);
    startRoot(turnActivity, 'task-a');
    startRoot(turnActivity, 'task-b');

    const first = layer.invoke('contact-message', { contact_id: ALICE }, undefined, opts('task-a'));
    await vi.waitFor(() => expect(handler.execute).toHaveBeenCalledTimes(1));
    expect(turnActivity.actionsOf('task-a')[0]!.outcome).toBe('pending');

    const held = await layer.invoke('contact-message', { contact_id: ALICE }, undefined, opts('task-b'));
    expect(held.success).toBe(false);
    if (held.success) throw new Error('expected a held result');
    expect(held.error).toContain('is doing this right now');

    finish({ success: true, data: 'ok' });
    expect((await first).success).toBe(true);
    expect(turnActivity.actionsOf('task-a')[0]!.outcome).toBe('succeeded');
  });

  it('a succeeded call holds with "already did this"', async () => {
    const { registry, layer, turnActivity } = setup();
    registry.register(makeRiskyManifest('contact-message', 'medium'), makeHandler());
    startRoot(turnActivity, 'task-a');
    startRoot(turnActivity, 'task-b');

    await layer.invoke('contact-message', { contact_id: ALICE }, undefined, opts('task-a'));
    const held = await layer.invoke('contact-message', { contact_id: ALICE }, undefined, opts('task-b'));
    if (held.success) throw new Error('expected a held result');
    expect(held.error).toContain('already did this');
  });

  it('a timed-out call stays recorded with an unknown outcome', async () => {
    const { registry, layer, turnActivity } = setup();
    const handler = makeHandler();
    handler.execute.mockImplementationOnce(() => new Promise(() => {}));
    registry.register({ ...makeRiskyManifest('contact-message', 'medium'), timeout: 20 }, handler);
    startRoot(turnActivity, 'task-a');
    startRoot(turnActivity, 'task-b');

    const result = await layer.invoke('contact-message', { contact_id: ALICE }, undefined, opts('task-a'));
    expect(result.success).toBe(false);
    expect(turnActivity.actionsOf('task-a')[0]!.outcome).toBe('unknown');
    const held = await layer.invoke('contact-message', { contact_id: ALICE }, undefined, opts('task-b'));
    if (held.success) throw new Error('expected a held result');
    expect(held.error).toContain('tried this; the outcome is unknown');
  });

  it('a settle failure is logged and the result still returns', async () => {
    const childLogger: Logger = pino({ level: 'silent' });
    const errorSpy = vi.spyOn(childLogger, 'error');
    const parentLogger: Logger = pino({ level: 'silent' });
    vi.spyOn(parentLogger, 'child').mockReturnValue(childLogger as unknown as ReturnType<Logger['child']>);
    const { registry, layer, turnActivity } = setup({ logger: parentLogger });
    registry.register(makeRiskyManifest('contact-message', 'medium'), makeHandler());
    startRoot(turnActivity, 'task-a');
    vi.spyOn(turnActivity, 'settle').mockImplementation(() => {
      throw new Error('settle exploded');
    });

    const result = await layer.invoke('contact-message', { contact_id: ALICE }, undefined, opts('task-a'));
    expect(result.success).toBe(true);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'contact-message', taskEventId: 'task-a', outcome: 'succeeded' }),
      expect.any(String),
    );
  });
});

describe('ExecutionLayer cross-turn backstop logging and fallbacks (#2588)', () => {
  function spiedLoggers() {
    const child: Logger = pino({ level: 'silent' });
    const parent: Logger = pino({ level: 'silent' });
    vi.spyOn(parent, 'child').mockReturnValue(child as unknown as ReturnType<Logger['child']>);
    return {
      parent,
      warn: vi.spyOn(child, 'warn'),
      error: vi.spyOn(child, 'error'),
      debug: vi.spyOn(child, 'debug'),
      parentWarn: vi.spyOn(parent, 'warn'),
    };
  }

  it('warns once at construction when the registry has no contact service', () => {
    const { parent, parentWarn } = spiedLoggers();
    new ExecutionLayer(new ToolRegistry(), parent, { turnActivity: new TurnActivityRegistry({ logger }) });
    const backstopWarns = () => parentWarn.mock.calls.filter((c) => String(c[0]).includes('no contact service'));
    expect(backstopWarns()).toHaveLength(1);
    parentWarn.mockClear();
    new ExecutionLayer(new ToolRegistry(), parent, { turnActivity: new TurnActivityRegistry({ logger }), contactService: makeContacts() });
    expect(backstopWarns()).toHaveLength(0);
  });

  it('a failure building the hold message still holds, with the generic text and an error log', async () => {
    const spies = spiedLoggers();
    const { registry, layer, turnActivity } = setup({ logger: spies.parent });
    const handler = makeHandler();
    registry.register(makeRiskyManifest('contact-message', 'medium'), handler);
    startRoot(turnActivity, 'task-a');
    startRoot(turnActivity, 'task-b');
    await layer.invoke('contact-message', { contact_id: ALICE }, undefined, opts('task-a'));

    const original = turnActivity.rootOf.bind(turnActivity);
    let calls = 0;
    vi.spyOn(turnActivity, 'rootOf').mockImplementation((id) => {
      calls += 1;
      // The first lookup is the async half's; the second is the hold message's viewer.
      if (calls === 2) throw new Error('viewer lookup exploded');
      return original(id);
    });
    const held = await layer.invoke('contact-message', { contact_id: ALICE }, undefined, opts('task-b'));
    expect(held.success).toBe(false);
    if (held.success) throw new Error('expected a held result');
    expect(held.error).toContain('Another conversation already acted on this same target recently.');
    expect(held.error).not.toContain('Alice Example');
    expect(handler.execute).toHaveBeenCalledTimes(1);
    expect(spies.error).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'contact-message', taskEventId: 'task-b' }),
      expect.stringContaining('generic'),
    );
  });

  it('a name lookup that finds no contact logs at debug; one that fails warns with the task id', async () => {
    const spies = spiedLoggers();
    const { registry, layer, turnActivity } = setup({ logger: spies.parent });
    registry.register(makeRiskyManifest('contact-message', 'medium'), makeHandler());
    startRoot(turnActivity, 'task-a', { originatorContactId: BOB });
    startRoot(turnActivity, 'task-b');
    await layer.invoke('contact-message', { contact_id: ALICE }, undefined, opts('task-a'));

    // From here on: Alice's name is gone, Bob's lookup fails. Target extraction still sees Alice.
    const contacts = (layer as unknown as { contactService: ContactService }).contactService;
    const getContact = vi.mocked(contacts.getContact);
    getContact.mockImplementation(async (id: string) => {
      if (id === BOB) throw new Error('db down');
      return id === ALICE ? ({ id: ALICE, displayName: 'Alice Example' } as Awaited<ReturnType<ContactService['getContact']>>) : undefined;
    });
    getContact.mockImplementationOnce(async () => ({ id: ALICE, displayName: 'Alice Example' } as Awaited<ReturnType<ContactService['getContact']>>));
    getContact.mockImplementationOnce(async () => undefined);

    const held = await layer.invoke('contact-message', { contact_id: ALICE }, undefined, opts('task-b'));
    if (held.success) throw new Error('expected a held result');
    expect(held.error).toContain('a conversation with another contact already did this: contact-message on a contact at ');
    expect(spies.debug).toHaveBeenCalledWith(
      expect.objectContaining({ taskEventId: 'task-b', contactId: ALICE }),
      expect.stringContaining('no contact'),
    );
    expect(spies.warn).toHaveBeenCalledWith(
      expect.objectContaining({ taskEventId: 'task-b', contactId: BOB }),
      expect.stringContaining('name lookup failed'),
    );
  });

  it('the hold line says whose turn it was', async () => {
    const { registry, layer, turnActivity } = setup();
    registry.register(makeRiskyManifest('contact-message', 'medium'), makeHandler());
    startRoot(turnActivity, 'task-a', { channelId: 'email' });
    startRoot(turnActivity, 'task-b');
    await layer.invoke('contact-message', { contact_id: ALICE }, undefined, opts('task-a', { channelId: 'email' }));
    const held = await layer.invoke('contact-message', { contact_id: ALICE }, undefined, opts('task-b'));
    if (held.success) throw new Error('expected a held result');
    expect(held.error).toContain('- your other conversation on email already did this: contact-message on "Alice Example" at ');
  });
});

describe('ExecutionLayer cross-turn backstop extraction failures (#2588)', () => {
  it('a rejected contact check lets the call proceed and logs the failure by id kind', async () => {
    const child: Logger = pino({ level: 'silent' });
    const parent: Logger = pino({ level: 'silent' });
    vi.spyOn(parent, 'child').mockReturnValue(child as unknown as ReturnType<Logger['child']>);
    const warn = vi.spyOn(child, 'warn');
    const { registry, layer, turnActivity } = setup({ logger: parent });
    const handler = makeHandler();
    registry.register(makeRiskyManifest('contact-message', 'medium'), handler);
    startRoot(turnActivity, 'task-a');
    const contacts = (layer as unknown as { contactService: ContactService }).contactService;
    vi.mocked(contacts.getContact).mockRejectedValue(new Error('contacts db down'));

    const result = await layer.invoke('contact-message', { contact_id: ALICE }, undefined, opts('task-a'));
    expect(result.success).toBe(true);
    expect(handler.execute).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'contact-message', idKind: 'uuid' }),
      expect.stringContaining('contact lookup failed'),
    );
    // Not a contact, so the call is recorded against the bare id instead.
    expect(turnActivity.actionsOf('task-a')[0]!.targets).toEqual([{ kind: 'id', value: ALICE }]);
  });

  it('a throw in the async half is logged at error and the call runs unchecked', async () => {
    const child: Logger = pino({ level: 'silent' });
    const parent: Logger = pino({ level: 'silent' });
    vi.spyOn(parent, 'child').mockReturnValue(child as unknown as ReturnType<Logger['child']>);
    const error = vi.spyOn(child, 'error');
    const { registry, layer, turnActivity } = setup({ logger: parent });
    const handler = makeHandler();
    registry.register(makeRiskyManifest('contact-message', 'medium'), handler);
    startRoot(turnActivity, 'task-a');
    vi.spyOn(turnActivity, 'rootOf').mockImplementation(() => {
      throw new Error('registry exploded');
    });

    const result = await layer.invoke('contact-message', { contact_id: ALICE }, undefined, opts('task-a'));
    expect(result.success).toBe(true);
    expect(handler.execute).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'contact-message', taskEventId: 'task-a' }),
      expect.stringContaining('fail-open'),
    );
    expect(turnActivity.actionsOf('task-a')).toHaveLength(0);
  });
});
