// streaming-turn.ts — shared streaming tool-loop primitive (#1552).
//
// Target end state (issue #1552): a provider-agnostic streaming turn that *both*
// VoiceTurnRunner and (optionally later) AgentRuntime.handleTask delegate to —
// **not** voice calling handleTask. Text channels stay on non-streaming chat()
// until explicitly opted in; this module is the stream() + tool_use / tool_result
// assembly path.
//
// Owns: provider.stream() consume, AbortSignal cancel, tool_use / tool_result
// message assembly (via tool-loop-messages.ts), round cap, invokeTool sequencing.
// Does NOT own: sentence-chunk TTS, filler speech, barge-in UX, chatWithRetry,
// DelegationGuard, clarification short-circuits, or autonomy prompt injection.
//
// Round-cap policy: callers pass maxRounds. Voice uses DEFAULT_STREAMING_MAX_ROUNDS
// (8) so a runaway tool loop fails fast into an audible fallback; text AgentRuntime
// keeps per-agent error_budget.max_turns on the chat() path (often 20–40). Sharing
// the coordinator's maxTurns=40 with spoken turns would leave the line silent far
// too long — the divergence is intentional and parameterized here.
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
// Cross-link: src/channels/voice/turn-runner.ts, src/agents/runtime.ts.

import type { AgentError } from '../../errors/types.js';
import type { Logger } from '../../logger.js';
import {
  buildAssistantToolUseMessage,
  buildUserToolResultMessage,
} from './tool-loop-messages.js';
import type {
  LLMProvider,
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
) => Promise<{ content: string; is_error?: boolean }>;

export interface StreamingTurnHooks {
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
}

export interface StreamingTurnConfig {
  /** Must implement stream() — construct-time callers should refuse otherwise. */
  provider: LLMProvider;
  model: string;
  tools?: ToolDefinition[];
  /** Hard cap on tool-use rounds. Required — see DEFAULT_STREAMING_MAX_ROUNDS. */
  maxRounds: number;
  signal: AbortSignal;
  invokeTool?: StreamingTurnInvokeTool;
  hooks?: StreamingTurnHooks;
  logger?: Logger;
  /** Placeholder tool_result content when invokeTool is missing. */
  missingInvokeToolResult?: string;
}

export type StreamingTurnStopReason =
  | 'message_end'
  | 'aborted'
  | 'exhausted'
  | 'stream_error'
  | 'empty_stream';

export interface StreamingTurnResult {
  /**
   * Preferred assistant text for this turn: message_end.content when present,
   * otherwise accumulated text_delta content.
   */
  finalText: string;
  /** Concatenation of text_delta chunks observed this turn (may be empty). */
  streamedText: string;
  /** Working transcript including any tool_use / tool_result pairs appended. */
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
 * Run one streaming assistant turn with a tool-use loop.
 * Resolves on message_end, abort, round-cap exhaustion, or empty stream.
 * Stream terminal errors are returned on the result (not thrown) so callers
 * can map them to channel-specific error types.
 */
export async function runStreamingToolLoop(
  initialMessages: Message[],
  config: StreamingTurnConfig,
): Promise<StreamingTurnResult> {
  assertStreamingProvider(config.provider);

  if (!Number.isFinite(config.maxRounds) || config.maxRounds < 1) {
    throw new Error(`streaming turn maxRounds must be a positive integer; got ${config.maxRounds}`);
  }

  const workingMessages: Message[] = [...initialMessages];
  const signal = config.signal;
  const missingResult =
    config.missingInvokeToolResult ?? DEFAULT_MISSING_INVOKE_TOOL_RESULT;
  let streamedText = '';
  let toolRounds = 0;

  const appendStreamed = (text: string): void => {
    streamedText = streamedText.length > 0 ? `${streamedText}${text}` : text;
  };

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

    // stream() is guaranteed present by assertStreamingProvider.
    const stream = config.provider.stream!({
      messages: workingMessages,
      tools: config.tools,
      model: config.model,
      options: { signal },
    });

    let toolUse: { toolCalls: ToolCall[]; content?: string } | undefined;
    let messageEnd: { content: string } | undefined;
    let streamError: AgentError | undefined;

    for await (const event of stream) {
      if (signal.aborted) break;

      if (event.type === 'text_delta') {
        appendStreamed(event.text);
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
      const finalText =
        messageEnd.content.length > 0 ? messageEnd.content : streamedText;
      return {
        finalText,
        streamedText,
        messages: workingMessages,
        toolRounds,
        aborted: false,
        exhausted: false,
        stopReason: 'message_end',
      };
    }

    if (toolUse) {
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
            result = await config.invokeTool(call);
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
