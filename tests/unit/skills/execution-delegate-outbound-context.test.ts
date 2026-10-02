// The execution layer hands `delegate` the outbound-context capability without
// the manifest declaring it (#1972). Declaring it would make the layer fail closed
// wherever the service is absent — the smoke suite's test-mode stack runs without
// it on purpose — and refuse every delegation there.
import { describe, it, expect } from 'vitest';
import pino from 'pino';
import { EventBus } from '../../../src/bus/bus.js';
import { ToolRegistry } from '../../../src/skills/registry.js';
import { ExecutionLayer } from '../../../src/skills/execution.js';
import { AgentRegistry } from '../../../src/agents/agent-registry.js';
import type { ToolContext, ToolHandler, ToolManifest, ToolResult } from '../../../src/skills/types.js';
import type { OutboundContextService } from '../../../src/dispatch/outbound-context.js';
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

function layer(outboundContextService: OutboundContextService | undefined) {
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
});
