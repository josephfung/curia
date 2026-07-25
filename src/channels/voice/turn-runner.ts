// turn-runner.ts — VoiceTurnRunner drives a single spoken assistant turn.
//
// Unlike AgentRuntime.handleTask (which buffers a complete reply before the
// channel delivers it), the voice turn must start speaking mid-generation.
// VoiceTurnRunner consumes LLMProvider.stream(), sentence-chunks the text
// deltas, and hands each finished sentence to onSpeechText for TTS. It also
// runs the streaming tool loop: when the model emits tool_use, the runner
// speaks a short filler, invokes the tools, and continues the stream with the
// tool results appended — looping until message_end, error, or abort.
//
// WHY TWO LOOPS EXIST (#1552, supersedes #1550): AgentRuntime.handleTask is a
// non-streaming while(tool_use) over provider.chat(), entangled with
// retry/fallback, error budgets, and full-buffer-then-deliver. Voice needs
// stream() + barge-in abort + sentence-chunk TTS — forcing it through
// handleTask now would risk every text channel. Both paths MUST keep Anthropic
// tool_use / tool_result message shapes in sync via
// src/agents/llm/tool-loop-messages.ts until a shared streaming turn primitive
// lands (#1552). Do not re-diverge block assembly here.
// Sibling debt (brain/context parity + history read model): #1551.
// Cross-link: src/agents/runtime.ts tool_use loop.
//
// Barge-in: runTurn honours the caller's AbortSignal. When the signal fires
// (the principal started speaking over the assistant), the runner stops
// consuming the stream promptly and returns { aborted: true } without flushing
// any buffered partial sentence.

import { randomUUID } from 'node:crypto';
import type { AgentError } from '../../errors/types.js';
import type { Logger } from '../../logger.js';
import type {
  LLMProvider,
  Message,
  ToolCall,
  ToolDefinition,
} from '../../agents/llm/provider.js';
import {
  buildAssistantToolUseMessage,
  buildUserToolResultMessage,
} from '../../agents/llm/tool-loop-messages.js';
import { SentenceChunker } from './sentence-chunker.js';

/** Filler spoken before invoking (potentially slow) tools so the line is not silent. */
const DEFAULT_FILLER = 'One moment.';

/** Spoken when the tool loop exhausts without a message_end so the line is not silent. */
const EXHAUSTION_FALLBACK = 'Sorry, I could not finish that — please try again.';

/** Hard cap on tool-use rounds to guard against a tool loop that never terminates. */
const MAX_TOOL_ROUNDS = 8;

export interface VoiceTurnRunnerConfig {
  /** LLM provider — must implement stream(). */
  provider: LLMProvider;
  model: string;
  logger: Logger;
  /** Optional tools available for this turn. */
  tools?: ToolDefinition[];
  /** Invoke a tool and return result text; used when the stream yields tool_use. */
  invokeTool?: (call: ToolCall) => Promise<{ content: string; is_error?: boolean }>;
  /** Spoken filler emitted before long tool work. */
  onFiller?: (text: string) => Promise<void>;
  /** Sentence chunks ready for TTS. */
  onSpeechText: (text: string, meta: { streamId: string }) => Promise<void>;
}

export interface VoiceTurnResult {
  /** Full assistant text for this turn (empty when aborted before any output). */
  finalText: string;
  /** True when the turn stopped because the AbortSignal fired (barge-in). */
  aborted: boolean;
  /** Number of tool-use rounds executed. */
  toolRounds: number;
  /** streamId used for onSpeechText / TTS correlation for this turn. */
  streamId: string;
}

/** Thrown when a provider without stream() support is used to construct a runner. */
export class StreamUnsupportedError extends Error {
  constructor(providerId: string) {
    super(`VoiceTurnRunner requires a streaming LLM provider; '${providerId}' does not implement stream()`);
    this.name = 'StreamUnsupportedError';
  }
}

/** Thrown when the LLM stream yields a terminal error event. */
export class VoiceTurnError extends Error {
  constructor(public readonly agentError: AgentError) {
    super(agentError.message);
    this.name = 'VoiceTurnError';
  }
}

export class VoiceTurnRunner {
  private readonly log: Logger;

  constructor(private readonly config: VoiceTurnRunnerConfig) {
    // Refuse to construct against a non-streaming provider — voice must never
    // silently full-buffer then speak (ADR-037).
    if (typeof config.provider.stream !== 'function') {
      throw new StreamUnsupportedError(config.provider.id);
    }
    this.log = config.logger.child({ component: 'voice-turn-runner' });
  }

  /**
   * Run one spoken assistant turn. Streams text to onSpeechText and drives the
   * tool loop. Resolves when the model finishes (message_end) or the signal
   * aborts; throws VoiceTurnError if the stream yields a terminal error.
   */
  async runTurn({ messages, signal }: { messages: Message[]; signal: AbortSignal }): Promise<VoiceTurnResult> {
    const streamId = randomUUID();
    const chunker = new SentenceChunker();
    const workingMessages: Message[] = [...messages];
    const turnStartedAt = Date.now();
    let ttftLogged = false;
    let toolRounds = 0;
    // Everything handed to TTS this turn, so finalText matches what was heard
    // even when we fall out of the loop without a message_end.
    let spokenText = '';
    const speak = async (text: string): Promise<void> => {
      spokenText = spokenText.length > 0 ? `${spokenText} ${text}` : text;
      await this.config.onSpeechText(text, { streamId });
    };

    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      if (signal.aborted) {
        chunker.reset();
        return { finalText: spokenText, aborted: true, toolRounds, streamId };
      }

      // stream() is guaranteed present by the constructor guard.
      const stream = this.config.provider.stream!({
        messages: workingMessages,
        tools: this.config.tools,
        model: this.config.model,
        options: { signal },
      });

      let toolUse: { toolCalls: ToolCall[]; content?: string } | undefined;
      let messageEnd: { content: string } | undefined;
      let streamError: AgentError | undefined;

      for await (const event of stream) {
        if (signal.aborted) break;

        if (event.type === 'text_delta') {
          if (!ttftLogged) {
            ttftLogged = true;
            this.log.debug({ streamId, llm_ttft_ms: Date.now() - turnStartedAt }, 'voice llm first token');
          }
          for (const sentence of chunker.push(event.text)) {
            if (signal.aborted) break;
            await speak(sentence);
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
        // Barge-in: drop any buffered partial sentence — it must not be spoken
        // or recorded as a completed assistant turn.
        chunker.reset();
        return { finalText: spokenText, aborted: true, toolRounds, streamId };
      }

      if (streamError) {
        chunker.reset();
        this.log.warn({ streamId, error: streamError.type, source: streamError.source }, 'voice turn stream error');
        throw new VoiceTurnError(streamError);
      }

      if (messageEnd) {
        // Speak any trailing partial sentence that never hit a boundary.
        const remainder = chunker.flush();
        if (remainder && !signal.aborted) {
          await speak(remainder);
        }
        // Prefer the model's terminal content when present; otherwise fall back
        // to what was actually handed to TTS (covers multi-round tool turns).
        const finalText = messageEnd.content.length > 0 ? messageEnd.content : spokenText;
        return { finalText, aborted: signal.aborted, toolRounds, streamId };
      }

      if (toolUse) {
        toolRounds += 1;
        // Speak whatever preceded the tool call, then a short filler so the
        // line is not silent while the tool runs.
        const remainder = chunker.flush();
        if (remainder) await speak(remainder);
        if (this.config.onFiller) {
          await this.config.onFiller(DEFAULT_FILLER);
          // Filler is heard but is not part of the assistant reply transcript.
        }

        // Assistant turn must carry the tool_use blocks so the following
        // tool_result blocks can reference their ids (Anthropic requirement).
        // Shape shared with AgentRuntime via tool-loop-messages.ts (#1552).
        workingMessages.push(buildAssistantToolUseMessage(toolUse.toolCalls, toolUse.content));

        const toolResults: Array<{ id: string; content: string; isError?: boolean }> = [];
        for (const call of toolUse.toolCalls) {
          if (signal.aborted) break;
          let result: { content: string; is_error?: boolean };
          if (this.config.invokeTool) {
            try {
              result = await this.config.invokeTool(call);
            } catch (err) {
              this.log.warn({ streamId, tool: call.name, err }, 'voice tool invocation threw');
              result = {
                content: `Tool '${call.name}' failed: ${err instanceof Error ? err.message : String(err)}`,
                is_error: true,
              };
            }
          } else {
            result = { content: 'Tool execution is not wired for voice turns yet.', is_error: true };
          }
          toolResults.push({
            id: call.id,
            content: result.content,
            isError: result.is_error,
          });
        }

        if (signal.aborted) {
          chunker.reset();
          return { finalText: spokenText, aborted: true, toolRounds, streamId };
        }

        workingMessages.push(buildUserToolResultMessage(toolResults));
        continue;
      }

      // Stream ended with no terminal event (unexpected). Stop the loop.
      this.log.warn({ streamId, round }, 'voice turn stream ended without a terminal event');
      break;
    }

    // Fell out of the loop (hit MAX_TOOL_ROUNDS or an empty stream). Flush any
    // buffered text so it is still spoken, and never leave the principal silent.
    const remainder = chunker.flush();
    if (remainder && !signal.aborted) {
      await speak(remainder);
    }
    if (spokenText.length === 0 && !signal.aborted) {
      await speak(EXHAUSTION_FALLBACK);
    }
    return { finalText: spokenText, aborted: signal.aborted, toolRounds, streamId };
  }
}
