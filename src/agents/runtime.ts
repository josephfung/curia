import type { LLMProvider, Message } from './llm/provider.js';
import type { EventBus } from '../bus/bus.js';
import { createAgentResponse, type AgentTaskEvent } from '../bus/events.js';
import type { Logger } from '../logger.js';
import { WorkingMemory } from '../memory/working-memory.js';

export interface AgentConfig {
  agentId: string;
  systemPrompt: string;
  provider: LLMProvider;
  bus: EventBus;
  logger: Logger;
  /** Optional working memory for conversation persistence across turns. */
  memory?: WorkingMemory;
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
   * Process a task: load conversation history (if memory is configured),
   * call the LLM with system prompt + history + user content, persist both
   * the user message and assistant response to memory, then publish the
   * response back to the bus as agent.response.
   */
  private async handleTask(taskEvent: AgentTaskEvent): Promise<void> {
    const { agentId, systemPrompt, provider, bus, logger, memory } = this.config;
    const { content, conversationId } = taskEvent.payload;

    // Load conversation history from working memory (if configured).
    // Without memory, each task is treated as a fresh single-turn exchange.
    const history = memory
      ? await memory.getHistory(conversationId, agentId)
      : [];

    // Assemble LLM context: system prompt + prior turns + new user message
    const messages: Message[] = [
      { role: 'system', content: systemPrompt },
      ...history,
      { role: 'user', content },
    ];

    logger.info({ agentId, conversationId, historyLength: history.length }, 'Agent processing task');

    // Persist the incoming user message before calling the LLM so that a
    // crash during the LLM call still records what the user said
    if (memory) {
      await memory.addTurn(conversationId, agentId, { role: 'user', content });
    }

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

    // Persist the assistant response so subsequent turns include it as context
    if (memory) {
      await memory.addTurn(conversationId, agentId, { role: 'assistant', content: responseContent });
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
