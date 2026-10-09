// The scenario stub layer is the second of two no-send guarantees (#1956): the
// test-mode gateway has no transport client, and on top of that no side-effecting
// tool reaches the real layer unless a case stubs it — and a stub never does.
import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../../../src/logger.js';
import { ExecutionLayer } from '../../../src/skills/execution.js';
import { ToolRegistry } from '../../../src/skills/registry.js';
import type { ActionRisk, ToolManifest } from '../../../src/skills/types.js';
import { createStubController, mustStub } from '../../scenarios/stub-layer.js';

const logger = createLogger('error');

function manifest(name: string, risk: ActionRisk): ToolManifest {
  return {
    name,
    description: name,
    version: '0.1.0',
    action_risk: risk,
    sensitivity: 'normal',
    permissions: [],
    secrets: [],
    timeout: 5000,
    inputs: {},
    outputs: {},
  };
}

function setup() {
  const registry = new ToolRegistry();
  const executed: string[] = [];
  for (const [name, risk] of [
    ['email-send', 'medium'],
    ['signal-send', 'medium'],
    ['context-bridge-release', 'low'],
    ['memory-query', 'none'],
    ['delegate', 'none'],
    ['risky-by-number', 40],
  ] as const) {
    registry.register(manifest(name, risk), {
      execute: async () => {
        executed.push(name);
        return { success: true, data: `real ${name}` };
      },
    });
  }
  const base = new ExecutionLayer(registry, logger);
  const controller = createStubController(() => registry);
  const layer = controller.wrap(base);
  return { layer, controller, executed };
}

const coordinatorCall = { agentId: 'coordinator', conversationId: 'scenario-1' };

describe('mustStub: capabilities', () => {
  it('refuses a "none"-risk tool that can re-invoke tools, send or resolve approvals', () => {
    const registry = new ToolRegistry();
    for (const cap of ['executionLayer', 'outboundGateway', 'actionLogRepo', 'secretCapture']) {
      registry.register({ ...manifest(`t-${cap}`, 'none'), capabilities: [cap] }, { execute: async () => ({ success: true, data: null }) });
      expect(mustStub(`t-${cap}`, registry), cap).toBe(true);
    }
    registry.register({ ...manifest('reader-with-bus', 'none'), capabilities: ['bus'] }, { execute: async () => ({ success: true, data: null }) });
    expect(mustStub('reader-with-bus', registry)).toBe(false);
  });
});

describe('tools test mode cannot serve', () => {
  it('are refused rather than run into a failure production never shows', () => {
    const registry = new ToolRegistry();
    registry.register(manifest('doc-read', 'none'), { execute: async () => ({ success: true, data: null }) });
    expect(mustStub('doc-read', registry)).toBe(false);
    expect(mustStub('doc-read', registry, new Set(['doc-read']))).toBe(true);
  });
});

describe('inert tools (#2024)', () => {
  it('run unstubbed whatever their action_risk, but never override delegate or an unavailable tool', () => {
    const registry = new ToolRegistry();
    registry.register(manifest('update_drive_file', 'low'), { execute: async () => ({ success: true, data: null }) });
    registry.register(manifest('delegate', 'none'), { execute: async () => ({ success: true, data: null }) });
    expect(mustStub('update_drive_file', registry)).toBe(true);
    expect(mustStub('update_drive_file', registry, new Set(), new Set(['update_drive_file']))).toBe(false);
    expect(mustStub('delegate', registry, new Set(), new Set(['delegate']))).toBe(true);
    expect(mustStub('update_drive_file', registry, new Set(['update_drive_file']), new Set(['update_drive_file']))).toBe(true);
  });

  it('pass through to the real layer when a run has no stub for them', async () => {
    const registry = new ToolRegistry();
    registry.register(manifest('update_drive_file', 'low'), { execute: async () => ({ success: true, data: 'canned' }) });
    const controller = createStubController(() => registry, () => new Set(), () => new Set(['update_drive_file']));
    const layer = controller.wrap(new ExecutionLayer(registry, logger));
    controller.beginRun({}, 'scenario-1');
    const result = await layer.invoke('update_drive_file', {}, undefined, coordinatorCall);
    expect(result).toEqual({ success: true, data: 'canned' });
    // Recorded as canned, a stub hole: the model got a stand-in, not data the case chose.
    expect(controller.endRun('scenario-1').map(c => c.disposition)).toEqual(['canned']);
  });
});

describe('stale conversations', () => {
  it('refuses, and does not record, a call from a conversation other than the run\'s', async () => {
    const { layer, controller, executed } = setup();
    controller.beginRun({ 'signal-send': [{ match: {}, return: { sent: true } }] }, 'scenario-2');
    const stale = await layer.invoke('signal-send', {}, undefined, { agentId: 'coordinator', conversationId: 'scenario-1' });
    expect(stale.success).toBe(false);
    const stalePassthrough = await layer.invoke('memory-query', {}, undefined, { agentId: 'coordinator', conversationId: 'scenario-1' });
    expect(stalePassthrough.success).toBe(false);
    expect(executed).toEqual([]);
    expect(controller.staleCalls).toBe(2);
    expect(controller.endRun('scenario-2')).toEqual([]);
  });
});

describe('concurrent runs (#1980)', () => {
  it('answer and record each call from its own conversation\'s run', async () => {
    const { layer, controller } = setup();
    controller.beginRun({ 'email-send': [{ match: {}, return: { from: 'run-a' } }] }, 'scenario-a');
    controller.beginRun({ 'email-send': [{ match: {}, return: { from: 'run-b' } }] }, 'scenario-b');
    const send = (conversationId: string) => layer.invoke('email-send', {}, undefined, { agentId: 'coordinator', conversationId });

    const [a1, b1, a2] = await Promise.all([send('scenario-a'), send('scenario-b'), send('scenario-a')]);
    expect([a1, a2]).toEqual([{ success: true, data: { from: 'run-a' } }, { success: true, data: { from: 'run-a' } }]);
    expect(b1).toEqual({ success: true, data: { from: 'run-b' } });
    expect(controller.endRun('scenario-a')).toHaveLength(2);
    // Closing one run leaves the other answering.
    expect(await send('scenario-b')).toEqual({ success: true, data: { from: 'run-b' } });
    expect(await send('scenario-a')).toMatchObject({ success: false });
    expect(controller.endRun('scenario-b')).toHaveLength(2);
  });

  it('refuses to open a second run on the same conversation', () => {
    const { controller } = setup();
    controller.beginRun({}, 'scenario-a');
    expect(() => controller.beginRun({}, 'scenario-a')).toThrow(/already has an open run/);
  });
});

describe('mustStub', () => {
  it('requires a stub for any tool above action_risk none, and for delegate', () => {
    const registry = new ToolRegistry();
    registry.register(manifest('reader', 'none'), { execute: async () => ({ success: true, data: null }) });
    registry.register(manifest('writer', 'low'), { execute: async () => ({ success: true, data: null }) });
    registry.register(manifest('zero', 0), { execute: async () => ({ success: true, data: null }) });
    registry.register(manifest('delegate', 'none'), { execute: async () => ({ success: true, data: null }) });
    expect(mustStub('reader', registry)).toBe(false);
    expect(mustStub('zero', registry)).toBe(false);
    expect(mustStub('writer', registry)).toBe(true);
    expect(mustStub('delegate', registry)).toBe(true);
    // Unknown names fall through to the real layer, which reports "not found".
    expect(mustStub('nope', registry)).toBe(false);
  });
});

describe('scenario stub layer', () => {
  it('fails closed for an unstubbed send and never reaches the real tool', async () => {
    const { layer, controller, executed } = setup();
    controller.beginRun({}, 'scenario-1');
    for (const tool of ['email-send', 'signal-send', 'context-bridge-release', 'delegate', 'risky-by-number']) {
      const result = await layer.invoke(tool, { to: 'someone@example.com' }, undefined, coordinatorCall);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toMatch(/^<skill_error>.*no stub/);
    }
    expect(executed).toEqual([]);
    expect(controller.endRun('scenario-1').map(c => c.disposition)).toEqual(Array(5).fill('refused'));
  });

  it('answers a stubbed send itself and never reaches the real tool', async () => {
    const { layer, controller, executed } = setup();
    controller.beginRun({ 'email-send': [{ match: {}, return: { sent: true } }] }, 'scenario-1');
    const result = await layer.invoke('email-send', { to: 'x@example.com' }, undefined, coordinatorCall);
    expect(result).toEqual({ success: true, data: { sent: true } });
    expect(executed).toEqual([]);
  });

  it('refuses an email attachment outside the temp store with production\'s error (#2059)', async () => {
    const { layer, controller, executed } = setup();
    const outside = {
      file_url: 'file:///tmp/.workspace-mcp/attachments/deck.pdf',
      filename: 'deck.pdf',
      content_type: 'application/pdf',
    };
    const inside = {
      file_url: 'file:///run/curia-tempfiles/5b1e7c3a-94d2-4f6b-8a0e-c2d9f4a7e316.pdf',
      filename: 'deck.pdf',
      content_type: 'application/pdf',
    };
    controller.beginRun({
      'email-send': [{ match: {}, return: { message_id: 'scenario-out-1' } }],
      'email-reply': [{ match: {}, return: { message_id: 'scenario-out-2' } }],
      'email-draft-save': [{ match: {}, return: { draft_id: 'scenario-draft-1' } }],
    }, 'scenario-1');

    const send = await layer.invoke('email-send', { attachments: [outside] }, undefined, coordinatorCall);
    const reply = await layer.invoke('email-reply', { attachments: [outside] }, undefined, coordinatorCall);
    const draft = await layer.invoke('email-draft-save', { attachments: [outside] }, undefined, coordinatorCall);
    const bare = await layer.invoke('email-send', {
      attachments: [{ ...outside, file_url: '/tmp/.workspace-mcp/attachments/deck.pdf' }],
    }, undefined, coordinatorCall);
    const ok = await layer.invoke('email-send', { attachments: [inside] }, undefined, coordinatorCall);
    const noFile = await layer.invoke('email-reply', { body: 'hi' }, undefined, coordinatorCall);

    expect(send).toEqual({
      success: false,
      error: '<skill_error>Attachment error: Attachment path is outside the allowed temp store directory: file:///tmp/.workspace-mcp/attachments/deck.pdf</skill_error>',
    });
    expect(reply.success).toBe(false);
    if (!reply.success) expect(reply.error).toContain('outside the allowed temp store directory');
    expect(draft.success).toBe(false);
    if (!draft.success) expect(draft.error).toContain('outside the allowed temp store directory');
    expect(bare.success).toBe(false);
    if (!bare.success) expect(bare.error).toContain('must start with file://');
    expect(ok).toEqual({ success: true, data: { message_id: 'scenario-out-1' } });
    expect(noFile).toEqual({ success: true, data: { message_id: 'scenario-out-2' } });
    expect(executed).toEqual([]);
    // Stubbed, not refused: the model is told production's error and the call is not a hole.
    expect(controller.endRun('scenario-1').map(c => c.disposition)).toEqual(Array(6).fill('stubbed'));
  });

  it('keeps a scripted email-send error ahead of the attachment check', async () => {
    const { layer, controller, executed } = setup();
    controller.beginRun({
      'email-send': [{ match: {}, error: 'recipient blocked' }],
    }, 'scenario-1');
    const result = await layer.invoke('email-send', {
      attachments: [{
        file_url: 'file:///tmp/.workspace-mcp/attachments/deck.pdf',
        filename: 'deck.pdf',
        content_type: 'application/pdf',
      }],
    }, undefined, coordinatorCall);
    expect(result).toEqual({ success: false, error: '<skill_error>recipient blocked</skill_error>' });
    expect(executed).toEqual([]);
  });

  it('returns a scripted error as a skill error', async () => {
    const { layer, controller } = setup();
    controller.beginRun({ delegate: [{ match: {}, error: 'specialist unavailable' }] }, 'scenario-1');
    const result = await layer.invoke('delegate', { agent: 'calendar' }, undefined, coordinatorCall);
    expect(result).toEqual({ success: false, error: '<skill_error>specialist unavailable</skill_error>' });
  });

  it('passes an unstubbed read-only tool through to the real layer', async () => {
    const { layer, controller, executed } = setup();
    controller.beginRun({}, 'scenario-1');
    const result = await layer.invoke('memory-query', {}, undefined, coordinatorCall);
    expect(result).toMatchObject({ success: true, data: 'real memory-query' });
    expect(executed).toEqual(['memory-query']);
    expect(controller.endRun('scenario-1')).toEqual([
      { agentId: 'coordinator', invokeEventId: undefined, toolName: 'memory-query', input: {}, disposition: 'passthrough' },
    ]);
  });

  it('refuses every side-effecting call outside a run', async () => {
    const { layer, executed } = setup();
    const result = await layer.invoke('signal-send', {}, undefined, coordinatorCall);
    expect(result.success).toBe(false);
    expect(executed).toEqual([]);
  });

  it('keeps every other ExecutionLayer method working', () => {
    const { layer } = setup();
    expect(layer.getToolDefinitions(['memory-query']).map(t => t.name)).toEqual(['memory-query']);
    expect(typeof layer.resolveSkillActivationForAgent).toBe('function');
  });

  it('does not let a stub return be mutated by a later run', async () => {
    const { layer, controller } = setup();
    const stubs = { 'email-send': [{ match: {}, return: { sent: true } }] };
    controller.beginRun(stubs, 'scenario-1');
    const first = await layer.invoke('email-send', {}, undefined, coordinatorCall);
    if (first.success) (first.data as Record<string, unknown>).sent = false;
    const second = await layer.invoke('email-send', {}, undefined, coordinatorCall);
    expect(second).toEqual({ success: true, data: { sent: true } });
  });

  it('records the real layer not being called even when invoke is spied', async () => {
    const { layer, controller } = setup();
    const spy = vi.spyOn(ExecutionLayer.prototype, 'invoke');
    controller.beginRun({ 'signal-send': [{ match: {}, return: { sent: true } }] }, 'scenario-1');
    await layer.invoke('signal-send', {}, undefined, coordinatorCall);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('replays scheduler and draft writes inside one run, and a draft_id stub overrides the read', async () => {
    const { layer, controller, executed } = setup();
    const job = '7d1c2e44-0b6a-4f0e-9d7e-3a1f5c2b8e10';
    const stubs = {
      'scheduler-list': [{ match: {}, return: { jobs: [{ id: job, status: 'pending', cronExpr: '0 9 * * 1', taskTitle: 'Pipeline review' }], count: 1 } }],
      'scheduler-update': [{ match: {}, return: { jobId: job, action: 'edit' } }],
      'scheduler-cancel': [{ match: {}, return: { cancelled: true, jobId: job } }],
      'ceo-inbox-draft-compose': [{ match: {}, return: { draft_id: 'draft-0002', subject: 'Hello', to: ['maya@techto.example'], cc: [] } }],
      'ceo-inbox-draft-edit': [{ match: {}, return: { draft_id: 'draft-0002' } }],
      'ceo-inbox-read': [{ match: {}, error: 'Message not found in this mailbox.' }],
    };
    controller.beginRun(stubs, 'scenario-1');
    controller.beginRun(stubs, 'scenario-2');
    const call = (tool: string, input: Record<string, unknown>, conversationId = 'scenario-1') =>
      layer.invoke(tool, input, undefined, { agentId: 'coordinator', conversationId });

    await call('scheduler-update', { job_id: job, action: 'edit', cron_expr: '0 10 * * 1' });
    const listed = await call('scheduler-list', {}) as { data: { jobs: Array<{ cronExpr: string; taskTitle: string }> } };
    expect(listed.data.jobs).toEqual([expect.objectContaining({ cronExpr: '0 10 * * 1', taskTitle: 'Pipeline review' })]);
    // The other run still sees the scripted 9am job.
    const other = await call('scheduler-list', {}, 'scenario-2') as { data: { jobs: Array<{ cronExpr: string }> } };
    expect(other.data.jobs.map(row => row.cronExpr)).toEqual(['0 9 * * 1']);

    await call('scheduler-cancel', { job_id: job });
    const cancelled = await call('scheduler-list', {}) as { data: { jobs: Array<{ status: string }> } };
    expect(cancelled.data.jobs).toEqual([expect.objectContaining({ status: 'cancelled' })]);

    await call('ceo-inbox-draft-compose', { subject: 'Hello', to: ['maya@techto.example'], body: 'Tuesday.' });
    await call('ceo-inbox-draft-edit', { draft_id: 'draft-0002', body: 'Wednesday.' });
    expect(await call('ceo-inbox-read', { draft_id: 'draft-0002' })).toEqual({
      success: true,
      data: expect.objectContaining({ id: 'draft-0002', is_draft: true, body_plain: 'Wednesday.' }),
    });
    expect(executed).toEqual([]);

    controller.endRun('scenario-1');
    controller.beginRun({
      ...stubs,
      'ceo-inbox-read': [{ match: { draft_id: 'draft-0002' }, return: { id: 'draft-0002', body_plain: 'scripted' } }],
    }, 'scenario-1');
    await call('ceo-inbox-draft-compose', { subject: 'Hello', to: ['maya@techto.example'], body: 'Tuesday.' });
    expect(await call('ceo-inbox-read', { draft_id: 'draft-0002' })).toEqual({
      success: true,
      data: { id: 'draft-0002', body_plain: 'scripted' },
    });
  });
});

describe('real delegation (#2027)', () => {
  const SENDS = ['email-send', 'email-reply', 'signal-send', 'sms-send', 'slack-send'] as const;

  /**
   * A registry whose `delegate` acts like the real one: it runs a "specialist" that makes
   * `specialistCalls` through the wrapped layer, in the conversation it was given.
   */
  function delegationSetup(specialistCalls: Array<{ tool: string; input?: Record<string, unknown> }>) {
    const registry = new ToolRegistry();
    const executed: string[] = [];
    const specialistResults: Array<{ tool: string; success: boolean; data?: unknown }> = [];
    const started: Array<{ root: string; conversation: string }> = [];
    let layer: ExecutionLayer | undefined;
    for (const [name, risk] of [
      ...SENDS.map(s => [s, 'medium'] as const),
      ['calendar-list-events', 'none'],
      ['context-bridge-keep-open', 'low'],
      ['context-bridge-release', 'low'],
      ['memory-query', 'none'],
    ] as const) {
      registry.register(manifest(name, risk), {
        execute: async () => {
          executed.push(name);
          return { success: true, data: `real ${name}` };
        },
      });
    }
    let seenConversation: string | undefined;
    registry.register(manifest('delegate', 'none'), {
      execute: async (ctx) => {
        executed.push('delegate');
        seenConversation = ctx.input['conversation_id'] as string;
        for (const call of specialistCalls) {
          const result = await layer!.invoke(call.tool, call.input ?? {}, undefined, { agentId: 'ceo-inbox', conversationId: seenConversation });
          specialistResults.push({ tool: call.tool, success: result.success, ...(result.success ? { data: result.data } : {}) });
        }
        return { success: true, data: { agent: 'ceo-inbox', response: 'done' } };
      },
    });
    const controller = createStubController(() => registry, () => new Set(), () => new Set(), {
      onDelegate: (root, conversation) => started.push({ root, conversation }),
    });
    layer = controller.wrap(new ExecutionLayer(registry, logger));
    return { layer, controller, executed, specialistResults, started, conversation: () => seenConversation };
  }

  it('runs delegate in a conversation the layer names, filed under the run', async () => {
    const { layer, controller, executed, started, conversation } = delegationSetup([{ tool: 'memory-query' }]);
    controller.beginRun({}, 'scenario-1', { realDelegation: true });
    const result = await layer.invoke('delegate', { agent: 'ceo-inbox', task: 'x' }, undefined, coordinatorCall);
    expect(result).toEqual({ success: true, data: { agent: 'ceo-inbox', response: 'done' } });
    expect(conversation()).toMatch(/^scenario-delegate-[0-9a-f-]{36}$/);
    expect(started).toEqual([{ root: 'scenario-1', conversation: conversation() }]);
    expect(executed).toEqual(['delegate', 'memory-query']);
    expect(controller.endRun('scenario-1').map(c => [c.agentId, c.toolName, c.disposition])).toEqual([
      ['coordinator', 'delegate', 'passthrough'],
      ['ceo-inbox', 'memory-query', 'passthrough'],
    ]);
    // Once the run is closed, the specialist's conversation is stale like any other.
    expect(controller.rootOf(conversation()!)).toBeUndefined();
  });

  it('keeps a conversation_id the model chose within the run, never across runs', async () => {
    const { layer, controller, conversation } = delegationSetup([]);
    controller.beginRun({}, 'scenario-1', { realDelegation: true });
    controller.beginRun({}, 'scenario-2', { realDelegation: true });
    const delegate = (conversationId: string, given: string) =>
      layer.invoke('delegate', { agent: 'ceo-inbox', task: 'x', conversation_id: given }, undefined, { agentId: 'coordinator', conversationId });

    await delegate('scenario-1', 'thread-7');
    const first = conversation()!;
    expect(first).toMatch(/^scenario-delegate-[0-9a-f]{8}-thread-7$/);
    expect(controller.rootOf(first)).toBe('scenario-1');
    // The run's own specialist conversation, passed back, stays itself.
    await delegate('scenario-1', first);
    expect(conversation()).toBe(first);
    // Another run choosing the same id gets a conversation of its own.
    await delegate('scenario-2', 'thread-7');
    expect(conversation()).not.toBe(first);
    expect(controller.rootOf(conversation()!)).toBe('scenario-2');
  });

  it('still refuses delegate in a run without real delegation', async () => {
    const { layer, controller, executed } = delegationSetup([]);
    controller.beginRun({}, 'scenario-1');
    const result = await layer.invoke('delegate', { agent: 'ceo-inbox', task: 'x' }, undefined, coordinatorCall);
    expect(result.success).toBe(false);
    expect(executed).toEqual([]);
  });

  it('lets no agent in a real-delegation run send unless a stub answers', async () => {
    // Every send, by the specialist and by the coordinator, unstubbed: all refused.
    const unstubbed = delegationSetup(SENDS.map(tool => ({ tool, input: { to: 'principal' } })));
    unstubbed.controller.beginRun({}, 'scenario-1', { realDelegation: true });
    await unstubbed.layer.invoke('delegate', { agent: 'ceo-inbox', task: 'x' }, undefined, coordinatorCall);
    for (const tool of SENDS) {
      expect((await unstubbed.layer.invoke(tool, { to: 'principal' }, undefined, coordinatorCall)).success, tool).toBe(false);
    }
    expect(unstubbed.specialistResults.map(r => [r.tool, r.success])).toEqual(SENDS.map(tool => [tool, false]));
    expect(unstubbed.executed).toEqual(['delegate']);
    const calls = unstubbed.controller.endRun('scenario-1');
    expect(calls.filter(c => c.toolName !== 'delegate').every(c => c.disposition === 'refused')).toBe(true);
    expect(calls.filter(c => c.agentId === 'ceo-inbox')).toHaveLength(SENDS.length);

    // Stubbed: answered by the stub, never by the real tool.
    const stubbed = delegationSetup(SENDS.map(tool => ({ tool })));
    stubbed.controller.beginRun(
      Object.fromEntries(SENDS.map(tool => [tool, [{ match: {}, return: { sent: tool } }]])),
      'scenario-1',
      { realDelegation: true },
    );
    await stubbed.layer.invoke('delegate', { agent: 'ceo-inbox', task: 'x' }, undefined, coordinatorCall);
    expect(stubbed.specialistResults.every(r => r.success)).toBe(true);
    expect(stubbed.executed).toEqual(['delegate']);
  });

  it('answers a stub scoped to an agent only for that agent', async () => {
    const { layer, controller, specialistResults } = delegationSetup([{ tool: 'calendar-list-events' }]);
    controller.beginRun({
      'calendar-list-events': [{ agent: 'ceo-inbox', match: {}, return: { events: ['specialist'] } }],
      'email-send': [{ agent: 'ceo-inbox', match: {}, return: { sent: true } }],
    }, 'scenario-1', { realDelegation: true });
    await layer.invoke('delegate', { agent: 'ceo-inbox', task: 'x' }, undefined, coordinatorCall);
    expect(specialistResults).toEqual([{ tool: 'calendar-list-events', success: true, data: { events: ['specialist'] } }]);
    // The coordinator's read falls through to the real read-only tool; its send is refused.
    expect(await layer.invoke('calendar-list-events', {}, undefined, coordinatorCall)).toMatchObject({ data: 'real calendar-list-events' });
    expect((await layer.invoke('email-send', {}, undefined, coordinatorCall)).success).toBe(false);
  });

  it('runs the outbound-context tools a specialist settles entries with, but not release', async () => {
    const { layer, controller, specialistResults, executed } = delegationSetup([
      { tool: 'context-bridge-keep-open', input: { entry_id: 'e-1' } },
      { tool: 'context-bridge-release', input: { entry_id: 'e-1' } },
    ]);
    controller.beginRun({}, 'scenario-1', { realDelegation: true });
    await layer.invoke('delegate', { agent: 'ceo-inbox', task: 'x' }, undefined, coordinatorCall);
    expect(specialistResults.map(r => [r.tool, r.success])).toEqual([['context-bridge-keep-open', true], ['context-bridge-release', false]]);
    expect(executed).toEqual(['delegate', 'context-bridge-keep-open']);
  });

  it('reports the specialists a run\'s delegate calls are still waiting on', async () => {
    let release: () => void = () => {};
    const registry = new ToolRegistry();
    registry.register(manifest('delegate', 'none'), {
      execute: () => new Promise(resolve => { release = () => resolve({ success: true, data: { agent: 'calendar' } }); }),
    });
    const controller = createStubController(() => registry);
    const layer = controller.wrap(new ExecutionLayer(registry, logger));
    controller.beginRun({}, 'scenario-1', { realDelegation: true });
    const pending = layer.invoke('delegate', { agent: 'calendar', task: 'x' }, undefined, coordinatorCall);
    await vi.waitFor(() => expect(controller.pendingDelegations('scenario-1')).toEqual(['calendar']));
    release();
    await pending;
    expect(controller.pendingDelegations('scenario-1')).toEqual([]);
  });
});

describe('mustStub with real delegation (#2027)', () => {
  it('lets delegate and the entry-settling tools run, and nothing else', () => {
    const registry = new ToolRegistry();
    for (const [name, risk] of [['delegate', 'none'], ['context-bridge-keep-open', 'low'], ['context-bridge-clear', 'low'], ['context-bridge-release', 'low'], ['email-send', 'medium']] as const) {
      registry.register(manifest(name, risk), { execute: async () => ({ success: true, data: null }) });
    }
    const real = { realDelegation: true };
    expect(mustStub('delegate', registry, new Set(), new Set(), real)).toBe(false);
    expect(mustStub('context-bridge-keep-open', registry, new Set(), new Set(), real)).toBe(false);
    expect(mustStub('context-bridge-clear', registry, new Set(), new Set(), real)).toBe(false);
    expect(mustStub('context-bridge-release', registry, new Set(), new Set(), real)).toBe(true);
    expect(mustStub('email-send', registry, new Set(), new Set(), real)).toBe(true);
    // A tool test mode cannot serve is refused whatever the mode.
    expect(mustStub('context-bridge-keep-open', registry, new Set(['context-bridge-keep-open']), new Set(), real)).toBe(true);
    expect(mustStub('context-bridge-keep-open', registry)).toBe(true);
  });
});
