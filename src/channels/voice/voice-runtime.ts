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
// Both paths run through historyForLlm before the provider call so consecutive
// same-role turns and trailing unpaired user turns never reach the model (#1776).
//
// liveTurn scope (#1598 / #1126): voice stamps liveTurn once per *session* at
// create time (a continuous call with one human), whereas every other channel
// stamps it per inbound *turn*. The elevated skill gate therefore stays
// satisfied for the call's full duration. This widening is deliberate — a
// voice session is one live conversation, not a sequence of independent
// messages — and must not be copied onto text channels.
import { monitorEventLoopDelay, type ELDHistogram } from 'node:perf_hooks';
import type { EventBus } from '../../bus/bus.js';
import { createInboundMessage, createVoiceSessionEnded } from '../../bus/events.js';
import type { VoiceSessionTurnStats } from '../../bus/events.js';
import type { OutboundContextService } from '../../dispatch/outbound-context.js';
import type { Logger } from '../../logger.js';
import type { LLMProvider, Message, ToolCall, ToolDefinition } from '../../agents/llm/provider.js';
import { DATE_RESOLVE_GUARDRAIL } from '../../agents/prompts/date-resolve-guardrail.js';
import { VOICE_ASYNC_OFFRAMP_GUIDANCE } from '../../agents/prompts/voice-async-offramp.js';
import { TurnDateResolveTracker } from '../../agents/delegate-brief-date-validation.js';
import type { WorkingMemory } from '../../memory/working-memory.js';
import { formatAgendaPromptBlock, parseAgendaLoadResult } from '../../meetings/agenda-prompt.js';
import type { AgendaIndexEntry, AgendaSnapshot, SessionAgendaLoad, SessionAgendas } from '../../meetings/types.js';
import { historyForLlm, LLM_FAILURE_TURN_CONTENT } from '../../memory/llm-failure-turn.js';
import {
  CONTACT_RECENT_HISTORY_MAX_TURNS,
  contactRecentHistorySince,
  formatContactRecentHistoryBlock,
  type ContactRecentTurn,
} from '../../memory/contact-recent-history.js';
import { persistableCallerContactId } from './caller-contact-id.js';
import { sanitizeOutput } from '../../skills/sanitize.js';
import { formatTimeContextBlock } from '../../time/time-context.js';
import type { AudioTransport } from './audio-transport.js';
import type { VoiceCallerContext } from './caller-context.js';
import {
  buildVoiceGreetingInstruction,
  hasUnsafeVoicePromptCharacter,
  VOICE_GREETING_USER_MESSAGE,
} from './greeting.js';
import type { SpeechToTextProvider, SttSession, SttTranscriptEvent, TextToSpeechProvider } from '../../speech/index.js';
import { TtsHttpError } from '../../speech/index.js';
import type { VoiceSessionRecord, VoiceSessionStore } from './session-store.js';
import { findInternalJargon } from './spoken-jargon.js';
import { VoiceTurnError, VoiceTurnRunner } from './turn-runner.js';

export {
  buildVoiceGreetingInstruction,
  hasUnsafeVoicePromptCharacter,
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
 * Deadline shared by the per-turn working_memory history read and the
 * contact-scoped recall read. Pool checkout timeouts do not bound the query
 * itself — a stalled read must not stall the spoken turn, so on expiry the
 * turn falls back to in-process history and skips cross-conversation recall.
 */
const DEFAULT_HISTORY_READ_TIMEOUT_MS = 1_000;
/** Ignore tiny interim blobs (echo / noise) when deciding barge-in. */
const BARGE_IN_MIN_CHARS = 3;
/** Ignore low-confidence interims when the provider reports confidence. */
const BARGE_IN_MIN_CONFIDENCE = 0.4;
/**
 * Wait after the STT end-of-speech signal before starting a turn (#2240). Speech
 * inside the window keeps the utterance open, so a principal who pauses
 * mid-thought ("His school is… Oakbridge") is answered once, not per fragment.
 * 600 ms (a turn about a second after the last word) felt sluggish on calls, so
 * it is 350 (#2379): a pause longer than ~750 ms now starts a turn, and speech
 * that resumes during that turn still joins it via barge-in carry-over.
 * Overridable with channels.voice.turn_hold_ms.
 */
const DEFAULT_TURN_HOLD_MS = 350;
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
 * Collapse consecutive same-role turns and drop a trailing unpaired `user`
 * turn so the next utterance (or greeting cue) is appended onto a
 * provider-safe prefix (#1767 / #1776). String-only: voice history never
 * stores content-block arrays.
 */
function spokenHistoryForLlm(turns: Array<{ role: Message['role']; content: string }>): Message[] {
  return historyForLlm(turns);
}

/** Join two pieces of one spoken utterance; either may be empty. */
function joinUtterances(first: string, second: string): string {
  if (!first) return second;
  if (!second) return first;
  return `${first} ${second}`;
}

function stringTurns(messages: Message[]): Array<{ role: Message['role']; content: string }> {
  const out: Array<{ role: Message['role']; content: string }> = [];
  for (const m of messages) {
    if (typeof m.content === 'string') out.push({ role: m.role, content: m.content });
  }
  return out;
}

type DeadlineRace<T> =
  | { status: 'ok'; value: T }
  | { status: 'timeout' }
  | { status: 'error'; err: unknown };

/**
 * Race `read` against an absolute deadline. A late rejection is the caller's
 * job to absorb — this helper settles exactly once.
 */
function raceDeadline<T>(read: Promise<T>, deadlineAt: number): Promise<DeadlineRace<T>> {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) return Promise.resolve({ status: 'timeout' });
  return new Promise(resolve => {
    let settled = false;
    const finish = (result: DeadlineRace<T>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ status: 'timeout' }), remaining);
    read.then(
      value => finish({ status: 'ok', value }),
      (err: unknown) => finish({ status: 'error', err }),
    );
  });
}

/** True when `prefix` is the leading role/content sequence of `full`. */
function isHistoryPrefix(prefix: Message[], full: Message[]): boolean {
  if (prefix.length > full.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    const a = prefix[i]!;
    const b = full[i]!;
    if (a.role !== b.role || a.content !== b.content) return false;
  }
  return true;
}

/**
 * Spoken-style guidance shared by every voice audience. The audience line
 * ("You are speaking to …") is composed separately by buildVoiceAudienceLine()
 * so a non-principal caller never inherits the principal framing (#1598).
 *
 * Known limitation (#2379): a form of address sounds spliced in ("Good morning,
 * Boss" like an old IVR) because Cartesia pauses on the comma before it, and
 * the model writes that comma by habit. A prompt line telling the model to drop
 * it failed on claude-haiku-5-5 (comma in 10/10 turns). Rewriting the text before
 * TTS was declined as a patch. Revisit when models or TTS handle this better.
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
  if (name && !hasUnsafeVoicePromptCharacter(name)) {
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
 *
 * "The principal's inbox" used to cover sending too, so a request to email the
 * principal a recap went to the inbox specialist, which only drafts. Its refusal
 * reached the caller as "the email tool refused" (#2347). The recap of the call
 * itself belongs to meeting-notes-start; this sentence must agree with that
 * tool's and async-offramp's descriptions on the turn the model chooses.
 *
 * The closing examples replaced a bare "never mention specialists" clause: the
 * model read the names back ("I'll ask the calendar specialist", #2379). Quoted
 * examples and "never say" sentences here must not name internal terms
 * (spoken-jargon.ts; voice-tools.test.ts).
 */
export const VOICE_DELEGATION_GUIDANCE =
  'Many requests are handled by delegating to a specialist with the delegate tool: ' +
  'calendar and scheduling, contacts and people lookups, research, and reading the ' +
  'principal\'s inbox all belong to the specialists listed below. A recap of this ' +
  'call is meeting-notes-start. Anything else to email or message after the call, ' +
  'such as links or research results, goes to async-offramp, not a specialist. When a request ' +
  'falls in a specialist\'s domain, delegate rather than answering from memory or ' +
  'guessing. Resolve pronouns before delegating: "my calendar" spoken by the ' +
  'principal means the principal\'s calendar. Fold the specialist\'s result into ' +
  'your own short spoken answer. The caller hears one person doing the work, so ' +
  'say what you are doing in their terms: "Let me check your calendar." "I\'ll ' +
  'take care of that after we hang up." Talk about the work itself, never about ' +
  'how it gets done.';

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
   * Loaded and queued agendas for this call (#2322). Omitted or null keeps the
   * prompt byte-identical to a call with no agendas. Sits immediately before
   * the time block so the static prefix stays cacheable.
   */
  agendaBlock?: string | null;
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
  if (parts.agendaBlock) sections.push(parts.agendaBlock);
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
      /** The turn's inbound.message id — the parent of its tool audit events (#1968). */
      turnEventId?: string;
    },
  ) => Promise<{ content: string; is_error?: boolean }>;
  /**
   * Max UTF-8 bytes for an accumulated STT utterance before it is dropped.
   * Mirrors the dispatcher `maxMessageBytes` guard (voice bypasses the dispatcher).
   */
  maxUtteranceBytes?: number;
  /**
   * Hold (ms) between the STT end-of-speech signal and starting the turn; speech
   * inside it extends the utterance (#2240). Default DEFAULT_TURN_HOLD_MS. 0
   * starts the turn on the signal itself.
   */
  turnHoldMs?: number;
  /**
   * How long a caller-mic mute (the installed app in the background) may last
   * before the call ends. Default two minutes. A disconnect still ends immediately.
   */
  pauseGraceMs?: number;
  /**
   * IANA timezone for the per-turn date/time block (same block the coordinator
   * gets — formatTimeContextBlock). Without it, "tomorrow / next week" is
   * un-anchored for every voice tool call (#1551). Omitted → no time block.
   */
  timezone?: string;
  /**
   * Deadline (ms) for per-turn Postgres reads on the spoken critical path
   * (working_memory history, contact-scoped recall, and outbound-context
   * getActive). On expiry the turn degrades — in-process history / no
   * cross-conversation block / no context injection — rather than stalling.
   * Default 1000ms. History and contact recall share one deadline.
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
      /** The turn's inbound.message id — the parent of its tool audit events (#1968). */
      turnEventId?: string;
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
  /**
   * Agent participant JWT (identity 'curia-agent'). Optional when `transport`
   * is supplied — LiveKit auth is irrelevant to a caller-provided transport
   * (#1672). Required (and validated) when `transport` is absent.
   */
  agentToken?: string;
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
  /**
   * Pre-built transport override (#1672). When set, createTransport is not
   * called and deleteRoom is skipped at teardown — the supplier owns the
   * media path lifecycle (e.g. SignalCallBridge / signal-cli tunnel).
   */
  transport?: AudioTransport;
  /**
   * Agendas prepared for this call (#2322). Absent on console calls and on
   * any call that did not go through agenda preparation.
   */
  agendas?: SessionAgendas;
}

/** When an utterance's speech ended, for the turn-gap timings (#2379). */
interface UtteranceTiming {
  /** The last word's end; null without word timings. */
  lastWordAt: number | null;
  /** When the hold fired and the utterance joined the turn queue. */
  endOfSpeechAt: number;
}

/** An utterance's timing plus when its turn left the queue. */
interface TurnGap {
  timing: UtteranceTiming | null;
  startedAt: number;
}

interface CarriedUtterance {
  utterance: string;
  /** The user row as stored (sanitized), for the pairing check. */
  storedContent: string;
  /** False when that turn's user-row write failed — never pair an older row. */
  persisted: boolean;
  fragments: number;
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
  /** Final transcript text of the utterance still being spoken (or held). */
  pendingFinalText: string;
  /** End-of-speech signals with words that `pendingFinalText` spans. */
  pendingFragments: number;
  /** Final words arrived since the last end-of-speech signal. */
  wordsSinceEndOfSpeech: boolean;
  /** Armed on end-of-speech; the utterance becomes a turn when it fires (#2240). */
  holdTimer: NodeJS.Timeout | null;
  /** Finished utterances waiting for the running turn; they run as one turn. */
  queuedUtterance: string;
  queuedFragments: number;
  /** True while a drain of `queuedUtterance` is chained on `turnTail`. */
  drainScheduled: boolean;
  /**
   * Utterance whose turn barge-in cancelled before any audio played. The next
   * turn runs on it joined with what the caller said next (#2240). Its stored
   * user row is unpaired until then; if it never joins (hang-up, oversize join)
   * it is paired with the failure marker instead.
   */
  carryOver: CarriedUtterance | null;
  turnStats: VoiceSessionTurnStats;
  ttsSeq: number;
  ending: boolean;
  /** Consecutive synthesize() failures; reset on a successful synthesis (#1556). */
  consecutiveTtsFailures: number;
  /**
   * True when the session was started with a caller-provided transport
   * (#1672). Skips deleteRoom at teardown — the supplier owns the media
   * lifecycle (e.g. the LiveKit room is not this runtime's to delete).
   */
  externalTransport: boolean;
  /** Agendas locked into this call, rendered into every later turn's prompt. */
  loadedAgendas: AgendaSnapshot[];
  /** Pending agendas offered but not yet loaded. */
  agendaIndex: AgendaIndexEntry[];
  /** Notes the caller asked for (#2347), from meeting-notes-start's result; restated in every later turn's prompt. */
  notes: { recap: boolean } | null;
  /**
   * Wall-clock estimate of when the pending utterance's last word ended (#2379).
   * Null when its latest final had no word timings, so a stale time never
   * stands in for this utterance's.
   */
  pendingLastWordAt: number | null;
  /** Timing of the latest utterance in `queuedUtterance`, for the turn-gap log. */
  queuedTiming: UtteranceTiming | null;
  /**
   * When published audio finishes playing, assuming the far end plays it in
   * real time from the first frame. Ahead of now = audio still queued (#2379).
   */
  playoutEndsAt: number;
  /** Audio published by the current assistant turn, ms. */
  turnAudioMs: number;
  /** Call-wide TTS delivery stats, logged when the session ends (#2379). */
  audioStats: { chunks: number; audioMs: number; gapMs: number; starvedMs: number; starvedCount: number };
  /** Event-loop delay over the call; the host shares one small box (#2379). */
  loopDelay: ELDHistogram;
  /** The caller's mic is muted, so TTS must not be published. */
  callerMuted: boolean;
  /** Fires when a background mute outlasts the grace period. */
  pauseTimer: ReturnType<typeof setTimeout> | null;
}

/** A session whose end is in progress: one caller tears it down and persists it. */
interface EndingSession {
  session: ActiveSession;
  /** Reason to persist. An explicit caller's reason replaces a transport close's. */
  reason: string;
  fromTransport: boolean;
  /** Settles with the persisted record (null if the store write failed or found it ended). */
  done: Promise<VoiceSessionRecord | null>;
}

export class VoiceRuntime {
  private readonly log: Logger;
  private readonly sessions = new Map<string, ActiveSession>();
  /** Sessions whose end is in progress; see endSessionWith (#2379). */
  private readonly endingSessions = new Map<string, EndingSession>();
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

    // (#1672) A caller-provided transport (e.g. a Signal call bridge) bypasses
    // LiveKit entirely: no createTransport call, no agentToken requirement.
    let transport: RateAwareTransport;
    if (params.transport) {
      transport = params.transport as RateAwareTransport;
    } else {
      if (!params.agentToken) {
        throw new Error('startSession requires agentToken when no transport override is provided');
      }
      transport = this.config.createTransport({
        roomName: params.roomName,
        token: params.agentToken,
        livekitUrl: this.config.livekitUrl,
        callerIdentity: params.caller.contactId,
      }) as RateAwareTransport;
    }

    const inboundSampleRate = transport.inboundSampleRate ?? DEFAULT_INBOUND_SAMPLE_RATE;
    const publishSampleRate = transport.publishSampleRate ?? DEFAULT_PUBLISH_SAMPLE_RATE;

    let stt: SttSession | undefined;
    try {
      // connect() lives inside the try (not before it) so a rejection here
      // still reaches the catch below and calls transport.disconnect() —
      // otherwise a transport that partially connects (e.g. one of two
      // spawned child processes) before throwing would never be reaped.
      await transport.connect();

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
        pendingFragments: 0,
        wordsSinceEndOfSpeech: false,
        holdTimer: null,
        queuedUtterance: '',
        queuedFragments: 0,
        drainScheduled: false,
        carryOver: null,
        turnStats: { utterances: 0, turns: 0, bargeInCancels: 0, joinedUtterances: 0 },
        ttsSeq: 0,
        ending: false,
        consecutiveTtsFailures: 0,
        externalTransport: params.transport !== undefined,
        loadedAgendas: [...(params.agendas?.loaded ?? [])],
        agendaIndex: [...(params.agendas?.index ?? [])],
        notes: null,
        pendingLastWordAt: null,
        queuedTiming: null,
        playoutEndsAt: 0,
        turnAudioMs: 0,
        audioStats: { chunks: 0, audioMs: 0, gapMs: 0, starvedMs: 0, starvedCount: 0 },
        loopDelay: monitorEventLoopDelay({ resolution: 10 }),
        callerMuted: false,
        pauseTimer: null,
      };
      session.loopDelay.enable();
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
        void this.endSessionWith(params.sessionId, reason, true);
      });

      transport.onCallerMuted(muted => {
        this.handleCallerMuted(session, muted);
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
      this.sessions.get(params.sessionId)?.loopDelay.disable();
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

    // Gate on length + confidence so speaker echo / noise neither interrupts
    // Curia mid-sentence nor holds a finished utterance open.
    const isSpeech = text.length >= BARGE_IN_MIN_CHARS
      && (event.confidence === undefined || event.confidence >= BARGE_IN_MIN_CONFIDENCE);

    // Barge-in: speech while the assistant talks cancels it.
    if (isSpeech && (session.llmActive || session.ttsActive)) {
      this.bargeIn(session, event);
    }

    if (event.isFinal && text.length > 0) {
      session.pendingLastWordAt = event.speechEndedAgoMs !== undefined ? Date.now() - event.speechEndedAgoMs : null;
    }

    // Speech inside the hold window: the caller resumed. Restart the hold rather
    // than clearing it — an interim Deepgram later revises away never brings a
    // final or an end-of-speech, and the held utterance must still run (#2240).
    if (isSpeech && session.holdTimer) {
      this.armHold(session);
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
        session.pendingFragments = 0;
        session.wordsSinceEndOfSpeech = false;
        return;
      }
      session.pendingFinalText = next;
      session.wordsSinceEndOfSpeech = true;
    }

    // End-of-speech. Deepgram can send it twice per utterance (speech_final,
    // then UtteranceEnd with no words); only one that closes new words counts.
    if (event.speechFinal) {
      const closedWords = session.wordsSinceEndOfSpeech;
      if (closedWords) {
        session.wordsSinceEndOfSpeech = false;
        session.pendingFragments += 1;
        session.turnStats.utterances += 1;
      }
      if (session.pendingFinalText.trim().length === 0) return;

      if ((this.config.turnHoldMs ?? DEFAULT_TURN_HOLD_MS) <= 0) {
        this.flushPendingUtterance(session);
        return;
      }
      // Re-arm whenever this end-of-speech closed new words, including a short or
      // low-confidence "ok" that did not pass the speech gate above. One with no
      // new words (UtteranceEnd right after speech_final) keeps the deadline.
      if (closedWords || !session.holdTimer) {
        this.armHold(session);
      }
    }
  }

  /** (Re)start the hold; when it fires, the pending utterance becomes a turn. */
  private armHold(session: ActiveSession): void {
    if (session.holdTimer) clearTimeout(session.holdTimer);
    session.holdTimer = setTimeout(() => {
      session.holdTimer = null;
      this.flushPendingUtterance(session);
    }, this.config.turnHoldMs ?? DEFAULT_TURN_HOLD_MS);
  }

  /** Hand the finished utterance to the turn queue. */
  private flushPendingUtterance(session: ActiveSession): void {
    if (session.holdTimer) {
      clearTimeout(session.holdTimer);
      session.holdTimer = null;
    }
    // A final segment can land after the last end-of-speech (a short "ok", or one
    // Deepgram finalizes mid-speech) and the hold can fire before its own
    // end-of-speech. Close it here, or it would count against the next utterance.
    if (session.wordsSinceEndOfSpeech) {
      session.wordsSinceEndOfSpeech = false;
      session.pendingFragments += 1;
      session.turnStats.utterances += 1;
    }
    const utterance = session.pendingFinalText.trim();
    const fragments = Math.max(session.pendingFragments, 1);
    session.pendingFinalText = '';
    session.pendingFragments = 0;
    if (utterance.length > 0) {
      this.enqueueUtterance(session, utterance, fragments, {
        lastWordAt: session.pendingLastWordAt,
        endOfSpeechAt: Date.now(),
      });
    }
    session.pendingLastWordAt = null;
  }

  private bargeIn(session: ActiveSession, event: SttTranscriptEvent): void {
    const controller = session.currentController;
    if (!controller || controller.signal.aborted) return;

    const startedAt = Date.now();
    for (const streamId of session.activeTtsStreamIds) {
      this.config.tts.cancel(streamId);
    }
    controller.abort();
    session.ttsActive = false;
    session.turnStats.bargeInCancels += 1;
    const stopMs = Date.now() - startedAt;

    // Audio already handed to the transport keeps playing unless it is dropped.
    // `aheadMs` is how far the transport has accepted writes ahead of the wall
    // clock, which is not what the caller still hears: on Signal, pacat's pipe paces
    // writes to real time once full, and PulseAudio's buffer never enters it. The
    // transport's own figure, when it has one, is the real queue (LiveKit).
    const aheadMs = Math.max(0, session.playoutEndsAt - Date.now());
    let transportQueuedMs: number | undefined;
    try {
      transportQueuedMs = session.transport.queuedAudioMs?.();
    } catch (err) {
      this.log.debug({ sessionId: session.sessionId, err }, 'transport queued-audio read failed');
    }
    let flushed = false;
    if (session.transport.clearQueuedAudio) {
      try {
        session.transport.clearQueuedAudio();
        session.playoutEndsAt = Date.now();
        flushed = true;
      } catch (err) {
        this.log.warn({ sessionId: session.sessionId, err }, 'failed to clear queued audio on barge-in');
      }
    }
    // info: speech onset → heard silence is detect + stop + whatever queued audio
    // still plays (#2379). Detect comes from the STT's word timings when present.
    this.log.info(
      {
        sessionId: session.sessionId,
        'voice.barge_in_detect_ms': event.speechStartedAgoMs,
        'voice.barge_in_stop_ms': stopMs,
        'voice.barge_in_accepted_ahead_ms': Math.round(aheadMs),
        'voice.barge_in_transport_queued_ms': transportQueuedMs === undefined ? undefined : Math.round(transportQueuedMs),
        'voice.barge_in_turn_audio_ms': Math.round(session.turnAudioMs),
        flushed,
      },
      'voice barge-in: cancelled assistant turn',
    );
  }

  /**
   * Queue a finished utterance. Utterances that finish while a turn is still
   * running join into one, so they run as a single turn when it ends instead of
   * replaying one turn per fragment (#2240). A carried-over utterance from a
   * silently cancelled turn is joined in front at drain time.
   */
  private enqueueUtterance(
    session: ActiveSession,
    utterance: string,
    fragments: number,
    timing: UtteranceTiming,
  ): void {
    session.queuedUtterance = joinUtterances(session.queuedUtterance, utterance);
    session.queuedFragments += fragments;
    // The latest utterance's timing is the gap the caller waits through.
    session.queuedTiming = timing;
    if (session.drainScheduled) return;
    session.drainScheduled = true;

    // Serialize turns onto the tail so a barged-in turn fully unwinds before the
    // next starts. Log rejections — never silently erase them or break the chain.
    session.turnTail = session.turnTail
      .catch(err => {
        this.log.warn({ sessionId: session.sessionId, err }, 'previous voice turn rejected; continuing chain');
      })
      .then(async () => {
        session.drainScheduled = false;
        // endSession takes any carry-over itself, synchronously with setting ending.
        if (session.ending) return;
        const carry = session.carryOver;
        const queued = session.queuedUtterance;
        const queuedFragments = session.queuedFragments;
        const timing = session.queuedTiming;
        session.carryOver = null;
        session.queuedUtterance = '';
        session.queuedFragments = 0;
        session.queuedTiming = null;

        let next = joinUtterances(carry?.utterance ?? '', queued);
        let nextFragments = (carry?.fragments ?? 0) + queuedFragments;
        const maxBytes = this.config.maxUtteranceBytes ?? DEFAULT_MAX_UTTERANCE_BYTES;
        if (carry && Buffer.byteLength(next, 'utf8') > maxBytes) {
          this.log.warn(
            { sessionId: session.sessionId, maxBytes },
            'joined voice utterance exceeded maxUtteranceBytes; dropping the carried-over part',
          );
          await this.pairCarriedUtterance(session, carry);
          next = queued;
          nextFragments = queuedFragments;
        }
        if (next.length === 0) return;
        await this.runUserTurn(session, next, nextFragments, timing);
      });
  }

  /**
   * A user turn reached an outcome — a reply, an error, or a hang-up — instead
   * of being carried into a later turn. Every fragment but one in it was joined,
   * so utterances = turns + joinedUtterances across a session.
   */
  private recordTurnOutcome(session: ActiveSession, fragments: number): void {
    session.turnStats.turns += 1;
    session.turnStats.joinedUtterances += Math.max(fragments - 1, 0);
  }

  /**
   * Pair a carried-over utterance that will not join a later turn with the
   * failure marker, so its stored user row is not left unpaired (dropped from
   * later LLM context, shown without a reply in console history).
   */
  private async pairCarriedUtterance(session: ActiveSession, carry: CarriedUtterance): Promise<void> {
    await this.persistIncompleteAssistantTurn(session, {
      inProcessContent: carry.utterance,
      storedContent: carry.storedContent,
      persistToStore: carry.persisted,
    });
    this.recordTurnOutcome(session, carry.fragments);
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
      /** Tags the first-token line so ADR-038's user-turn gate can drop greetings (#2271). */
      turnKind: 'greeting' | 'user';
      ttfaLogKey: 'voice.ttfa_ms' | 'voice.greeting_ttfa_ms';
      ttfaLogMessage: string;
      failureLogMessage: string;
      /**
       * Prior history for message assembly. When omitted the core loads it
       * (greeting). User turns pass the pre-loaded prior so the current
       * utterance can be persisted before the assistant runs.
       */
      priorHistory?: Message[];
      /** Cross-conversation recall block. Omitted when the caller loaded history itself and passed null. */
      contactRecent?: string | null;
      assembleMessages: (ctx: {
        systemPrompt: string;
        priorHistory: Message[];
        contactRecent: string | null;
      }) => Message[];
      /** Wire coordinator tools + filler (user turns). Greeting passes false. */
      withTools: boolean;
      /** The user turn's inbound.message id, passed to the tool bridge for audit (#1968). */
      turnEventId?: string;
      /**
       * Turn-gap timings (#2379), user turns only: the utterance's timing, and when
       * the turn left the queue (before its bus/history preamble).
       */
      turnGap?: TurnGap;
      /** Persist a completed spoken reply (in-process + working_memory). */
      persistSuccess: (finalText: string) => Promise<void>;
      /**
       * Pair a user turn that was already persisted when this assistant turn
       * does not `persistSuccess` — every exit, including abort during the
       * prelude. `spokenText` is what was handed to TTS (empty when nothing
       * was heard). `cancelledSilently` is true when barge-in cancelled the
       * turn before any audio played (#2240). Greeting omits this; its cue is
       * written only on success.
       */
      persistIncomplete?: (spokenText: string | undefined, outcome: { cancelledSilently: boolean }) => Promise<void>;
      /**
       * Controller the caller already registered (user turns register it before
       * their preamble so barge-in reaches it there too). Created here otherwise.
       */
      controller?: AbortController;
    },
  ): Promise<void> {
    if (session.ending) {
      await this.safePersistIncomplete(opts.persistIncomplete, session, undefined, false);
      return;
    }

    // Register the controller BEFORE any await so a concurrent endSession can
    // abort this turn (otherwise updateStatus yields with currentController
    // still null and a phantom reply can persist after hangup).
    const controller = opts.controller ?? new AbortController();
    session.currentController = controller;
    session.llmActive = true;

    let completed = false;
    let spokenForPairing: string | undefined;
    let audioPlayed = false;
    // A turn that reached a tool may have had side effects, heard or not.
    let toolInvoked = false;
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

      let priorHistory = opts.priorHistory;
      let contactRecent = opts.contactRecent ?? null;
      if (!priorHistory) {
        const loaded = await this.loadTurnContext(session);
        priorHistory = loaded.history;
        contactRecent = loaded.contactRecent;
      }
      if (session.ending || controller.signal.aborted) return;

      const turnStartedAt = Date.now();
      session.turnAudioMs = 0;
      let ttfaRecorded = false;
      const onSpeechText = this.createSpeechHandler(session, controller, {
        onFirstAudio: () => {
          audioPlayed = true;
          if (ttfaRecorded) return;
          ttfaRecorded = true;
          const now = Date.now();
          // The gap the caller hears, split (#2379): last word → hold fired is the
          // end-of-speech wait (endpointing + hold); hold fired → turn start is time
          // queued behind a running turn; last word → audio is the whole gap.
          // Omitted when this utterance had no word timings.
          const gap = opts.turnGap;
          const gaps = gap && gap.timing?.lastWordAt != null
            ? {
              'voice.end_of_speech_wait_ms': gap.timing.endOfSpeechAt - gap.timing.lastWordAt,
              'voice.turn_queue_wait_ms': gap.startedAt - gap.timing.endOfSpeechAt,
              'voice.last_word_to_audio_ms': now - gap.timing.lastWordAt,
            }
            : {};
          // info: what the caller hears, logged beside llm_ttft_ms for ADR-038's check (#2245).
          this.log.info(
            { sessionId: session.sessionId, [opts.ttfaLogKey]: now - turnStartedAt, ...gaps },
            opts.ttfaLogMessage,
          );
        },
      });

      const systemPrompt = await this.buildTurnSystemPrompt(session);
      if (session.ending || controller.signal.aborted) return;

      const messages = opts.assembleMessages({ systemPrompt, priorHistory, contactRecent });

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
            toolInvoked = true;
            const result = await this.toolBridge!.invokeTool(call, {
              conversationId: session.conversationId,
              sessionId: session.sessionId,
              caller: session.caller,
              turnDateResolveResults: turnDateResolveTracker.snapshot(),
              turnEventId: opts.turnEventId,
            });
            if (call.name === 'date-resolve') {
              turnDateResolveTracker.recordFromJsonContent(result.content, result.is_error);
            }
            if (call.name === 'meeting-agenda-load') {
              await this.noteMeetingAgendaLoad(session, result);
            }
            if (call.name === 'meeting-notes-start') {
              this.noteMeetingNotesStart(session, result);
            }
            return result;
          }
          : this.config.invokeTool
            ? async (call: ToolCall) => {
              toolInvoked = true;
              const result = await this.config.invokeTool!(call, {
                conversationId: session.conversationId,
                sessionId: session.sessionId,
                caller: session.caller,
                turnDateResolveResults: turnDateResolveTracker.snapshot(),
                turnEventId: opts.turnEventId,
              });
              if (call.name === 'date-resolve') {
                turnDateResolveTracker.recordFromJsonContent(result.content, result.is_error);
              }
              if (call.name === 'meeting-agenda-load') {
                await this.noteMeetingAgendaLoad(session, result);
              }
              if (call.name === 'meeting-notes-start') {
                this.noteMeetingNotesStart(session, result);
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
        turnKind: opts.turnKind,
        tools,
        invokeTool,
        onFiller,
        onSpeechText,
      });

      const result = await runner.runTurn({ messages, signal: controller.signal });
      if (result.aborted || session.ending || result.finalText.length === 0) {
        spokenForPairing = result.finalText;
        return;
      }

      await opts.persistSuccess(result.finalText);
      completed = true;
    } catch (err) {
      this.log.warn({ sessionId: session.sessionId, err }, opts.failureLogMessage);
      if (err instanceof VoiceTurnError && err.spokenText.length > 0) {
        spokenForPairing = err.spokenText;
      }
    } finally {
      this.clearTurnState(session, controller);
      if (!completed) {
        // Only barge-in and endSession abort the controller; endSession sets ending.
        // A turn that invoked a tool is never joined: rerunning its request in the
        // next turn could repeat a side effect (a send, a booking). The filler can
        // finish without a frame, so `audioPlayed` alone does not rule that out.
        const cancelledSilently =
          controller.signal.aborted && !session.ending && !audioPlayed && !toolInvoked;
        await this.safePersistIncomplete(opts.persistIncomplete, session, spokenForPairing, cancelledSilently);
      }
    }
  }

  private async safePersistIncomplete(
    persistIncomplete:
      | ((spokenText: string | undefined, outcome: { cancelledSilently: boolean }) => Promise<void>)
      | undefined,
    session: ActiveSession,
    spokenText: string | undefined,
    cancelledSilently: boolean,
  ): Promise<void> {
    if (!persistIncomplete) return;
    try {
      await persistIncomplete(spokenText, { cancelledSilently });
    } catch (persistErr) {
      this.log.warn(
        { sessionId: session.sessionId, err: persistErr },
        'voice incomplete-turn persist threw',
      );
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
      turnKind: 'greeting',
      ttfaLogKey: 'voice.greeting_ttfa_ms',
      ttfaLogMessage: 'voice greeting time-to-first-audio',
      failureLogMessage: 'voice greeting turn failed',
      // No tools — keep the open short and latency-tight; outbound context is
      // already in the system prompt when present.
      withTools: false,
      assembleMessages: ({ systemPrompt, priorHistory, contactRecent }) => [
        {
          role: 'system',
          content: `${systemPrompt}\n\n${buildVoiceGreetingInstruction({
            liveTurn: session.caller.liveTurn,
            displayName: session.caller.displayName,
          })}`,
        },
        ...(contactRecent ? [{ role: 'system' as const, content: contactRecent }] : []),
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
          }, {
            // The cue is Curia's own row, not something the caller said.
            // The column is what recall and the sender backfill read, so the
            // spoken replies still come back later (#1892).
            channelId: 'voice',
            synthetic: true,
            // Condensation must not sit on the spoken-turn path (#2266).
            summarize: 'background',
          });
          try {
            await this.config.workingMemory.addTurn(session.conversationId, VOICE_HISTORY_AGENT_ID, {
              role: 'assistant',
              content: finalText,
            }, {
              channelId: 'voice',
              summarize: 'background',
            });
          } catch (assistantErr) {
            // Cue landed but the spoken reply did not — next loadTurnContext will
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
      if (controller.signal.aborted || session.ending || session.callerMuted) return;
      // A prod signal for #2379, not a filter: the sentence is still spoken.
      // Terms only — the sentence itself is call content.
      const jargon = findInternalJargon(sentence);
      if (jargon.length > 0) {
        this.log.warn({ sessionId: session.sessionId, terms: jargon }, 'voice reply named an internal component');
      }
      const ttsStreamId = `${meta.streamId}:${session.ttsSeq++}`;
      session.activeTtsStreamIds.add(ttsStreamId);
      session.ttsActive = true;
      // Chunk timing (#2379): provider latency, and the playout clock running
      // dry, which the caller hears as silence. Dry before the chunk's first
      // frame is a gap between sentences (or a tool pause after the filler);
      // dry after it means audio arrived slower than real time: choppy speech.
      const requestedAt = Date.now();
      let firstFrameAt: number | null = null;
      let gapBeforeMs = 0;
      let chunkAudioMs = 0;
      let starvedMs = 0;
      let starvedCount = 0;
      try {
        for await (const frame of this.config.tts.synthesize({
          text: sentence,
          streamId: ttsStreamId,
          voiceId: this.config.voiceId,
          sampleRate: session.publishSampleRate,
          signal: controller.signal,
        })) {
          if (controller.signal.aborted || session.ending || session.callerMuted) break;
          opts.onFirstAudio?.();
          const arrivedAt = Date.now();
          // The turn's first frame starts from silence, so only later frames can find the clock dry.
          const dryMs = session.turnAudioMs > 0 ? Math.max(0, arrivedAt - session.playoutEndsAt) : 0;
          if (firstFrameAt === null) {
            firstFrameAt = arrivedAt;
            gapBeforeMs = dryMs;
          } else if (dryMs > 0) {
            starvedMs += dryMs;
            starvedCount += 1;
          }
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
          // Barge-in can land while this frame is inside publishAudio, after its
          // clear: drop the frame again so a flushed queue stays flushed.
          if (controller.signal.aborted) {
            session.transport.clearQueuedAudio?.();
            break;
          }
          const frameMs = (frame.pcm.length / frame.channels / frame.sampleRate) * 1000;
          session.playoutEndsAt = Math.max(session.playoutEndsAt, Date.now()) + frameMs;
          session.turnAudioMs += frameMs;
          chunkAudioMs += frameMs;
        }
        // Healthy synthesis (including barge-in abort mid-stream) clears the streak.
        if (!session.ending) session.consecutiveTtsFailures = 0;
        if (firstFrameAt !== null) {
          session.audioStats.chunks += 1;
          session.audioStats.audioMs += chunkAudioMs;
          session.audioStats.gapMs += gapBeforeMs;
          session.audioStats.starvedMs += starvedMs;
          session.audioStats.starvedCount += starvedCount;
          this.log.info(
            {
              sessionId: session.sessionId,
              'voice.tts_first_byte_ms': firstFrameAt - requestedAt,
              'voice.tts_total_ms': Date.now() - requestedAt,
              'voice.tts_audio_ms': Math.round(chunkAudioMs),
              'voice.tts_gap_before_ms': Math.round(gapBeforeMs),
              'voice.tts_starved_ms': Math.round(starvedMs),
              starvedCount,
              chars: sentence.length,
              aborted: controller.signal.aborted,
            },
            'voice TTS chunk delivered',
          );
        }
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
    // text channels (#1594). Global (not voice-session-scoped): voice mint
    // conversationId = voice:${sessionId} per call, and proactive sends were
    // registered under signal:/email:/scheduler:/bullpen ids (#1817). Empty
    // result → null → prompt unchanged. Failure and deadline expiry are
    // best-effort: log and continue without the bridge (parity with dispatcher
    // failure mode + loadTurnContext latency contract).
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
    let agendaTimezone: string | undefined;
    const timezone = this.config.timezone?.trim();
    if (timezone) {
      try {
        timeContextBlock = formatTimeContextBlock(timezone, new Date());
        agendaTimezone = timezone;
      } catch (err) {
        this.log.error({ err, timezone }, 'formatTimeContextBlock failed — time context not injected into voice turn; check TIMEZONE config');
      }
    }

    return buildVoiceSystemPrompt({
      identityBlock,
      specialistRoster,
      outboundContextBlock,
      timeContextBlock,
      agendaBlock: formatAgendaPromptBlock({
        loaded: session.loadedAgendas,
        index: session.agendaIndex,
        notes: session.notes,
      }, agendaTimezone),
      audience: {
        liveTurn: session.caller.liveTurn,
        displayName: session.caller.displayName,
      },
    });
  }

  /**
   * A successful meeting-agenda-load joins the session's prompt state and is
   * appended to voice_sessions metadata. A store failure is logged and does
   * not fail the turn — the startup sweep can still settle an in_call agenda.
   */
  private async noteMeetingAgendaLoad(
    session: ActiveSession,
    result: { content: string; is_error?: boolean },
  ): Promise<void> {
    if (result.is_error) return;
    const snapshot = parseAgendaLoadResult(result.content);
    if (!snapshot) return;
    if (!session.loadedAgendas.some((agenda) => agenda.agendaId === snapshot.agendaId)) {
      session.loadedAgendas.push(snapshot);
    }
    session.agendaIndex = session.agendaIndex.filter((entry) => entry.agendaId !== snapshot.agendaId);
    const load: SessionAgendaLoad = {
      agendaId: snapshot.agendaId,
      loadedAt: new Date().toISOString(),
      snapshot,
    };
    try {
      await this.config.sessionStore.appendAgendaLoad(session.sessionId, load);
    } catch (err) {
      this.log.warn(
        { err, sessionId: session.sessionId, agendaId: snapshot.agendaId },
        'failed to record agenda load; startup sweep can recover the in_call agenda',
      );
    }
  }

  /**
   * meeting-notes-start writes the session mark itself (#2347), so its audited
   * result is the truth. A successful result joins the session's prompt state;
   * an error or an unreadable result leaves notes off.
   */
  private noteMeetingNotesStart(
    session: ActiveSession,
    result: { content: string; is_error?: boolean },
  ): void {
    if (result.is_error) return;
    try {
      const parsed = JSON.parse(result.content) as { notes_on?: unknown; recap?: unknown };
      if (parsed.notes_on === true) session.notes = { recap: parsed.recap === true };
    } catch (err) {
      this.log.warn({ err, sessionId: session.sessionId }, 'meeting-notes-start result was not JSON; notes stay off in the prompt');
    }
  }

  /**
   * Load spoken-turn context from working_memory — the same rows console chat
   * history reads — so persistence and LLM context are single-sourced (#1551).
   * Also loads contact-scoped turns from other conversations (#1599) under the
   * same deadline. Falls back to the in-process session history when no store
   * is configured, the history read fails or exceeds its deadline, or the store
   * reads back empty while the in-process copy is not (a prior addTurn write
   * failed warn-only): a degraded slim turn beats failing — or stalling — the
   * call. A timed-out or failed contact read drops only that block. Callers
   * invoke this BEFORE persisting the current utterance, so the returned turns
   * are strictly prior history.
   *
   * Every return path is passed through {@link spokenHistoryForLlm} so leftover
   * unpaired `user` rows (crash before the pairing write, a previous process)
   * cannot become two consecutive `user` messages. Barge-in, hang-up, empty
   * reply, and provider errors pair the user turn in
   * `persistIncompleteAssistantTurn` — with the heard reply when TTS already
   * spoke, otherwise the failure marker (#1776).
   */
  private async loadTurnContext(
    session: ActiveSession,
  ): Promise<{ history: Message[]; contactRecent: string | null }> {
    const fallback = (): Message[] => spokenHistoryForLlm(stringTurns(session.history));
    if (!this.config.workingMemory) return { history: fallback(), contactRecent: null };
    const timeoutMs = this.config.historyReadTimeoutMs ?? DEFAULT_HISTORY_READ_TIMEOUT_MS;
    const deadlineAt = Date.now() + timeoutMs;
    const memory = this.config.workingMemory;
    const historyRead = memory.getHistory(
      session.conversationId,
      VOICE_HISTORY_AGENT_ID,
      { maxTurns: VOICE_HISTORY_MAX_TURNS },
    );
    // A read that loses the deadline race settles later with no awaiter —
    // absorb its eventual rejection so it cannot become an unhandled rejection.
    historyRead.catch(err => {
      this.log.debug(
        { sessionId: session.sessionId, err },
        'late working-memory history read failure (turn already proceeded)',
      );
    });

    const contactId = persistableCallerContactId(session.caller.contactId);
    const recentWindow = contactRecentHistorySince(new Date(), this.config.timezone, 'voice');
    const contactRead: Promise<ContactRecentTurn[] | null> =
      contactId && typeof memory.getContactRecentHistory === 'function'
        ? memory.getContactRecentHistory({
          contactId,
          agentId: VOICE_HISTORY_AGENT_ID,
          excludeConversationId: session.conversationId,
          since: recentWindow.since,
          maxTurns: CONTACT_RECENT_HISTORY_MAX_TURNS,
        }).then(
          turns => turns,
          (err: unknown) => {
            this.log.warn(
              { sessionId: session.sessionId, err },
              'contact recent-history read failed; proceeding without it',
            );
            return null;
          },
        )
        : Promise.resolve(null);

    const [historyOutcome, contactOutcome] = await Promise.all([
      raceDeadline(historyRead, deadlineAt),
      raceDeadline(contactRead, deadlineAt),
    ]);

    let history: Message[];
    if (historyOutcome.status === 'timeout') {
      this.log.warn(
        { sessionId: session.sessionId, timeoutMs },
        'working-memory history read exceeded the voice deadline; falling back to in-process history',
      );
      history = fallback();
    } else if (historyOutcome.status === 'error') {
      this.log.warn(
        { sessionId: session.sessionId, err: historyOutcome.err },
        'failed to load voice history from working memory; falling back to in-process history',
      );
      history = fallback();
    } else {
      // A prior addTurn may have failed (warn-only), leaving the store behind
      // the in-process copy (including a store that sanitizes to empty because
      // it still ends on an unpaired user). Prefer the longer in-process copy
      // only when it continues the store as a prefix — otherwise the store
      // wins so an earlier process's turns are not dropped (#1776).
      const sanitized = spokenHistoryForLlm(historyOutcome.value);
      if (session.history.length > 0) {
        const fb = fallback();
        history = fb.length > sanitized.length && isHistoryPrefix(sanitized, fb) ? fb : sanitized;
      } else {
        history = sanitized;
      }
    }

    let contactRecent: string | null = null;
    if (contactOutcome.status === 'timeout') {
      this.log.warn(
        { sessionId: session.sessionId, timeoutMs },
        'contact recent-history read exceeded the voice deadline; proceeding without it',
      );
    } else if (contactOutcome.status === 'ok' && contactOutcome.value) {
      try {
        contactRecent = formatContactRecentHistoryBlock(contactOutcome.value, {
          timezone: this.config.timezone,
          windowLabel: recentWindow.windowLabel,
        });
      } catch (err) {
        this.log.warn(
          { sessionId: session.sessionId, err },
          'contact recent-history block failed to render; proceeding without it',
        );
      }
    }

    return { history, contactRecent };
  }

  /**
   * Pair an unpaired user turn when the assistant reply does not complete, so
   * the next spoken turn keeps the interrupted utterance as a referent
   * (#1776 / #1767). Uses the text handed to TTS when the caller heard
   * something; otherwise the LLM-failure marker (empty reply / thrown call).
   */
  private async persistIncompleteAssistantTurn(
    session: ActiveSession,
    contents: {
      inProcessContent: string;
      storedContent: string;
      spokenText?: string;
      /** False when this turn's user `addTurn` failed — do not pair an older same-text row. */
      persistToStore: boolean;
    },
  ): Promise<void> {
    const assistantContent =
      contents.spokenText && contents.spokenText.length > 0
        ? contents.spokenText
        : LLM_FAILURE_TURN_CONTENT;
    const lastInProcess = session.history[session.history.length - 1];
    if (
      lastInProcess?.role === 'user'
      && typeof lastInProcess.content === 'string'
      && lastInProcess.content === contents.inProcessContent
    ) {
      session.history.push({ role: 'assistant', content: assistantContent });
      this.trimSessionHistory(session);
    }

    if (!contents.persistToStore || !this.config.workingMemory) return;
    try {
      // Pairing check against stored content, not the sanitized rewrite (#1775).
      const history = await this.config.workingMemory.getHistory(
        session.conversationId,
        VOICE_HISTORY_AGENT_ID,
        { raw: true, maxTurns: 1 },
      );
      const last = history[history.length - 1];
      if (last?.role !== 'user') return;
      if (last.content !== contents.storedContent) {
        this.log.warn(
          { sessionId: session.sessionId },
          'voice incomplete-turn marker skipped — last user turn is not this utterance',
        );
        return;
      }
      await this.config.workingMemory.addTurn(session.conversationId, VOICE_HISTORY_AGENT_ID, {
        role: 'assistant',
        content: assistantContent,
      }, {
        channelId: 'voice',
        summarize: 'background',
      });
    } catch (err) {
      this.log.warn(
        { sessionId: session.sessionId, err },
        'failed to persist voice incomplete-turn marker — next turn may drop the unpaired user utterance',
      );
    }
  }

  /** `fragments` counts the end-of-speech pieces in `utterance`, for turn stats. */
  private async runUserTurn(
    session: ActiveSession,
    utterance: string,
    fragments: number,
    timing: UtteranceTiming | null,
  ): Promise<void> {
    // Register the turn before the preamble's awaits (bus publish, history read,
    // user-row write). Speech during them then barges in and joins this
    // utterance, instead of queuing as a second turn that answers it (#2240).
    const controller = new AbortController();
    session.currentController = controller;
    session.llmActive = true;
    const turnGap: TurnGap = { timing, startedAt: Date.now() };
    let carried = false;
    try {
      await this.runUserTurnBody(session, utterance, fragments, controller, turnGap, () => {
        carried = true;
      });
    } finally {
      this.clearTurnState(session, controller);
      if (!carried) this.recordTurnOutcome(session, fragments);
    }
  }

  private async runUserTurnBody(
    session: ActiveSession,
    utterance: string,
    fragments: number,
    controller: AbortController,
    turnGap: TurnGap,
    onCarried: () => void,
  ): Promise<void> {
    if (session.ending) return;

    // Publish the final user transcript for bus audit. The dispatcher skips
    // agent.task creation for channelId 'voice' (VoiceRuntime owns the turn).
    // Its id parents the turn's tool audit events (#1968).
    const inbound = createInboundMessage({
      conversationId: session.conversationId,
      channelId: 'voice',
      senderId: session.caller.senderId,
      content: sanitizeOutput(utterance),
    });
    // publish() rejects only before or in the audit write-ahead, so a failed publish
    // means no audit row for this id. Tool audit then parents on the session instead
    // of pointing at a missing row. The tools still run: each call's own tool.invoke is
    // written ahead, and a call whose invoke cannot be written does not run.
    let turnEventId: string | undefined = inbound.id;
    try {
      await this.config.bus.publish('channel', inbound);
    } catch (err) {
      turnEventId = undefined;
      this.log.warn(
        { sessionId: session.sessionId, err },
        'failed to publish voice inbound.message — this turn\'s tool audit parents on the session',
      );
    }

    // Single authoritative history (#1551): reload prior turns from working_memory
    // BEFORE persisting this utterance, so the current user message is appended
    // to the LLM context exactly once (turns are serialized per session, so the
    // read cannot race the write below).
    const turnContext = await this.loadTurnContext(session);
    if (session.ending) return;

    const storedUserContent = sanitizeOutput(utterance);

    // Persist user turn to working_memory so console history can show it.
    let userTurnPersisted = false;
    if (this.config.workingMemory) {
      try {
        await this.config.workingMemory.addTurn(session.conversationId, VOICE_HISTORY_AGENT_ID, {
          role: 'user',
          content: storedUserContent,
        }, {
          senderContactId: persistableCallerContactId(session.caller.contactId) ?? null,
          channelId: 'voice',
          summarize: 'background',
        });
        userTurnPersisted = true;
      } catch (err) {
        this.log.warn({ sessionId: session.sessionId, err }, 'failed to persist voice user turn to working memory');
      }
    }

    const userMessage: Message = { role: 'user', content: utterance };
    // Keep the user request in the in-process copy even if the assistant reply
    // is aborted. Continuity for the next provider call comes from pairing it
    // in persistIncomplete (heard text, or a marker if nothing was spoken) —
    // historyForLlm would otherwise drop this trailing user turn (#1776).
    session.history.push(userMessage);
    this.trimSessionHistory(session);

    await this.runAssistantTurn(session, {
      turnKind: 'user',
      ttfaLogKey: 'voice.ttfa_ms',
      ttfaLogMessage: 'voice time-to-first-audio',
      failureLogMessage: 'voice turn failed',
      priorHistory: turnContext.history,
      contactRecent: turnContext.contactRecent,
      withTools: true,
      turnEventId,
      turnGap,
      controller,
      persistIncomplete: async (spokenText, { cancelledSilently }) => {
        if (cancelledSilently) {
          // The caller spoke over a turn that had not said anything yet: they
          // had not finished. Carry the utterance into the next turn instead of
          // pairing it with a failure marker (#2240). The stored user row stays
          // unpaired; historyForLlm collapses it under the joined row. Turns are
          // serialized and the drain took any earlier carry, so this one is
          // the whole utterance.
          session.carryOver = {
            utterance,
            storedContent: storedUserContent,
            persisted: userTurnPersisted,
            fragments,
          };
          onCarried();
          this.log.debug(
            { sessionId: session.sessionId, fragments },
            'voice turn cancelled before any audio; joining it to the next utterance',
          );
          return;
        }
        await this.persistIncompleteAssistantTurn(session, {
          inProcessContent: utterance,
          storedContent: storedUserContent,
          spokenText,
          persistToStore: userTurnPersisted,
        });
      },
      assembleMessages: ({ systemPrompt, priorHistory: prior, contactRecent }) => [
        { role: 'system', content: systemPrompt },
        ...(contactRecent ? [{ role: 'system' as const, content: contactRecent }] : []),
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
          }, {
            channelId: 'voice',
            summarize: 'background',
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

  /**
   * A muted caller mic means the installed app is in the background. Stop
   * speaking immediately. End the call if it stays muted for the grace period.
   * Unmute cancels that timer; a disconnect still ends the call at once.
   */
  private handleCallerMuted(session: ActiveSession, muted: boolean): void {
    if (session.ending) return;
    if (muted) {
      session.callerMuted = true;
      if (session.currentController && !session.currentController.signal.aborted) {
        session.currentController.abort();
      }
      if (session.pauseTimer) return;
      const graceMs = this.config.pauseGraceMs ?? 120_000;
      session.pauseTimer = setTimeout(() => {
        session.pauseTimer = null;
        if (session.ending || !session.callerMuted) return;
        this.log.info({ sessionId: session.sessionId }, 'voice pause grace elapsed; ending session');
        void this.endSession(session.sessionId, 'pause_grace');
      }, graceMs);
      return;
    }
    session.callerMuted = false;
    if (session.pauseTimer) {
      clearTimeout(session.pauseTimer);
      session.pauseTimer = null;
    }
  }

  async endSession(sessionId: string, reason: string): Promise<VoiceSessionRecord | null> {
    return this.endSessionWith(sessionId, reason, false);
  }

  /**
   * End a session once, however many paths ask. Hangups race (#2379): the Signal
   * bridge fires the transport's onClose (`principal_disconnected`) and then calls
   * endSession with `remote_hangup` while the first teardown waits on pacat. The
   * first caller tears down and persists; later callers wait for it and get the
   * same record. An explicit caller's reason replaces a transport close's, so the
   * row keeps the reason the hangup's owner gave, and the ended event keeps the
   * session's turnStats.
   */
  private async endSessionWith(
    sessionId: string,
    reason: string,
    fromTransport: boolean,
  ): Promise<VoiceSessionRecord | null> {
    const ending = this.endingSessions.get(sessionId);
    if (ending) {
      if (ending.fromTransport && !fromTransport) {
        ending.reason = reason;
        ending.fromTransport = false;
      }
      return ending.done;
    }

    const live = this.sessions.get(sessionId);
    if (!live) {
      // Already ended (or never started here): the store dedupes, so no second event.
      return this.persistSessionEnd(sessionId, reason, undefined);
    }

    live.ending = true;
    this.sessions.delete(sessionId);
    let resolveDone!: (record: VoiceSessionRecord | null) => void;
    const entry: EndingSession = {
      session: live,
      reason,
      fromTransport,
      done: new Promise(resolve => {
        resolveDone = resolve;
      }),
    };
    // Registered before teardown's first step, so a re-entrant call during it
    // (an STT or TTS error fired by cancel) joins this end instead of racing it.
    this.endingSessions.set(sessionId, entry);
    let record: VoiceSessionRecord | null = null;
    try {
      try {
        await this.teardownSession(live);
      } catch (err) {
        // Persist the end anyway: a row left active would never close.
        this.log.error({ sessionId, err }, 'voice session teardown failed; persisting the end anyway');
      }
      record = await this.persistSessionEnd(sessionId, entry.reason, live);
      return record;
    } finally {
      this.endingSessions.delete(sessionId);
      resolveDone(record);
    }
  }

  /** Stop the session's media and pair any carried-over utterance. Never throws. */
  private async teardownSession(session: ActiveSession): Promise<void> {
    const sessionId = session.sessionId;
    this.logAudioSummary(session);
    if (session.holdTimer) {
      clearTimeout(session.holdTimer);
      session.holdTimer = null;
    }
    if (session.pauseTimer) {
      clearTimeout(session.pauseTimer);
      session.pauseTimer = null;
    }
    // Taken in the same tick as `ending` is set, so a drain that runs later
    // finds nothing to join; paired below rather than left unpaired.
    const carry = session.carryOver;
    session.carryOver = null;

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
    // Skipped for externally-supplied transports (#1672): there is no
    // LiveKit room this runtime created, so nothing to delete.
    if (this.config.deleteRoom && !session.externalTransport) {
      try {
        await this.config.deleteRoom(session.roomName);
      } catch (err) {
        this.log.warn({ sessionId, roomName: session.roomName, err }, 'failed to delete LiveKit room after session end');
      }
    }

    // A silently cancelled utterance the caller never continued: pair its
    // stored row so the next call's history keeps the request (#2240).
    if (carry) {
      await this.pairCarriedUtterance(session, carry);
    }
  }

  /**
   * One line per call for diagnosing choppy audio (#2379): TTS delivery totals,
   * and event-loop delay over the call (Curia shares its host with LiveKit and
   * the Signal bridge; a stalled loop delays every audio frame).
   */
  private logAudioSummary(session: ActiveSession): void {
    const loop = session.loopDelay;
    loop.disable();
    const nsToMs = (ns: number): number => Math.round(ns / 1e4) / 100;
    const stats = session.audioStats;
    this.log.info(
      {
        sessionId: session.sessionId,
        'voice.tts_chunks': stats.chunks,
        'voice.tts_audio_ms': Math.round(stats.audioMs),
        'voice.tts_gap_ms': Math.round(stats.gapMs),
        'voice.tts_starved_ms': Math.round(stats.starvedMs),
        'voice.tts_starved_count': stats.starvedCount,
        // NaN until the histogram has a sample (a call shorter than one tick).
        'voice.loop_delay_p50_ms': loop.count > 0 ? nsToMs(loop.percentile(50)) : null,
        'voice.loop_delay_p99_ms': loop.count > 0 ? nsToMs(loop.percentile(99)) : null,
        'voice.loop_delay_max_ms': loop.count > 0 ? nsToMs(loop.max) : null,
      },
      'voice session audio summary',
    );
  }

  private async persistSessionEnd(
    sessionId: string,
    reason: string,
    session: ActiveSession | undefined,
  ): Promise<VoiceSessionRecord | null> {
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
            ...(session ? { turnStats: { ...session.turnStats } } : {}),
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
