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
    // parentEventId uses a delegate-prefixed UUID. Ideally this would trace back
    // to the Coordinator's skill.invoke event, but SkillContext doesn't currently
    // carry the invoking event's ID. TODO: Add invokeEventId to SkillContext so
    // infrastructure skills can maintain the full audit causal chain.
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
    // persists after the delegation completes. The settled guard makes it
    // a near-zero-cost no-op after resolution. Phase 5 should add
    // bus.unsubscribe() or a one-shot subscription pattern.
    let timeoutHandle: NodeJS.Timeout;
    const responsePromise = new Promise<string>((resolve, reject) => {
      let settled = false;

      timeoutHandle = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error(`Specialist '${agent}' did not respond within ${SPECIALIST_TIMEOUT_MS}ms`));
        }
      }, SPECIALIST_TIMEOUT_MS);

      ctx.bus!.subscribe('agent.response', 'system', async (event) => {
        if (settled) return; // Skip processing after settlement — prevents double-resolve
        try {
          const responseEvent = event as AgentResponseEvent;
          // Match on the task event ID — the specialist sets parentEventId to the task ID
          if (responseEvent.parentEventId === taskEvent.id) {
            settled = true;
            clearTimeout(timeoutHandle);
            resolve(responseEvent.payload.content);
          }
        } catch (err) {
          // Fail fast on malformed events rather than silently hanging until timeout
          if (!settled) {
            settled = true;
            clearTimeout(timeoutHandle);
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        }
      });
    });

    // Publish the task to the bus — the specialist will pick it up.
    // We publish as 'dispatch' layer because only dispatch can publish agent.task
    // per the permission model. Infrastructure skills are trusted to impersonate layers.
    try {
      await ctx.bus.publish('dispatch', taskEvent);
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
    } finally {
      // Always clean up the timeout — prevents unhandled rejection if publish()
      // throws before responsePromise is awaited
      clearTimeout(timeoutHandle!);
    }
  }
}
