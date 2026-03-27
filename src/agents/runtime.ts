import type { LLMProvider, LLMResponse, Message, ToolDefinition, ContentBlock, ToolUseContent, ToolResultContent, TextContent } from './llm/provider.js';
import type { EventBus } from '../bus/bus.js';
import { createAgentResponse, createAgentError, createSkillInvoke, createSkillResult, type AgentTaskEvent } from '../bus/events.js';
import type { Logger } from '../logger.js';
import type { WorkingMemory } from '../memory/working-memory.js';
import type { EntityMemory } from '../memory/entity-memory.js';
import type { ExecutionLayer } from '../skills/execution.js';
import { sanitizeOutput } from '../skills/sanitize.js';
import { classifySkillError, formatTaskError } from '../errors/classify.js';
import { DEFAULT_ERROR_BUDGET, type AgentError, type ErrorBudget } from '../errors/types.js';

export interface AgentConfig {
  agentId: string;
  systemPrompt: string;
  provider: LLMProvider;
  bus: EventBus;
  logger: Logger;
  /** Optional working memory for conversation persistence across turns. */
  memory?: WorkingMemory;
  /** Optional entity memory for knowledge graph access. */
  entityMemory?: EntityMemory;
  /** Optional execution layer for skill invocations via tool-use. */
  executionLayer?: ExecutionLayer;
  /** Skill names to include as tools in every LLM call. */
  pinnedSkills?: string[];
  /** Pre-built tool definitions for the LLM (from SkillRegistry.toToolDefinitions). */
  skillToolDefs?: ToolDefinition[];
  /** Error budget config — turn and consecutive error limits per task. */
  errorBudget?: {
    maxTurns: number;
    maxConsecutiveErrors: number;
  };
}

// LLM retry backoff schedule (milliseconds). Three attempts with exponential backoff.
const RETRY_BACKOFF_MS = [1000, 5000, 15000] as const;

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

    // Initialize the error budget for this task.
    // Config values override defaults; budget tracks runtime counters.
    const budgetConfig = this.config.errorBudget;
    const budget: ErrorBudget = {
      maxTurns: budgetConfig?.maxTurns ?? DEFAULT_ERROR_BUDGET.maxTurns,
      maxConsecutiveErrors: budgetConfig?.maxConsecutiveErrors ?? DEFAULT_ERROR_BUDGET.maxConsecutiveErrors,
      turnsUsed: 0,
      consecutiveErrors: 0,
    };

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

    // Inject resolved sender context as a system message so the coordinator
    // knows who it's talking to. Inserted after the system prompt but before
    // history, so it's visible but doesn't pollute working memory.
    const senderCtx = taskEvent.payload.senderContext;
    if (senderCtx?.resolved) {
      // Sanitize sender fields before prompt inclusion — these originate from
      // external sources (self-claimed names, imported roles) and could contain
      // prompt injection attempts.
      const safeName = sanitizeOutput(senderCtx.displayName);
      const safeRole = senderCtx.role ? sanitizeOutput(senderCtx.role) : null;
      // Length-limit knowledgeSummary to prevent context stuffing
      const safeKnowledge = senderCtx.knowledgeSummary
        ? sanitizeOutput(senderCtx.knowledgeSummary).slice(0, 2000)
        : '';

      let senderInfo = `Current sender: ${safeName}`;
      if (safeRole) senderInfo += ` (${safeRole})`;
      senderInfo += senderCtx.verified ? ' [verified]' : ' [unverified]';
      // Include the channel and sender identifier so the coordinator knows
      // HOW the message arrived and WHO sent it (e.g., their email address).
      const channelId = taskEvent.payload.channelId;
      const senderId = sanitizeOutput(taskEvent.payload.senderId);
      senderInfo += `\nChannel: ${channelId} | Sender identifier: ${senderId}`;
      if (safeKnowledge) {
        senderInfo += `\n\nKnown context about ${safeName}:\n${safeKnowledge}`;
      }

      // Include authorization context so the coordinator knows what the sender can do.
      // This is deterministic — the AuthorizationService evaluated it, not the LLM.
      if (senderCtx.authorization) {
        const auth = senderCtx.authorization;
        if (auth.contactStatus !== 'confirmed') {
          senderInfo += `\n\nAUTHORIZATION: This contact is ${auth.contactStatus}. They have NO permissions. Do not take any actions on their behalf until the CEO confirms them.`;
        } else {
          const allowedStr = auth.allowed.length > 0 ? auth.allowed.join(', ') : 'none';
          const deniedStr = auth.denied.length > 0 ? auth.denied.join(', ') : 'none';
          senderInfo += `\n\nAUTHORIZATION:`;
          senderInfo += `\n  Allowed: ${allowedStr}`;
          senderInfo += `\n  Denied: ${deniedStr}`;
          if (auth.trustBlocked.length > 0) {
            senderInfo += `\n  Blocked by channel trust (${auth.channelTrust}): ${auth.trustBlocked.join(', ')} — ask sender to use a higher-trust channel`;
          }
          if (auth.escalate.length > 0) {
            senderInfo += `\n  Needs CEO decision: ${auth.escalate.join(', ')}`;
          }
        }
      }

      // Insert after system prompt (index 0) but before history
      messages.splice(1, 0, { role: 'system', content: senderInfo });
    }

    logger.info({ agentId, conversationId, historyLength: history.length }, 'Agent processing task');

    // Persist the incoming user message
    if (memory) {
      await memory.addTurn(conversationId, agentId, { role: 'user', content });
    }

    // Tool-use loop: call LLM, handle tool calls, feed results back, repeat.
    // The Anthropic API requires the full conversation context including the
    // assistant's tool_use content blocks and the user's tool_result blocks.
    // We build these as structured ContentBlock[] in the messages array so
    // the provider can pass them through to the API correctly.
    //
    // Budget-driven loop: each LLM round-trip consumes one turn from the budget.
    // The loop exits when: the LLM returns text, the budget is exhausted, or
    // consecutive errors exceed the threshold.
    let response = await this.chatWithRetry(provider, { messages, tools: skillToolDefs }, budget, taskEvent);
    if (!response) return; // chatWithRetry already published error events

    while (response.type === 'tool_use' && executionLayer) {
      // Check turn budget before processing this round of tool calls
      budget.turnsUsed++;
      if (budget.turnsUsed >= budget.maxTurns) {
        await this.handleBudgetExceeded(budget, taskEvent, 'maxTurns');
        return;
      }

      logger.info(
        { agentId, turn: budget.turnsUsed, toolCalls: response.toolCalls.map(tc => tc.name) },
        'LLM requested tool calls',
      );

      // Build the assistant turn with the actual tool_use content blocks.
      // The Anthropic API requires these to exist so tool_result blocks can
      // reference their IDs in the next user turn.
      const assistantBlocks: ContentBlock[] = [];
      if (response.content) {
        assistantBlocks.push({ type: 'text', text: response.content } as TextContent);
      }
      for (const tc of response.toolCalls) {
        assistantBlocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.name,
          input: tc.input,
        } as ToolUseContent);
      }
      messages.push({ role: 'assistant', content: assistantBlocks });

      // Execute each tool call through the execution layer.
      // Publish skill.invoke and skill.result bus events for audit coverage.
      const toolResultBlocks: ContentBlock[] = [];
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
          // Success: reset consecutive error counter
          budget.consecutiveErrors = 0;
          const resultContent = typeof result.data === 'string' ? result.data : JSON.stringify(result.data);
          toolResultBlocks.push({
            type: 'tool_result',
            tool_use_id: toolCall.id,
            content: resultContent,
          } as ToolResultContent);
        } else {
          // Failure: classify the error and format as a structured <task_error> block
          // so the LLM gets machine-readable error context instead of raw strings.
          budget.consecutiveErrors++;
          const agentErr = classifySkillError(toolCall.name, result.error);
          const formattedError = formatTaskError(
            toolCall.name,
            agentErr.type,
            agentErr.message,
            budget.turnsUsed,
            budget.maxTurns,
          );
          toolResultBlocks.push({
            type: 'tool_result',
            tool_use_id: toolCall.id,
            content: formattedError,
            is_error: true,
          } as ToolResultContent);
        }
      }

      // Check consecutive error budget after processing all tool calls in this turn
      if (budget.consecutiveErrors >= budget.maxConsecutiveErrors) {
        // Still append results so the LLM history is consistent, then bail
        messages.push({ role: 'user', content: toolResultBlocks });
        await this.handleBudgetExceeded(budget, taskEvent, 'maxConsecutiveErrors');
        return;
      }

      // Append tool results as a user turn with structured content blocks.
      // This is the format the Anthropic API expects — each tool_result references
      // a tool_use_id from the preceding assistant turn.
      messages.push({ role: 'user', content: toolResultBlocks });

      // Continue the loop — the full conversation history is now in messages
      response = await this.chatWithRetry(provider, { messages, tools: skillToolDefs }, budget, taskEvent);
      if (!response) return; // chatWithRetry already published error events
    }

    // Handle the final response (text or tool_use without execution layer)
    let responseContent: string;
    if (response.type === 'tool_use') {
      // No execution layer configured — the LLM wanted tools but we can't run them
      logger.warn({ agentId }, 'LLM returned tool_use but no execution layer configured');
      responseContent = response.content ?? "I wasn't able to complete that request — I hit my tool-use limit. Please try rephrasing.";
    } else if (response.type === 'text') {
      logger.info(
        { agentId, inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens },
        'Agent task completed',
      );
      responseContent = response.content;
    } else {
      // Shouldn't reach here — chatWithRetry handles errors — but be safe
      logger.error({ agentId, error: response.error }, 'LLM call failed after retries');
      responseContent = "I'm sorry, I was unable to process that request. Please try again.";
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

  /**
   * Call the LLM provider with retry logic for transient failures.
   *
   * - Non-retryable errors: publish agent.error, send error response, return null
   * - Retryable errors: backoff and retry up to 3 times, incrementing budget counters
   * - AUTH_FAILURE counts double against the budget (it's a serious signal)
   * - On success: reset consecutive error counter, return the response
   * - If all retries exhausted: publish agent.error, send error response, return null
   */
  private async chatWithRetry(
    provider: LLMProvider,
    params: { messages: Message[]; tools?: ToolDefinition[] },
    budget: ErrorBudget,
    taskEvent: AgentTaskEvent,
  ): Promise<LLMResponse | null> {
    const { agentId, logger } = this.config;

    const response = await provider.chat(params);
    if (response.type !== 'error') {
      // LLM call succeeded — reset consecutive error counter
      budget.consecutiveErrors = 0;
      return response;
    }

    const agentErr = response.error;

    // Non-retryable errors: bail immediately
    if (!agentErr.retryable) {
      logger.error({ agentId, errorType: agentErr.type, source: agentErr.source }, 'Non-retryable LLM error');
      await this.publishAgentError(agentErr, taskEvent);
      await this.sendErrorResponse(taskEvent);
      return null;
    }

    // Retryable error — attempt backoff retries
    logger.warn({ agentId, errorType: agentErr.type }, 'Retryable LLM error, starting retry sequence');

    for (const backoffMs of RETRY_BACKOFF_MS) {
      // Increment budget counters for the failed attempt
      budget.consecutiveErrors++;
      budget.turnsUsed++;
      // AUTH_FAILURE counts double — it's a serious signal that something is wrong
      if (agentErr.type === 'AUTH_FAILURE') {
        budget.consecutiveErrors++;
        budget.turnsUsed++;
      }

      await new Promise(resolve => setTimeout(resolve, backoffMs));

      const retryResponse = await provider.chat(params);
      if (retryResponse.type !== 'error') {
        // Retry succeeded — reset consecutive error counter
        budget.consecutiveErrors = 0;
        return retryResponse;
      }

      logger.warn(
        { agentId, backoffMs, errorType: retryResponse.error.type },
        'LLM retry failed',
      );
    }

    // All retries exhausted
    logger.error({ agentId, retries: RETRY_BACKOFF_MS.length }, 'All LLM retries exhausted');
    await this.publishAgentError(agentErr, taskEvent);
    await this.sendErrorResponse(taskEvent);
    return null;
  }

  /**
   * Handle budget exhaustion: log, publish a BUDGET_EXCEEDED agent.error event,
   * and send a user-facing error response.
   */
  private async handleBudgetExceeded(
    budget: ErrorBudget,
    taskEvent: AgentTaskEvent,
    reason: 'maxTurns' | 'maxConsecutiveErrors',
  ): Promise<void> {
    const { agentId, logger } = this.config;
    const message = reason === 'maxTurns'
      ? `Task exceeded turn budget (${budget.turnsUsed}/${budget.maxTurns} turns used)`
      : `Task exceeded consecutive error budget (${budget.consecutiveErrors}/${budget.maxConsecutiveErrors} consecutive errors)`;

    logger.warn({ agentId, budget, reason }, message);

    const agentErr: AgentError = {
      type: 'BUDGET_EXCEEDED',
      source: 'runtime',
      message,
      retryable: false,
      context: { budget, reason },
      timestamp: new Date(),
    };
    await this.publishAgentError(agentErr, taskEvent);
    await this.sendErrorResponse(taskEvent);
  }

  /**
   * Publish a structured agent.error event to the bus for audit and monitoring.
   */
  private async publishAgentError(agentErr: AgentError, taskEvent: AgentTaskEvent): Promise<void> {
    const { agentId, bus } = this.config;
    const { conversationId } = taskEvent.payload;
    const errorEvent = createAgentError({
      agentId,
      conversationId,
      errorType: agentErr.type,
      source: agentErr.source,
      message: agentErr.message,
      retryable: agentErr.retryable,
      context: agentErr.context,
      parentEventId: taskEvent.id,
    });
    await bus.publish('agent', errorEvent);
  }

  /**
   * Send a user-facing error response so the user isn't left waiting.
   */
  private async sendErrorResponse(taskEvent: AgentTaskEvent): Promise<void> {
    const { agentId, bus } = this.config;
    const { conversationId } = taskEvent.payload;
    const responseEvent = createAgentResponse({
      agentId,
      conversationId,
      content: "I'm sorry, I was unable to process that request. Please try again.",
      parentEventId: taskEvent.id,
    });
    await bus.publish('agent', responseEvent);
  }
}
