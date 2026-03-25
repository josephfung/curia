// handler.ts — delegate skill implementation.
//
// This is an infrastructure skill — it has bus and agentRegistry access
// that normal skills don't get. It publishes an agent.task event for the
// target specialist, then waits for the specialist's agent.response.
//
// The Coordinator uses this skill to delegate work: it calls
// delegate({ agent: "research-analyst", task: "..." }) and gets back
// the specialist's response, which it can then synthesize into its own reply.

import { randomUUID } from 'node:crypto';
import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { createAgentTask, type AgentResponseEvent } from '../../src/bus/events.js';

// How long to wait for the specialist to respond before timing out.
const SPECIALIST_TIMEOUT_MS = 90000;

export class DelegateHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const { agent, task, conversation_id } = ctx.input as {
      agent?: string;
      task?: string;
      conversation_id?: string;
    };

    // Validate required inputs
    if (!agent || typeof agent !== 'string') {
      return { success: false, error: 'Missing required input: agent (string)' };
    }
    if (!task || typeof task !== 'string') {
      return { success: false, error: 'Missing required input: task (string)' };
    }

    // Infrastructure skills need bus and agent registry
    if (!ctx.bus || !ctx.agentRegistry) {
      return {
        success: false,
        error: 'Delegate skill requires infrastructure access (bus, agentRegistry). Is infrastructure: true set in the manifest?',
      };
    }

    // Validate target agent exists and isn't the coordinator
    if (!ctx.agentRegistry.has(agent)) {
      const available = ctx.agentRegistry.listSpecialists().map(a => a.name).join(', ');
      return {
        success: false,
        error: `Agent '${agent}' not found. Available specialists: ${available || 'none'}`,
      };
    }

    const targetAgent = ctx.agentRegistry.get(agent)!;
    if (targetAgent.role === 'coordinator') {
      return {
        success: false,
        error: 'You cannot delegate to the coordinator — that would create a loop. Delegate to a specialist instead.',
      };
    }

    const conversationId = conversation_id ?? `delegate-${randomUUID()}`;

    ctx.log.info({ targetAgent: agent, task: task.slice(0, 100) }, 'Delegating task to specialist');

    // Publish an agent.task event for the specialist.
    const taskEvent = createAgentTask({
      agentId: agent,
      conversationId,
      channelId: 'internal',
      senderId: 'coordinator',
      content: task,
      parentEventId: `delegate-${randomUUID()}`,
    });

    // Set up a one-time listener for the specialist's response BEFORE
    // publishing the task, so we don't miss a fast response.
    // TODO: The EventBus has no unsubscribe mechanism, so this subscriber
    // persists after the delegation completes. For Phase 4 this is acceptable
    // (the filter prevents duplicate processing), but Phase 5 should add
    // bus.unsubscribe() or a one-shot subscription pattern.
    const responsePromise = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Specialist '${agent}' did not respond within ${SPECIALIST_TIMEOUT_MS}ms`));
      }, SPECIALIST_TIMEOUT_MS);

      ctx.bus!.subscribe('agent.response', 'system', async (event) => {
        const responseEvent = event as AgentResponseEvent;
        // Match on the task event ID — the specialist sets parentEventId to the task ID
        if (responseEvent.parentEventId === taskEvent.id) {
          clearTimeout(timeout);
          resolve(responseEvent.payload.content);
        }
      });
    });

    // Publish the task to the bus — the specialist will pick it up
    await ctx.bus.publish('dispatch', taskEvent);

    try {
      const response = await responsePromise;
      ctx.log.info({ targetAgent: agent }, 'Specialist responded');

      return {
        success: true,
        data: {
          response,
          agent,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, targetAgent: agent }, 'Delegation failed');
      return { success: false, error: message };
    }
  }
}
