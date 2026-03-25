import type { LLMProvider, Message } from './llm/provider.js';
import type { EventBus } from '../bus/bus.js';
import { createAgentResponse, type AgentTaskEvent } from '../bus/events.js';
import type { Logger } from '../logger.js';

export interface AgentConfig {
  agentId: string;
  systemPrompt: string;
  provider: LLMProvider;
  bus: EventBus;
  logger: Logger;
}

/**
 * AgentRuntime is the execution engine for a single agent.
 *
 * It subscribes to agent.task events on the bus and publishes agent.response
 * events back. It does NOT return values — the bus is the only communication
 * channel. This ensures:
 * 1. Every response flows through the audit logger (bus write-ahead hook)
 * 2. The dispatcher doesn't need a direct reference to the agent
 * 3. Multiple agents can coexist on the same bus without coupling
 */
export class AgentRuntime {
  private config: AgentConfig;

  constructor(config: AgentConfig) {
    this.config = config;
  }

  /**
   * Register this agent on the bus. After this call, the agent will
   * automatically process any agent.task events addressed to it.
   */
  register(): void {
    this.config.bus.subscribe('agent.task', 'agent', async (event) => {
      const taskEvent = event as AgentTaskEvent;
      // Only handle tasks addressed to this agent — other agents on the bus
      // will handle their own tasks
      if (taskEvent.payload.agentId !== this.config.agentId) return;
      await this.handleTask(taskEvent);
    });

    this.config.logger.info({ agentId: this.config.agentId }, 'Agent registered');
  }

  /**
   * Process a task: call the LLM with system prompt + user content,
   * then publish the response back to the bus as agent.response.
   */
  private async handleTask(taskEvent: AgentTaskEvent): Promise<void> {
    const { agentId, systemPrompt, provider, bus, logger } = this.config;
    const { content, conversationId } = taskEvent.payload;

    const messages: Message[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content },
    ];

    logger.info({ agentId, conversationId }, 'Agent processing task');

    const response = await provider.chat({ messages });

    let responseContent: string;
    if (response.type === 'error') {
      logger.error({ agentId, error: response.error }, 'LLM call failed');
      responseContent = "I'm sorry, I was unable to process that request. Please try again.";
    } else {
      logger.info(
        { agentId, inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens },
        'Agent task completed',
      );
      responseContent = response.content;
    }

    // Publish response back to the bus — the dispatcher subscribes to
    // agent.response and converts it to outbound.message
    const responseEvent = createAgentResponse({
      agentId,
      conversationId,
      content: responseContent,
      parentEventId: taskEvent.id,
    });
    await bus.publish('agent', responseEvent);
  }
}
