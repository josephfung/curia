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
// tool set + ExecutionLayer.invoke are available; the same bridge carries the
// coordinator context providers (identity block, specialist roster) for spoken-
// turn brain parity (#1551). See ADR-037 §6.
//
// History: spoken-turn context reloads from working_memory (the same rows the
// console chat history endpoint reads) each turn; the in-process session history
// is only a fallback when the store is absent or the read fails (#1551).
//
// liveTurn scope (#1598 / #1126): voice stamps liveTurn once per *session* at
// create time (a continuous call with one human), whereas every other channel
// stamps it per inbound *turn*. The elevated skill gate therefore stays
// satisfied for the call's full duration. This widening is deliberate — a
// voice session is one live conversation, not a sequence of independent
// messages — and must not be copied onto text channels.
import type { EventBus } from '../../bus/bus.js';
import { createInboundMessage, createVoiceSessionEnded } from '../../bus/events.js';
import type { OutboundContextService } from '../../dispatch/outbound-context.js';
import type { Logger } from '../../logger.js';
import type { LLMProvider, Message, ToolCall, ToolDefinition } from '../../agents/llm/provider.js';
import { DATE_RESOLVE_GUARDRAIL } from '../../agents/prompts/date-resolve-guardrail.js';
import { VOICE_ASYNC_OFFRAMP_GUIDANCE } from '../../agents/prompts/voice-async-offramp.js';
import { TurnDateResolveTracker } from '../../agents/delegate-brief-date-validation.js';
import type { WorkingMemory } from '../../memory/working-memory.js';
import { sanitizeOutput } from '../../skills/sanitize.js';
import { formatTimeContextBlock } from '../../time/time-context.js';
import type { AudioTransport } from './audio-transport.js';
import type { VoiceCallerContext } from './caller-context.js';
import {
  VOICE_GREETING_INSTRUCTION,
  VOICE_GREETING_USER_MESSAGE,
} from './greeting.js';
import type { SpeechToTextProvider, SttSession, SttTranscriptEvent, TextToSpeechProvider } from '../../speech/index.js';
import { TtsHttpError } from '../../speech/index.js';
import type { VoiceSessionRecord, VoiceSessionStore } from './session-store.js';
import { VoiceTurnRunner } from './turn-runner.js';

export {
  VOICE_GREETING_INSTRUCTION,
  VOICE_GREETING_USER_MESSAGE,
  isVoiceGreetingCueContent,
} from './greeting.js';

const DEFAULT_INBOUND_SAMPLE_RATE = 16000;
const DEFAULT_PUBLISH_SAMPLE_RATE = 24000;
/**
 * How many messages (user + assistant) of in-process history to keep per session.
 * This is the FALLBACK context source only — spoken turns load history from
 * working_memory when it is configured (#1551); the in-process copy covers
 * store-less deployments/tests and mid-call DB read failures.
 */
const MAX_HISTORY_MESSAGES = 8;
/**
 * Max working_memory turns reloaded into a spoken turn's context. Spoken turns
 * are short (1-3 sentences), so this stays well inside the latency budget while
 * giving far more continuity than the in-process window. Summarization (when
 * configured on the shared store) condenses older turns before this cap bites.
 */
const VOICE_HISTORY_MAX_TURNS = 20;
/**
 * Deadline for the per-turn working_memory history read. Pool checkout timeouts
 * do not bound the query itself — a stalled read must not stall the spoken turn,
 * so on expiry the turn falls back to in-process history.
 */
const DEFAULT_HISTORY_READ_TIMEOUT_MS = 1_000;
/** Ignore tiny interim blobs (echo / noise) when deciding barge-in. */
const BARGE_IN_MIN_CHARS = 3;
/** Ignore low-confidence interims when the provider reports confidence. */
const BARGE_IN_MIN_CONFIDENCE = 0.4;
/** Agent id used when writing voice turns into working_memory (chat history). */
const VOICE_HISTORY_AGENT_ID = 'coordinator';
/** Default max utterance size — matches Dispatcher maxMessageBytes. */
const DEFAULT_MAX_UTTERANCE_BYTES = 102_400;
/**
 * Consecutive TTS synthesis failures before ending the session. A single
 * transient blip must not tear down an otherwise-healthy call (#1556).
 */
const TTS_CONSECUTIVE_FAILURE_LIMIT = 3;

const HARD_TTS_STATUS_CODES = new Set([401, 403, 404]);

/** Auth / missing-voice hard failures should not wait for the soft threshold. */
function isHardTtsFailure(err: unknown): boolean {
  return err instanceof TtsHttpError && HARD_TTS_STATUS_CODES.has(err.statusCode);
}

/**
 * Spoken-style guidance shared by every voice audience. The audience line
 * ("You are speaking to …") is composed separately by buildVoiceAudienceLine()
 * so a non-principal caller never inherits the principal framing (#1598).
 */
export const VOICE_SPOKEN_STYLE_ADDENDUM =
  'Reply in a natural, ' +
  'conversational spoken style: 1-3 short sentences, no markdown, no bullet lists, ' +
  'no tables, no code blocks, and no emoji. Spell out anything that must be heard ' +
  'clearly. Keep it brief — the user can always ask for more.';

/**
 * Audience line for the spoken-turn system prompt. Principal framing is only
 * emitted when liveTurn is true — never inferred from channel alone (#1598).
 */
export function buildVoiceAudienceLine(audience: {
  liveTurn: boolean;
  displayName?: string | null;
}): string {
  if (audience.liveTurn) {
    return 'You are speaking to the principal in a live voice call.';
  }
  const name = audience.displayName?.trim();
  if (name) {
    return (
      `You are speaking to ${name} in a live voice call. They are not the principal — ` +
      'do not treat them as having principal authority.'
    );
  }
  return (
    'You are speaking to a non-principal caller in a live voice call. ' +
    'Do not treat them as having principal authority.'
  );
}

/**
 * Compose the voice system addendum (audience + spoken style) for a resolved caller.
 */
export function buildVoiceSystemAddendum(audience: {
  liveTurn: boolean;
  displayName?: string | null;
}): string {
  return `${buildVoiceAudienceLine(audience)} ${VOICE_SPOKEN_STYLE_ADDENDUM}`;
}

/**
 * Default principal-audience addendum. Kept as a constant so existing tests and
 * the slim-prompt path stay behaviorally identical for console (principal) calls.
 */
export const VOICE_SYSTEM_ADDENDUM = buildVoiceSystemAddendum({ liveTurn: true });

/**
 * Honest-negative policy for spoken tool results. A failed or errored check must
 * be narrated as "couldn't check", never as a confident empty result — "your
 * calendar is clear" after a failed lookup is a trust hazard the principal may
 * act on (#1551).
 */
export const VOICE_TOOL_RESULT_POLICY =
  'When a tool call or delegation fails, errors out, or cannot complete, say plainly ' +
  'that you could not check — for example "I couldn\'t reach your calendar just now" — ' +
  'and offer to try again. Never present a failed or incomplete lookup as a definitive ' +
  'answer. Only report an empty result ("nothing on your calendar tomorrow") when the ' +
  'check succeeded and genuinely returned no items.';

/**
 * Delegation guidance for spoken turns. The slim Phase 1 prompt never told the
 * voice model that specialist-delegated domains (calendar, contacts, research,
 * the principal's inbox) are reached via the delegate tool, so those domains
 * were effectively unreachable from voice (#1551). Included only when a
 * specialist roster is available from the bridge.
 */
export const VOICE_DELEGATION_GUIDANCE =
  'Many requests are handled by delegating to a specialist with the delegate tool: ' +
  'calendar and scheduling, contacts and people lookups, research, and the ' +
  'principal\'s inbox all belong to the specialists listed below. When a request ' +
  'falls in a specialist\'s domain, delegate rather than answering from memory or ' +
  'guessing. Resolve pronouns before delegating: "my calendar" spoken by the ' +
  'principal means the principal\'s calendar. Fold the specialist\'s result into ' +
  'your own short spoken answer — never mention specialists, delegation, or tools ' +
  'out loud.';

/**
 * Assemble the per-turn system prompt for a spoken turn. Static sections come
 * first and the (per-minute changing) time block last, so provider prompt
 * caching keeps a stable prefix across turns. Pure — callers resolve/guard the
 * dynamic parts (identity compile, roster lookup, outbound context, time
 * formatting) themselves.
 *
 * Shared guardrails (ADR-038) are composed from `src/agents/prompts/` — do not
 * copy-paste coordinator YAML lines here.
 *
 * Brain stance (#1551, revised by ADR-038): spoken turns get a curated subset
 * of the coordinator's context — office identity/persona block, specialist
 * roster + delegation guidance, shared channel-agnostic guardrails (starting
 * with date-resolve, #1595), the voice async off-ramp (#1614), and a fresh
 * date/time block. They deliberately do NOT get the coordinator's full YAML
 * system prompt or KG/sender enrichment (latency + text-channel content that
 * makes no sense spoken). Active outbound-context entries are included for
 * principal (liveTurn) callers only (#1594 / #1598) so voice can acknowledge
 * recent proactive sends on other channels without leaking them to a
 * non-principal audience. See ADR-037 Consequences and ADR-038.
 */
export function buildVoiceSystemPrompt(parts: {
  /** Compiled office identity/persona block; omitted when null/empty. */
  identityBlock?: string | null;
  /** Specialist roster body ("- @name: description" lines); enables delegation guidance. */
  specialistRoster?: string | null;
  /**
   * Pre-formatted [ACTIVE OUTBOUND CONTEXT] block from
   * OutboundContextService.formatInjectionBlock (cross-channel proactive sends).
   * Omitted when null/empty — same bridge text channels get via the dispatcher (#1594).
   * Callers must already have gated this on liveTurn (#1598).
   */
  outboundContextBlock?: string | null;
  /** Pre-formatted "## Current Date & Time" block; omitted when null/empty. */
  timeContextBlock?: string | null;
  /**
   * Resolved audience for the voice addendum. Required so a missing audience
   * cannot silently default to principal framing (#1598).
   */
  audience: { liveTurn: boolean; displayName?: string | null };
}): string {
  const sections: string[] = [];
  if (parts.identityBlock) sections.push(parts.identityBlock);
  sections.push(buildVoiceSystemAddendum(parts.audience));
  sections.push(VOICE_TOOL_RESULT_POLICY);
  // Channel-agnostic date-arithmetic rule — same module the coordinator composes
  // (ADR-038 / #1595). Always present: voice already pins date-resolve via
  // coordinator tools; the failure mode was missing instruction, not missing tool.
  sections.push(DATE_RESOLVE_GUARDRAIL);
  // Async off-ramp (#1614 / ADR-038 gate #3): composed only once the real
  // async-offramp tool exists — never promise a follow-up we cannot deliver.
  sections.push(VOICE_ASYNC_OFFRAMP_GUIDANCE);
  if (parts.specialistRoster) {
    sections.push(
      VOICE_DELEGATION_GUIDANCE + '\n\n## Available Specialists\n' + parts.specialistRoster,
    );
  }
  // Dynamic suffix: outbound context then time. Time stays last so the static
  // prefix (+ identity/roster) remains provider-cacheable across turns.
  if (parts.outboundContextBlock) sections.push(parts.outboundContextBlock);
  if (parts.timeContextBlock) sections.push(parts.timeContextBlock);
  return sections.join('\n\n');
}

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
  /**
   * Builds the per-session audio transport (LiveKitRoomSession in prod, fake in tests).
   * `callerIdentity` is the resolved contact id minted in the caller's LiveKit token (#1598);
   * the transport uses it to detect caller disconnect (ParticipantDisconnected).
   */
  createTransport: (opts: { roomName: string; token: string; livekitUrl: string; callerIdentity: string }) => AudioTransport;
  /** Optional TTS voice id. */
  voiceId?: string;
  /**
   * Optional working-memory store so user + assistant transcripts appear in
   * console chat history (same path as web chat). Spoken egress stays on TTS —
   * this does not go through OutboundGateway (parity with web chat).
   */
  workingMemory?: WorkingMemory;
  /**
   * Best-effort LiveKit room delete after session end (cleanup). Does not revoke
   * JWTs — a leaked token remains valid until TTL and may auto-recreate the room.
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
    ctx: {
      conversationId: string;
      sessionId: string;
      /** Resolved caller identity — required so the fallback path cannot drop authorization context. */
      caller: VoiceCallerContext;
      turnDateResolveResults?: readonly import('../../agents/delegate-brief-date-validation.js').TurnDateResolveResult[];
    },
  ) => Promise<{ content: string; is_error?: boolean }>;
  /**
   * Max UTF-8 bytes for an accumulated STT utterance before it is dropped.
   * Mirrors the dispatcher `maxMessageBytes` guard (voice bypasses the dispatcher).
   */
  maxUtteranceBytes?: number;
  /**
   * IANA timezone for the per-turn date/time block (same block the coordinator
   * gets — formatTimeContextBlock). Without it, "tomorrow / next week" is
   * un-anchored for every voice tool call (#1551). Omitted → no time block.
   */
  timezone?: string;
  /**
   * Deadline (ms) for per-turn Postgres reads on the spoken critical path
   * (working_memory history and outbound-context getActive). On expiry the
   * turn degrades — in-process history / no context injection — rather than
   * stalling. Default 1000ms.
   */
  historyReadTimeoutMs?: number;
  /**
   * Cross-channel outbound-context bridge — the same service the dispatcher
   * injects into text-channel task content. Voice bypasses the dispatcher, so
   * VoiceRuntime must read getActive() itself (#1594). Optional: absent → no
   * injection (tests / pool-less boots).
   *
   * Gated on the session caller's liveTurn (#1598): non-principal callers must
   * never hear "messages you've sent" (cross-channel audience leak).
   */
  outboundContextService?: OutboundContextService;
}

/**
 * Late-bound coordinator wiring — set after coordinator pins + ExecutionLayer
 * exist. Besides tools, the bridge carries the coordinator context providers
 * for spoken-turn brain parity (#1551); all are optional so partial wiring
 * (and older tests) degrade to the slim prompt rather than failing.
 */
export interface VoiceToolBridge {
  resolveVoiceTools: () => ToolDefinition[];
  invokeTool: (
    call: ToolCall,
    ctx: {
      conversationId: string;
      sessionId: string;
      /** Resolved caller identity for this session — drives liveTurn/originator at the execution layer. */
      caller: VoiceCallerContext;
      turnDateResolveResults?: readonly import('../../agents/delegate-brief-date-validation.js').TurnDateResolveResult[];
    },
  ) => Promise<{ content: string; is_error?: boolean }>;
  /**
   * Per-turn compiled office identity/persona block (hot-reloadable, same as
   * AgentRuntime's preamble). May throw — the runtime guards and omits.
   */
  identityBlock?: () => string | null;
  /** Specialist roster body for the "## Available Specialists" block; null → no delegation guidance. */
  specialistRoster?: () => string | null;
}

interface StartVoiceSessionParams {
  sessionId: string;
  conversationId: string;
  roomName: string;
  /** Agent participant JWT (identity 'curia-agent'). */
  agentToken: string;
  /**
   * Resolved caller identity for this session (#1598). Required — omitting it
   * must not silently grant principal standing. Tests pass principalCaller() /
   * partnerCaller() from test-fixtures.ts.
   */
  caller: VoiceCallerContext;
  /**
   * When true (default), run one LLM greeting turn after the transport connects
   * so Curia opens the call (#1596). Per-session — not a runtime-wide flag — so
   * a future Curia-initiated outbound path can pass false without affecting
   * inbound console calls on the same VoiceRuntime instance.
   */
  openingGreeting?: boolean;
}

interface ActiveSession {
  sessionId: string;
  conversationId: string;
  roomName: string;
  /** Per-session resolved caller — drives prompt audience, senderId, liveTurn gates. */
  caller: VoiceCallerContext;
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
  /** Consecutive synthesize() failures; reset on a successful synthesis (#1556). */
  consecutiveTtsFailures: number;
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
      callerIdentity: params.caller.contactId,
    }) as RateAwareTransport;

    const inboundSampleRate = transport.inboundSampleRate ?? DEFAULT_INBOUND_SAMPLE_RATE;
    const publishSampleRate = transport.publishSampleRate ?? DEFAULT_PUBLISH_SAMPLE_RATE;

    await transport.connect();

    let stt: SttSession | undefined;
    try {
      stt = await this.config.stt.startSession({
        sampleRate: inboundSampleRate,
        onError: err => {
          // Ignore errors that fire before the session is registered — otherwise
          // endSession would only flip the DB row and leave a zombie in the map.
          if (!this.sessions.has(params.sessionId)) {
            this.log.warn(
              { sessionId: params.sessionId, err },
              'STT connection error during startup (session not yet registered)',
            );
            return;
          }
          this.log.warn({ sessionId: params.sessionId, err }, 'STT connection error; ending session');
          void this.endSession(params.sessionId, 'stt_error');
        },
      });

      const session: ActiveSession = {
        sessionId: params.sessionId,
        conversationId: params.conversationId,
        roomName: params.roomName,
        caller: params.caller,
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
        consecutiveTtsFailures: 0,
      };
      this.sessions.set(params.sessionId, session);

      // Pipe principal audio → STT.
      transport.onRemoteAudio(frame => {
        session.stt.sendAudio(frame);
      });

      // Principal left / room dropped without DELETE — end the Curia session so
      // STT sockets and voice_sessions rows are not left active. Ignore while
      // endSession is already tearing down (avoids racing hangup → 404).
      transport.onClose(reason => {
        if (session.ending) return;
        this.log.info({ sessionId: params.sessionId, reason }, 'Audio transport closed; ending voice session');
        void this.endSession(params.sessionId, reason);
      });

      // Handle transcripts (interim → barge-in; final+endpoint → turn).
      stt.onTranscript(event => {
        this.handleTranscript(session, event);
      });

      // Inbound console calls: Curia opens the conversation (#1596). Enqueued on
      // the turn chain so a barged-in greeting fully unwinds before the first
      // user turn. Per-session flag — outbound (Curia-initiated) callers pass
      // openingGreeting: false when that path exists.
      if (params.openingGreeting !== false) {
        this.enqueueGreetingTurn(session);
      }

      this.log.info(
        { sessionId: params.sessionId, conversationId: params.conversationId, inboundSampleRate, publishSampleRate },
        'Voice session runtime started',
      );
    } catch (err) {
      this.sessions.delete(params.sessionId);
      if (stt) {
        try {
          stt.cancel();
        } catch (cancelErr) {
          this.log.debug({ sessionId: params.sessionId, err: cancelErr }, 'error cancelling STT after start failure');
        }
      }
      try {
        await transport.disconnect();
      } catch (disconnectErr) {
        this.log.warn({ sessionId: params.sessionId, err: disconnectErr }, 'error disconnecting transport after start failure');
      }
      throw err;
    }
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
      const next = session.pendingFinalText ? `${session.pendingFinalText} ${text}` : text;
      const maxBytes = this.config.maxUtteranceBytes ?? DEFAULT_MAX_UTTERANCE_BYTES;
      if (Buffer.byteLength(next, 'utf8') > maxBytes) {
        this.log.warn(
          {
            sessionId: session.sessionId,
            pendingBytes: Buffer.byteLength(session.pendingFinalText, 'utf8'),
            nextBytes: Buffer.byteLength(next, 'utf8'),
            maxBytes,
          },
          'voice utterance exceeded maxUtteranceBytes; dropping pending transcript',
        );
        session.pendingFinalText = '';
        return;
      }
      session.pendingFinalText = next;
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
    // next starts. Log rejections — never silently erase them or break the chain.
    session.turnTail = session.turnTail
      .catch(err => {
        this.log.warn({ sessionId: session.sessionId, err }, 'previous voice turn rejected; continuing chain');
      })
      .then(() => this.runUserTurn(session, utterance));
  }

  private enqueueGreetingTurn(session: ActiveSession): void {
    session.turnTail = session.turnTail
      .catch(err => {
        this.log.warn({ sessionId: session.sessionId, err }, 'previous voice turn rejected; continuing chain');
      })
      .then(() => this.runGreetingTurn(session));
  }

  /** Clear llmActive / currentController for a turn that is unwinding. */
  private clearTurnState(session: ActiveSession, controller: AbortController): void {
    session.llmActive = false;
    if (session.currentController === controller) {
      session.currentController = null;
    }
  }

  private trimSessionHistory(session: ActiveSession): void {
    if (session.history.length > MAX_HISTORY_MESSAGES) {
      session.history.splice(0, session.history.length - MAX_HISTORY_MESSAGES);
    }
  }

  /**
   * Shared spoken-turn lifecycle for greeting and user turns (#1596 review).
   * Owns: controller/`llmActive`, mark-active, ending/aborted checkpoints,
   * speech handler, system prompt, VoiceTurnRunner, and a single finally teardown.
   * Callers supply only what differs (TTFA key, message assembly, tools, persist).
   */
  private async runAssistantTurn(
    session: ActiveSession,
    opts: {
      ttfaLogKey: 'voice.ttfa_ms' | 'voice.greeting_ttfa_ms';
      ttfaLogMessage: string;
      failureLogMessage: string;
      /**
       * Prior history for message assembly. When omitted the core loads it
       * (greeting). User turns pass the pre-loaded prior so the current
       * utterance can be persisted before the assistant runs.
       */
      priorHistory?: Message[];
      assembleMessages: (ctx: {
        systemPrompt: string;
        priorHistory: Message[];
      }) => Message[];
      /** Wire coordinator tools + filler (user turns). Greeting passes false. */
      withTools: boolean;
      /** Persist a completed spoken reply (in-process + working_memory). */
      persistSuccess: (finalText: string) => Promise<void>;
    },
  ): Promise<void> {
    if (session.ending) return;

    // Register the controller BEFORE any await so a concurrent endSession can
    // abort this turn (otherwise updateStatus yields with currentController
    // still null and a phantom reply can persist after hangup).
    const controller = new AbortController();
    session.currentController = controller;
    session.llmActive = true;

    try {
      if (!session.markedActive) {
        session.markedActive = true;
        try {
          await this.config.sessionStore.updateStatus(session.sessionId, 'active');
        } catch (err) {
          this.log.warn({ sessionId: session.sessionId, err }, 'failed to mark voice session active');
        }
      }

      if (session.ending || controller.signal.aborted) return;

      const priorHistory = opts.priorHistory ?? await this.loadTurnHistory(session);
      if (session.ending || controller.signal.aborted) return;

      const turnStartedAt = Date.now();
      let ttfaRecorded = false;
      const onSpeechText = this.createSpeechHandler(session, controller, {
        onFirstAudio: () => {
          if (ttfaRecorded) return;
          ttfaRecorded = true;
          this.log.debug(
            { sessionId: session.sessionId, [opts.ttfaLogKey]: Date.now() - turnStartedAt },
            opts.ttfaLogMessage,
          );
        },
      });

      const systemPrompt = await this.buildTurnSystemPrompt(session);
      if (session.ending || controller.signal.aborted) return;

      const messages = opts.assembleMessages({ systemPrompt, priorHistory });

      let tools: ToolDefinition[] | undefined;
      let invokeTool: ((call: ToolCall) => Promise<{ content: string; is_error?: boolean }>) | undefined;
      let onFiller: ((text: string) => Promise<void>) | undefined;

      if (opts.withTools) {
        tools = this.toolBridge
          ? this.toolBridge.resolveVoiceTools()
          : (this.config.resolveVoiceTools ? this.config.resolveVoiceTools() : this.config.tools);

        const turnDateResolveTracker = new TurnDateResolveTracker();
        invokeTool = this.toolBridge
          ? async (call: ToolCall) => {
            const result = await this.toolBridge!.invokeTool(call, {
              conversationId: session.conversationId,
              sessionId: session.sessionId,
              caller: session.caller,
              turnDateResolveResults: turnDateResolveTracker.snapshot(),
            });
            if (call.name === 'date-resolve') {
              turnDateResolveTracker.recordFromJsonContent(result.content, result.is_error);
            }
            return result;
          }
          : this.config.invokeTool
            ? async (call: ToolCall) => {
              const result = await this.config.invokeTool!(call, {
                conversationId: session.conversationId,
                sessionId: session.sessionId,
                caller: session.caller,
                turnDateResolveResults: turnDateResolveTracker.snapshot(),
              });
              if (call.name === 'date-resolve') {
                turnDateResolveTracker.recordFromJsonContent(result.content, result.is_error);
              }
              return result;
            }
            : undefined;

        onFiller = async filler => {
          await onSpeechText(filler, { streamId: `${session.sessionId}-filler` });
        };
      }

      const runner = new VoiceTurnRunner({
        provider: this.config.llm,
        model: this.config.model,
        logger: this.log,
        tools,
        invokeTool,
        onFiller,
        onSpeechText,
      });

      const result = await runner.runTurn({ messages, signal: controller.signal });
      if (result.aborted || session.ending || result.finalText.length === 0) return;

      await opts.persistSuccess(result.finalText);
    } catch (err) {
      this.log.warn({ sessionId: session.sessionId, err }, opts.failureLogMessage);
    } finally {
      this.clearTurnState(session, controller);
    }
  }

  /**
   * Opening turn for inbound console calls (#1596). Speaks an LLM greeting
   * (context-aware via the outbound-context bridge + time block) before any
   * user speech. Barge-in cancels it the same way as a normal assistant turn.
   *
   * On success, persists a synthetic leading user cue *and* the assistant
   * greeting so later turns stay provider-safe (Anthropic requires user-first).
   * The cue is never published as inbound.message; the console history endpoint
   * filters it from display via isVoiceGreetingCueContent.
   */
  private async runGreetingTurn(session: ActiveSession): Promise<void> {
    await this.runAssistantTurn(session, {
      ttfaLogKey: 'voice.greeting_ttfa_ms',
      ttfaLogMessage: 'voice greeting time-to-first-audio',
      failureLogMessage: 'voice greeting turn failed',
      // No tools — keep the open short and latency-tight; outbound context is
      // already in the system prompt when present.
      withTools: false,
      assembleMessages: ({ systemPrompt, priorHistory }) => [
        { role: 'system', content: `${systemPrompt}\n\n${VOICE_GREETING_INSTRUCTION}` },
        ...priorHistory,
        { role: 'user', content: VOICE_GREETING_USER_MESSAGE },
      ],
      persistSuccess: async (finalText) => {
        // Persist cue + greeting together so history stays user-first for every
        // subsequent provider call (Anthropic/Gemini reject a leading assistant).
        session.history.push(
          { role: 'user', content: VOICE_GREETING_USER_MESSAGE },
          { role: 'assistant', content: finalText },
        );
        this.trimSessionHistory(session);
        if (!this.config.workingMemory) return;
        try {
          await this.config.workingMemory.addTurn(session.conversationId, VOICE_HISTORY_AGENT_ID, {
            role: 'user',
            content: VOICE_GREETING_USER_MESSAGE,
          });
          try {
            await this.config.workingMemory.addTurn(session.conversationId, VOICE_HISTORY_AGENT_ID, {
              role: 'assistant',
              content: finalText,
            });
          } catch (assistantErr) {
            // Cue landed but the spoken reply did not — next loadTurnHistory will
            // see a cue-only prefix and lose the fact Curia already greeted.
            this.log.warn(
              { sessionId: session.sessionId, err: assistantErr },
              'greeting cue persisted but assistant reply write failed — working memory now missing the spoken greeting',
            );
          }
        } catch (err) {
          this.log.warn(
            { sessionId: session.sessionId, err },
            'failed to persist voice greeting to working memory',
          );
        }
      },
    });
  }

  /**
   * Shared TTS publish path for user turns and the opening greeting. Counts soft
   * TTS failures toward the session teardown threshold (#1556).
   */
  private createSpeechHandler(
    session: ActiveSession,
    controller: AbortController,
    opts: { onFirstAudio?: () => void },
  ): (sentence: string, meta: { streamId: string }) => Promise<void> {
    return async (sentence: string, meta: { streamId: string }): Promise<void> => {
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
          opts.onFirstAudio?.();
          // Publish is outside the TTS failure streak — a LiveKit blip must not
          // be recorded as tts_error (#1556 review).
          try {
            await session.transport.publishAudio(frame);
          } catch (publishErr) {
            this.log.warn(
              { sessionId: session.sessionId, err: publishErr },
              'failed to publish TTS audio frame; not counted as a TTS synthesis failure',
            );
            break;
          }
        }
        // Healthy synthesis (including barge-in abort mid-stream) clears the streak.
        if (!session.ending) session.consecutiveTtsFailures = 0;
      } catch (err) {
        if (controller.signal.aborted || session.ending) return;
        session.consecutiveTtsFailures += 1;
        const hard = isHardTtsFailure(err);
        this.log.warn(
          {
            sessionId: session.sessionId,
            err,
            consecutiveFailures: session.consecutiveTtsFailures,
            hard,
          },
          'TTS synthesis failed',
        );
        // Soft: tolerate a blip. Hard (auth / bad voice id) or repeated soft → end
        // with tts_error so the console reflects it (mirrors stt_error).
        if (hard || session.consecutiveTtsFailures >= TTS_CONSECUTIVE_FAILURE_LIMIT) {
          this.log.error(
            {
              sessionId: session.sessionId,
              err,
              consecutiveFailures: session.consecutiveTtsFailures,
              hard,
            },
            'TTS synthesis failures exceeded threshold; ending session',
          );
          void this.endSession(session.sessionId, 'tts_error');
        }
      } finally {
        session.activeTtsStreamIds.delete(ttsStreamId);
        if (session.activeTtsStreamIds.size === 0) session.ttsActive = false;
      }
    };
  }

  /**
   * Resolve the dynamic prompt parts (guarding each — a compile failure, bad
   * timezone, or outbound-context read failure must degrade to a slimmer prompt,
   * never abort the spoken turn) and assemble the per-turn system prompt.
   * Mirrors AgentRuntime.processTask's guard-and-omit pattern for the same blocks.
   */
  private async buildTurnSystemPrompt(session: ActiveSession): Promise<string> {
    let identityBlock: string | null = null;
    if (this.toolBridge?.identityBlock) {
      try {
        identityBlock = this.toolBridge.identityBlock();
      } catch (err) {
        this.log.error({ err }, 'Failed to compile identity block for voice turn — identity omitted this turn');
      }
    }

    let specialistRoster: string | null = null;
    if (this.toolBridge?.specialistRoster) {
      try {
        specialistRoster = this.toolBridge.specialistRoster();
      } catch (err) {
        this.log.error({ err }, 'Failed to resolve specialist roster for voice turn — delegation guidance omitted this turn');
      }
    }

    // Same getActive() + formatInjectionBlock() path the dispatcher uses for
    // text channels (#1594). Empty result → null → prompt unchanged. Failure
    // and deadline expiry are best-effort: log and continue without the bridge
    // (parity with dispatcher failure mode + loadTurnHistory latency contract).
    //
    // Gate on liveTurn (#1598): "messages you've sent" is principal-audience
    // content — never inject it for a non-principal voice caller.
    let outboundContextBlock: string | null = null;
    if (this.config.outboundContextService && session.caller.liveTurn) {
      const timeoutMs = this.config.historyReadTimeoutMs ?? DEFAULT_HISTORY_READ_TIMEOUT_MS;
      const read = this.config.outboundContextService.getActive();
      // A read that loses the deadline race settles later with no awaiter —
      // absorb its eventual rejection so it cannot become an unhandled rejection.
      read.catch(err => {
        this.log.debug(
          { err },
          'late outbound-context getActive failure (turn already proceeded)',
        );
      });
      let timer: NodeJS.Timeout | undefined;
      try {
        const outcome = await Promise.race([
          read,
          new Promise<'timeout'>(resolve => {
            timer = setTimeout(() => resolve('timeout'), timeoutMs);
          }),
        ]);
        if (outcome === 'timeout') {
          this.log.warn(
            { timeoutMs },
            'outbound-context getActive exceeded the voice deadline; proceeding without context injection',
          );
        } else {
          // Pass '' for originalContent — the utterance stays a separate user
          // message; only the [ACTIVE OUTBOUND CONTEXT] preamble goes into the
          // system prompt.
          const preamble = this.config.outboundContextService.formatInjectionBlock(
            outcome,
            '',
          );
          if (preamble !== null) {
            outboundContextBlock = preamble.trimEnd();
            this.log.debug(
              { entryCount: outcome.length },
              'Injected active outbound context into voice system prompt',
            );
          }
        }
      } catch (err) {
        this.log.error(
          { err },
          'Failed to read outbound context entries — proceeding without context injection',
        );
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }

    let timeContextBlock: string | null = null;
    const timezone = this.config.timezone?.trim();
    if (timezone) {
      try {
        timeContextBlock = formatTimeContextBlock(timezone, new Date());
      } catch (err) {
        this.log.error({ err, timezone }, 'formatTimeContextBlock failed — time context not injected into voice turn; check TIMEZONE config');
      }
    }

    return buildVoiceSystemPrompt({
      identityBlock,
      specialistRoster,
      outboundContextBlock,
      timeContextBlock,
      audience: {
        liveTurn: session.caller.liveTurn,
        displayName: session.caller.displayName,
      },
    });
  }

  /**
   * Load spoken-turn context from working_memory — the same rows console chat
   * history reads — so persistence and LLM context are single-sourced (#1551).
   * Falls back to the in-process session history when no store is configured,
   * the read fails or exceeds its deadline, or the store reads back empty while
   * the in-process copy is not (a prior addTurn write failed warn-only): a
   * degraded slim turn beats failing — or stalling — the call. Callers invoke
   * this BEFORE persisting the current utterance, so the returned turns are
   * strictly prior history.
   */
  private async loadTurnHistory(session: ActiveSession): Promise<Message[]> {
    if (!this.config.workingMemory) return [...session.history];
    const timeoutMs = this.config.historyReadTimeoutMs ?? DEFAULT_HISTORY_READ_TIMEOUT_MS;
    const read = this.config.workingMemory.getHistory(
      session.conversationId,
      VOICE_HISTORY_AGENT_ID,
      { maxTurns: VOICE_HISTORY_MAX_TURNS },
    );
    // A read that loses the deadline race settles later with no awaiter —
    // absorb its eventual rejection so it cannot become an unhandled rejection.
    read.catch(err => {
      this.log.debug(
        { sessionId: session.sessionId, err },
        'late working-memory history read failure (turn already proceeded)',
      );
    });
    let timer: NodeJS.Timeout | undefined;
    try {
      const outcome = await Promise.race([
        read,
        new Promise<'timeout'>(resolve => {
          timer = setTimeout(() => resolve('timeout'), timeoutMs);
        }),
      ]);
      if (outcome === 'timeout') {
        this.log.warn(
          { sessionId: session.sessionId, timeoutMs },
          'working-memory history read exceeded the voice deadline; falling back to in-process history',
        );
        return [...session.history];
      }
      // A prior addTurn may have failed (warn-only), leaving the store behind
      // the in-process copy. Prefer the fallback over starting the turn amnesiac.
      if (outcome.length === 0 && session.history.length > 0) return [...session.history];
      return outcome.map(t => ({ role: t.role, content: t.content }));
    } catch (err) {
      this.log.warn(
        { sessionId: session.sessionId, err },
        'failed to load voice history from working memory; falling back to in-process history',
      );
      return [...session.history];
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
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
          senderId: session.caller.senderId,
          content: sanitizeOutput(utterance),
        }),
      );
    } catch (err) {
      this.log.warn({ sessionId: session.sessionId, err }, 'failed to publish voice inbound.message');
    }

    // Single authoritative history (#1551): reload prior turns from working_memory
    // BEFORE persisting this utterance, so the current user message is appended
    // to the LLM context exactly once (turns are serialized per session, so the
    // read cannot race the write below).
    const priorHistory = await this.loadTurnHistory(session);
    if (session.ending) return;

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

    const userMessage: Message = { role: 'user', content: utterance };
    // Retain the user request even if barge-in aborts the assistant reply —
    // otherwise the next turn loses conversational continuity. The in-process
    // copy is only the fallback context source (see loadTurnHistory).
    session.history.push(userMessage);
    this.trimSessionHistory(session);

    await this.runAssistantTurn(session, {
      ttfaLogKey: 'voice.ttfa_ms',
      ttfaLogMessage: 'voice time-to-first-audio',
      failureLogMessage: 'voice turn failed',
      priorHistory,
      withTools: true,
      assembleMessages: ({ systemPrompt, priorHistory: prior }) => [
        { role: 'system', content: systemPrompt },
        ...prior,
        userMessage,
      ],
      persistSuccess: async (finalText) => {
        // Append only the completed assistant reply (user was already pushed).
        session.history.push({ role: 'assistant', content: finalText });
        this.trimSessionHistory(session);
        // Persist assistant transcript so console history can show what was spoken.
        // Spoken egress stays on TTS — we do not publish outbound.message (web chat
        // also skips OutboundGateway for principal console replies).
        if (!this.config.workingMemory) return;
        try {
          await this.config.workingMemory.addTurn(session.conversationId, VOICE_HISTORY_AGENT_ID, {
            role: 'assistant',
            content: finalText,
          });
        } catch (err) {
          this.log.warn(
            { sessionId: session.sessionId, err },
            'failed to persist voice assistant turn to working memory',
          );
        }
      },
    });
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

      // Cleanup LiveKit room after hangup. Room delete does not revoke JWTs —
      // a leaked token remains valid until TTL and may auto-create the room.
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
    // Wrapped like every other side-effect here: endSession is fire-and-forgotten
    // (`void this.endSession(...)`) from stt.onError / transport.onClose, so a DB
    // hiccup would otherwise become an unhandled rejection and crash the process.
    let ended: VoiceSessionRecord | null = null;
    try {
      ended = await this.config.sessionStore.endSession(sessionId, reason);
    } catch (err) {
      this.log.error({ sessionId, err }, 'failed to persist voice session end');
    }
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
