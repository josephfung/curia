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
});
