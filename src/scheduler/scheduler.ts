import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { EventBus } from '../bus/bus.js';
import type { Logger } from '../logger.js';
import type { SchedulerService } from './scheduler-service.js';
import type { AgentYamlConfig } from '../agents/loader.js';
import {
  createScheduleFired,
  createScheduleSuspended,
  createScheduleRecovered,
  createScheduleDriftPaused,
  createAgentTask,
} from '../bus/events.js';
import type { AgentResponseEvent, AgentErrorEvent, AgentTaskEvent, ScheduleFiredEvent } from '../bus/events.js';
import { makeWakeContext } from '../autonomy/effective-standing.js';
import type { DriftDetector } from './drift-detector.js';
import type { DreamEngine } from '../memory/dream-engine.js';
import type { JobRow } from './scheduler-service.js';
import type { OutboundContextService } from '../dispatch/outbound-context.js';
import { classifyError } from '../errors/classify.js';
import { findTemplateTokens } from '../skills/_shared/placeholder-guard.js';
import { isUuid } from '../util/uuid.js';
import type { TaskOriginator } from '../contacts/types.js';
import {
  formatDelegationRetryWakeContent,
  readDelegationRetryWake,
} from '../agents/deferred-delegation.js';

// Poll every 30 seconds for due jobs.
export const POLL_INTERVAL_MS = 30_000;

/**
 * Default cap on scheduler-started agent runs executing at once (#1160).
 * 8 is headroom above the observed production peak of 6, so the busiest day
 * in that sample does not shed load. Growth past 8 is what the cap bounds.
 */
export const DEFAULT_MAX_IN_FLIGHT = 8;

// Watchdog runs every 5 minutes to detect jobs stuck mid-run.
export const WATCHDOG_INTERVAL_MS = 5 * 60 * 1000;

// Outbound context cleanup runs daily to purge expired and released rows.
export const OUTBOUND_CONTEXT_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Default assumed duration for a job with no explicit expectedDurationSeconds.
const DEFAULT_EXPECTED_DURATION_SECONDS = 600; // 10 minutes

// Timeout = min(expected × MULTIPLIER, expected + CAP). Gives larger headroom for
// short jobs while capping the maximum extension at +60 minutes for long ones.
//   2m expected → 15m timeout;  30m expected → 90m timeout.
const RECOVERY_TIMEOUT_MULTIPLIER = 7.5;
const RECOVERY_TIMEOUT_CAP_SECONDS = 3600;

// Hard caps on the prior-run fields injected into agent.task content (#243).
//
// NOTE: this is currently the ONLY cap, not a backstop. `scheduler-report` was meant to
// be the write-time boundary, but its handler validates only presence of job_id/summary
// and its manifest declares `context` as a bare `object?` — nothing bounds what gets
// written. So an agent can write a 20 KB blob, be told `success: true`, and have it cut
// here a day later. Other readers of the same columns are still unbounded — the drift
// detector and `ops-lookup` both pass the raw `lastRunSummary` to an LLM.
// @TODO: add a write-time cap in scheduler-report so the agent learns at write time.
//
// Exported for unit testing.
export const MAX_PRIOR_SUMMARY_CHARS = 2_000;
export const MAX_PRIOR_CONTEXT_CHARS = 4_000;

// Per-value budget when reducing an oversized context object. A value that serialises
// within this is kept verbatim, so the small scalars that carry continuity state — an
// offset cursor, a count, a flag — always survive. Anything larger becomes a marker.
export const MAX_PRIOR_CONTEXT_VALUE_CHARS = 160;

// Base name for the metadata key added to a reduced context when keys had to be dropped.
// last_run_context is opaque JSONB written from caller-supplied context, so this name is
// not reserved — a caller can legitimately hold it. See pickOmissionKey.
const CONTEXT_OMITTED_KEY = '__truncated__';

// Marker appended to any value that had to be cut. Its length is counted *against* the
// cap rather than added on top, so a truncated value never exceeds its own limit.
// Exported for unit testing.
export const TRUNCATED_MARKER = '…[truncated]';

/** A truncation that happened while building the block, for the caller to log. */
interface TruncationRecord {
  field: 'lastRunSummary' | 'lastRunContext';
  originalChars: number;
  cappedAt: number;
  /** Top-level keys whose value was replaced by an elision marker (context only). */
  elidedValues?: number;
  /** Top-level keys (or array entries) dropped outright — unrecoverable, worth alerting on. */
  omittedKeys?: number;
}

/**
 * Cut prose to `maxChars` and mark it, so a reader can tell it is a fragment rather than
 * silently receiving a partial summary as if it were the whole thing.
 *
 * NOTE: `slice` counts UTF-16 code units, so a cut can split a surrogate pair (an emoji)
 * and falls short of the intent for CJK content. Acceptable for a size guard on prose.
 */
function truncateText(
  value: string,
  maxChars: number,
  field: TruncationRecord['field'],
  into: TruncationRecord[],
): string {
  if (value.length <= maxChars) return value;
  into.push({ field, originalChars: value.length, cappedAt: maxChars });
  // Reserve room for the marker rather than appending past the cap. The marker is itself
  // sliced so an absurdly small cap still yields a string within it.
  const contentLimit = Math.max(0, maxChars - TRUNCATED_MARKER.length);
  return `${value.slice(0, contentLimit)}${TRUNCATED_MARKER.slice(0, maxChars)}`;
}

/** Replace a value with a marker when its serialised form exceeds the per-value budget. */
function elideValue(value: unknown): { out: unknown; elided: boolean } {
  const serialised = JSON.stringify(value) ?? 'null';
  if (serialised.length <= MAX_PRIOR_CONTEXT_VALUE_CHARS) return { out: value, elided: false };
  return { out: `…[elided ${serialised.length} chars]`, elided: true };
}

/**
 * Pick a metadata key for the omission count that no caller key already occupies, suffixing
 * until it is free. Uses hasOwnProperty so an inherited name (e.g. 'constructor') cannot
 * push it into a needless suffix.
 */
function pickOmissionKey(reduced: Record<string, unknown>): string {
  let key = CONTEXT_OMITTED_KEY;
  for (let n = 2; Object.prototype.hasOwnProperty.call(reduced, key); n++) {
    key = `${CONTEXT_OMITTED_KEY}${n}`;
  }
  return key;
}

/**
 * Serialise a prior-run context, reducing it per-value rather than cutting the serialised
 * string. The result is always valid JSON and always within `maxChars`.
 *
 * Cutting the string would drop whatever sorts last, and `JSON.stringify` emits keys in
 * insertion order — so a verbose key written before a cursor takes the cursor with it.
 * That matters because `last_run_context` carries continuity state (spec 05 §"Contacts
 * promotion sweep batching" persists the sweep's offset there) and no skill reads the
 * column back — `scheduler-list` deliberately omits it. A cut cursor is therefore
 * unrecoverable, and would surface only as a sweep that re-scans the same batch forever.
 *
 * Reduction is two-stage, each stage recorded in `into` so the caller can log it:
 *   1. Replace over-budget values with `…[elided N chars]`, keeping every entry.
 *   2. Only if that still overflows (very many entries), drop entries from the tail and
 *      count them. This stage can lose a cursor; stage 1 cannot.
 *
 * The column is JSONB, so despite the `Record<string, unknown>` type it can hold an array
 * or a scalar at runtime. Arrays get the same two-stage treatment element-wise; a scalar
 * has no structure to preserve, so it keeps a prefix inside a valid JSON string.
 */
function truncateContext(
  context: Record<string, unknown>,
  maxChars: number,
  into: TruncationRecord[],
): string {
  const full = JSON.stringify(context, null, 2);
  if (full.length <= maxChars) return full;

  // --- Scalar: nothing structural to keep, so keep a prefix as a valid JSON string. ---
  if (typeof context !== 'object' || context === null) {
    into.push({ field: 'lastRunContext', originalChars: full.length, cappedAt: maxChars });
    const text = typeof context === 'string' ? context : String(context);
    // Escaping can expand the result past the cap (quotes, newlines, control chars),
    // so shrink until the *serialised* form fits rather than assuming a fixed overhead.
    let budget = Math.max(0, maxChars - TRUNCATED_MARKER.length - 2);
    let out = JSON.stringify(`${text.slice(0, budget)}${TRUNCATED_MARKER}`);
    while (out.length > maxChars && budget > 0) {
      budget = Math.floor(budget / 2);
      out = JSON.stringify(`${text.slice(0, budget)}${TRUNCATED_MARKER}`);
    }
    return out;
  }

  // --- Array: reduce element-wise, then shed from the tail. ---
  if (Array.isArray(context)) {
    const reduced: unknown[] = [];
    let elidedValues = 0;
    for (const value of context) {
      const { out, elided } = elideValue(value);
      reduced.push(out);
      if (elided) elidedValues++;
    }

    let omittedEntries = 0;
    let out = JSON.stringify(reduced, null, 2);
    while (out.length > maxChars && reduced.length > 0) {
      reduced.pop();
      omittedEntries++;
      out = JSON.stringify([...reduced, `…[${omittedEntries} entries omitted]`], null, 2);
    }

    into.push({
      field: 'lastRunContext',
      originalChars: full.length,
      cappedAt: maxChars,
      elidedValues,
      omittedKeys: omittedEntries,
    });
    return out;
  }

  // --- Object: reduce per key, then shed keys from the tail. ---
  // Null-prototype target: pg parses JSONB with JSON.parse, which creates `__proto__` as an
  // own data property. Assigning that onto a plain `{}` would invoke the legacy prototype
  // setter instead of creating a property, so the key would vanish here while a context
  // under the cap kept it — the same data surviving or not depending on its size.
  const reduced = Object.create(null) as Record<string, unknown>;
  let elidedValues = 0;
  for (const [key, value] of Object.entries(context)) {
    const { out, elided } = elideValue(value);
    reduced[key] = out;
    if (elided) elidedValues++;
  }

  // Settle on a metadata key that cannot collide with caller data before shedding starts.
  // Writing the count over a caller's own '__truncated__' would destroy exactly the
  // continuity state this reduction exists to preserve.
  const omissionKey = pickOmissionKey(reduced);

  // Earliest keys are likeliest to be the stable ones, so shed from the tail.
  const keys = Object.keys(reduced);
  let omittedKeys = 0;
  let out = JSON.stringify(reduced, null, 2);
  while (out.length > maxChars && keys.length > 0) {
    delete reduced[keys.pop()!];
    omittedKeys++;
    reduced[omissionKey] = `${omittedKeys} keys omitted`;
    out = JSON.stringify(reduced, null, 2);
  }

  into.push({
    field: 'lastRunContext',
    originalChars: full.length,
    cappedAt: maxChars,
    elidedValues,
    omittedKeys,
  });
  return out;
}

/**
 * Strip scheduler-owned diagnostics keys from last_run_context before injecting
 * it into the next run's prompt (#1830). `failedSkills` is operator visibility —
 * feeding it back would make the model re-litigate yesterday's tool errors
 * (and could smuggle unsanitised third-party error text into the prompt).
 * Continuity keys written by scheduler-report are preserved.
 */
function contextForPriorRunPrompt(context: unknown): unknown {
  if (typeof context !== 'object' || context === null || Array.isArray(context)) {
    return context;
  }
  const rest: Record<string, unknown> = { ...(context as Record<string, unknown>) };
  delete rest['failedSkills'];
  delete rest['failedSkillsOmitted'];
  return Object.keys(rest).length > 0 ? rest : null;
}

/**
 * Build a structured text block summarising the previous run's outcome.
 * Injected into the agent.task content so the agent can avoid repeating work
 * or adjust its approach based on what happened last time.
 *
 * Both prior-run fields are size-capped — see MAX_PRIOR_SUMMARY_CHARS / MAX_PRIOR_CONTEXT_CHARS.
 * `failedSkills` / `failedSkillsOmitted` are stripped before injection (#1830).
 *
 * Returns an empty string when there is no prior-run data (first run ever).
 */
function buildPriorRunBlock(job: JobRow, truncations: TruncationRecord[] = []): string {
  if (!job.lastRunOutcome) return '';

  const lastRanStr = job.lastRunAt
    ? new Date(job.lastRunAt).toLocaleString('en-CA', { timeZone: job.timezone, dateStyle: 'short', timeStyle: 'short' })
    : job.lastRunOutcome === 'timed_out'
      ? 'no completion recorded (timed out)'
      : 'no completion recorded';

  const parts: string[] = [
    `[Prior run context — ${lastRanStr}]`,
    `Outcome: ${job.lastRunOutcome}`,
  ];

  if (job.lastRunSummary) {
    parts.push(`Summary: ${truncateText(job.lastRunSummary, MAX_PRIOR_SUMMARY_CHARS, 'lastRunSummary', truncations)}`);
  }

  // `!= null`, not truthiness: last_run_context is JSONB and accepts 0, false and "".
  // The row loader preserves those (`?? null` only collapses null/undefined), so a
  // truthiness check here would silently drop continuity state that was really written.
  // Strip failedSkills* first — diagnostics-only, not prompt input (#1830 review).
  const priorContext = contextForPriorRunPrompt(job.lastRunContext);
  if (priorContext != null) {
    parts.push(
      `Agent context: ${truncateContext(
        priorContext as Record<string, unknown>,
        MAX_PRIOR_CONTEXT_CHARS,
        truncations,
      )}`,
    );
  }

  return parts.join('\n');
}

/**
 * Resolve runtime template placeholders in a scheduled job's agent.task content.
 *
 * Agent system prompts get `${principal_contact_id}` resolved by
 * `interpolateRuntimeContext()` (src/agents/loader.ts) at bootstrap. Scheduled-job
 * payloads are authored in the same voice — the `schedule:` block in agents/calendar.yaml
 * sits a few hundred lines below a system prompt that does resolve the token — but nothing
 * interpolated them on the way to the bus, so the model received the literal text and
 * copied it straight into `contactId` tool arguments, which were then rejected as
 * non-UUIDs (#1800).
 *
 * Runs on the serialised content rather than the payload object so it covers both payload
 * shapes (top-level spread and the nested `task_payload` of a task-bound job) in one pass.
 * That is safe because the only substituted value is a UUID-format string: it survives
 * JSON encoding unchanged, so replacing inside the JSON text cannot produce invalid JSON.
 *
 * An unavailable or malformed principal ID substitutes the empty string, matching
 * `interpolateRuntimeContext`. Leaving the token in place would simply re-deliver the bug
 * this function exists to fix; the caller logs the substitution either way.
 *
 * Exported for unit testing.
 */
export function interpolateTaskContent(
  content: string,
  principalContactId: string | undefined,
): { content: string; principalReplacements: number; principalResolved: boolean; unresolvedTokens: string[] } {
  // Same defense-in-depth UUID check as interpolateRuntimeContext: never let a value from
  // outside the UUID-generating path become free text inside a model-visible payload.
  const resolved = isUuid(principalContactId) ? (principalContactId ?? '') : '';
  // Reports what was actually substituted, not merely whether an argument was supplied —
  // a malformed ID is as unusable as a missing one and must warn the same way.
  const principalResolved = resolved !== '';

  let principalReplacements = 0;
  // Regex literals are constructed per call, so no /g lastIndex state is shared.
  const out = content.replace(/\$\{principal_contact_id\}/g, () => {
    principalReplacements++;
    return resolved;
  });

  // Any other `${...}` token is a payload nothing will ever resolve. The text is passed
  // through unchanged — we do not guess at a value — and surfaced to the caller, so the
  // next instance of this bug class is a log line rather than a month of degraded runs.
  //
  // Shares findTemplateTokens() with the skill input guard and the manifest scan so all
  // three agree on what counts as a token; a local regex here previously matched only
  // `[a-z_]+` and so missed any name containing a digit.
  const unresolvedTokens = findTemplateTokens(out);

  return { content: out, principalReplacements, principalResolved, unresolvedTokens };
}

/**
 * Compute the recovery timeout for a job given its expected duration.
 * Exported for unit testing; the SQL query in recoverStuckJobs() mirrors this formula.
 */
export function computeRecoveryTimeout(expectedDurationSeconds: number): number {
  return Math.min(
    expectedDurationSeconds * RECOVERY_TIMEOUT_MULTIPLIER,
    expectedDurationSeconds + RECOVERY_TIMEOUT_CAP_SECONDS,
  );
}

/**
 * True when a job's payload is the contentless wake envelope `{"type":"task-wake"}`
 * produced by wake_at / SchedulerService.enqueueTaskWake. Such payloads carry no task
 * description (the real intent lives in intent_anchor and the linked task row), so they
 * must be excluded from drift detection — see the guard in handleCompletion (#1064).
 *
 * Accepts `unknown` and null-checks before dereferencing: although job.taskPayload is typed
 * Record<string, unknown>, it ultimately comes from DB JSONB. The column is NOT NULL, but a
 * JSON-null literal (distinct from SQL NULL) can still round-trip to JS `null`, so reading
 * `['type']` off it unguarded would throw a TypeError inside the drift-check guard — where
 * handleCompletion's outer try/catch would swallow it and skip completeJobRun, stranding the
 * run in 'running' until watchdog recovery. Anything that isn't a non-null object is "not a
 * task-wake envelope" → false.
 */
function isTaskWakePayload(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) return false;
  return (payload as Record<string, unknown>)['type'] === 'task-wake';
}

export interface SchedulerConfig {
  pool: Pool;
  bus: EventBus;
  logger: Logger;
  schedulerService: SchedulerService;
  /** Optional drift detector — when absent, the drift check is skipped entirely. */
  driftDetector?: DriftDetector;
  /** Dream engine for background KG maintenance. When absent, no background decay runs. */
  dreamEngine?: DreamEngine;
  /** Outbound context service — when present, expired/released rows are purged daily and at startup. */
  outboundContextService?: OutboundContextService;
  /** Assumed task duration for jobs with no explicit expectedDurationSeconds.
   *  Sourced from config.scheduler.defaultExpectedDurationSeconds. Default: 600. */
  defaultExpectedDurationSeconds?: number;
  /** The principal's contact ID, resolved once at bootstrap from
   *  contactService.findContactBySystemRole('principal') — the same value agents receive
   *  via interpolateRuntimeContext. Substituted into `${principal_contact_id}` in job
   *  payloads at fire time (#1800). Undefined in setup-required mode (no principal yet),
   *  in which case the token resolves to an empty string and the fire is logged. */
  principalContactId?: string;
  /** Max agent runs this process will have in flight. Default: DEFAULT_MAX_IN_FLIGHT.
   *  Sourced from config.scheduler.maxInFlight. */
  maxInFlight?: number;
}

type FireOutcome = 'dispatched' | 'skipped' | 'saturated';

export class Scheduler {
  private pool: Pool;
  private bus: EventBus;
  private logger: Logger;
  private schedulerService: SchedulerService;
  private driftDetector?: DriftDetector;
  private dreamEngine?: DreamEngine;
  private outboundContextService?: OutboundContextService;
  private defaultExpectedDurationSeconds: number;
  private principalContactId?: string;
  private readonly maxInFlight: number;
  /** Seeds dispatcher routing for a delegation-retry wake in the original conversation. */
  private externalRoutingRegistrar?: (
    taskEventId: string,
    routing: {
      channelId: string;
      conversationId: string;
      senderId: string;
      originator: TaskOriginator;
    },
  ) => void;
  /** Runs whose publish has been handed off and has not settled. */
  private inFlight = 0;
  /** Settling handles so tests can wait out a detached publish. */
  private inFlightRuns = new Set<Promise<void>>();
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private watchdogHandle: ReturnType<typeof setInterval> | null = null;
  private cleanupHandle: ReturnType<typeof setInterval> | null = null;

  // Maps the agent.task event ID back to the job ID so we can match
  // agent.response / agent.error events to the originating scheduled job.
  private pendingJobs = new Map<string, string>();

  // agent.error arrives before agent.response(isError) on failure paths. Stash the
  // structured error message here so the response subscriber can complete the job
  // with both the real message and failedSkills (#1830 follow-on).
  private pendingFailureMessages = new Map<string, string>();

  // Tracks burst counts per job for checkEveryNBursts support.
  // In-memory only — resets on process restart (a missed check is not a security failure).
  private burstCounts = new Map<string, number>();

  /** Timestamp of the most recent pollDueJobs tick. Null until the first tick runs.
   *  Read by HealthService to detect a stalled scheduler. Stamped on the 30s poll
   *  cadence (POLL_INTERVAL_MS), not the 5-min watchdog — the watchdog interval is
   *  slower than scheduler_max_tick_s, which flapped the liveness check to 'fail'
   *  for ~3 of every 5 minutes on an otherwise healthy scheduler (#1359). */
  public lastTickAt: Date | null = null;

  constructor(config: SchedulerConfig) {
    this.pool = config.pool;
    this.bus = config.bus;
    this.logger = config.logger;
    this.schedulerService = config.schedulerService;
    this.driftDetector = config.driftDetector;
    this.dreamEngine = config.dreamEngine;
    this.outboundContextService = config.outboundContextService;
    this.defaultExpectedDurationSeconds = config.defaultExpectedDurationSeconds ?? DEFAULT_EXPECTED_DURATION_SECONDS;
    this.principalContactId = config.principalContactId;
    const maxInFlight = config.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;
    if (!Number.isInteger(maxInFlight) || maxInFlight < 1) {
      throw new Error(`scheduler maxInFlight must be a positive integer, got: ${String(maxInFlight)}`);
    }
    this.maxInFlight = maxInFlight;
  }

  /**
   * Called once the dispatcher exists. A deferred delegation wakes in the
   * originating conversation, which the dispatcher never saw arrive (#1893).
   */
  setExternalRoutingRegistrar(registrar: NonNullable<Scheduler['externalRoutingRegistrar']>): void {
    this.externalRoutingRegistrar = registrar;
  }

  /**
   * Start the scheduler loop.
   * Sets up bus subscribers for completion tracking, then starts the polling interval.
   */
  start(): void {
    // Subscribe to agent.response on system layer to track completions.
    // Both success and isError responses complete the job here. Failure paths emit
    // agent.error first (stashed below) then agent.response(isError) with failedSkills;
    // completing on the response means a run that dies mid-tooling still records what
    // failed (#1830 follow-on). agent.error alone does not complete — every runtime
    // failure path also emits a response.
    this.bus.subscribe('agent.response', 'system', (event) => {
      const responseEvent = event as AgentResponseEvent;
      if (!responseEvent.parentEventId) return;

      const parentEventId = responseEvent.parentEventId;
      const failedSkills = responseEvent.payload.failedSkills;
      const failedSkillsOmitted = responseEvent.payload.failedSkillsOmitted;

      if (responseEvent.payload.isError) {
        const stashed = this.pendingFailureMessages.get(parentEventId);
        this.pendingFailureMessages.delete(parentEventId);
        if (stashed === undefined) {
          // Invariant broken: every runtime failure path should have published
          // agent.error first. Falling back to response content loses the
          // structured cause (often the generic LLM_FAILURE_USER_MESSAGE).
          this.logger.warn(
            { parentEventId },
            'scheduler: agent.response(isError) arrived with no preceding agent.error — last_error will use response content',
          );
        }
        const errorMessage =
          stashed
          ?? (responseEvent.payload.content.slice(0, 500) || 'Agent error');
        this.handleCompletion(
          parentEventId,
          false,
          errorMessage,
          undefined,
          failedSkills,
          failedSkillsOmitted,
        ).catch((err) => {
          this.logger.error({ err, parentEventId }, 'Unhandled error in handleCompletion (error-response path)');
        });
        return;
      }

      this.pendingFailureMessages.delete(parentEventId);
      // Pass the agent's final text as a fallback summary (truncated to 500 chars).
      // completeJobRun() writes it via COALESCE — agent-provided scheduler-report wins.
      const autoSummary = responseEvent.payload.content.slice(0, 500) || undefined;
      this.handleCompletion(
        parentEventId,
        true,
        undefined,
        autoSummary,
        failedSkills,
        failedSkillsOmitted,
      ).catch((err) => {
        this.logger.error({ err, parentEventId }, 'Unhandled error in handleCompletion (success path)');
      });
    });

    // agent.error: stash the structured message for the paired agent.response(isError).
    // Do not complete here — completing early would clear pendingJobs before the response
    // arrives with failedSkills, leaving a failed run with no tool-failure visibility.
    this.bus.subscribe('agent.error', 'system', (event) => {
      const errorEvent = event as AgentErrorEvent;
      if (errorEvent.parentEventId && this.pendingJobs.has(errorEvent.parentEventId)) {
        this.pendingFailureMessages.set(
          errorEvent.parentEventId,
          errorEvent.payload.message,
        );
      }
    });

    this.intervalHandle = setInterval(() => {
      this.pollDueJobs().catch((err) => {
        this.logger.error({ err }, 'Unhandled error in pollDueJobs');
      });
    }, POLL_INTERVAL_MS);

    // Watchdog: periodically recover jobs that got stuck in 'running' state.
    // Liveness (lastTickAt) is stamped by pollDueJobs, not here — see its comment.
    this.watchdogHandle = setInterval(() => {
      this.recoverStuckJobs().catch((err) => {
        this.logger.error({ err }, 'Unhandled error in recoverStuckJobs watchdog');
      });
      // Reclaim burst counters for jobs that went terminal without the poller
      // observing it (cancel/delete/suspend all mutate the DB directly) (#1664).
      this.pruneStaleBurstCounts().catch((err) => {
        this.logger.error({ err }, 'Unhandled error in pruneStaleBurstCounts watchdog');
      });
    }, WATCHDOG_INTERVAL_MS);

    // Dream engine — background KG maintenance (decay, and future passes).
    if (this.dreamEngine) {
      this.dreamEngine.start();
    }

    // Outbound context cleanup — purge expired and released rows.
    // Run once at startup to clear any rows that expired while the service was down,
    // then schedule the interval for ongoing daily maintenance.
    if (this.outboundContextService) {
      this.runOutboundContextCleanup();
      this.cleanupHandle = setInterval(() => {
        this.runOutboundContextCleanup();
      }, OUTBOUND_CONTEXT_CLEANUP_INTERVAL_MS);
    }

    this.logger.info({ intervalMs: POLL_INTERVAL_MS, maxInFlight: this.maxInFlight }, 'Scheduler started');
  }

  /**
   * Stop the scheduler loop.
   */
  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    if (this.watchdogHandle) {
      clearInterval(this.watchdogHandle);
      this.watchdogHandle = null;
    }
    if (this.cleanupHandle) {
      clearInterval(this.cleanupHandle);
      this.cleanupHandle = null;
    }
    if (this.dreamEngine) {
      this.dreamEngine.stop();
    }
    this.logger.info('Scheduler stopped');
  }

  /**
   * Delete expired and released outbound context rows and log the result.
   * Called at startup and then on the daily interval via cleanupHandle.
   *
   * The explicit guard prevents a synchronous throw from escaping the Promise
   * chain in case the method is ever called outside its guarded call sites.
   */
  private runOutboundContextCleanup(): void {
    if (!this.outboundContextService) return;
    this.outboundContextService.cleanupExpired()
      .then((deletedCount) => {
        this.logger.info({ deletedCount }, 'Outbound context cleanup complete');
      })
      .catch((err: unknown) => {
        const agentErr = classifyError(err, 'outbound-context-cleanup');
        this.logger.error({ err: agentErr, service: 'outboundContext' }, 'Outbound context cleanup failed');
      });
  }

  /**
   * Poll for due jobs and hand each claimed job to the bounded runner.
   * Public for testing — normally called by the interval.
   *
   * Mutual exclusion is the atomic claim UPDATE in fireJob, guarded on
   * `status IN ('pending','failed')` and, for cron, `next_run_at <= now()`
   * (#1124, #1159). That predicate is what makes overlapping polls and multiple
   * scheduler processes safe. A `FOR UPDATE SKIP LOCKED` on this read would
   * release as soon as the SELECT returned — before the claim — so it is not
   * used. The read is a plain SELECT with `LIMIT` = free slots.
   *
   * Agent runs are not awaited. Each successful claim reserves one in-flight
   * slot and publishes on a detached promise, so this method returns without
   * waiting on the agent even when a run lasts minutes. The cap
   * (`scheduler.maxInFlight`, default 8) bounds how many of those runs execute
   * at once. The slot is released when publish settles, or when the watchdog
   * recovery timeout elapses if the run is still going. When no slot is free
   * the poll claims nothing; due jobs stay pending for the next tick.
   *
   * Stamps lastTickAt on every call, before the query — this is the scheduler's actual
   * 30s liveness cadence, read by HealthService's checkScheduler (#1359). Stamped even
   * if the query below fails, so a transient DB hiccup doesn't itself read as a stalled
   * scheduler — the poll loop running at all is the signal, not query success.
   */
  async pollDueJobs(): Promise<void> {
    this.lastTickAt = new Date();
    const slots = this.maxInFlight - this.inFlight;
    if (slots <= 0) {
      await this.logInFlightCap('scheduler: in-flight cap reached; leaving due jobs for the next poll');
      return;
    }
    try {
      const sql = `
        SELECT sj.*,
               t.id AS agent_task_id,
               t.intent_anchor,
               t.progress,
               t.error_budget AS task_error_budget,
               t.tags AS task_tags,
               t.title AS task_title
          FROM scheduled_jobs sj
          LEFT JOIN tasks t ON sj.task_id = t.id
         WHERE sj.status IN ('pending', 'failed')
           AND sj.next_run_at <= now()
         ORDER BY sj.next_run_at ASC
         LIMIT $1
      `;
      const { rows } = await this.pool.query(sql, [slots]);
      let dispatched = 0;

      for (const row of rows) {
        // Map the snake_case DB row to the camelCase JobRow shape.
        const job: JobRow = {
          id: row.id,
          agentId: row.agent_id,
          cronExpr: row.cron_expr,
          runAt: row.run_at,
          taskPayload: row.task_payload,
          status: row.status,
          lastRunAt: row.last_run_at,
          nextRunAt: row.next_run_at,
          lastError: row.last_error,
          consecutiveFailures: row.consecutive_failures,
          createdBy: row.created_by,
          createdAt: row.created_at,
          timezone: row.timezone as string,
          agentTaskId: row.agent_task_id ?? null,
          intentAnchor: row.intent_anchor ?? null,
          progress: row.progress ?? null,
          taskErrorBudget: row.task_error_budget ?? null,
          taskTags: row.task_tags ?? null,
          taskTitle: row.task_title ?? null,
          runStartedAt: row.run_started_at ?? null,
          expectedDurationSeconds: row.expected_duration_seconds ?? null,
          lastRunOutcome: row.last_run_outcome ?? null,
          lastRunSummary: row.last_run_summary ?? null,
          lastRunContext: row.last_run_context ?? null,
          // pg returns JSONB as a plain object; null for pre-040 rows only.
          originator: row.originator ?? null,
        };
        try {
          const outcome = await this.fireJob(job);
          if (outcome === 'saturated') {
            // A slot freed between the SELECT and here is picked up next tick.
            // Rows from here on stay pending — claiming them would start the
            // watchdog clock before the agent runs.
            await this.logInFlightCap('scheduler: in-flight cap reached; leaving remaining due jobs unclaimed');
            break;
          }
          if (outcome === 'dispatched') dispatched += 1;
        } catch (err) {
          // Claim/build failures only. A detached publish rejection reverts
          // itself inside dispatchPublish — fireJob has already returned.
          await this.revertFailedFire(job.id, err);
        }
      }

      if (dispatched > 0) {
        this.logger.info({ count: dispatched }, 'Polled and fired due jobs');
      }
    } catch (err) {
      this.logger.error({ err }, 'Error polling due jobs');
    }
  }

  /**
   * info, not debug: prod runs at LOG_LEVEL=info, so a debug line would never
   * be seen. Saturation is the signal that distinguishes a lateness regression
   * caused by the cap from the model simply getting slower (#1160).
   * `deferred` is how many due rows are still pending, not merely that the
   * cap was reached.
   */
  private async logInFlightCap(message: string): Promise<void> {
    const deferred = await this.countDueJobs();
    this.logger.info(
      { inFlight: this.inFlight, maxInFlight: this.maxInFlight, deferred },
      message,
    );
  }

  private async countDueJobs(): Promise<number | undefined> {
    try {
      const { rows } = await this.pool.query<{ due: number }>(
        `SELECT count(*)::int AS due
           FROM scheduled_jobs
          WHERE status IN ('pending', 'failed')
            AND next_run_at <= now()`,
      );
      return rows[0]?.due;
    } catch (err) {
      this.logger.error({ err }, 'scheduler: failed to count due jobs while at the in-flight cap');
      return undefined;
    }
  }

  /**
   * Claim one job and hand its publish to the bounded runner.
   *
   * Reserves an in-flight slot before any await so overlapping polls cannot
   * both pass the cap. The slot is released here unless the publish was handed
   * off, in which case dispatchPublish releases it when the run settles or
   * the recovery timeout elapses.
   *
   * Returns `saturated` without claiming when the cap is full. Due jobs stay
   * pending for the next poll.
   */
  private async fireJob(job: JobRow): Promise<FireOutcome> {
    if (this.inFlight >= this.maxInFlight) return 'saturated';
    this.inFlight += 1;
    try {
      const outcome = await this.claimAndDispatch(job);
      if (outcome !== 'dispatched') this.inFlight -= 1;
      return outcome;
    } catch (err) {
      this.inFlight -= 1;
      throw err;
    }
  }

  /**
   * Claim a single job and build its events. The caller owns the in-flight slot.
   *
   * For persistent tasks (linked agent_task), includes progress and task_payload
   * in content for agent context. The intent anchor is passed separately in the
   * event payload so the runtime can inject it into the system prompt as a
   * non-negotiable behavioral instruction.
   */
  private async claimAndDispatch(job: JobRow): Promise<Exclude<FireOutcome, 'saturated'>> {
    // Atomically claim the job by setting status to 'running' only if it's still
    // in a claimable state. The rowCount check prevents double-firing if another
    // scheduler instance (or overlapping poll) claimed the same job.
    //
    // For cron jobs, also advance next_run_at to the next scheduled occurrence at
    // claim time — not just at completion. This closes a second re-fire window:
    // if the publish step throws and the error handler reverts status to 'pending',
    // the row's next_run_at is already in the future so the next poll's SELECT
    // (WHERE next_run_at <= now()) skips it instead of re-firing it. (#1124)
    //
    // rowCount is typed number|null by pg; null must be treated the same as 0 —
    // both mean 0 rows updated, i.e. another poller already claimed the job.
    let claimResult: {
      rowCount: number | null;
      rows?: ReadonlyArray<{ run_started_at?: unknown }>;
    };
    if (job.cronExpr) {
      // Compute next_run_at before the claim UPDATE so it can be written atomically.
      // nextRunFromCron() can throw on a corrupt cron expression (e.g. direct DB insert
      // bypassing createJob validation). Guard it here so a throw does NOT cause the outer
      // pollDueJobs error handler to attempt reverting status = 'running' when the job was
      // never claimed — that revert would be a silent no-op, leaving next_run_at in the past
      // and causing an infinite tight-loop re-fire on every poll. Transition to 'failed'
      // instead so the job stops being selected.
      let nextRunAt: Date;
      try {
        nextRunAt = this.schedulerService.nextRunFromCron(job.cronExpr, job.timezone);
      } catch (err: unknown) {
        const agentErr = classifyError(err, 'scheduler-fire-job');
        this.logger.error(
          { err: agentErr, jobId: job.id, cronExpr: job.cronExpr, timezone: job.timezone },
          'Invalid cron expression — marking job failed to prevent retry storm',
        );
        // Set next_run_at = NULL so the poll SELECT (WHERE next_run_at <= now()) never
        // re-selects this job. Without it, the job stays 'failed' with a past next_run_at
        // and fires again on every poll. Guard with status IN (...) to avoid clobbering
        // a concurrent cancellation that could have occurred after the SELECT.
        // Guard on cron_expr/timezone: if updateJob() changed the cron between poll and
        // here, this UPDATE won't match (rowCount=0) and the job stays 'pending' with the
        // new (now-valid) expression — correctly deferring until the next poll.
        await this.pool.query(
          `UPDATE scheduled_jobs
              SET status = 'failed',
                  last_error = $2,
                  next_run_at = NULL
            WHERE id = $1
              AND status IN ('pending', 'failed')
              AND cron_expr = $3
              AND timezone = $4`,
          [job.id, agentErr.message, job.cronExpr, job.timezone],
        );
        return 'skipped';
      }
      // Optimistic-concurrency guard on cron_expr/timezone: if updateJob() changes
      // the expression between the poll SELECT and this claim UPDATE, the WHERE won't
      // match (rowCount=0), the job skips as "already claimed", and the next poll fires
      // it with the correct (updated) expression and next_run_at.
      //
      // next_run_at <= now() re-checks the SAME predicate the poll SELECT used, so the
      // claim is idempotent against overlapping poll cycles. pollDueJobs returns as soon
      // as the publish is handed off, so two polls (or two scheduler processes) can both
      // SELECT a row that is still pending. Poll A claims it and advances next_run_at;
      // completeJobRun may reset the recurring job to 'pending' before poll B reaches its
      // claim. Without this guard, poll B's claim would succeed (status is 'pending'
      // again) and fire a duplicate — e.g. two daily digests on 2026-06-24. With it, the
      // first claim advances next_run_at into the future, so any stale concurrent claim
      // matches 0 rows and skips.
      // (#1124 advanced next_run_at but only shielded the NEXT poll's SELECT, not a
      // concurrent poll already holding the row. #1159 added this predicate. #1160
      // detached the agent run from the poll; the predicate is still the mutex.)
      // Clear last_run_summary at claim so completeJobRun's COALESCE prefers an
      // explicit scheduler-report from *this* run over a stale prior summary (#1829).
      // last_run_context is intentionally left alone — it carries continuity state
      // (e.g. sweep cursors) that must survive a crash/timeout before the next report.
      // Prior-run injection below still uses the in-memory JobRow from the poll SELECT.
      claimResult = await this.pool.query(
        `UPDATE scheduled_jobs
            SET status = $1,
                run_started_at = now(),
                next_run_at = $3,
                last_run_summary = NULL
          WHERE id = $2
            AND status IN ('pending', 'failed')
            AND cron_expr = $4
            AND timezone = $5
            AND next_run_at <= now()
          RETURNING run_started_at::text AS run_started_at`,
        ['running', job.id, nextRunAt, job.cronExpr, job.timezone],
      );
    } else {
      claimResult = await this.pool.query(
        `UPDATE scheduled_jobs
            SET status = $1,
                run_started_at = now(),
                last_run_summary = NULL
          WHERE id = $2
            AND status IN ('pending', 'failed')
          RETURNING run_started_at::text AS run_started_at`,
        ['running', job.id],
      );
    }
    if (claimResult.rowCount === 0) {
      // 0 rows now has three distinct causes, all benign: another poller/instance
      // claimed the row first, cron_expr/timezone drifted between SELECT and claim, or
      // (cron jobs) next_run_at was already advanced into the future by a prior poll's
      // claim — the overlapping-poll de-dup this guard exists for. Word the message so a
      // missed-fire investigation isn't misled into thinking a real claim happened.
      this.logger.debug(
        { jobId: job.id, cronExpr: job.cronExpr },
        'Claim matched 0 rows; skipping fire (already claimed, cron/timezone drift, or next_run_at already advanced by a prior poll)',
      );
      return 'skipped';
    }
    // rowCount === null is an anomalous pg driver state (UPDATE always returns a count).
    // Treat it as 0 but log at warn so it's visible in production.
    if (claimResult.rowCount === null) {
      this.logger.warn({ jobId: job.id }, 'Claim UPDATE returned null rowCount — treating as already claimed, skipping fire');
      return 'skipped';
    }
    // The value the claim wrote. A later revert matches this exact timestamp so
    // it cannot undo a newer run of the same job (#1160).
    //
    // pg parses timestamptz as a Date and drops microseconds. now() has
    // microseconds, so sending that Date back compares unequal and the revert
    // matches 0 rows, leaving the job running. ::text keeps the full value;
    // the revert casts it back to timestamptz.
    const runStartedAt = claimResult.rows?.[0]?.run_started_at;
    if (typeof runStartedAt !== 'string' || runStartedAt.length === 0) {
      this.logger.error(
        { jobId: job.id },
        'Claim UPDATE returned no run_started_at text — reverting without dispatch',
      );
      // No task event exists yet, so the unscoped revert is the one that just
      // claimed this row. Dispatch has not started.
      await this.revertFailedFire(job.id, new Error('claim returned no run_started_at text'));
      return 'skipped';
    }

    // Build the agent.task content. Do NOT inject a bare job UUID here — agents
    // mistook `scheduler_job_id` for a bullpen thread_id (#1828). scheduler-report
    // derives job_id from conversationId (`scheduler:<uuid>:<runId>`) server-side.
    // For task-bound jobs, include task_id, title, and progress. For non-task-bound
    // jobs the payload fields are spread at the top level.
    let content: string;
    if (job.agentTaskId) {
      content = JSON.stringify({
        task_id: job.agentTaskId,
        ...(job.taskTitle !== null && { title: job.taskTitle }),
        progress: job.progress ?? {},
        task_payload: job.taskPayload,
      });
    } else {
      content = JSON.stringify({ ...job.taskPayload });
    }

    // Resolve runtime placeholders before the payload is ever visible to a model. Runs on
    // the payload only — the prior-run block prepended below is agent-written prose, and
    // substituting into it would let a prior run's text influence this run's arguments.
    const interpolated = interpolateTaskContent(content, this.principalContactId);
    content = interpolated.content;
    if (interpolated.principalReplacements > 0) {
      // info, not debug: these payloads are rare and each one is a job that was silently
      // broken before #1800. Searchable on 'scheduler: resolved runtime placeholder'.
      this.logger.info(
        {
          jobId: job.id,
          agentId: job.agentId,
          replacements: interpolated.principalReplacements,
          resolved: interpolated.principalResolved,
        },
        'scheduler: resolved runtime placeholder ${principal_contact_id} in task payload',
      );
      if (!interpolated.principalResolved) {
        this.logger.warn(
          { jobId: job.id, agentId: job.agentId },
          'scheduler: task payload references ${principal_contact_id} but no usable principal contact ID is available — substituted an empty string; complete onboarding at /setup',
        );
      }
    }
    if (interpolated.unresolvedTokens.length > 0) {
      // Nothing downstream will ever fill these in, so the agent is about to read template
      // syntax as if it were data. Warn rather than fail the fire: the rest of the payload
      // is usually still actionable, and a dead job is worse than a degraded one.
      this.logger.warn(
        { jobId: job.id, agentId: job.agentId, tokens: interpolated.unresolvedTokens },
        'scheduler: task payload contains unresolvable template tokens — the agent will read them as literal text',
      );
    }

    // Prepend prior-run context so the agent knows what happened last time
    // and can avoid repeating work or adjust its approach accordingly.
    const truncations: TruncationRecord[] = [];
    const priorRunBlock = buildPriorRunBlock(job, truncations);
    if (priorRunBlock) {
      content = `${priorRunBlock}\n\n${content}`;
    }
    for (const cut of truncations) {
      // warn, not debug: a repeatedly-cut lastRunContext means the job is losing
      // continuity state on every run, which is otherwise invisible to operators.
      // omittedKeys > 0 is the serious case — whole keys are gone, possibly a cursor.
      this.logger.warn(
        { jobId: job.id, agentId: job.agentId, ...cut },
        'scheduler: prior-run field truncated before injection — agent sees a fragment',
      );
    }

    // Built now, published with agent.task on the detached runner. parentEventId
    // is the event id, which exists before publish.
    const firedEvent = createScheduleFired({
      jobId: job.id,
      agentId: job.agentId,
      agentTaskId: job.agentTaskId,
    });

    // Use a unique per-run conversationId so that each scheduler invocation gets
    // its own conversation thread. Re-using just the job ID would let unrelated
    // runs bleed into the same conversation history.
    const runId = randomUUID();

    // Restore the TaskOriginator stored at schedule-creation / wake-enqueue time so the autonomy
    // gate can identify principal-authorized scheduled actions (e.g. "email my mother tomorrow at
    // 10am"). Without this, the task fires with no originator and isPrincipalOriginated() returns
    // false, blocking elevated skills.
    //
    // For BacklogHeartbeat wakes (#1125) also stamp a wakeContext so the execution layer applies
    // the bypass ladder + woken fail-closed path: for an open-ended backlog wake the live autonomy
    // score can only DOWNGRADE the lineage's standing, never grant it.
    //
    // The woken marker is keyed on the `standing` envelope that `enqueueTaskWake` always writes —
    // NOT on `job.originator`. A heartbeat wake of a pre-065 / unstamped task has a null originator
    // but is still a woken autonomous execution that must be marked (the ladder is then a safe
    // no-op — a null lineage has no standing to downgrade). A specific scheduler-create job
    // (different payload) and a `wake_at` job (task-wake payload but no `standing`) carry no
    // wakeContext and keep their originator at fire time — already pre-authorized, not laddered.
    const taskWakeStanding = isTaskWakePayload(job.taskPayload)
      ? (job.taskPayload as { standing?: { derived?: boolean } }).standing
      : undefined;
    let metadata: Record<string, unknown> | undefined;
    if (job.originator || taskWakeStanding || job.agentTaskId) {
      metadata = {};
      if (job.originator) metadata.originator = job.originator;
      if (taskWakeStanding) metadata.wakeContext = makeWakeContext(taskWakeStanding.derived === true);
      if (job.agentTaskId) {
        metadata.boundTask = {
          taskId: job.agentTaskId,
          errorBudget: job.taskErrorBudget ?? {},
          tags: job.taskTags ?? [],
          progress: job.progress ?? {},
        };
      }
    }

    // A deferred delegation wakes in the conversation that queued it (#1893).
    // Every other job keeps the per-run scheduler thread.
    const delegationRetry = readDelegationRetryWake(job.taskPayload);
    if (delegationRetry) {
      metadata = {
        ...(metadata ?? {}),
        delegationRetry: {
          attempt: delegationRetry.attempt,
          targetAgent: delegationRetry.targetAgent,
        },
      };
    }

    // Publish agent.task so the coordinator picks up the work.
    const taskEvent = createAgentTask({
      agentId: job.agentId,
      conversationId: delegationRetry?.conversationId ?? `scheduler:${job.id}:${runId}`,
      channelId: delegationRetry?.channelId ?? 'scheduler',
      senderId: delegationRetry?.senderId ?? 'scheduler',
      content: delegationRetry ? formatDelegationRetryWakeContent(delegationRetry) : content,
      ...(delegationRetry && { syntheticTurn: true }),
      // Pass the anchor in the payload so the runtime injects it into the system
      // prompt. null (no linked agent_task) becomes undefined (field omitted).
      intentAnchor: job.intentAnchor ?? undefined,
      // Pass the duration hint so the runtime can widen the delegate timeout for
      // long-running scheduled tasks. null (no explicit duration) becomes undefined.
      expectedDurationSeconds: job.expectedDurationSeconds ?? undefined,
      // Thread the stored originator (+ wakeContext for heartbeat wakes) through.
      metadata,
      parentEventId: firedEvent.id,
    });
    if (delegationRetry) {
      const originator = job.originator ?? {
        contactId: 'unresolved',
        systemRole: null,
        channel: delegationRetry.channelId,
        initiatedAt: new Date().toISOString(),
        tier: null,
      };
      if (this.externalRoutingRegistrar) {
        this.externalRoutingRegistrar(taskEvent.id, {
          channelId: delegationRetry.channelId,
          conversationId: delegationRetry.conversationId,
          senderId: delegationRetry.senderId,
          originator,
        });
      } else {
        this.logger.warn(
          { jobId: job.id, conversationId: delegationRetry.conversationId },
          'Delegation retry wake has no routing registrar — the reply may not reach the principal',
        );
      }
    }
    // Track the mapping BEFORE publishing. dispatchPublish starts bus.publish
    // immediately, and publish awaits handlers, so the agent may emit
    // agent.response before publish() returns. Setting the entry after that
    // would make handleCompletion see an empty map and drop the completion.
    this.pendingJobs.set(taskEvent.id, job.id);
    this.dispatchPublish(job, firedEvent, taskEvent, runStartedAt);
    return 'dispatched';
  }

  /**
   * Publish schedule.fired and agent.task without blocking the poll.
   * The in-flight slot reserved by fireJob is released when this promise settles
   * (including when publish rejects and the job is reverted to pending), or when
   * the watchdog recovery timeout elapses — whichever comes first. The timeout
   * releases only the slot. The agent run keeps going, and recoverStuckJobs
   * remains responsible for the row.
   */
  private dispatchPublish(
    job: JobRow,
    firedEvent: ScheduleFiredEvent,
    taskEvent: AgentTaskEvent,
    runStartedAt: string,
  ): void {
    const timeoutMs = this.slotTimeoutMs(job);
    let slotHeld = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const releaseSlot = (reason: 'settled' | 'timeout'): void => {
      if (!slotHeld) return;
      slotHeld = false;
      if (timer !== undefined) clearTimeout(timer);
      this.inFlight -= 1;
      if (reason === 'timeout') {
        this.logger.warn(
          {
            jobId: job.id,
            agentId: job.agentId,
            timeoutMs,
            inFlight: this.inFlight,
            maxInFlight: this.maxInFlight,
          },
          'scheduler: released in-flight slot after recovery timeout; the agent run is still going',
        );
      }
    };
    // setTimeout fires immediately for delays above 2^31-1 ms. slotTimeoutMs clamps.
    timer = setTimeout(() => {
      releaseSlot('timeout');
    }, timeoutMs);
    timer.unref();

    const run = this.publishFire(job, firedEvent, taskEvent)
      .catch((err: unknown) => this.revertFailedFire(job.id, err, {
        taskEventId: taskEvent.id,
        runStartedAt,
      }))
      .catch((err: unknown) => {
        this.logger.error({ err, jobId: job.id }, 'Revert after failed fire threw');
      })
      .finally(() => {
        releaseSlot('settled');
        this.inFlightRuns.delete(run);
      });
    this.inFlightRuns.add(run);
  }

  /**
   * How long a handed-off run may hold its slot. Same horizon recoverStuckJobs
   * uses to decide the row is stuck, so the slot and the row become eligible
   * to move again together. The watchdog itself still runs on its own interval.
   */
  private slotTimeoutMs(job: JobRow): number {
    const expected = job.expectedDurationSeconds;
    const seconds = expected != null && expected > 0
      ? expected
      : this.defaultExpectedDurationSeconds;
    const ms = computeRecoveryTimeout(seconds) * 1000;
    // Node clamps delays above 2^31-1 to 1, which would release the slot immediately.
    return Math.min(ms, 2_147_483_647);
  }

  private async publishFire(job: JobRow, firedEvent: ScheduleFiredEvent, taskEvent: AgentTaskEvent): Promise<void> {
    await this.bus.publish('system', firedEvent);
    await this.bus.publish('system', taskEvent);
    if (readDelegationRetryWake(job.taskPayload)) {
      await this.closeDelegationRetryTask(job);
    }
    this.logger.info(
      { jobId: job.id, agentId: job.agentId, taskEventId: taskEvent.id },
      'Job fired',
    );
  }

  /**
   * The retry task's job is to hold the brief until this wake. Once the wake
   * has been published, an open row is what BacklogHeartbeat re-runs — the
   * brief as a generic poke, with no delegationRetry cap. Close it here.
   * A failure is logged and not rethrown: the wake already went out, and
   * failing publishFire would revert the job and fire it again.
   */
  private async closeDelegationRetryTask(job: JobRow): Promise<void> {
    if (!job.agentTaskId) {
      this.logger.warn(
        { jobId: job.id },
        'Delegation retry wake has no linked task — BacklogHeartbeat cannot be stopped from re-running it',
      );
      return;
    }
    try {
      await this.pool.query(
        `UPDATE tasks
            SET status = 'done', updated_at = now()
          WHERE id = $1
            AND status IN ('open', 'in_progress', 'waiting', 'blocked')
            AND 'delegation-retry' = ANY(tags)`,
        [job.agentTaskId],
      );
    } catch (err) {
      this.logger.error(
        { err, jobId: job.id, taskId: job.agentTaskId },
        'Delegation retry wake fired but the backlog task stayed open — BacklogHeartbeat may re-run the brief',
      );
    }
  }

  /**
   * Undo a claim that never became a running agent.
   *
   * The detached path passes the task event and the `run_started_at` the claim
   * returned. Only that map entry is removed, and the UPDATE matches that
   * timestamp. After the slot timeout the original publish can still reject,
   * by which point the watchdog may have reset the row and a later poll claimed
   * it again. A revert keyed only on job id would drop the newer pendingJobs
   * entry and set that newer row back to pending.
   *
   * The poll catch (claim or payload build threw before a task event existed)
   * omits the generation. Nothing has been handed off, so there is no newer
   * run to protect. The UPDATE still matches only status='running'.
   *
   * The map check and the UPDATE are independent. A missing map entry does not
   * skip the UPDATE: completion may have dropped the entry while this
   * generation's row is still running, and the timestamp predicate is what
   * keeps a newer run untouched.
   */
  private async revertFailedFire(
    jobId: string,
    err: unknown,
    generation?: { taskEventId: string; runStartedAt: string },
  ): Promise<void> {
    this.logger.error({ err, jobId }, 'Failed to fire job — reverting to pending for retry');
    if (generation) {
      if (this.pendingJobs.get(generation.taskEventId) === jobId) {
        this.pendingJobs.delete(generation.taskEventId);
        this.pendingFailureMessages.delete(generation.taskEventId);
      }
      await this.pool.query(
        `UPDATE scheduled_jobs
            SET status = 'pending'
          WHERE id = $1
            AND status = 'running'
            AND run_started_at = $2::timestamptz`,
        [jobId, generation.runStartedAt],
      ).catch((revertErr: unknown) => {
        this.logger.error({ revertErr, jobId }, 'Failed to revert job status after fire failure — job may be stuck in running');
      });
      return;
    }
    for (const [eventId, pendingJobId] of this.pendingJobs) {
      if (pendingJobId === jobId) {
        this.pendingJobs.delete(eventId);
        this.pendingFailureMessages.delete(eventId);
        break;
      }
    }
    await this.pool.query(
      `UPDATE scheduled_jobs SET status = 'pending' WHERE id = $1 AND status = 'running'`,
      [jobId],
    ).catch((revertErr: unknown) => {
      this.logger.error({ revertErr, jobId }, 'Failed to revert job status after fire failure — job may be stuck in running');
    });
  }

  /**
   * Resolves when every detached publish has settled.
   *
   * Test-only. `stop()` does not call this, on purpose: wiring it into
   * shutdown would need its own timeout. The loop never returns if a publish
   * stays pending (a hung agent run). The in-flight slot is released separately
   * when the recovery timeout elapses; this wait is not that release. `index.ts`
   * still closes the pool after `stop()` without waiting, which is the same
   * shape as before this change, when the poll promise was never awaited at
   * shutdown either.
   */
  async drainInFlight(): Promise<void> {
    while (this.inFlightRuns.size > 0) {
      await Promise.allSettled([...this.inFlightRuns]);
    }
  }

  /**
   * Handle a completion event (agent.response or agent.error) by matching
   * the parentEventId back to a pending job and completing the job run.
   */
  private async handleCompletion(
    parentEventId: string,
    success: boolean,
    error?: string,
    autoSummary?: string,
    failedSkills?: Array<{ name: string; error: string }>,
    failedSkillsOmitted?: number,
  ): Promise<void> {
    const jobId = this.pendingJobs.get(parentEventId);
    if (!jobId) {
      // Not a scheduler-originated event — ignore silently.
      return;
    }

    // Clean up the tracking map.
    this.pendingJobs.delete(parentEventId);
    this.pendingFailureMessages.delete(parentEventId);

    try {
      // Run the drift check on the success path for persistent tasks only.
      // Skip on the failure path — the error handling flow takes over.
      if (success && this.driftDetector) {
        const job = await this.schedulerService.getJob(jobId);

        // Skip drift detection for task-bound wake jobs. These are created via wake_at /
        // enqueueTaskWake and carry the contentless envelope `{"type":"task-wake"}` as their
        // payload — the real task context lives in intent_anchor and the linked task row, not
        // the payload. Feeding the rich intent vs. the empty envelope to the detector made it
        // report drift on every such job, hard-pausing healthy meeting-debriefs/reminders and
        // triggering a duplicate outbound send via the drift-pause notification (#1064). A
        // one-shot wake also cannot meaningfully "drift" — it fires exactly once.
        if (job?.agentTaskId && job.intentAnchor && !isTaskWakePayload(job.taskPayload)) {
          // Enforce checkEveryNBursts: only check on the Nth burst.
          const burstCount = (this.burstCounts.get(jobId) ?? 0) + 1;
          this.burstCounts.set(jobId, burstCount);

          const shouldCheck = burstCount % this.driftDetector.checkEveryNBursts === 0;

          if (shouldCheck) {
            // Prefer an explicit mid-run scheduler-report; otherwise use this run's
            // auto-summary. The DB column is cleared at claim (#1829), so reading it
            // alone would always drop the detector's "last run" section for agents
            // that rely on the auto-summary path.
            const driftSummary = job.lastRunSummary ?? autoSummary ?? null;
            const verdict = await this.driftDetector.check({
              intentAnchor: job.intentAnchor,
              taskPayload: job.taskPayload,
              lastRunSummary: driftSummary,
            });

            if (verdict !== null) {
              this.logger.info(
                { jobId, agentTaskId: job.agentTaskId, drifted: verdict.drifted, confidence: verdict.confidence, reason: verdict.reason },
                'drift-detector: verdict',
              );

              if (this.driftDetector.shouldPause(verdict)) {
                // Hard pause: set status to paused, publish the drift event, notify CEO.
                // Wrapped in its own try/catch so a failure here falls back to normal
                // completion — preventing the job from being left in 'running' state.
                let pauseSucceeded = false;
                try {
                  await this.schedulerService.pauseJobForDrift(jobId);

                  const driftEvent = createScheduleDriftPaused({
                    jobId,
                    agentId: job.agentId,
                    agentTaskId: job.agentTaskId,
                    intentAnchor: job.intentAnchor,
                    taskPayload: job.taskPayload,
                    lastRunSummary: driftSummary,
                    verdict,
                    parentEventId,
                  });
                  await this.bus.publish('system', driftEvent);

                  // Notify the CEO via the coordinator (same pattern as schedule.suspended).
                  // IMPORTANT: this is a review-only notice — it must NOT embed the original
                  // intent or the raw payload. Previously it echoed `Original intent: …` /
                  // `Current task: …` verbatim, which the coordinator re-interpreted as an
                  // actionable instruction and re-executed, causing a duplicate outbound
                  // message to the principal (#1064). Reference the job by id + reason only,
                  // and explicitly instruct the coordinator not to act on the paused task. The
                  // full intent/payload remains on the schedule.drift_paused audit event above.
                  //
                  // verdict.reason is LLM-generated free text. Normalise it before embedding so
                  // it stays a single short sentence and can't smuggle imperative multi-line
                  // phrasing back into the coordinator's instructions (it's constrained to one
                  // sentence by the detector prompt, but defend at the boundary anyway).
                  const safeReason = verdict.reason.replace(/[\r\n]+/g, ' ').trim().slice(0, 280);

                  const notifyContent = [
                    `A scheduled job was automatically paused for review because its behaviour may have drifted from its original goal.`,
                    ``,
                    `Job: ${jobId}`,
                    `Reason: ${safeReason} (confidence: ${verdict.confidence})`,
                    ``,
                    `This is a review notice only — do not re-run, re-send, or otherwise act on the paused task. Let the principal know the job is paused and awaiting their review; they can resume it with corrected instructions or cancel it.`,
                  ].join('\n');

                  const notifyEvent = createAgentTask({
                    agentId: 'coordinator',
                    conversationId: `scheduler:${jobId}`,
                    channelId: 'scheduler',
                    senderId: 'scheduler',
                    content: notifyContent,
                    parentEventId: driftEvent.id,
                  });
                  await this.bus.publish('system', notifyEvent);

                  this.logger.warn(
                    { jobId, agentTaskId: job.agentTaskId, reason: verdict.reason, confidence: verdict.confidence },
                    'Job paused due to intent drift detection',
                  );

                  // Do NOT call completeJobRun — the job is paused, not completed.
                  // Clean up burst counter: paused jobs don't burst again.
                  this.burstCounts.delete(jobId);
                  pauseSucceeded = true;
                } catch (pauseErr) {
                  this.logger.error(
                    { err: pauseErr, jobId, agentTaskId: job.agentTaskId },
                    'drift-detector: pause-and-notify failed — falling back to normal completion',
                  );
                }

                if (pauseSucceeded) return;
              }
            }
          }

          // One-shot jobs (no cron_expr) fire exactly once and never burst again,
          // so their counter is dead weight the moment the run completes — drop it
          // inline. Recurring jobs keep their counter (checkEveryNBursts spans runs)
          // and are reclaimed by the watchdog sweep once they go terminal (#1664).
          if (!job.cronExpr) {
            this.burstCounts.delete(jobId);
          }
        }
      }

      const result = await this.schedulerService.completeJobRun(
        jobId,
        success,
        error,
        autoSummary,
        failedSkills,
        failedSkillsOmitted,
      );

      if (result.suspended) {
        // Fetch the job to get the agentId and consecutiveFailures for the event.
        const job = await this.schedulerService.getJob(jobId);
        if (job) {
          // Publish schedule.suspended for audit trail.
          const suspendedEvent = createScheduleSuspended({
            jobId,
            agentId: job.agentId,
            lastError: error ?? 'Unknown error',
            consecutiveFailures: job.consecutiveFailures,
            parentEventId,
          });
          await this.bus.publish('system', suspendedEvent);

          // Publish a synthetic agent.task to the coordinator so the user gets notified
          // about the suspension (e.g., "your scheduled job was suspended after 3 failures").
          // Always routes to coordinator — it's the user-facing agent that can deliver notifications.
          const notifyEvent = createAgentTask({
            agentId: 'coordinator',
            conversationId: `scheduler:${jobId}`,
            channelId: 'scheduler',
            senderId: 'scheduler',
            content: JSON.stringify({
              type: 'schedule_suspended',
              jobId,
              lastError: error ?? 'Unknown error',
              consecutiveFailures: job.consecutiveFailures,
            }),
            parentEventId: suspendedEvent.id,
          });
          await this.bus.publish('system', notifyEvent);
        }
      }
    } catch (err) {
      this.logger.error({ err, jobId, parentEventId }, 'Error completing job run');
    }
  }

  /**
   * Load declarative jobs from agent YAML configs.
   * For each config that has a `schedule` block, upserts the declarative jobs
   * so they're always present in the DB on startup.
   */
  async loadDeclarativeJobs(agentConfigs: AgentYamlConfig[]): Promise<void> {
    const knownAgents = new Set(agentConfigs.map(config => config.name));
    // Collect all (source -> target) schedule edges for cycle detection after upserts.
    const edges: Array<{ source: string; target: string }> = [];
    // Collect (source_agent_id, agent_id, cron_expr, task_payload) tuples for every YAML-declared schedule that
    // passes the knownAgents guard. Used to shield existing DB rows from stale-job cleanup.
    // Populated BEFORE the upsert attempt so that a transient upsert failure cannot cause a
    // still-declared job's existing DB row to be misclassified as stale and cancelled.
    const declaredTuples: Array<{ sourceAgentId: string; agentId: string; cronExpr: string; taskPayload: string }> = [];

    for (const config of agentConfigs) {
      if (!config.schedule || config.schedule.length === 0) {
        continue;
      }

      for (const schedule of config.schedule) {
        // agent_id lets a specialist declare its schedule fires at a different agent
        // (e.g. coordinator). Defaults to the agent's own name if omitted.
        const targetAgentId = schedule.agent_id ?? config.name;

        // Reject unknown targets early — a typo in agent_id would silently write a
        // job that targets nobody. Fail loudly at startup instead.
        if (!knownAgents.has(targetAgentId)) {
          this.logger.error(
            { sourceAgent: config.name, targetAgentId, cron: schedule.cron, task: schedule.task },
            'Skipping declarative job — target agent_id is not a known agent',
          );
          continue;
        }

        // Track this declaration before attempting the upsert — a YAML declaration
        // protects its DB row from stale-job cleanup regardless of upsert outcome.
        // (A transient DB error during the upsert must not cause a still-declared
        // job's existing pending row to be cancelled on this startup pass.)
        declaredTuples.push({
          sourceAgentId: config.name,
          agentId: targetAgentId,
          cronExpr: schedule.cron,
          taskPayload: JSON.stringify({ task: schedule.task }),
        });

        try {
          const jobId = await this.schedulerService.upsertDeclarativeJob(
            config.name,
            targetAgentId,
            schedule,
          );
          // Only record the edge after a successful upsert — a failed upsert means
          // the job doesn't exist in the DB, so it shouldn't influence cycle detection.
          edges.push({ source: config.name, target: targetAgentId });
          this.logger.info(
            { agentId: targetAgentId, sourceAgent: config.name, cron: schedule.cron, task: schedule.task, jobId },
            'Declarative job upserted',
          );
        } catch (err) {
          this.logger.error(
            { err, agentId: targetAgentId, sourceAgent: config.name, schedule },
            'Failed to upsert declarative job',
          );
        }
      }
    }

    // Detect two-agent targeting cycles and warn loudly. A cycle means agent A's schedule
    // targets agent B, and agent B's schedule targets agent A — this will cause infinite
    // task loops at runtime. Self-targeting (source === target) is intentional and fine.
    //
    // Use a Set keyed on the canonical (sorted) pair to warn exactly once per pair,
    // even if one agent has multiple schedules targeting the other.
    const warnedPairs = new Set<string>();
    for (const edge of edges) {
      if (edge.source === edge.target) continue; // self-targeting is fine
      const hasCycle = edges.some(
        e => e.source === edge.target && e.target === edge.source,
      );
      const pairKey = [edge.source, edge.target].sort().join('::');
      if (hasCycle && !warnedPairs.has(pairKey)) {
        warnedPairs.add(pairKey);
        this.logger.warn(
          { agentA: edge.source, agentB: edge.target },
          'Declarative schedule cycle detected — agents target each other; this will cause infinite task loops',
        );
      }
    }

    // Cancel system-created rows whose (agent_id, cron_expr, task_payload) triple is no longer
    // declared in any agent YAML. This handles both cron expression changes (old row becomes
    // stale when the new cron conflicts on the unique index) and removed schedule entries
    // (row has no corresponding YAML declaration at all).
    try {
      const cancelledCount = await this.schedulerService.cancelStaleDeclarativeJobs(declaredTuples);
      if (cancelledCount > 0) {
        this.logger.info(
          { cancelledCount },
          'stale declarative jobs cancelled — schedule entries changed or removed from YAML',
        );
      }
    } catch (err) {
      this.logger.error(
        { err, declaredTupleCount: declaredTuples.length },
        'Failed to cancel stale declarative jobs — resolve the error above and restart to trigger cleanup',
      );
    }
  }

  /**
   * Detect and recover jobs stuck in 'running' state beyond their timeout threshold.
   * Called at startup (before scheduler.start()) and by the watchdog loop every 5 minutes.
   *
   * Timeout formula: min(expected × 7.5, expected + 3600s)
   * This gives proportionally more headroom to short jobs while capping the max extension
   * at +60 minutes for long-running jobs.
   *
   * Jobs with NULL run_started_at (e.g., stuck before this migration ran) are always recovered.
   */
  async recoverStuckJobs(): Promise<void> {
    // Find all running jobs that have exceeded their timeout. The LEAST() formula mirrors
    // the JS constants above — keep them in sync if the formula ever changes.
    // run_started_at IS NULL handles jobs stuck before this migration added the column.
    const sql = `
      SELECT
        id,
        agent_id,
        run_started_at,
        LEAST(
          COALESCE(expected_duration_seconds, $1)::float8 * $2,
          (COALESCE(expected_duration_seconds, $1) + $3)::float8
        )::integer AS timeout_seconds
      FROM scheduled_jobs
      WHERE status = 'running'
        AND (
          run_started_at IS NULL
          OR run_started_at < now() - make_interval(secs =>
              LEAST(
                COALESCE(expected_duration_seconds, $1)::float8 * $2,
                (COALESCE(expected_duration_seconds, $1) + $3)::float8
              )
            )
        )
      FOR UPDATE SKIP LOCKED
    `;
    const { rows } = await this.pool.query(sql, [
      this.defaultExpectedDurationSeconds,
      RECOVERY_TIMEOUT_MULTIPLIER,
      RECOVERY_TIMEOUT_CAP_SECONDS,
    ]);

    if (rows.length === 0) {
      this.logger.debug('recoverStuckJobs: no stuck jobs found');
      return;
    }

    this.logger.warn({ count: rows.length }, 'Recovering stuck jobs');

    for (const row of rows as Array<{ id: string; agent_id: string; run_started_at: string | null; timeout_seconds: number }>) {
      try {
        const result = await this.schedulerService.recoverStuckJob(row.id, row.timeout_seconds);

        if (!result.noOp) {
          // Remove any stale pendingJobs entry so a late agent.response for the
          // old run cannot complete the freshly-reset job.
          for (const [eventId, pendingJobId] of this.pendingJobs) {
            if (pendingJobId === row.id) {
              this.pendingJobs.delete(eventId);
              this.pendingFailureMessages.delete(eventId);
              this.burstCounts.delete(row.id);
              this.logger.debug({ jobId: row.id, eventId }, 'Removed stale pendingJobs entry for recovered job');
              break; // At most one entry per job
            }
          }

          this.logger.warn(
            {
              jobId: row.id,
              agentId: row.agent_id,
              runStartedAt: row.run_started_at,
              timeoutSeconds: row.timeout_seconds,
              consecutiveFailures: result.consecutiveFailures,
              suspended: result.suspended,
            },
            'Stuck job recovered',
          );

          // Publish audit events separately — failures here are non-fatal since the DB
          // mutation already committed. Log at error but do not treat as a recovery failure.
          try {
            const recoveredEvent = createScheduleRecovered({
              jobId: row.id,
              agentId: row.agent_id,
              runStartedAt: row.run_started_at,
              timeoutSeconds: row.timeout_seconds,
              consecutiveFailures: result.consecutiveFailures,
              suspended: result.suspended,
            });
            await this.bus.publish('system', recoveredEvent);

            // When watchdog recovery leads to suspension, also fire schedule.suspended
            // so SuspensionNotifier can email the CEO through the same path as normal
            // completion-failure suspensions. Uses recoveredEvent as parent to preserve
            // the causal chain in the audit log.
            if (result.suspended) {
              const timeoutMinutes = Math.round(row.timeout_seconds / 60);
              const suspendedEvent = createScheduleSuspended({
                jobId: row.id,
                agentId: row.agent_id,
                lastError: `Job timed out after ${timeoutMinutes}m — auto-recovered`,
                consecutiveFailures: result.consecutiveFailures,
                parentEventId: recoveredEvent.id,
              });
              await this.bus.publish('system', suspendedEvent);
            }
          } catch (publishErr) {
            this.logger.error({ publishErr, jobId: row.id }, 'Failed to publish schedule.recovered event — job was recovered in DB');
          }
        }
      } catch (err) {
        this.logger.error({ err, jobId: row.id }, 'Failed to recover stuck job — will retry on next watchdog tick');
      }
    }
  }

  /**
   * Evict burst counters for jobs that are no longer active recurring jobs.
   *
   * `burstCounts` is only meaningful for a pending/running **recurring** job between
   * its runs — it drives checkEveryNBursts. One-shot completion is evicted inline in
   * handleCompletion, but cancel, delete, and suspend all mutate the DB directly via
   * SchedulerService without the poller ever seeing it, so those entries would live
   * for the whole process lifetime. This sweep is the catch-all: it keeps only the
   * counters whose job is still a pending/running recurring job and drops the rest.
   * Runs on the watchdog cadence.
   *
   * Over-eviction is harmless: a wrongly-dropped counter simply restarts its N-burst
   * window, and a missed drift check is explicitly not a security failure (see the
   * burstCounts field declaration). (#1664)
   */
  async pruneStaleBurstCounts(): Promise<void> {
    if (this.burstCounts.size === 0) return;

    const ids = [...this.burstCounts.keys()];
    const { rows } = await this.pool.query(
      `SELECT id FROM scheduled_jobs
        WHERE id = ANY($1::uuid[])
          AND status IN ('pending', 'running')
          AND cron_expr IS NOT NULL`,
      [ids],
    );
    const live = new Set((rows as Array<{ id: string }>).map((r) => r.id));

    for (const id of ids) {
      if (!live.has(id)) {
        this.burstCounts.delete(id);
      }
    }
  }
}
