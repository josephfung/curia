// The scenario stub layer is the second of two no-send guarantees (#1956): the
// test-mode gateway has no transport client, and on top of that no side-effecting
// tool reaches the real layer unless a case stubs it — and a stub never does.
import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../../../src/logger.js';
import { ExecutionLayer } from '../../../src/skills/execution.js';
import { ToolRegistry } from '../../../src/skills/registry.js';
import type { ActionRisk, ToolManifest } from '../../../src/skills/types.js';
import { createStubController, mustStub, THROUGH_GATEWAY_SEND_TOOLS } from '../../scenarios/stub-layer.js';
import type { DraftMirror, MailboxDraft } from '../../shared/tool-state.js';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { PRINCIPAL_SEND_REFUSALS } from '../../../src/skills/outbound-gateway.js';
import { DEFAULT_STUBS_DIR, parseStubs } from '../../scenarios/loader.js';

// Lets a test force two runs onto the same conversation token; real UUIDs otherwise.
const uuid = vi.hoisted(() => ({ next: [] as string[] }));
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, randomUUID: () => uuid.next.shift() ?? actual.randomUUID() };
});

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
    const result = await layer.invoke('email-send', { to: '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b' }, undefined, coordinatorCall);
    expect(result).toEqual({ success: true, data: { sent: true } });
    expect(executed).toEqual([]);
  });

  it('refuses a typed address on a success send stub with production\'s error (#2149)', async () => {
    const { layer, controller, executed } = setup();
    controller.beginRun({
      'email-send': [{ match: {}, return: { sent: true } }],
      'signal-send': [{ match: {}, return: { sent: true } }],
    }, 'scenario-1');
    const email = await layer.invoke('email-send', { to: 'x@example.com' }, undefined, coordinatorCall);
    const signal = await layer.invoke('signal-send', { recipient: '+15195550123' }, undefined, coordinatorCall);
    expect(email.success).toBe(false);
    if (!email.success) expect(email.error).toMatch(/^<skill_error>to takes a contact ID or "principal", not "x@example.com"/);
    expect(signal.success).toBe(false);
    if (!signal.success) expect(signal.error).toMatch(/recipient takes a contact ID/);
    expect(executed).toEqual([]);
    // Recorded as stubbed, like the attachment refusal: the model can recover.
    expect(controller.endRun('scenario-1').map(c => c.disposition)).toEqual(['stubbed', 'stubbed']);
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

  it('counts web-search calls that reach the real tool, and Tavily quota refusals (#2106)', async () => {
    const registry = new ToolRegistry();
    const answers = [
      { success: false as const, error: 'Tavily returned HTTP 432: request failed' },
      { success: true as const, data: { results: [], count: 0 } },
    ];
    registry.register(manifest('web-search', 'none'), { execute: async () => answers.shift()! });
    const controller = createStubController(() => registry);
    const layer = controller.wrap(new ExecutionLayer(registry, logger));
    controller.beginRun({}, 'scenario-1');
    await layer.invoke('web-search', { query: 'a' }, undefined, coordinatorCall);
    await layer.invoke('web-search', { query: 'b' }, undefined, coordinatorCall);
    controller.endRun('scenario-1');
    controller.beginRun({ 'web-search': [{ match: {}, return: { results: [], count: 0 } }] }, 'scenario-2');
    await layer.invoke('web-search', { query: 'stubbed' }, undefined, { ...coordinatorCall, conversationId: 'scenario-2' });
    expect(controller.liveSearch).toEqual({ calls: 2, quotaErrors: 1 });
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

  it('holds only the first call until the harness releases it (#2018)', async () => {
    const { layer, controller } = setup();
    controller.beginRun({ 'memory-query': [{ match: {}, return: { hits: 0 } }] }, 'scenario-1');
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    controller.holdFirstCall('scenario-1', held);
    let firstReturned = false;
    const first = layer.invoke('memory-query', {}, undefined, coordinatorCall).then((result) => {
      firstReturned = true;
      return result;
    });
    await controller.whenFirstCall('scenario-1');
    expect(firstReturned).toBe(false);
    await expect(layer.invoke('memory-query', { q: 'later' }, undefined, coordinatorCall))
      .resolves.toEqual({ success: true, data: { hits: 0 } });
    expect(firstReturned).toBe(false);
    release();
    await expect(first).resolves.toEqual({ success: true, data: { hits: 0 } });
    expect(controller.endRun('scenario-1')).toHaveLength(2);
  });

  it('settles whenFirstCall when the run closes with no call (#2018)', async () => {
    const { controller } = setup();
    controller.beginRun({}, 'scenario-1');
    let settled = false;
    const pending = controller.whenFirstCall('scenario-1').then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    controller.endRun('scenario-1');
    await pending;
    expect(settled).toBe(true);
  });

  it('whenFirstCall resolves immediately when no run is open (#2018)', async () => {
    const { controller } = setup();
    await controller.whenFirstCall('missing');
  });

  it('holdFirstCall requires an open run (#2018)', () => {
    const { controller } = setup();
    expect(() => controller.holdFirstCall('missing', Promise.resolve())).toThrow(/no open run/);
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

  it('never hands one run a specialist conversation another open run owns', async () => {
    const { layer, controller, conversation } = delegationSetup([]);
    // Both runs draw the same token, so both name 'thread-7' identically.
    uuid.next.push('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000002');
    controller.beginRun({}, 'scenario-1', { realDelegation: true });
    controller.beginRun({}, 'scenario-2', { realDelegation: true });
    const delegate = (conversationId: string) =>
      layer.invoke('delegate', { agent: 'ceo-inbox', task: 'x', conversation_id: 'thread-7' }, undefined, { agentId: 'coordinator', conversationId });

    await delegate('scenario-1');
    const first = conversation()!;
    expect(first).toBe('scenario-delegate-aaaaaaaa-thread-7');
    await delegate('scenario-2');
    expect(conversation()).toMatch(/^scenario-delegate-[0-9a-f-]{36}$/);
    expect(controller.rootOf(conversation()!)).toBe('scenario-2');
    expect(controller.rootOf(first)).toBe('scenario-1');
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

describe('through-gateway runs (#2312)', () => {
  /** The send and approval tools, plus a stub for each a shared set would bring. */
  function gatewaySetup() {
    const registry = new ToolRegistry();
    const executed: Array<{ name: string; liveTurn: unknown; layer: string }> = [];
    for (const [name, risk, caps] of [
      ['email-send', 'medium', ['outboundGateway']],
      ['send-draft', 'none', ['outboundGateway']],
      ['approve-action', 'none', ['bus', 'actionLogRepo', 'executionLayer', 'disclosureDecisions']],
      ['deliver-approval', 'none', ['approvalDelivery']],
      ['list-pending-actions', 'none', ['actionLogRepo']],
      ['calendar-create-event', 'high', []],
      ['contact-merge', 'low', []],
    ] as const) {
      registry.register({ ...manifest(name, risk), capabilities: [...caps] }, {
        execute: async (ctx) => {
          executed.push({ name, liveTurn: ctx.liveTurn, layer: (ctx.outboundGateway as { id?: string } | undefined)?.id ?? (ctx.actionLogRepo ? 'review' : 'base') });
          return { success: true, data: `real ${name}` };
        },
      });
    }
    // The layer agents call has a gateway but none of the approval wiring, as in test mode;
    // the recording stack's review layer has all of it.
    const bus = { publish: async () => {} } as never;
    const base = new ExecutionLayer(registry, logger, { bus, outboundGateway: { id: 'base' } as never });
    const review = new ExecutionLayer(registry, logger, {
      bus,
      outboundGateway: { id: 'review' } as never,
      actionLogRepo: {} as never,
      approvalDelivery: {} as never,
      disclosureDecisions: {} as never,
    });
    const unavailable = new Set(['approve-action', 'deliver-approval', 'list-pending-actions']);
    const controller = createStubController(() => registry, () => unavailable);
    const layer = controller.wrap(base, review);
    const stubs = {
      'email-send': [{ match: {}, return: { stubbed: true } }],
      'calendar-create-event': [{ match: {}, return: { stubbed: true } }],
    };
    return { layer, controller, executed, stubs };
  }

  it('runs a send for real past its stub, and still stubs every other tool', async () => {
    const { layer, controller, executed, stubs } = gatewaySetup();
    controller.beginRun(stubs, 'scenario-1', { throughGateway: true });
    expect(await layer.invoke('email-send', { to: 'c0ffee00-0000-4000-8000-000000000001' }, undefined, coordinatorCall))
      .toEqual({ success: true, data: 'real email-send' });
    expect(await layer.invoke('calendar-create-event', {}, undefined, coordinatorCall))
      .toEqual({ success: true, data: { stubbed: true } });
    // The run's own approvals are listed for real, so a later "yes" can find the one it means.
    expect(await layer.invoke('list-pending-actions', {}, undefined, coordinatorCall))
      .toEqual({ success: true, data: 'real list-pending-actions' });
    // Not a send or approval tool, and no stub: refused as in any run.
    expect((await layer.invoke('contact-merge', {}, undefined, coordinatorCall)).success).toBe(false);
    // On the review layer, not the one agents call.
    expect(executed.map(e => [e.name, e.layer])).toEqual([['email-send', 'review'], ['list-pending-actions', 'review']]);
    expect(controller.endRun('scenario-1').map(c => [c.toolName, c.disposition])).toEqual([
      ['email-send', 'passthrough'], ['calendar-create-event', 'stubbed'], ['list-pending-actions', 'passthrough'], ['contact-merge', 'refused'],
    ]);
  });

  it('leaves a run without through_gateway exactly as before: stubs answer, unstubbed approvals are refused', async () => {
    const { layer, controller, executed, stubs } = gatewaySetup();
    controller.beginRun(stubs, 'scenario-1');
    expect(await layer.invoke('email-send', {}, undefined, coordinatorCall)).toEqual({ success: true, data: { stubbed: true } });
    for (const tool of ['send-draft', 'approve-action', 'deliver-approval']) {
      const result = await layer.invoke(tool, {}, undefined, coordinatorCall);
      expect(result.success, tool).toBe(false);
      if (!result.success) expect(result.error).toMatch(/no stub/);
    }
    expect(executed).toEqual([]);
  });

  it('lets a follow-up principal turn reach approve-action with its live-turn signal (elevated gate)', async () => {
    const { layer, controller, executed } = gatewaySetup();
    controller.beginRun({}, 'scenario-1', { throughGateway: true });
    const liveTurn = true;
    const result = await layer.invoke('approve-action', { short_ref: '3' }, undefined, { ...coordinatorCall, liveTurn });
    expect(result).toEqual({ success: true, data: 'real approve-action' });
    expect(executed).toEqual([{ name: 'approve-action', liveTurn, layer: 'review' }]);
    controller.endRun('scenario-1');
  });
});

// #2499: a gated_tools stub is answered behind the review layer's gates, so band Gate C (the
// escalation judge's purpose check) decides whether the stub's answer is ever reached.
describe('gated stubs (#2499)', () => {
  function gatedSetup(verdict: { ok: true; purpose: 'serving' | 'steered'; reason: string }) {
    const registry = new ToolRegistry();
    const executed: string[] = [];
    // Real manifests declare the calendar client, which test mode never wires.
    for (const [name, risk] of [['calendar-create-event', 'high'], ['calendar-list-events', 'none']] as const) {
      registry.register({ ...manifest(name, risk), capabilities: ['nylasCalendarClient'] }, {
        execute: async () => { executed.push(name); return { success: true, data: `real ${name}` }; },
      });
    }
    const bus = { publish: async () => {} } as never;
    const review = vi.fn().mockResolvedValue(verdict);
    const controller = createStubController(() => registry);
    const reviewLayer = new ExecutionLayer(controller.reviewRegistry(registry), logger, {
      bus,
      autonomyService: { getConfig: vi.fn().mockResolvedValue({ score: 84, band: 'spot-check', updatedAt: new Date(), updatedBy: 't' }) } as never,
      escalationJudge: { isEnabled: () => true, review, classifyAction: vi.fn() } as never,
      gating: 'band',
      sendEvidence: { collect: vi.fn().mockResolvedValue({ unavailable: false, toolResults: [], authority: { originator: null, liveTurn: false } }) },
    });
    const layer = controller.wrap(new ExecutionLayer(registry, logger), reviewLayer);
    const stubs = {
      'calendar-create-event': [{ match: {}, return: { event: { id: 'evt-stub' } } }],
      'calendar-list-events': [{ match: {}, return: { events: [] } }],
    };
    return { layer, controller, executed, review, stubs };
  }
  const outsiderCall = {
    agentId: 'calendar', conversationId: 'scenario-1', taskEventId: 'task-1',
    taskMetadata: { originator: { contactId: 'c', systemRole: null, channel: 'email', initiatedAt: new Date().toISOString(), tier: 'known' } },
  };

  it('holds a steered write at Gate C: the stub never answers and no handler runs', async () => {
    const { layer, controller, executed, review, stubs } = gatedSetup({ ok: true, purpose: 'steered', reason: 'pushed' });
    controller.beginRun(stubs, 'scenario-1', { throughGateway: true, gatedTools: ['calendar-create-event'] });
    const result = await layer.invoke('calendar-create-event', {}, undefined, outsiderCall);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('steered by someone outside');
    expect(review).toHaveBeenCalledTimes(1);
    expect(executed).toEqual([]);
    expect(controller.endRun('scenario-1').map(c => [c.toolName, c.disposition])).toEqual([['calendar-create-event', 'stubbed']]);
  });

  it('answers a write the gates let through with its stub, never the real handler', async () => {
    const { layer, controller, executed, stubs } = gatedSetup({ ok: true, purpose: 'serving', reason: 'fine' });
    controller.beginRun(stubs, 'scenario-1', { throughGateway: true, gatedTools: ['calendar-create-event'] });
    const result = await layer.invoke('calendar-create-event', {}, undefined, outsiderCall);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({ event: { id: 'evt-stub' } });
    expect(executed).toEqual([]);
    controller.endRun('scenario-1');
  });

  it('drops only for the gated call the capabilities the review layer lacks', async () => {
    const { controller } = gatedSetup({ ok: true, purpose: 'serving', reason: 'fine' });
    const registry = new ToolRegistry();
    registry.register({ ...manifest('calendar-create-event', 'high'), capabilities: ['nylasCalendarClient'] }, { execute: async () => ({ success: true, data: null }) });
    // Outside a gated call the manifest is the real one, so an ungated call still fails closed.
    expect(controller.reviewRegistry(registry).get('calendar-create-event')!.manifest.capabilities).toEqual(['nylasCalendarClient']);
  });

  it('leaves tools it does not gate, and runs without gated_tools, answered before any gate', async () => {
    const { layer, controller, review, stubs } = gatedSetup({ ok: true, purpose: 'steered', reason: 'x' });
    controller.beginRun(stubs, 'scenario-1', { throughGateway: true, gatedTools: ['calendar-create-event'] });
    expect(await layer.invoke('calendar-list-events', {}, undefined, outsiderCall)).toEqual({ success: true, data: { events: [] } });
    controller.endRun('scenario-1');
    controller.beginRun(stubs, 'scenario-1', { throughGateway: true });
    expect(await layer.invoke('calendar-create-event', {}, undefined, outsiderCall)).toEqual({ success: true, data: { event: { id: 'evt-stub' } } });
    controller.endRun('scenario-1');
    expect(review).not.toHaveBeenCalled();
  });

  it('runs the real handler on the review layer when no gated call is in flight', async () => {
    const { controller, executed } = gatedSetup({ ok: true, purpose: 'serving', reason: 'x' });
    const registry = new ToolRegistry();
    registry.register(manifest('calendar-create-event', 'high'), { execute: async () => { executed.push('real'); return { success: true, data: 'real' }; } });
    const wrapped = controller.reviewRegistry(registry);
    expect(await wrapped.get('calendar-create-event')!.handler.execute({} as never)).toEqual({ success: true, data: 'real' });
    expect(wrapped.list()).toHaveLength(1);
    expect(wrapped.get('missing')).toBeUndefined();
  });

  it('refuses a gated stub on a stack without a review layer', async () => {
    const registry = new ToolRegistry();
    registry.register(manifest('calendar-create-event', 'high'), { execute: async () => ({ success: true, data: null }) });
    const controller = createStubController(() => registry);
    const layer = controller.wrap(new ExecutionLayer(registry, logger));
    controller.beginRun({ 'calendar-create-event': [{ match: {}, return: { ok: true } }] }, 'scenario-1', { throughGateway: true, gatedTools: ['calendar-create-event'] });
    const result = await layer.invoke('calendar-create-event', {}, undefined, coordinatorCall);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/no review layer/);
    controller.endRun('scenario-1');
  });
});

describe('mustStub with through_gateway (#2312)', () => {
  it('lets the send and approval tools run, and nothing else', () => {
    const registry = new ToolRegistry();
    for (const [name, risk, caps] of [
      ['email-send', 'medium', []], ['email-reply', 'medium', []], ['signal-send', 'medium', []], ['sms-send', 'medium', []],
      ['slack-send', 'medium', []], ['send-draft', 'none', ['outboundGateway']], ['deliver-approval', 'none', ['approvalDelivery']],
      ['approve-action', 'none', ['actionLogRepo', 'executionLayer']], ['deny-action', 'none', ['actionLogRepo']],
      ['list-pending-actions', 'none', ['actionLogRepo']], ['email-draft-save', 'low', []],
    ] as const) {
      registry.register({ ...manifest(name, risk), capabilities: [...caps] }, { execute: async () => ({ success: true, data: null }) });
    }
    const gw = { throughGateway: true };
    // list-pending-actions too: a stub saying "none pending" hid the approval a send raised from
    // the principal's later "yes" (#2312). It reads the run-scoped action log (scopedActionLog).
    for (const tool of ['email-send', 'email-reply', 'signal-send', 'sms-send', 'slack-send', 'send-draft', 'list-pending-actions', 'deliver-approval', 'approve-action', 'deny-action']) {
      expect(mustStub(tool, registry, new Set(), new Set(), gw), tool).toBe(false);
      expect(mustStub(tool, registry), `${tool} without through_gateway`).toBe(true);
    }
    expect(mustStub('email-draft-save', registry, new Set(), new Set(), gw)).toBe(true);
    // The review layer serves them, whatever the layer agents call lacks.
    expect(mustStub('approve-action', registry, new Set(['approve-action']), new Set(), gw)).toBe(false);
    expect(mustStub('approve-action', registry, new Set(['approve-action']))).toBe(true);
  });
});

describe('a through-gateway run on a stack without a review layer', () => {
  it('refuses the send rather than run it on the layer agents call', async () => {
    const registry = new ToolRegistry();
    const executed: string[] = [];
    registry.register(manifest('email-send', 'medium'), { execute: async () => { executed.push('email-send'); return { success: true, data: null }; } });
    const controller = createStubController(() => registry);
    const layer = controller.wrap(new ExecutionLayer(registry, logger));
    controller.beginRun({}, 'scenario-1', { throughGateway: true });
    const result = await layer.invoke('email-send', {}, undefined, coordinatorCall);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/no review layer/);
    expect(executed).toEqual([]);
    controller.endRun('scenario-1');
  });
});

describe('attach (#2312: inbound.then)', () => {
  it('files a later conversation under the open run: same stubs, calls recorded with the run, released at endRun', async () => {
    const { layer, controller } = setup();
    controller.beginRun({ 'email-send': [{ match: {}, return: { sent: true } }] }, 'scenario-1');
    controller.attach('scenario-1', 'scenario-then-1');
    expect(controller.rootOf('scenario-then-1')).toBe('scenario-1');
    expect(await layer.invoke('email-send', {}, undefined, { agentId: 'coordinator', conversationId: 'scenario-then-1' }))
      .toEqual({ success: true, data: { sent: true } });
    expect(() => controller.attach('scenario-1', 'scenario-then-1')).toThrow(/already belongs/);
    expect(controller.endRun('scenario-1').map(c => c.toolName)).toEqual(['email-send']);
    expect(controller.rootOf('scenario-then-1')).toBeUndefined();
    expect(() => controller.attach('scenario-1', 'scenario-then-2')).toThrow(/no open run/);
  });
});

// #2474: ceo-inbox-send-draft runs for real in a through-gateway run, from the principal's own
// mailbox. Its drafts are the case's seeds plus what the stubbed ceo-inbox draft tools write.
describe('principal-mailbox drafts (#2474)', () => {
  it('runs ceo-inbox-send-draft for real in a through-gateway run', () => {
    expect(THROUGH_GATEWAY_SEND_TOOLS.has('ceo-inbox-send-draft')).toBe(true);
  });

  it('refuses it in the ceo-inbox stub sets in production\'s words', () => {
    for (const set of ['ceo-inbox-mailroom', 'ceo-inbox-office']) {
      const stubs = parseStubs(yaml.load(readFileSync(path.join(DEFAULT_STUBS_DIR, `${set}.yaml`), 'utf-8')), `${set}.yaml`);
      expect(stubs['ceo-inbox-send-draft'], set).toEqual([{ agent: 'ceo-inbox', match: {}, error: PRINCIPAL_SEND_REFUSALS.not_requested }]);
    }
  });

  function draftSetup() {
    const registry = new ToolRegistry();
    for (const name of ['ceo-inbox-draft-compose', 'ceo-inbox-draft-reply', 'ceo-inbox-draft-edit', 'ceo-inbox-read']) {
      registry.register(manifest(name, name === 'ceo-inbox-read' ? 'none' : 'low'), { execute: async () => ({ success: true, data: `real ${name}` }) });
    }
    const controller = createStubController(() => registry);
    const layer = controller.wrap(new ExecutionLayer(registry, logger));
    const stubs = {
      'ceo-inbox-draft-compose': [{ match: {}, return: { draft_id: 'draft-0002', subject: 'Agenda' } }],
      'ceo-inbox-draft-reply': [{ match: {}, return: { draft_id: 'draft-0001', subject: 'Re: Venue', to: [{ email: 'jo.park@acme.example.test' }], cc: [] } }],
      'ceo-inbox-draft-edit': [{ match: {}, return: { draft_id: 'scenario-draft-edit-1' } }],
    };
    const mirrored: Array<{ draft: MailboxDraft; curiaWrote: boolean; edited?: true }> = [];
    const draftMirror: DraftMirror = (draft, curiaWrote, edited) => { mirrored.push({ draft, curiaWrote, ...(edited ? { edited } : {}) }); };
    return { layer, controller, stubs, mirrored, draftMirror };
  }

  it('hands each stubbed compose or reply to the run\'s mirror as a draft Curia wrote', async () => {
    const { layer, controller, stubs, mirrored, draftMirror } = draftSetup();
    controller.beginRun(stubs, 'scenario-1', { throughGateway: true, draftMirror });
    await layer.invoke('ceo-inbox-draft-compose', { to_addresses: ['sam@older.test'], subject: 'Agenda', body: 'Here is the agenda.' }, undefined, coordinatorCall);
    await layer.invoke('ceo-inbox-draft-reply', { reply_to_message_id: 'm1', body: 'The Harbour Room works.' }, undefined, coordinatorCall);
    expect(mirrored).toEqual([
      { draft: { id: 'draft-0002', subject: 'Agenda', to: [{ email: 'sam@older.test' }], cc: [], body: 'Here is the agenda.' }, curiaWrote: true },
      // The message a reply answers (#2474 PR 2): the run's mailbox puts the draft on its thread.
      { draft: { id: 'draft-0001', subject: 'Re: Venue', to: [{ email: 'jo.park@acme.example.test' }], cc: [], body: 'The Harbour Room works.', replyTo: 'm1' }, curiaWrote: true },
    ]);
    controller.endRun('scenario-1');
  });

  it('hands a compose\'s contact-ID recipients to the mirror to resolve, not dropped (#2474 PR 2)', async () => {
    const { layer, controller, stubs, mirrored, draftMirror } = draftSetup();
    controller.beginRun(stubs, 'scenario-1', { throughGateway: true, draftMirror });
    await layer.invoke('ceo-inbox-draft-compose', { to: ['contact-pat'], cc: ['principal'], to_addresses: ['sam@older.test'], subject: 'Agenda', body: 'x' }, undefined, coordinatorCall);
    expect(mirrored).toEqual([{
      draft: { id: 'draft-0002', subject: 'Agenda', to: [{ email: 'sam@older.test' }], cc: [], body: 'x', contactIds: { to: ['contact-pat'], cc: ['principal'] } },
      curiaWrote: true,
    }]);
    controller.endRun('scenario-1');
  });

  it('applies a stubbed edit to a draft already in the mailbox, and reads it back', async () => {
    const { layer, controller, stubs, mirrored, draftMirror } = draftSetup();
    const seeded: MailboxDraft = { id: 'draft-30z-acme', subject: 'Offsite', to: [{ name: 'Jo Park', email: 'jo.park@acme.example.test' }], cc: [], body: 'Venue: [venue TBD]' };
    controller.beginRun(stubs, 'scenario-1', { throughGateway: true, draftMirror, mailboxDrafts: [seeded] });
    await layer.invoke('ceo-inbox-draft-edit', { draft_id: 'draft-30z-acme', body: 'Venue: the Harbour Room' }, undefined, coordinatorCall);
    // An edit (final review S1): the gateway reviews the draft as curia-edited.
    expect(mirrored).toEqual([{ draft: { ...seeded, body: 'Venue: the Harbour Room' }, curiaWrote: false, edited: true }]);
    // The seed itself is not a write: only the edit reached the mirror.
    const read = await layer.invoke('ceo-inbox-read', { draft_id: 'draft-30z-acme' }, undefined, coordinatorCall);
    expect(read).toMatchObject({ success: true, data: { id: 'draft-30z-acme', body_plain: 'Venue: the Harbour Room', to: [{ name: 'Jo Park', email: 'jo.park@acme.example.test' }] } });
    controller.endRun('scenario-1');
  });

  it('does not count a reply that found the principal\'s existing draft as Curia\'s', async () => {
    const { layer, controller, mirrored, draftMirror } = draftSetup();
    const stubs = { 'ceo-inbox-draft-reply': [{ match: {}, return: { draft_id: 'draft-theirs', subject: 'Re: Venue', to: [{ email: 'jo.park@acme.example.test' }], cc: [], already_exists: true } }] };
    controller.beginRun(stubs, 'scenario-1', { throughGateway: true, draftMirror });
    await layer.invoke('ceo-inbox-draft-reply', { reply_to_message_id: 'm1', body: 'Sure.' }, undefined, coordinatorCall);
    expect(mirrored.map(m => [m.draft.id, m.curiaWrote])).toEqual([['draft-theirs', false]]);
    controller.endRun('scenario-1');
  });

  it('leaves the principal\'s existing draft as it was when a reply finds it (already_exists)', async () => {
    const { layer, controller, mirrored, draftMirror } = draftSetup();
    const seeded: MailboxDraft = { id: 'draft-theirs', subject: 'Re: Venue', to: [{ name: 'Jo Park', email: 'jo.park@acme.example.test' }], cc: [], body: 'Jo, the Harbour Room works and' };
    const stubs = { 'ceo-inbox-draft-reply': [{ match: {}, return: { draft_id: 'draft-theirs', subject: 'Re: Venue', to: [{ email: 'jo.park@acme.example.test' }], cc: [], already_exists: true } }] };
    controller.beginRun(stubs, 'scenario-1', { throughGateway: true, draftMirror, mailboxDrafts: [seeded] });
    await layer.invoke('ceo-inbox-draft-reply', { reply_to_message_id: 'm1', body: 'Curia wrote this.' }, undefined, coordinatorCall);
    // The real tool writes nothing: the read and the mirror keep the principal's text.
    expect(mirrored).toEqual([{ draft: seeded, curiaWrote: false }]);
    const read = await layer.invoke('ceo-inbox-read', { draft_id: 'draft-theirs' }, undefined, coordinatorCall);
    expect(read).toMatchObject({ success: true, data: { body_plain: 'Jo, the Harbour Room works and' } });
    controller.endRun('scenario-1');
  });

  it('mirrors nothing for a run without a mirror', async () => {
    const { layer, controller, stubs, mirrored } = draftSetup();
    controller.beginRun(stubs, 'scenario-1');
    await layer.invoke('ceo-inbox-draft-compose', { to_addresses: ['sam@older.test'], subject: 'Agenda', body: 'x' }, undefined, coordinatorCall);
    expect(mirrored).toEqual([]);
    controller.endRun('scenario-1');
  });
});
