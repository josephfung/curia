// tests/scenarios/types.ts — coordinator scenario suite (#1956).
//
// A scenario is one inbound message to the coordinator, with seeded state and
// stubbed tools, run N times on the production prompt. Behaviors are scored per
// run, either in code (`check`) or by the LLM judge (no `check`).
import type { ObservedToolCall } from '../shared/turn-capture.js';
import type { UsageBreakdown } from '../shared/usage.js';

// ── Case definition (loaded from YAML) ─────────────────────────────────────

export type BehaviorWeight = 'critical' | 'important' | 'nice-to-have';

export const WEIGHT_VALUES: Record<BehaviorWeight, number> = {
  critical: 3,
  important: 2,
  'nice-to-have': 1,
};

export interface ToolStub {
  /**
   * Subset match on the call's arguments: every key here must equal the argument.
   * `null` means "this argument is absent". `{}` matches any call.
   */
  match: Record<string, unknown>;
  /**
   * Only calls by this agent match (#2027). Absent: every agent's calls. In a case with
   * real delegation, `calendar` + `calendar-list-events` answers the specialist without
   * also answering the coordinator.
   */
  agent?: string;
  /** What the model receives on success — the `data` payload, not the envelope. */
  return?: unknown;
  /** Return a tool failure instead. The runtime formats it as a <task_error>, as in production. */
  error?: string;
}

/**
 * Whose calls a `called` / `not_called` / `order` check reads (#2027): an agent id, or
 * `any` for every agent in the run. Absent means the coordinator, the only agent whose
 * calls a stubbed-delegation run has.
 */
export type CheckAgent = string;

/** The `agent` value that makes a check read every agent's calls. */
export const ANY_AGENT = 'any';

/**
 * A deterministic check, scored in code. Exactly one kind per check.
 *
 * `called` / `not_called` take an optional `with` (argument subset, same rules as a
 * stub match) and `contains` (each named argument, stringified, must contain the
 * substring — case-insensitive). `called` may also set `success`: only a call whose
 * result has that success value matches, and `min` / `max` count only those calls.
 * `returns` keeps only calls that succeeded with data containing it (a nested subset:
 * `{ outbound_entry: { status: released } }`), e.g. what the platform reported doing.
 * On `not_called` it narrows the forbidden calls the same way (`returns: { declined: true }`).
 * A refused send still counts for `not_called`.
 */
export type BehaviorCheck =
  /** `tool` may list several tools: their matching calls are counted together. */
  | { kind: 'called'; tool: string | string[]; agent?: CheckAgent; with?: Record<string, unknown>; contains?: Record<string, string>; min?: number; max?: number; success?: boolean; returns?: Record<string, unknown> }
  | { kind: 'not_called'; tools: string[]; agent?: CheckAgent; with?: Record<string, unknown>; contains?: Record<string, string>; returns?: Record<string, unknown> }
  | { kind: 'order'; tools: string[]; agent?: CheckAgent }
  | { kind: 'reply'; is: 'no_reply' | 'not_no_reply' }
  | { kind: 'reply_excludes'; patterns: string[] }
  /** No tool, agent or system identifier from the running stack appears in the reply. */
  | { kind: 'reply_excludes_internal_names' }
  /**
   * A real specialist run of `agent` received a brief containing every one of `contains`
   * (case-insensitive) (#2027): what the delegate handler handed it, after its additions.
   */
  | { kind: 'briefed'; agent: string; contains: string[] }
  /**
   * Passes when any alternative passes. For a behavior the platform accepts in more
   * than one shape — e.g. delegate links an entry from `outbound_entry_id` or from its
   * id quoted in the brief (#1972).
   */
  | { kind: 'any_of'; checks: BehaviorCheck[] };

export interface ExpectedBehavior {
  id: string;
  description: string;
  weight: BehaviorWeight;
  /** Absent → scored by the LLM judge from `description`. */
  check?: BehaviorCheck;
}

/** A contact to create for the run. Referenced elsewhere as `{{contact:<key>}}`. */
export interface SeedContact {
  key: string;
  displayName: string;
  /** `trusted` is a grant made after creation; createContact refuses it. */
  tier: 'known' | 'unknown';
  kind?: 'person' | 'organization' | 'automated';
  role?: string;
  /** Channel identity used when this contact is the sender. */
  channel: string;
  identifier: string;
}

/** A row in outbound_context. Referenced as `{{entry:<key>}}`. */
export interface SeedOutboundEntry {
  key: string;
  channelId: string;
  agentId: string;
  content: string;
  expectedReply?: string;
  delegationHint?: string;
  metadata?: Record<string, unknown>;
  /** Backdates created_at so the block reads "sent N minutes ago". Default 10. */
  sentMinutesAgo?: number;
  expiresInHours?: number;
  /**
   * The entry relays a specialist's clarification question (#2027): seeding encodes this
   * with production's encodeResumeToken into `metadata.resume_token`, the way the relay
   * send's context_bridge stores it. Referenced as `{{resume_token:<key>}}`.
   */
  resume?: { agent: string; originalTask: string; context: string };
}

/** A bullpen thread. Referenced as `{{thread:<key>}}`. */
export interface SeedBullpenThread {
  key: string;
  topic: string;
  creatorAgentId: string;
  participants: string[];
  content: string;
  mentionedAgentIds: string[];
}

/**
 * The message the coordinator receives.
 * `from: principal` resolves through the stack's principal (channel `cli` by default;
 * any other channel uses the principal's own identity on it). `from: <contact key>`
 * uses that seeded contact's channel identity. `from: bullpen` wakes the coordinator
 * on a seeded thread the way BullpenDispatcher does, with `content` as the new message.
 * `from: scheduler` fires a recurring job with no linked task the way the scheduler
 * does: an agent.task on the `scheduler` channel whose content is `{"task": content}`.
 */
export interface ScenarioInbound {
  from: string;
  channel?: string;
  content: string;
  /** Bullpen only: the thread key the new message is posted on. */
  thread?: string;
  /** Email only: rendered as the email preamble the Dispatcher builds. */
  email?: {
    nylasMessageId?: string;
    /** The named account that received it (the inbound's accountId); the preamble's Account line. */
    account?: string;
    autoGenerated?: boolean;
    autoGeneratedSignals?: string[];
  };
}

/**
 * `stubbed` (the default): `delegate` is answered by a stub and no specialist runs, so a
 * case isolates the coordinator's decision. `real` (#2027): `delegate` runs production's
 * handler and the specialist runs too, under the same stub layer as the coordinator.
 */
export type DelegationMode = 'stubbed' | 'real';

export interface ScenarioCase {
  name: string;
  description: string;
  tags: string[];
  delegation: DelegationMode;
  /**
   * False: the case runs only on demand (#2027) — when --case or --tags selects it, or with
   * --on-demand — and not in an unfiltered run, which is the release gate. For cases whose
   * cost (real delegation multiplies model calls) outweighs what they add to every release.
   */
  releaseGate: boolean;
  /** Per-case override of the CLI default. */
  runs?: number;
  /**
   * A tracked regression: the case still runs and reports, but its critical failures do
   * not fail the gate. Requires an issue, so the exception is reviewable and has an
   * owner. Errored runs, judge errors and stub holes still fail the gate.
   */
  knownFailure?: { issue: string; reason: string };
  /**
   * Per-run wait for the coordinator, overriding SCENARIO_TIMEOUT_MS / the 180s default
   * (for real delegation, the longest delegate wait plus a margin). For cases where
   * exploring before answering is legitimate and slow.
   */
  timeoutSeconds?: number;
  seed: {
    contacts: SeedContact[];
    outboundContext: SeedOutboundEntry[];
    bullpen: SeedBullpenThread[];
  };
  inbound: ScenarioInbound;
  toolStubs: Record<string, ToolStub[]>;
  /**
   * Tools the case stubbed itself (tool_stubs and named stub_sets), as opposed to the
   * `defaults` set every case gets. Only these must name a tool the coordinator is
   * offered — a default for a tool this registry did not load is simply unused.
   */
  explicitStubTools: string[];
  expectedBehaviors: ExpectedBehavior[];
  failureModes: string[];
  /** File the case came from, for messages. */
  sourceFile: string;
}

// ── Execution ─────────────────────────────────────────────────────────────

/** A bus-observed call (tests/shared/turn-capture.ts) plus how the harness answered it. */
export interface CapturedToolCall extends ObservedToolCall {
  /**
   * The agent that made the call (#2027). Absent on transcripts saved before it existed,
   * which hold only the coordinator's calls.
   */
  agentId?: string;
  /**
   * stubbed = answered by a stub; passthrough = real read-only tool; canned = an
   * unstubbed snapshot-served MCP tool, answered with an empty stand-in (#2024);
   * refused = fail-closed by the stub layer; runtime = the runtime answered it without
   * the ExecutionLayer (a tool outside the turn's allowlist, a delegation its guard blocked).
   */
  disposition: 'stubbed' | 'passthrough' | 'canned' | 'refused' | 'runtime';
}

export interface ScenarioRun {
  runIndex: number;
  /** The inbound content after placeholder resolution. */
  inboundContent: string;
  /**
   * `kind:key` → id for the rows this run seeded. Checks and judge descriptions that
   * name a seeded row ({{entry:x}}) are resolved against it at rating time.
   */
  refs: Record<string, string>;
  /**
   * The instant and timezone this run resolved its date placeholders against (#1958).
   * Absent on transcripts saved before it existed.
   */
  clock?: { now: string; timezone: string };
  toolCalls: CapturedToolCall[];
  /** The coordinator's agent.response content (NO_REPLY included verbatim). */
  reply: string | null;
  /** Set when the Dispatcher suppressed delivery (outbound.no_reply reason). */
  noReplyReason?: string;
  durationMs: number;
  /** Calls the harness answered badly: refused by the stub layer, or a failed passthrough read. */
  unstubbedCalls: number;
  /** Set when the run could not complete (timeout, boot error, agent.error). */
  error?: string;
  /**
   * For a run that timed out: `delegate_wait` when a real specialist was still working
   * when the run's wait ran out (a slow specialist, not a stuck coordinator); `run`
   * otherwise (#2027).
   */
  timeoutKind?: 'run' | 'delegate_wait';
  /** Every real specialist run the coordinator started (#2027). Absent for stubbed delegation. */
  delegations?: DelegationRecord[];
  /** Set when removing the run's rows failed; leftovers may be in the database. */
  cleanupError?: string;
  /**
   * Model spend on this run (#1980): the agents' calls, from every attempt (provider
   * retries included); the judge's are added when the run is rated.
   */
  usage: UsageBreakdown;
  /**
   * Attempts thrown away for a provider failure (stall, provider error, model fallback)
   * and run again, one reason each. The run above is the last attempt.
   */
  providerRetries: string[];
}

/** One real specialist run inside a scenario run (#2027). */
export interface DelegationRecord {
  agentId: string;
  /** The conversation the specialist ran in. */
  conversationId: string;
  /** The agent.task content the specialist received: the brief after the delegate handler's additions. */
  brief: string;
  /** The specialist's agent.response content, or null when it had not answered by the end of the run. */
  response: string | null;
  /**
   * answered: it responded. error: it responded with an error, or published agent.error.
   * in_flight: it was still working when the run ended (the delegate wait gave up, or the
   * run's own wait did).
   */
  outcome: 'answered' | 'error' | 'in_flight';
}

// ── Scoring ───────────────────────────────────────────────────────────────

export type BehaviorRating = 'PASS' | 'PARTIAL' | 'MISS';

export const RATING_VALUES: Record<BehaviorRating, number> = {
  PASS: 1,
  PARTIAL: 0.5,
  MISS: 0,
};

export interface RunRating {
  rating: BehaviorRating;
  justification: string;
}

export interface BehaviorResult {
  behavior: ExpectedBehavior;
  /** One rating per run, in run order. */
  ratings: RunRating[];
  /** Mean of RATING_VALUES over ratings (PARTIAL = 0.5). Feeds the weighted score. */
  passRate: number;
  /**
   * Share of runs rated a full PASS. The critical gate uses this, not passRate: the
   * binomial table behind "≥0.8 at 5 runs" assumes pass/fail, and with PARTIAL at 0.5
   * three PASS and two PARTIAL would clear 0.8 on a behavior that fully held 60% of the time.
   */
  strictPassRate: number;
}

export interface CaseResult {
  name: string;
  runs: ScenarioRun[];
  behaviors: BehaviorResult[];
  /** Σ(weight × passRate) / Σweight. */
  weightedScore: number;
  /** Critical behaviors whose strict pass rate is under CRITICAL_PASS_THRESHOLD. */
  criticalFailures: string[];
  /** Copied from the case: when set, criticalFailures are reported, not gated. */
  knownFailure?: { issue: string; reason: string };
  /** Runs where the judge itself failed (not the model) — reported as a gate failure. */
  judgeErrors: number;
  /** Model spend on the case: its runs' agents and judge calls. */
  usage: UsageBreakdown;
}

export interface SuiteResult {
  timestamp: string;
  model: string;
  commit?: string;
  /** Cases marked release_gate: false that this run left out (#2027). */
  onDemandSkipped?: string[];
  /** Runs each case actually got (a case's `runs` or --runs can differ from the default). */
  runsPerCase: Record<string, number>;
  cases: CaseResult[];
  passed: boolean;
  /**
   * Set when the run was narrowed (--case, --tags, --runs): its pass is not a release
   * gate result, whatever `passed` says.
   */
  filtered?: { caseFilter?: string; tags?: string[]; runs?: number };
  /** Critical failures in cases marked known_failure — reported, not gated. */
  knownFailures: string[];
  /** Notices that need a human but do not fail the gate (a known failure now passing). */
  warnings: string[];
  /** Non-behavioral reasons the suite failed (coverage gate, errored runs). */
  gateFailures: string[];
  durationMs: number;
  /** Cases run at once (--concurrency). A case's own runs are always one at a time. */
  concurrency: number;
  /** Estimated model spend: every case's plus `overheadUsage` (tests/shared/usage.ts). */
  usage: UsageBreakdown;
  /** Spend outside every run (should be ~0). */
  overheadUsage: UsageBreakdown;
}

/**
 * A `critical` behavior must pass at least this share of its runs. Not unanimity: at
 * 5 runs, unanimity fails a truly 95%-reliable behavior 22.6% of the time, while
 * 0.8 (≥4/5) fails it 2.3% of the time. The arithmetic is in tests/scenarios/README.md.
 */
export const CRITICAL_PASS_THRESHOLD = 0.8;

/** Default runs per case. See CRITICAL_PASS_THRESHOLD for why not 3. */
export const DEFAULT_RUNS = 5;
