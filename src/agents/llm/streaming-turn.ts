// streaming-turn.ts — streaming tool-loop primitive (#1552 / #1563).
//
// Both VoiceTurnRunner and AgentRuntime.handleTask delegate tool-loop /
// message assembly here. Voice opens provider.stream() directly; text uses a
// chat-compatible openStream adapter over chatWithRetry (ADR-038: text may use
// stream() — adapter keeps retry/fallback/telemetry intact while sharing round
// cap, invoke sequencing, and sanitization policy). Do **not** fold voice into
// handleTask — both call this primitive.
//
// Owns: stream consume (or openStream), AbortSignal cancel, tool_use /
// tool_result message assembly (via tool-loop-messages.ts), round cap,
// invokeTool sequencing, optional onToolUse / afterTools policy hooks.
// Does NOT own: sentence-chunk TTS, filler speech, barge-in UX, chatWithRetry,
// DelegationGuard, clarification short-circuits, or autonomy prompt injection
// (those stay in callers / openStream adapters).
//
// Round-cap policy: callers pass maxRounds. Voice uses DEFAULT_STREAMING_MAX_ROUNDS
// (8) so a runaway tool loop fails fast into an audible fallback; text passes
// error_budget.max_turns and enforces turnsUsed semantics via onToolUse (often
// 20–40). Sharing the coordinator's maxTurns=40 with spoken turns would leave
// the line silent far too long — the divergence is intentional and parameterized.
//
// Autonomy / Gate-C: this primitive never bypasses ExecutionLayer. Callers supply
// invokeTool; voice and handleTask both route through executionLayer.invoke, so
// Gates A/B/C stay equivalent. Voice's bridge is intentionally thinner (no
// DelegationGuard / clarification protocol / tool.invoke bus events) — those are
// handleTask concerns, not Gate-C divergences.
//
// Assistant-text sanitization policy: LLM-authored assistant text is NOT passed
// through sanitizeOutput on either path. sanitizeOutput is for untrusted skill
// output before it re-enters the model context — ExecutionLayer.invoke already
// applies it. User inbound is sanitized at channel boundaries where applicable.
// Cross-link: src/channels/voice/turn-runner.ts, src/agents/runtime.ts, #1563.

import type { AgentError } from '../../errors/types.js';
import type { Logger } from '../../logger.js';
import {
  buildAssistantToolUseMessage,
  buildUserToolResultMessage,
} from './tool-loop-messages.js';
import type {
  LLMProvider,
  LLMResponse,
  LLMStreamEvent,
  Message,
  ToolCall,
  ToolDefinition,
} from './provider.js';

/**
 * Default max tool-use rounds for streaming turns (voice).
 * Intentionally lower than typical agent `error_budget.max_turns` — see file header.
 */
export const DEFAULT_STREAMING_MAX_ROUNDS = 8;

const DEFAULT_MISSING_INVOKE_TOOL_RESULT =
  'Tool execution is not wired for this streaming turn.';

export type StreamingTurnInvokeTool = (
  call: ToolCall,
  /** Mutable working transcript — text path splices skill-activate system blocks here. */
  ctx?: { messages: Message[] },
) => Promise<{ content: string; is_error?: boolean }>;

/** Hook decision: continue the loop, or stop and return to the caller. */
export type StreamingTurnRoundDecision = 'continue' | 'stop';

export interface StreamingTurnOpenStreamParams {
  messages: Message[];
  tools?: ToolDefinition[];
  model: string;
  signal: AbortSignal;
}

/**
 * Optional stream opener for callers that wrap chat()/retry (text path #1563)
 * or otherwise cannot use provider.stream() directly. When set,
 * assertStreamingProvider is skipped.
 */
export type StreamingTurnOpenStream = (
  params: StreamingTurnOpenStreamParams,
) => AsyncIterable<LLMStreamEvent>;

export interface StreamingTurnHooks {
  /**
   * Called at the start of each LLM round with the mutable working transcript.
   * Text uses this for Bullpen refresh + checkpoint budget nudges before chat.
   */
  beforeRound?: (info: {
    messages: Message[];
    round: number;
    toolRounds: number;
  }) => void | Promise<void>;
  /** Called for each text_delta from the model (before sentence chunking). */
  onTextDelta?: (text: string) => void | Promise<void>;
  /**
   * Called when the model requests tools, after any preceding text has been
   * delivered via onTextDelta, and before invokeTool runs. Voice uses this for
   * filler TTS so the line is not silent during tool work.
   */
  onBeforeTools?: (info: {
    toolCalls: ToolCall[];
    content?: string;
  }) => void | Promise<void>;
  /**
   * Called after tool_use is observed, before onBeforeTools / invokeTool.
   * Text AgentRuntime uses this for turnsUsed / maxTurns budget checks.
   * Return `'stop'` to exit without invoking tools (stopReason: `'stopped'`).
   */
  onToolUse?: (info: {
    toolCalls: ToolCall[];
    content?: string;
    round: number;
    messages: Message[];
  }) => Promise<StreamingTurnRoundDecision>;
  /**
   * Called after tool results are appended to `messages` (mutable working
   * transcript). Text uses this for clarification / delegation short-circuits
   * and consecutive-error budget checks.
   * Return `'stop'` to exit (stopReason: `'stopped'`).
   */
  afterTools?: (info: {
    messages: Message[];
    toolCalls: ToolCall[];
    toolRounds: number;
  }) => Promise<StreamingTurnRoundDecision>;
}

export interface StreamingTurnConfig {
  /**
   * Must implement stream() unless `openStream` is provided (chat-compatible
   * adapter path). Construct-time voice callers should still assertStreamingProvider.
   */
  provider: LLMProvider;
  model: string;
  tools?: ToolDefinition[];
  /** Hard cap on LLM rounds. Required — see DEFAULT_STREAMING_MAX_ROUNDS. */
  maxRounds: number;
  signal: AbortSignal;
  invokeTool?: StreamingTurnInvokeTool;
  hooks?: StreamingTurnHooks;
  logger?: Logger;
  /** Placeholder tool_result content when invokeTool is missing. */
  missingInvokeToolResult?: string;
  /**
   * Custom per-round stream source. Text AgentRuntime passes a chatWithRetry
   * adapter here so retry/fallback/telemetry stay on the chat path while the
   * tool loop is shared (#1563 / ADR-038).
   */
  openStream?: StreamingTurnOpenStream;
}

export type StreamingTurnStopReason =
  | 'message_end'
  | 'aborted'
  | 'exhausted'
  | 'stream_error'
  | 'empty_stream'
  /** Caller hook (onToolUse / afterTools) requested an early exit. */
  | 'stopped';

export interface StreamingTurnResult {
  /**
   * On `message_end`: the model's terminal `content` **as-is** (may be empty).
   * Callers that transform deltas (e.g. voice sentence-chunking / whitespace
   * join) MUST fall back to their own delivered text when this is empty — do
   * not assume `streamedText` matches what was spoken or persisted.
   * On other stop reasons: accumulated `streamedText`.
   */
  finalText: string;
  /** Concatenation of text_delta chunks observed this turn (may be empty). */
  streamedText: string;
    /**
   * Working transcript including tool_use / tool_result pairs.
   * On `message_end`, also includes a final assistant text turn when there is
   * non-empty terminal content, otherwise this round's streamed deltas when
   * non-empty (not whole-turn streamedText — that would duplicate pre-tool
   * narration already on a prior tool_use turn). On abort mid-tool-round,
   * unanswered tool_use ids are closed with cancelled placeholder results.
   */
  messages: Message[];
  toolRounds: number;
  aborted: boolean;
  /** True when the round cap was hit without a message_end. */
  exhausted: boolean;
  stopReason: StreamingTurnStopReason;
  /** Set when stopReason === 'stream_error'. */
  error?: AgentError;
}

/** Thrown when a provider without stream() is used with the streaming primitive. */
export class StreamUnsupportedError extends Error {
  constructor(providerId: string) {
    super(
      `Streaming turn requires a streaming LLM provider; '${providerId}' does not implement stream()`,
    );
    this.name = 'StreamUnsupportedError';
  }
}

/** Assert provider.stream exists — call from wrappers that refuse silent full-buffer. */
export function assertStreamingProvider(provider: LLMProvider): void {
  if (typeof provider.stream !== 'function') {
    throw new StreamUnsupportedError(provider.id);
  }
}

/**
 * Adapt a single chat()/LLMResponse into stream events so callers can feed
 * chatWithRetry (or any non-streaming round) into runStreamingToolLoop (#1563).
 */
export async function* llmResponseAsStream(
  response: LLMResponse,
): AsyncIterable<LLMStreamEvent> {
  if (response.type === 'error') {
    yield { type: 'error', error: response.error, ...(response.usage ? { usage: response.usage } : {}) };
    return;
  }
  if (response.type === 'tool_use') {
    yield {
      type: 'tool_use',
      toolCalls: response.toolCalls,
      content: response.content,
      usage: response.usage,
      provenance: response.provenance,
    };
    return;
  }
  if (response.content.length > 0) {
    yield { type: 'text_delta', text: response.content };
  }
  yield {
    type: 'message_end',
    content: response.content,
    usage: response.usage,
    provenance: response.provenance,
  };
}

/**
 * Run one streaming assistant turn with a tool-use loop.
 * Resolves on message_end, abort, round-cap exhaustion, caller stop, or empty stream.
 * Stream terminal errors are returned on the result (not thrown) so callers
 * can map them to channel-specific error types.
 */
export async function runStreamingToolLoop(
  initialMessages: Message[],
  config: StreamingTurnConfig,
): Promise<StreamingTurnResult> {
  if (!config.openStream) {
    assertStreamingProvider(config.provider);
  }

  if (!Number.isFinite(config.maxRounds) || config.maxRounds < 1) {
    throw new Error(`streaming turn maxRounds must be a positive integer; got ${config.maxRounds}`);
  }

  const workingMessages: Message[] = [...initialMessages];
  const signal = config.signal;
  const missingResult =
    config.missingInvokeToolResult ?? DEFAULT_MISSING_INVOKE_TOOL_RESULT;
  let streamedText = '';
  let toolRounds = 0;

  for (let round = 0; round < config.maxRounds; round += 1) {
    if (signal.aborted) {
      return {
        finalText: streamedText,
        streamedText,
        messages: workingMessages,
        toolRounds,
        aborted: true,
        exhausted: false,
        stopReason: 'aborted',
      };
    }

    if (config.hooks?.beforeRound) {
      await config.hooks.beforeRound({
        messages: workingMessages,
        round,
        toolRounds,
      });
    }

    // Per-round delta accumulator — used for empty message_end transcript
    // fallback so we do not re-append pre-tool narration already present in a
    // prior assistant tool_use turn (whole-turn streamedText still tracks all
    // deltas for callers that need the full spoken/streamed string).
    let roundStreamedText = '';

    // Snapshot for the provider — never hand out the live workingMessages array
    // (providers/tests often retain the reference; we mutate after tool rounds).
    const streamParams: StreamingTurnOpenStreamParams = {
      messages: [...workingMessages],
      tools: config.tools,
      model: config.model,
      signal,
    };
    const stream = config.openStream
      ? config.openStream(streamParams)
      : config.provider.stream!({
          messages: streamParams.messages,
          tools: streamParams.tools,
          model: streamParams.model,
          options: { signal },
        });

    let toolUse: { toolCalls: ToolCall[]; content?: string } | undefined;
    let messageEnd: { content: string } | undefined;
    let streamError: AgentError | undefined;

    for await (const event of stream) {
      if (signal.aborted) break;

      if (event.type === 'text_delta') {
        streamedText = streamedText.length > 0 ? `${streamedText}${event.text}` : event.text;
        roundStreamedText =
          roundStreamedText.length > 0 ? `${roundStreamedText}${event.text}` : event.text;
        if (config.hooks?.onTextDelta) {
          await config.hooks.onTextDelta(event.text);
        }
      } else if (event.type === 'tool_use') {
        toolUse = { toolCalls: event.toolCalls, content: event.content };
        break;
      } else if (event.type === 'message_end') {
        messageEnd = { content: event.content };
        break;
      } else if (event.type === 'error') {
        streamError = event.error;
        break;
      }
    }

    if (signal.aborted) {
      return {
        finalText: streamedText,
        streamedText,
        messages: workingMessages,
        toolRounds,
        aborted: true,
        exhausted: false,
        stopReason: 'aborted',
      };
    }

    if (streamError) {
      config.logger?.warn(
        { error: streamError.type, source: streamError.source },
        'streaming turn stream error',
      );
      return {
        finalText: streamedText,
        streamedText,
        messages: workingMessages,
        toolRounds,
        aborted: false,
        exhausted: false,
        stopReason: 'stream_error',
        error: streamError,
      };
    }

    if (messageEnd) {
      // Build the returned transcript with the terminal assistant reply so
      // consumers get a complete conversation — but do not mutate
      // workingMessages after the last stream() call (callers/tests often hold
      // a reference to the messages array that was passed into stream).
      // Empty terminal content falls back to THIS ROUND's deltas only — not
      // whole-turn streamedText, which would duplicate pre-tool narration
      // already carried on a prior assistant tool_use turn.
      const transcriptReply =
        messageEnd.content.length > 0 ? messageEnd.content : roundStreamedText;
      const messages =
        transcriptReply.length > 0
          ? [...workingMessages, { role: 'assistant' as const, content: transcriptReply }]
          : workingMessages;
      return {
        // Preserve empty terminal content — callers decide their own fallback
        // (voice uses spokenText, not streamedText).
        finalText: messageEnd.content,
        streamedText,
        messages,
        toolRounds,
        aborted: false,
        exhausted: false,
        stopReason: 'message_end',
      };
    }

    if (toolUse) {
      if (config.hooks?.onToolUse) {
        const decision = await config.hooks.onToolUse({
          toolCalls: toolUse.toolCalls,
          content: toolUse.content,
          round,
          messages: workingMessages,
        });
        if (decision === 'stop') {
          return {
            finalText: streamedText,
            streamedText,
            messages: workingMessages,
            toolRounds,
            aborted: false,
            exhausted: false,
            stopReason: 'stopped',
          };
        }
      }

      toolRounds += 1;
      if (config.hooks?.onBeforeTools) {
        await config.hooks.onBeforeTools(toolUse);
      }

      // Assistant turn must carry tool_use blocks so the following tool_result
      // blocks can reference their ids (Anthropic requirement).
      workingMessages.push(
        buildAssistantToolUseMessage(toolUse.toolCalls, toolUse.content),
      );

      const toolResults: Array<{ id: string; content: string; isError?: boolean }> = [];
      for (const call of toolUse.toolCalls) {
        if (signal.aborted) break;
        let result: { content: string; is_error?: boolean };
        if (config.invokeTool) {
          try {
            result = await config.invokeTool(call, { messages: workingMessages });
          } catch (err) {
            config.logger?.warn({ tool: call.name, err }, 'streaming turn tool invocation threw');
            result = {
              content: `Tool '${call.name}' failed: ${err instanceof Error ? err.message : String(err)}`,
              is_error: true,
            };
          }
        } else {
          result = { content: missingResult, is_error: true };
        }
        toolResults.push({
          id: call.id,
          content: result.content,
          isError: result.is_error,
        });
      }

      if (signal.aborted) {
        // Every tool_use id must be answered, even on barge-in — otherwise the
        // returned transcript ends in an unanswered assistant tool_use turn
        // and any later replay against Anthropic is rejected.
        const answered = new Set(toolResults.map((r) => r.id));
        for (const call of toolUse.toolCalls) {
          if (!answered.has(call.id)) {
            toolResults.push({
              id: call.id,
              content: 'Tool execution cancelled (turn aborted).',
              isError: true,
            });
          }
        }
        workingMessages.push(buildUserToolResultMessage(toolResults));
        return {
          finalText: streamedText,
          streamedText,
          messages: workingMessages,
          toolRounds,
          aborted: true,
          exhausted: false,
          stopReason: 'aborted',
        };
      }

      workingMessages.push(buildUserToolResultMessage(toolResults));

      if (config.hooks?.afterTools) {
        const decision = await config.hooks.afterTools({
          messages: workingMessages,
          toolCalls: toolUse.toolCalls,
          toolRounds,
        });
        if (decision === 'stop') {
          return {
            finalText: streamedText,
            streamedText,
            messages: workingMessages,
            toolRounds,
            aborted: false,
            exhausted: false,
            stopReason: 'stopped',
          };
        }
      }
      continue;
    }

    // Stream ended with no terminal event (unexpected).
    config.logger?.warn({ round }, 'streaming turn stream ended without a terminal event');
    return {
      finalText: streamedText,
      streamedText,
      messages: workingMessages,
      toolRounds,
      aborted: false,
      exhausted: false,
      stopReason: 'empty_stream',
    };
  }

  return {
    finalText: streamedText,
    streamedText,
    messages: workingMessages,
    toolRounds,
    aborted: false,
    exhausted: true,
    stopReason: 'exhausted',
  };
}
