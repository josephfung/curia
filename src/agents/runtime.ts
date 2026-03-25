import type { LLMProvider, Message, ToolDefinition, ToolResult } from './llm/provider.js';
import type { EventBus } from '../bus/bus.js';
import { createAgentResponse, createSkillInvoke, createSkillResult, type AgentTaskEvent } from '../bus/events.js';
import type { Logger } from '../logger.js';
import type { WorkingMemory } from '../memory/working-memory.js';
import type { ExecutionLayer } from '../skills/execution.js';
import { sanitizeOutput } from '../skills/sanitize.js';

export interface AgentConfig {
  agentId: string;
  systemPrompt: string;
  provider: LLMProvider;
  bus: EventBus;
  logger: Logger;
  /** Optional working memory for conversation persistence across turns. */
  memory?: WorkingMemory;
  /** Optional execution layer for skill invocations via tool-use. */
  executionLayer?: ExecutionLayer;
  /** Skill names to include as tools in every LLM call. */
  pinnedSkills?: string[];
  /** Pre-built tool definitions for the LLM (from SkillRegistry.toToolDefinitions). */
  skillToolDefs?: ToolDefinition[];
}

// Maximum tool-use iterations to prevent infinite loops.
// If the LLM keeps requesting tools beyond this limit, we force a text response.
const MAX_TOOL_ITERATIONS = 10;

/**
 * AgentRuntime is the execution engine for a single agent.
 *
 * It subscribes to agent.task events on the bus and publishes agent.response
 * events back. When tools are configured, it drives a tool-use loop:
 * call LLM → if tool_use, invoke skill → feed result back → repeat until text.
 */
export class AgentRuntime {
  private config: AgentConfig;

  constructor(config: AgentConfig) {
    this.config = config;
  }

  register(): void {
    this.config.bus.subscribe('agent.task', 'agent', async (event) => {
      const taskEvent = event as AgentTaskEvent;
      if (taskEvent.payload.agentId !== this.config.agentId) return;
      await this.handleTask(taskEvent);
    });

    this.config.logger.info({ agentId: this.config.agentId }, 'Agent registered');
  }

  /**
   * Top-level error boundary for task processing.
   * Ensures the user always gets a response, even if something unexpected throws.
   */
  private async handleTask(taskEvent: AgentTaskEvent): Promise<void> {
    try {
      await this.processTask(taskEvent);
    } catch (err) {
      this.config.logger.error(
        { err, agentId: this.config.agentId, conversationId: taskEvent.payload.conversationId },
        'Unhandled error in agent task processing',
      );
      // Best-effort: try to send an error response so the user isn't left hanging
      try {
        const responseEvent = createAgentResponse({
          agentId: this.config.agentId,
          conversationId: taskEvent.payload.conversationId,
          content: "I'm sorry, an unexpected error occurred while processing your request.",
          parentEventId: taskEvent.id,
        });
        await this.config.bus.publish('agent', responseEvent);
      } catch (publishErr) {
        this.config.logger.error({ err: publishErr }, 'Failed to publish error response');
      }
    }
  }

  private async processTask(taskEvent: AgentTaskEvent): Promise<void> {
    const { agentId, systemPrompt, provider, bus, logger, memory, executionLayer, skillToolDefs } = this.config;
    const { content, conversationId } = taskEvent.payload;

    // Load conversation history from working memory (if configured)
    const history = memory
      ? await memory.getHistory(conversationId, agentId)
      : [];

    // Assemble initial LLM context
    const messages: Message[] = [
      { role: 'system', content: systemPrompt },
      ...history,
      { role: 'user', content },
    ];

    logger.info({ agentId, conversationId, historyLength: history.length }, 'Agent processing task');

    // Persist the incoming user message
    if (memory) {
      await memory.addTurn(conversationId, agentId, { role: 'user', content });
    }

    // Tool-use loop: call LLM, handle tool calls, feed results back, repeat.
    // The Anthropic API requires the full conversation context including the
    // assistant's tool_use response and the user's tool_result turn. We build
    // this up in the messages array across iterations.
    let response = await provider.chat({ messages, tools: skillToolDefs });
    let iterations = 0;

    while (response.type === 'tool_use' && executionLayer && iterations < MAX_TOOL_ITERATIONS) {
      iterations++;
      logger.info(
        { agentId, iteration: iterations, toolCalls: response.toolCalls.map(tc => tc.name) },
        'LLM requested tool calls',
      );

      // Append the assistant's tool_use turn to the conversation so the LLM
      // has full context on the next call. We represent the assistant turn as
      // a text summary since our Message type doesn't carry tool_use blocks.
      // The actual tool results are passed via the toolResults parameter.
      const toolCallSummary = response.toolCalls
        .map(tc => `[Calling tool: ${tc.name}]`)
        .join(' ');
      messages.push({
        role: 'assistant',
        content: response.content
          ? `${response.content} ${toolCallSummary}`
          : toolCallSummary,
      });

      // Execute each tool call through the execution layer.
      // Publish skill.invoke and skill.result bus events for audit coverage.
      const toolResults: ToolResult[] = [];
      for (const toolCall of response.toolCalls) {
        logger.info({ agentId, skill: toolCall.name, callId: toolCall.id }, 'Invoking skill');

        // Publish skill.invoke for audit trail
        const invokeEvent = createSkillInvoke({
          agentId,
          conversationId,
          skillName: toolCall.name,
          input: toolCall.input,
          taskEventId: taskEvent.id,
          parentEventId: taskEvent.id,
        });
        await bus.publish('agent', invokeEvent);

        const startTime = Date.now();
        const result = await executionLayer.invoke(toolCall.name, toolCall.input);
        const durationMs = Date.now() - startTime;

        // Publish skill.result for audit trail
        // Published by agent layer on behalf of the execution layer —
        // the execution layer doesn't have bus access in Phase 3.
        // TODO: When execution layer gets bus access, move this publish there.
        const resultEvent = createSkillResult({
          agentId,
          conversationId,
          skillName: toolCall.name,
          result,
          durationMs,
          parentEventId: invokeEvent.id,
        });
        await bus.publish('agent', resultEvent);

        if (result.success) {
          const resultContent = typeof result.data === 'string' ? result.data : JSON.stringify(result.data);
          toolResults.push({ id: toolCall.id, content: resultContent });
        } else {
          // Sanitize error messages before sending to LLM — skill errors
          // can contain injection vectors from external sources
          const sanitizedError = sanitizeOutput(result.error, { isError: true });
          toolResults.push({ id: toolCall.id, content: sanitizedError, is_error: true });
        }
      }

      // Append a user turn summarizing tool results for conversation context
      const resultsSummary = toolResults
        .map(tr => tr.is_error ? `[Tool error: ${tr.content}]` : `[Tool result received]`)
        .join(' ');
      messages.push({ role: 'user', content: resultsSummary });

      // Feed tool results back to the LLM and continue the loop
      response = await provider.chat({ messages, tools: skillToolDefs, toolResults });
    }

    // Handle the final response (text or error)
    let responseContent: string;
    if (response.type === 'error') {
      logger.error({ agentId, error: response.error }, 'LLM call failed');
      responseContent = "I'm sorry, I was unable to process that request. Please try again.";
    } else if (response.type === 'tool_use') {
      // Reached max iterations — the LLM is stuck in a tool loop
      logger.warn({ agentId, iterations: MAX_TOOL_ITERATIONS }, 'Tool-use loop hit max iterations');
      responseContent = response.content ?? "I wasn't able to complete that request — I hit my tool-use limit. Please try rephrasing.";
    } else {
      logger.info(
        { agentId, inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens },
        'Agent task completed',
      );
      responseContent = response.content;
    }

    // Persist the assistant response
    if (memory) {
      await memory.addTurn(conversationId, agentId, { role: 'assistant', content: responseContent });
    }

    const responseEvent = createAgentResponse({
      agentId,
      conversationId,
      content: responseContent,
      parentEventId: taskEvent.id,
    });
    await bus.publish('agent', responseEvent);
  }
}
