// The execution layer hands `delegate` the outbound-context capability without
// the manifest declaring it (#1972). Declaring it would make the layer fail closed
// wherever the service is absent — the smoke suite's test-mode stack runs without
// it on purpose — and refuse every delegation there.
import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { EventBus } from '../../../src/bus/bus.js';
import { ToolRegistry } from '../../../src/skills/registry.js';
import { ExecutionLayer } from '../../../src/skills/execution.js';
import { AgentRegistry } from '../../../src/agents/agent-registry.js';
import type { ToolContext, ToolHandler, ToolManifest, ToolResult } from '../../../src/skills/types.js';
import type { OutboundContextService } from '../../../src/dispatch/outbound-context.js';
import type { VerificationRuntime } from '../../../src/verification/index.js';
import delegateManifest from '../../../skills/delegate/tool.json' with { type: 'json' };

const logger = pino({ level: 'silent' });

/** Stands in for the delegate handler: records the context it was given. */
class CapturingHandler implements ToolHandler {
  seen: ToolContext | undefined;
  async execute(ctx: ToolContext): Promise<ToolResult> {
    this.seen = ctx;
    return { success: true, data: { response: 'ok', agent: 'ceo-inbox' } };
  }
}

function layer(outboundContextService: OutboundContextService | undefined, verification?: VerificationRuntime) {
  const handler = new CapturingHandler();
  const registry = new ToolRegistry();
  registry.register(delegateManifest as ToolManifest, handler);
  const agentRegistry = new AgentRegistry();
  agentRegistry.register('coordinator', { role: 'coordinator', description: 'router' });
  agentRegistry.register('ceo-inbox', { role: 'specialist', description: 'inbox' });
  const executionLayer = new ExecutionLayer(registry, logger, {
    bus: new EventBus(logger),
    agentRegistry,
    ...(outboundContextService ? { outboundContextService } : {}),
    ...(verification ? { verification } : {}),
  });
  return { executionLayer, handler };
}

const options = { agentId: 'coordinator', taskEventId: 'task-1', conversationId: 'signal:+15555550100', channelId: 'signal' };

describe('delegate outbound-context injection (#1972)', () => {
  it('does not declare the capability, so a layer without the service still runs delegate', async () => {
    expect(delegateManifest.capabilities).not.toContain('outboundContext');
    const { executionLayer, handler } = layer(undefined);
    const result = await executionLayer.invoke('delegate', { agent: 'ceo-inbox', task: 'go' }, undefined, options);
    expect(result.success).toBe(true);
    expect(handler.seen?.outboundContext).toBeUndefined();
  });

  it('injects a scoped outbound context for delegate when the service is configured', async () => {
    const service = {
      defaultExpiryHours: 6,
      explicitExpiryHours: 24,
      defaultExpiryHoursFor: () => 6,
    } as unknown as OutboundContextService;
    const { executionLayer, handler } = layer(service);
    const result = await executionLayer.invoke('delegate', { agent: 'ceo-inbox', task: 'go' }, undefined, options);
    expect(result.success).toBe(true);
    expect(handler.seen?.outboundContext).toBeDefined();
  });

  // #2017: a pending sign-in verification for the task suppresses the task-wake auto-bind.
  it('wires the task auto-bind suppression lookup to the verification service', async () => {
    const service = {
      defaultExpiryHours: 6,
      explicitExpiryHours: 24,
      defaultExpiryHoursFor: () => 6,
    } as unknown as OutboundContextService;
    const pendingForTask = vi.fn(async (taskId: string) => (taskId === 'task-with-code-ask' ? { id: 'ver-1' } : null));
    const verification = { service: { pendingForTask }, tracker: { scrubDeep: <T>(v: T) => v } } as unknown as VerificationRuntime;
    const { executionLayer, handler } = layer(service, verification);
    await executionLayer.invoke('delegate', { agent: 'ceo-inbox', task: 'go' }, undefined, options);
    const scoped = handler.seen?.outboundContext;
    await expect(scoped?.taskAutoBindSuppressed?.('task-with-code-ask')).resolves.toBe(true);
    await expect(scoped?.taskAutoBindSuppressed?.('other-task')).resolves.toBe(false);
  });

  it('never suppresses the auto-bind when no verification runtime is wired', async () => {
    const service = {
      defaultExpiryHours: 6,
      explicitExpiryHours: 24,
      defaultExpiryHoursFor: () => 6,
    } as unknown as OutboundContextService;
    const { executionLayer, handler } = layer(service);
    await executionLayer.invoke('delegate', { agent: 'ceo-inbox', task: 'go' }, undefined, options);
    await expect(handler.seen?.outboundContext?.taskAutoBindSuppressed?.('any-task')).resolves.toBe(false);
  });
});
