// voice-runtime.ts — owns the live duplex loop for each voice session.
//
// Per session it wires: AudioTransport (LiveKit) → SpeechToTextProvider →
// VoiceTurnRunner (streaming LLM + tools) → TextToSpeechProvider → back out the
// transport. Media never touches the bus; only session lifecycle events and the
// final user transcript (inbound.message) do.
//
// Barge-in: while the assistant is talking (TTS or LLM active), any detected
// principal speech cancels the in-flight TTS streams and aborts the turn.
//
// Skills: tools default to empty at construction (bootstrap order — ExecutionLayer
// and coordinator pins land later). Call `configureTools()` once the coordinator
// tool set + ExecutionLayer.invoke are available. See ADR-037 §6.

import type { EventBus } from '../../bus/bus.js';
import { createInboundMessage, createVoiceSessionEnded } from '../../bus/events.js';
import type { Logger } from '../../logger.js';
import type { LLMProvider, Message, ToolCall, ToolDefinition } from '../../agents/llm/provider.js';
import type { WorkingMemory } from '../../memory/working-memory.js';
import { sanitizeOutput } from '../../skills/sanitize.js';
import type { AudioTransport } from './audio-transport.js';
import type { SpeechToTextProvider, SttSession, SttTranscriptEvent, TextToSpeechProvider } from './speech/types.js';
import type { VoiceSessionRecord, VoiceSessionStore } from './session-store.js';
import { VoiceTurnRunner } from './turn-runner.js';

const DEFAULT_INBOUND_SAMPLE_RATE = 16000;
const DEFAULT_PUBLISH_SAMPLE_RATE = 24000;
/** Console chat and voice share the same synthetic principal sender id. */
const DEFAULT_SENDER_ID = 'ceo-web-user';
/** How many messages (user + assistant) of history to keep per session. */
const MAX_HISTORY_MESSAGES = 8;
/** Ignore tiny interim blobs (echo / noise) when deciding barge-in. */
const BARGE_IN_MIN_CHARS = 3;
/** Ignore low-confidence interims when the provider reports confidence. */
const BARGE_IN_MIN_CONFIDENCE = 0.4;
/** Agent id used when writing voice turns into working_memory (chat history). */
const VOICE_HISTORY_AGENT_ID = 'coordinator';

/**
 * Voice-mode system addendum. Keeps spoken replies short and free of markup that
 * makes no sense read aloud. Prepended as a system message on every turn.
 *
 * Phase 1 deliberate non-goal: this is NOT the coordinator's full system prompt /
 * persona / KG enrichment / working-memory reload. Spoken turns are a slim
 * Q&A loop (addendum + last N in-memory turns + tools). See ADR-037 Consequences
 * and docs/wip/2026-07-25-voice-channel-design.md §3.7 / §"Phase 1 brain".
 */
export const VOICE_SYSTEM_ADDENDUM =
  'You are speaking to the principal in a live voice call. Reply in a natural, ' +
  'conversational spoken style: 1-3 short sentences, no markdown, no bullet lists, ' +
  'no tables, no code blocks, and no emoji. Spell out anything that must be heard ' +
  'clearly. Keep it brief — the user can always ask for more.';

/** Transport optionally advertises its negotiated sample rates for STT/TTS. */
type RateAwareTransport = AudioTransport & {
  inboundSampleRate?: number;
  publishSampleRate?: number;
};

export interface VoiceRuntimeConfig {
  bus: EventBus;
  logger: Logger;
  sessionStore: VoiceSessionStore;
  stt: SpeechToTextProvider;
  tts: TextToSpeechProvider;
  /** LLM provider — must implement stream(). VoiceRuntime refuses turns otherwise. */
  llm: LLMProvider;
  model: string;
  livekitUrl: string;
  /** Builds the per-session audio transport (LiveKitRoomSession in prod, fake in tests). */
  createTransport: (opts: { roomName: string; token: string; livekitUrl: string }) => AudioTransport;
  /** Optional TTS voice id. */
  voiceId?: string;
  /** Synthetic sender id for inbound.message (defaults to the console principal id). */
  senderId?: string;
  /**
   * Optional working-memory store so user + assistant transcripts appear in
   * console chat history (same path as web chat). Spoken egress stays on TTS —
   * this does not go through OutboundGateway (parity with web chat).
   */
  workingMemory?: WorkingMemory;
  /**
   * Best-effort LiveKit room delete after session end (invalidates leaked JWTs).
   * Failures must not throw into hangup.
   */
  deleteRoom?: (roomName: string) => Promise<void>;
  /** Optional static tool set for voice turns. Prefer configureTools() post-boot. */
  tools?: ToolDefinition[];
  /** Optional per-turn tool resolver (takes precedence over `tools`). */
  resolveVoiceTools?: () => ToolDefinition[];
  /** Optional tool invoker; when absent the runner returns a not-wired placeholder. */
  invokeTool?: (
    call: ToolCall,
    ctx: { conversationId: string; sessionId: string },
  ) => Promise<{ content: string; is_error?: boolean }>;
}

/** Late-bound tool wiring — set after coordinator pins + ExecutionLayer exist. */
export interface VoiceToolBridge {
  resolveVoiceTools: () => ToolDefinition[];
  invokeTool: (
    call: ToolCall,
    ctx: { conversationId: string; sessionId: string },
  ) => Promise<{ content: string; is_error?: boolean }>;
}

interface StartVoiceSessionParams {
  sessionId: string;
  conversationId: string;
  roomName: string;
  /** Agent participant JWT (identity 'curia-agent'). */
  agentToken: string;
}

interface ActiveSession {
  sessionId: string;
  conversationId: string;
  roomName: string;
  transport: AudioTransport;
  stt: SttSession;
  publishSampleRate: number;
  history: Message[];
  /** Serializes turns; barge-in aborts the current turn so the next runs promptly. */
  turnTail: Promise<void>;
  currentController: AbortController | null;
  activeTtsStreamIds: Set<string>;
  llmActive: boolean;
  ttsActive: boolean;
  /** Set once a first transcript is seen so we flip DB status starting→active once. */
  markedActive: boolean;
  pendingFinalText: string;
  ttsSeq: number;
  ending: boolean;
}

export class VoiceRuntime {
  private readonly log: Logger;
  private readonly sessions = new Map<string, ActiveSession>();
  private toolBridge: VoiceToolBridge | null = null;

  constructor(private readonly config: VoiceRuntimeConfig) {
    this.log = config.logger.child({ component: 'voice-runtime' });
    if (typeof config.llm.stream !== 'function') {
      throw new Error(
        `VoiceRuntime requires a streaming LLM provider; '${config.llm.id}' does not implement stream()`,
      );
    }
  }

  /**
   * Bind coordinator tools + ExecutionLayer invoke after bootstrap. Safe to call
   * once agents are registered; subsequent calls replace the bridge.
   */
  configureTools(bridge: VoiceToolBridge): void {
    this.toolBridge = bridge;
    this.log.info(
      { toolCount: bridge.resolveVoiceTools().length },
      'VoiceRuntime tools configured',
    );
  }

  get activeSessionCount(): number {
    return this.sessions.size;
  }

  async startSession(params: StartVoiceSessionParams): Promise<void> {
    if (this.sessions.has(params.sessionId)) {
      this.log.warn({ sessionId: params.sessionId }, 'startSession called for an already-active session; ignoring');
      return;
    }

    const transport = this.config.createTransport({
      roomName: params.roomName,
      token: params.agentToken,
      livekitUrl: this.config.livekitUrl,
    }) as RateAwareTransport;

    const inboundSampleRate = transport.inboundSampleRate ?? DEFAULT_INBOUND_SAMPLE_RATE;
    const publishSampleRate = transport.publishSampleRate ?? DEFAULT_PUBLISH_SAMPLE_RATE;

    await transport.connect();

    const stt = await this.config.stt.startSession({
      sampleRate: inboundSampleRate,
      onError: err => {
        this.log.warn({ sessionId: params.sessionId, err }, 'STT connection error; ending session');
        void this.endSession(params.sessionId, 'stt_error');
      },
    });

    const session: ActiveSession = {
      sessionId: params.sessionId,
      conversationId: params.conversationId,
      roomName: params.roomName,
      transport,
      stt,
      publishSampleRate,
      history: [],
      turnTail: Promise.resolve(),
      currentController: null,
      activeTtsStreamIds: new Set(),
      llmActive: false,
      ttsActive: false,
      markedActive: false,
      pendingFinalText: '',
      ttsSeq: 0,
      ending: false,
    };
    this.sessions.set(params.sessionId, session);

    // Pipe principal audio → STT.
    transport.onRemoteAudio(frame => {
      session.stt.sendAudio(frame);
    });

    // Principal left / room dropped without DELETE — end the Curia session so
    // STT sockets and voice_sessions rows are not left active.
    transport.onClose(reason => {
      this.log.info({ sessionId: params.sessionId, reason }, 'Audio transport closed; ending voice session');
      void this.endSession(params.sessionId, reason);
    });

    // Handle transcripts (interim → barge-in; final+endpoint → turn).
    stt.onTranscript(event => {
      this.handleTranscript(session, event);
    });

    this.log.info(
      { sessionId: params.sessionId, conversationId: params.conversationId, inboundSampleRate, publishSampleRate },
      'Voice session runtime started',
    );
  }

  private handleTranscript(session: ActiveSession, event: SttTranscriptEvent): void {
    if (session.ending) return;
    const text = event.text.trim();

    // Barge-in: speech while the assistant talks cancels it. Gate on length +
    // confidence so speaker echo / noise doesn't interrupt Curia mid-sentence.
    if (
      text.length >= BARGE_IN_MIN_CHARS
      && (session.llmActive || session.ttsActive)
      && (event.confidence === undefined || event.confidence >= BARGE_IN_MIN_CONFIDENCE)
    ) {
      this.bargeIn(session);
    }

    if (!event.isFinal) return;

    if (text.length > 0) {
      session.pendingFinalText = session.pendingFinalText ? `${session.pendingFinalText} ${text}` : text;
    }

    // Endpoint (end-of-turn) — run the accumulated utterance as one user turn.
    if (event.speechFinal) {
      const utterance = session.pendingFinalText.trim();
      session.pendingFinalText = '';
      if (utterance.length > 0) {
        this.enqueueTurn(session, utterance);
      }
    }
  }

  private bargeIn(session: ActiveSession): void {
    const controller = session.currentController;
    if (!controller || controller.signal.aborted) return;

    const startedAt = Date.now();
    for (const streamId of session.activeTtsStreamIds) {
      this.config.tts.cancel(streamId);
    }
    controller.abort();
    session.ttsActive = false;
    this.log.debug(
      { sessionId: session.sessionId, 'voice.barge_in_stop_ms': Date.now() - startedAt },
      'voice barge-in: cancelled assistant turn',
    );
  }

  private enqueueTurn(session: ActiveSession, utterance: string): void {
    // Serialize turns onto the tail so a barged-in turn fully unwinds before the
    // next starts. Errors are logged, never allowed to break the chain.
    session.turnTail = session.turnTail
      .catch(() => {})
      .then(() => this.runUserTurn(session, utterance));
  }

  private async runUserTurn(session: ActiveSession, utterance: string): Promise<void> {
    if (session.ending) return;

    // Publish the final user transcript for bus audit. The dispatcher skips
    // agent.task creation for channelId 'voice' (VoiceRuntime owns the turn).
    try {
      await this.config.bus.publish(
        'channel',
        createInboundMessage({
          conversationId: session.conversationId,
          channelId: 'voice',
          senderId: this.config.senderId ?? DEFAULT_SENDER_ID,
          content: sanitizeOutput(utterance),
        }),
      );
    } catch (err) {
      this.log.warn({ sessionId: session.sessionId, err }, 'failed to publish voice inbound.message');
    }

    // Persist user turn to working_memory so console history can show it.
    if (this.config.workingMemory) {
      try {
        await this.config.workingMemory.addTurn(session.conversationId, VOICE_HISTORY_AGENT_ID, {
          role: 'user',
          content: sanitizeOutput(utterance),
        });
      } catch (err) {
        this.log.warn({ sessionId: session.sessionId, err }, 'failed to persist voice user turn to working memory');
      }
    }

    // Flip DB status starting → active on the first real turn.
    if (!session.markedActive) {
      session.markedActive = true;
      try {
        await this.config.sessionStore.updateStatus(session.sessionId, 'active');
      } catch (err) {
        this.log.warn({ sessionId: session.sessionId, err }, 'failed to mark voice session active');
      }
    }

    const controller = new AbortController();
    session.currentController = controller;
    session.llmActive = true;

    const userTurnEndAt = Date.now();
    let ttfaRecorded = false;

    const tools = this.toolBridge
      ? this.toolBridge.resolveVoiceTools()
      : (this.config.resolveVoiceTools ? this.config.resolveVoiceTools() : this.config.tools);

    const invokeTool = this.toolBridge
      ? (call: ToolCall) => this.toolBridge!.invokeTool(call, {
        conversationId: session.conversationId,
        sessionId: session.sessionId,
      })
      : this.config.invokeTool
        ? (call: ToolCall) => this.config.invokeTool!(call, {
          conversationId: session.conversationId,
          sessionId: session.sessionId,
        })
        : undefined;

    const userMessage: Message = { role: 'user', content: utterance };
    const messages: Message[] = [
      { role: 'system', content: VOICE_SYSTEM_ADDENDUM },
      ...session.history,
      userMessage,
    ];

    const onSpeechText = async (sentence: string, meta: { streamId: string }): Promise<void> => {
      if (controller.signal.aborted || session.ending) return;
      const ttsStreamId = `${meta.streamId}:${session.ttsSeq++}`;
      session.activeTtsStreamIds.add(ttsStreamId);
      session.ttsActive = true;
      try {
        for await (const frame of this.config.tts.synthesize({
          text: sentence,
          streamId: ttsStreamId,
          voiceId: this.config.voiceId,
          sampleRate: session.publishSampleRate,
          signal: controller.signal,
        })) {
          if (controller.signal.aborted || session.ending) break;
          if (!ttfaRecorded) {
            ttfaRecorded = true;
            this.log.debug(
              { sessionId: session.sessionId, 'voice.ttfa_ms': Date.now() - userTurnEndAt },
              'voice time-to-first-audio',
            );
          }
          await session.transport.publishAudio(frame);
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          this.log.warn({ sessionId: session.sessionId, err }, 'TTS synthesis failed');
        }
      } finally {
        session.activeTtsStreamIds.delete(ttsStreamId);
        if (session.activeTtsStreamIds.size === 0) session.ttsActive = false;
      }
    };

    const runner = new VoiceTurnRunner({
      provider: this.config.llm,
      model: this.config.model,
      logger: this.log,
      tools,
      invokeTool,
      onFiller: async filler => {
        await onSpeechText(filler, { streamId: `${session.sessionId}-filler` });
      },
      onSpeechText,
    });

    try {
      const result = await runner.runTurn({ messages, signal: controller.signal });
      if (!result.aborted && result.finalText.length > 0) {
        // Persist the completed exchange to in-memory history (trimmed).
        session.history.push(userMessage, { role: 'assistant', content: result.finalText });
        if (session.history.length > MAX_HISTORY_MESSAGES) {
          session.history.splice(0, session.history.length - MAX_HISTORY_MESSAGES);
        }
        // Persist assistant transcript so console history can show what was spoken.
        // Spoken egress stays on TTS — we do not publish outbound.message (web chat
        // also skips OutboundGateway for principal console replies).
        if (this.config.workingMemory) {
          try {
            await this.config.workingMemory.addTurn(session.conversationId, VOICE_HISTORY_AGENT_ID, {
              role: 'assistant',
              content: result.finalText,
            });
          } catch (err) {
            this.log.warn({ sessionId: session.sessionId, err }, 'failed to persist voice assistant turn to working memory');
          }
        }
      }
    } catch (err) {
      this.log.warn({ sessionId: session.sessionId, err }, 'voice turn failed');
    } finally {
      session.llmActive = false;
      if (session.currentController === controller) {
        session.currentController = null;
      }
    }
  }

  async endSession(sessionId: string, reason: string): Promise<VoiceSessionRecord | null> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.ending = true;
      this.sessions.delete(sessionId);

      if (session.currentController && !session.currentController.signal.aborted) {
        session.currentController.abort();
      }
      for (const streamId of session.activeTtsStreamIds) {
        this.config.tts.cancel(streamId);
      }
      try {
        session.stt.cancel();
      } catch (err) {
        this.log.debug({ sessionId, err }, 'error cancelling STT session');
      }
      try {
        await session.transport.disconnect();
      } catch (err) {
        this.log.warn({ sessionId, err }, 'error disconnecting transport');
      }

      // Invalidate the LiveKit room so a leaked JWT cannot rejoin after hangup.
      if (this.config.deleteRoom) {
        try {
          await this.config.deleteRoom(session.roomName);
        } catch (err) {
          this.log.warn({ sessionId, roomName: session.roomName, err }, 'failed to delete LiveKit room after session end');
        }
      }
    }

    // store.endSession returns null when the row is already 'ended', so the ended
    // event is published at most once even if the adapter and runtime both call in.
    const ended = await this.config.sessionStore.endSession(sessionId, reason);
    if (ended) {
      try {
        await this.config.bus.publish(
          'channel',
          createVoiceSessionEnded({
            sessionId: ended.id,
            conversationId: ended.conversationId,
            reason: ended.endReason ?? reason,
            durationMs: ended.endedAt ? ended.endedAt.getTime() - ended.startedAt.getTime() : undefined,
          }),
        );
      } catch (err) {
        this.log.warn({ sessionId, err }, 'failed to publish voice.session.ended');
      }
    }
    return ended;
  }

  /** End every active session (used on adapter/runtime stop). */
  async endAllSessions(reason: string): Promise<void> {
    const ids = [...this.sessions.keys()];
    await Promise.all(ids.map(id => this.endSession(id, reason)));
  }

  /**
   * Test-only: await the current turn chain for a session to settle.
   * Loops until the tail stops being replaced by a newly-enqueued turn.
   */
  async awaitIdle(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    let tail: Promise<void>;
    do {
      tail = session.turnTail;
      await tail.catch(() => {});
    } while (tail !== session.turnTail);
  }
}
