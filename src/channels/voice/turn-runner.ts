// turn-runner.ts — VoiceTurnRunner drives a single spoken assistant turn.
//
// Thin voice wrapper over the shared streaming turn primitive
// (src/agents/llm/streaming-turn.ts, #1552). This file owns only voice UX:
// sentence-chunk TTS, filler speech, barge-in AbortSignal semantics, and the
// audible exhaustion fallback. Tool-loop / message assembly / round-cap /
// stream+abort live in the shared primitive.
//
// Text AgentRuntime.handleTask stays on non-streaming provider.chat() unless
// explicitly opted into the streaming primitive later — do not fold voice into
// handleTask. Cross-link: src/agents/runtime.ts tool_use loop.
// Sibling: #1551 (brain/context + history read model).

import { randomUUID } from 'node:crypto';
import type { Logger } from '../../logger.js';
import type {
  LLMProvider,
  Message,
  ToolCall,
  ToolDefinition,
} from '../../agents/llm/provider.js';
import type { AgentError } from '../../errors/types.js';
import {
  DEFAULT_STREAMING_MAX_ROUNDS,
  StreamUnsupportedError,
  assertStreamingProvider,
  runStreamingToolLoop,
} from '../../agents/llm/streaming-turn.js';
import { SentenceChunker } from './sentence-chunker.js';

export { StreamUnsupportedError, DEFAULT_STREAMING_MAX_ROUNDS };

/** Filler spoken before invoking (potentially slow) tools so the line is not silent. */
const DEFAULT_FILLER = 'One moment.';

/** Spoken when the tool loop exhausts without a message_end so the line is not silent. */
const EXHAUSTION_FALLBACK = 'Sorry, I could not finish that — please try again.';

/** Placeholder when voice has no invokeTool bridge (should not happen in production). */
const MISSING_INVOKE_TOOL_RESULT = 'Tool execution is not wired for voice turns yet.';

export interface VoiceTurnRunnerConfig {
  /** LLM provider — must implement stream(). */
  provider: LLMProvider;
  model: string;
  logger: Logger;
  /** Optional tools available for this turn. */
  tools?: ToolDefinition[];
  /** Invoke a tool and return result text; used when the stream yields tool_use. */
  invokeTool?: (call: ToolCall) => Promise<{ content: string; is_error?: boolean }>;
  /**
   * Max tool-use rounds. Defaults to DEFAULT_STREAMING_MAX_ROUNDS (8).
   * Intentionally not the coordinator's text-path maxTurns — see streaming-turn.ts.
   */
  maxRounds?: number;
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

/** Thrown when the LLM stream yields a terminal error event. */
export class VoiceTurnError extends Error {
  constructor(public readonly agentError: AgentError) {
    super(agentError.message);
    this.name = 'VoiceTurnError';
  }
}

export class VoiceTurnRunner {
  private readonly log: Logger;
  private readonly maxRounds: number;

  constructor(private readonly config: VoiceTurnRunnerConfig) {
    // Refuse to construct against a non-streaming provider — voice must never
    // silently full-buffer then speak (ADR-037).
    assertStreamingProvider(config.provider);
    this.maxRounds = config.maxRounds ?? DEFAULT_STREAMING_MAX_ROUNDS;
    this.log = config.logger.child({ component: 'voice-turn-runner' });
  }

  /**
   * Run one spoken assistant turn. Streams text to onSpeechText and drives the
   * tool loop via the shared streaming primitive. Resolves when the model
   * finishes (message_end) or the signal aborts; throws VoiceTurnError if the
   * stream yields a terminal error.
   */
  async runTurn({ messages, signal }: { messages: Message[]; signal: AbortSignal }): Promise<VoiceTurnResult> {
    const streamId = randomUUID();
    const chunker = new SentenceChunker();
    const turnStartedAt = Date.now();
    let ttftLogged = false;
    // Everything handed to TTS this turn, so finalText matches what was heard
    // even when we fall out of the loop without a message_end.
    let spokenText = '';
    const speak = async (text: string): Promise<void> => {
      spokenText = spokenText.length > 0 ? `${spokenText} ${text}` : text;
      await this.config.onSpeechText(text, { streamId });
    };

    const result = await runStreamingToolLoop(messages, {
      provider: this.config.provider,
      model: this.config.model,
      tools: this.config.tools,
      maxRounds: this.maxRounds,
      signal,
      invokeTool: this.config.invokeTool,
      missingInvokeToolResult: MISSING_INVOKE_TOOL_RESULT,
      logger: this.log,
      hooks: {
        onTextDelta: async (text) => {
          if (!ttftLogged) {
            ttftLogged = true;
            this.log.debug({ streamId, llm_ttft_ms: Date.now() - turnStartedAt }, 'voice llm first token');
          }
          for (const sentence of chunker.push(text)) {
            if (signal.aborted) break;
            await speak(sentence);
          }
        },
        onBeforeTools: async () => {
          // Speak whatever preceded the tool call, then a short filler so the
          // line is not silent while the tool runs.
          const remainder = chunker.flush();
          if (remainder) await speak(remainder);
          if (this.config.onFiller) {
            await this.config.onFiller(DEFAULT_FILLER);
            // Filler is heard but is not part of the assistant reply transcript.
          }
        },
      },
    });

    if (result.aborted) {
      // Barge-in: drop any buffered partial sentence — it must not be spoken
      // or recorded as a completed assistant turn.
      chunker.reset();
      return { finalText: spokenText, aborted: true, toolRounds: result.toolRounds, streamId };
    }

    if (result.stopReason === 'stream_error' && result.error) {
      chunker.reset();
      this.log.warn(
        { streamId, error: result.error.type, source: result.error.source },
        'voice turn stream error',
      );
      throw new VoiceTurnError(result.error);
    }

    if (result.stopReason === 'message_end') {
      // Speak any trailing partial sentence that never hit a boundary.
      const remainder = chunker.flush();
      if (remainder && !signal.aborted) {
        await speak(remainder);
      }
      // Prefer the model's terminal content when present; otherwise fall back
      // to what was actually handed to TTS (covers multi-round tool turns).
      const finalText = result.finalText.length > 0 ? result.finalText : spokenText;
      return { finalText, aborted: signal.aborted, toolRounds: result.toolRounds, streamId };
    }

    // Exhausted or empty stream: flush any buffered text and never leave the
    // principal silent.
    const remainder = chunker.flush();
    if (remainder && !signal.aborted) {
      await speak(remainder);
    }
    if (spokenText.length === 0 && !signal.aborted) {
      await speak(EXHAUSTION_FALLBACK);
    }
    return { finalText: spokenText, aborted: signal.aborted, toolRounds: result.toolRounds, streamId };
  }
}
