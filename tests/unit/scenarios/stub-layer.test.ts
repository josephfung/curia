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
  const controller = createStubController(registry);
  const layer = controller.wrap(base);
  return { layer, controller, executed };
}

const coordinatorCall = { agentId: 'coordinator', conversationId: 'scenario-1' };

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
    controller.beginRun({});
    for (const tool of ['email-send', 'signal-send', 'context-bridge-release', 'delegate', 'risky-by-number']) {
      const result = await layer.invoke(tool, { to: 'someone@example.com' }, undefined, coordinatorCall);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toMatch(/^<skill_error>.*no stub/);
    }
    expect(executed).toEqual([]);
    expect(controller.endRun().map(c => c.disposition)).toEqual(Array(5).fill('refused'));
  });

  it('answers a stubbed send itself and never reaches the real tool', async () => {
    const { layer, controller, executed } = setup();
    controller.beginRun({ 'email-send': [{ match: {}, return: { sent: true } }] });
    const result = await layer.invoke('email-send', { to: 'x@example.com' }, undefined, coordinatorCall);
    expect(result).toEqual({ success: true, data: { sent: true } });
    expect(executed).toEqual([]);
  });

  it('returns a scripted error as a skill error', async () => {
    const { layer, controller } = setup();
    controller.beginRun({ delegate: [{ match: {}, error: 'specialist unavailable' }] });
    const result = await layer.invoke('delegate', { agent: 'calendar' }, undefined, coordinatorCall);
    expect(result).toEqual({ success: false, error: '<skill_error>specialist unavailable</skill_error>' });
  });

  it('passes an unstubbed read-only tool through to the real layer', async () => {
    const { layer, controller, executed } = setup();
    controller.beginRun({});
    const result = await layer.invoke('memory-query', {}, undefined, coordinatorCall);
    expect(result).toMatchObject({ success: true, data: 'real memory-query' });
    expect(executed).toEqual(['memory-query']);
    expect(controller.endRun()).toEqual([
      { agentId: 'coordinator', toolName: 'memory-query', input: {}, disposition: 'passthrough' },
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
    controller.beginRun(stubs);
    const first = await layer.invoke('email-send', {}, undefined, coordinatorCall);
    if (first.success) (first.data as Record<string, unknown>).sent = false;
    const second = await layer.invoke('email-send', {}, undefined, coordinatorCall);
    expect(second).toEqual({ success: true, data: { sent: true } });
  });

  it('records the real layer not being called even when invoke is spied', async () => {
    const { layer, controller } = setup();
    const spy = vi.spyOn(ExecutionLayer.prototype, 'invoke');
    controller.beginRun({ 'signal-send': [{ match: {}, return: { sent: true } }] });
    await layer.invoke('signal-send', {}, undefined, coordinatorCall);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
