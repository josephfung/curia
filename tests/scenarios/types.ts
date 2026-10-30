// tests/scenarios/types.ts — scenario suite (#1956).
//
// A scenario is one inbound message to the coordinator, or one task fired at a specialist
// (#2025), with seeded state and stubbed tools, run N times on the production prompt.
// Behaviors are scored per run, either in code (`check`) or by the LLM judge (no `check`).
import type { InjectionDrainPoint } from '../../src/bus/events.js';
import type { PrincipalBacklogCounts } from '../../src/agents/prompts/backlog-line.js';
import type { AutonomyFixture, OfficeIdentityFixture } from '../../src/startup/test-mode-stack.js';
import type { RecordedReview } from '../../src/startup/test-mode-sends.js';
import type { VerificationDelivery, VerificationStatus } from '../../src/verification/types.js';
import type { LiveSearchTally } from '../shared/live-search.js';
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
 * `any` for every agent in the run. Absent means the case's agent (the coordinator unless
 * the case sets `agent`), the only agent whose calls a stubbed-delegation run has.
 */
export type CheckAgent = string;

/** The agent a case reaches when it does not name one. */
export const COORDINATOR = 'coordinator';

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
   * Whether the coordinator left a note for the principal in a <note_for_principal> block,
   * which the runtime cuts out of a reply to a non-principal sender and the dispatcher
   * emails to the principal (prompt trim PR 5). `contains`: every string appears in the
   * note (case-insensitive).
   */
  | { kind: 'principal_note'; is: 'present' | 'absent'; contains?: string[] }
  /**
   * Limits on text the agent wrote (#2143): its reply, or one argument of every call it
   * made to a tool (the `message` of a `signal-send`). `maxWords` caps the word count;
   * `excludes` are case-insensitive regexes none may match. Silence, or no call to read,
   * is a miss: an empty message is not a short one.
   */
  | { kind: 'text'; of: TextSource; agent?: CheckAgent; maxWords?: number; excludes?: string[] }
  /**
   * Over what the recording transports took this run (`through_gateway` cases, #2312): at
   * least one delivered message (exactly `count` when set) matching every filter. `to` and
   * `cc_includes` name a seeded contact key, `principal`, or an address; `contains` and
   * `excludes` are case-insensitive substrings of the delivered text (subject and body). An
   * email draft is not a delivery; a sent draft is. `ownText`: match the reply's own text
   * only (subject and the body above a quoted message), so the sender's own quoted words do
   * not count as something Curia sent them.
   */
  | { kind: 'delivered'; channel?: DeliveryChannel; to?: string; ccIncludes?: string; contains?: string[]; excludes?: string[]; count?: number; ownText?: boolean; quoteContains?: string[]; turn?: DeliveryTurn }
  /** Nothing was delivered this run, or nothing to `to` when it is set. */
  | { kind: 'not_delivered'; to?: string }
  /**
   * An approval was raised this run (a held send or a gated tool): its row in the action log,
   * and what the principal is shown contains every one of `contains` (case-insensitive).
   */
  | { kind: 'held'; contains?: string[] }
  /**
   * No approval was raised this run; with `contains`, none showing every one of those texts.
   * Resolved or not, an approval raised during the run counts.
   */
  | { kind: 'not_held'; contains?: string[] }
  /**
   * Outreach was recorded this run (a row the run's sends wrote, or a seeded row they added
   * to), naming `domain` when set, with that `confirmed` flag when set.
   */
  | { kind: 'outreach_recorded'; domain?: string; confirmed?: boolean }
  /** The principal's answer to a personal-data ask was recorded this run for `label`. */
  | { kind: 'decision_recorded'; label: string; decision: 'yes' | 'no' }
  /**
   * The gateway's band review ruled on a detected item with `label` in a send's own text
   * (body or subject, not a quoted message) this run, with that `outcome` when set: whether
   * the path a case exists for was exercised at all (#2312).
   */
  | { kind: 'reviewed'; label: string; outcome?: ReviewOutcome }
  /**
   * Passes when any alternative passes. For a behavior the platform accepts in more
   * than one shape — e.g. delegate links an entry from `outbound_entry_id` or from its
   * id quoted in the brief (#1972).
   */
  | { kind: 'any_of'; checks: BehaviorCheck[] };

/** What a `text` check reads: the reply, or one argument of each call to a tool. */
export type TextSource = 'reply' | { tool: string; arg: string };

export type DeliveryChannel = 'email' | 'signal' | 'slack' | 'sms';

/** The check kinds that read what a through-gateway run sent (#2312). */
export const GATEWAY_CHECK_KINDS = ['delivered', 'not_delivered', 'held', 'not_held', 'outreach_recorded', 'decision_recorded', 'reviewed'] as const;

/** What a band review decided for a send. */
export type ReviewOutcome = RecordedReview['outcome'];
export const REVIEW_OUTCOMES: readonly ReviewOutcome[] = ['send', 'bounce', 'block', 'hold'];

export interface ExpectedBehavior {
  id: string;
  description: string;
  weight: BehaviorWeight;
  /** Absent → scored by the LLM judge from `description`. */
  check?: BehaviorCheck;
}

/**
 * What the run's agents read through pinned_context (`seed.pinned`, #2339). The harness
 * serves these instead of the database's own, so runs never see each other's documents
 * or the copied database's: an entry not named here reads as not yet created / not set.
 * Plain records and arrays, not Map/Set: the seed passes through resolveDatePlaceholders,
 * which rebuilds every object from its own entries.
 */
export interface SeedPinned {
  /** Document text by `/shared/` path, shown as the block shows a live document. */
  docs: Record<string, string>;
  /** Config value by `<namespace>/<key>`. */
  configs: Record<string, string>;
  /** Paths and `<namespace>/<key>` keys whose read fails: the block shows them as unavailable. */
  unavailable: string[];
}

/** A contact to create for the run. Referenced elsewhere as `{{contact:<key>}}`. */
export interface SeedContact {
  key: string;
  displayName: string;
  /** `trusted` is a grant made after creation (createContact refuses it), so seeding sets it then. */
  tier: 'trusted' | 'known' | 'unknown';
  kind?: 'person' | 'organization' | 'automated';
  role?: string;
  /** Channel identity used when this contact is the sender. */
  channel: string;
  identifier: string;
  /**
   * The principal has sent mail to this (email) contact: the principal-mailbox lookup the
   * Dispatcher makes for an unknown sender answers yes (#2227).
   */
  principalWrote?: boolean;
}

/**
 * A standing task (#2312): a `tasks` row with an originator, which band review reads as the
 * authority a send on it carries. Referenced as `{{task:<key>}}` (the row's id), e.g. as a
 * task wake's `inbound.task.id`.
 */
export interface SeedTask {
  key: string;
  title: string;
  /** The intent anchor. Default: the title. */
  intent?: string;
  /** Who started it: `principal` or a seeded contact key. */
  originator: string;
  /** The agent that owns it. Default: the coordinator. */
  agent: string;
}

/**
 * A `task_outreach` row (#2312): who Curia already contacted, so a reply from them links to
 * the task. Referenced as `{{outreach:<key>}}`.
 */
export interface SeedOutreach {
  key: string;
  /** A seeded task key. Absent: live-turn outreach, keyed by a conversation of its own. */
  task?: string;
  via: 'email' | 'web_form' | 'signal' | 'sms' | 'slack' | 'phone' | 'other';
  orgName?: string;
  /** Lowercased org domains, under example.test. */
  domains: string[];
  /** Addresses contacted, under example.test. */
  addresses: string[];
  /** Seeded contact keys contacted. */
  contacts: string[];
  summary: string;
  /** An explicit act on a principal turn (a strong link); false is a backstop guess (weak only). */
  confirmed: boolean;
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
  /**
   * Seeded contact keys the message was sent to (#2261). A reply from one of them gets
   * this entry in its recipient-matched block. Omitted: principal turns only.
   */
  recipients?: string[];
  /**
   * Messages the recipients already sent back on this entry, oldest first, recorded as the
   * Dispatcher records them (#2261). `from` is one of `recipients`. A task wake lists them.
   */
  replies?: { from: string; content: string }[];
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
 * A sign-in verification (#2017): a site waiting on a code, as the coordinator's per-turn
 * "## Sign-in verifications" block and the Dispatcher's code tracking read it. Referenced
 * as `{{verification:<key>}}` (the row's id).
 */
export interface SeedVerification {
  key: string;
  /** The site the principal asked about (stored as its registrable domain). */
  site: string;
  /** The page showing the challenge, often an identity provider. */
  pageDomain: string;
  delivery: VerificationDelivery;
  browserSessionId: string;
  /** The backlog task the errand belongs to, a fixed UUID the case's task stubs match on. */
  taskId?: string;
  /** Default `pending`. A closed row is still in the block for its recent window. */
  status: VerificationStatus;
  /**
   * Backdates the request; the expiry stays the configured 10 minutes after it, and a
   * closed row closes at its expiry. Default 1 for a pending row, 15 for any other (so an
   * `expired` one really is past its expiry).
   */
  requestedMinutesAgo: number;
  /**
   * Whether the block reads the browser session as alive. There is no browser in a run
   * (`web-browser` is stubbed), so this is what the case says the stub honours. Default:
   * alive while pending, gone otherwise.
   */
  sessionAlive: boolean;
}

/**
 * A channel identity the principal needs for the run (#2017): a case that sends as the
 * principal on a channel the database's principal may have no identity on. Seeding adds a
 * verified, active one only when the principal has no active identity on the channel, and
 * cleanup removes only that row.
 */
export interface SeedPrincipalIdentity {
  channel: string;
  identifier: string;
}

/**
 * The message the case's agent receives.
 * `from: principal` resolves through the stack's principal (channel `cli` by default;
 * any other channel uses the principal's own identity on it). `from: <contact key>`
 * uses that seeded contact's channel identity. Both reach the coordinator only, through
 * the Dispatcher. `from: bullpen` wakes the case's agent on a seeded thread the way
 * BullpenDispatcher does, with `content` as the new message. `from: scheduler` fires a
 * recurring job with no linked task the way the scheduler does: an agent.task on the
 * `scheduler` channel whose content is `{"task": content}`. `from: task-wake` fires a
 * task's `wake_at` (prompt trim PR 9): the body Scheduler.fireJob builds from `task`, with
 * the wake instruction. It has no `content`. `from: delegate` (#2025) fires a specialist
 * the way the coordinator's `delegate` call does: the agent.task the delegate handler
 * publishes, with `content` as the brief and the requester's originator forwarded.
 */
export interface ScenarioInbound {
  from: string;
  channel?: string;
  /** For a task wake, the body the coordinator receives, built when the run starts. */
  content: string;
  /** Bullpen only: the thread key the new message is posted on. */
  thread?: string;
  /**
   * Bullpen only: the agent that posts the new message. Default: the thread's creator. A
   * specialist's consult reply comes from the agent it consulted, on a thread it opened.
   */
  author?: string;
  /**
   * Delegate only: whose request the coordinator delegated — `principal` (the default) or
   * a seeded contact key. It sets the forwarded originator, so the specialist builds the
   * requester-identity block production gives it (#1871).
   */
  requester?: string;
  /** Task wake only: the woken task, as its row reads at fire time. */
  task?: ScenarioWakeTask;
  /** Email only: rendered as the email preamble the Dispatcher builds. */
  email?: {
    nylasMessageId?: string;
    /** The named account that received it (the inbound's accountId); the preamble's Account line. */
    account?: string;
    autoGenerated?: boolean;
    autoGeneratedSignals?: string[];
    /**
     * The envelope's To and CC: `curia` (Curia's own address), `principal`, a seeded contact
     * key, or an address under example.test. With them the email reads as the adapter
     * builds it: participants, the To list as primary recipients, and `curiaRole: 'cc'`
     * when `curia` is in `cc` (the Dispatcher's [OWNER CC] preamble). Without them, the
     * participants are the sender alone.
     */
    to?: string[];
    cc?: string[];
    /**
     * The adapter's `senderVerified` (SPF, DKIM and DMARC pass). Unset leaves it out of the
     * metadata, as before #2227.
     */
    senderVerified?: boolean;
  };
  /**
   * A second message published while the first turn is still running (#2018).
   * Capture still expects one reply: the follow-up joins that turn when injection
   * is on, and a second turn on the same conversation fails the run.
   */
  followup?: ScenarioFollowup;
  /**
   * The principal's next message, as its own turn once the first has ended (#2312): an
   * inbound from the principal's verified identity on `channel`, in a second conversation of
   * the same run. It is a live principal turn, so the elevated gate is production's: this is
   * how a hold raised on someone else's turn gets approved within the run. Its calls join the
   * run's; its reply is `then.reply` on the run.
   */
  then?: ScenarioPrincipalTurn;
}

/** A principal turn after the first one (ScenarioInbound.then). */
export interface ScenarioPrincipalTurn {
  content: string;
  /** A channel the principal has a verified identity on (seed one with principal_identities). */
  channel: string;
  /**
   * Email only (#2333): the turn is a reply on the thread of the approval email the run
   * delivered to the principal, as Nylas threads a reply, instead of a fresh email.
   */
  replyToApproval?: boolean;
}

/** When the harness publishes `ScenarioInbound.followup`. */
export type ScenarioFollowupAfter = 'first_tool_call' | { ms: number };

/**
 * A same-conversation message sent during the turn under test (#2018).
 * `from` is `principal` or a seeded contact key. Injection only lands it in
 * the live turn when that sender is the same contact as the holder.
 */
export interface ScenarioFollowup {
  after: ScenarioFollowupAfter;
  from: string;
  content: string;
  /** Defaults to the inbound's channel. */
  channel?: string;
}

/**
 * The task a `from: task-wake` case wakes. No row is written: the wake body carries what
 * the coordinator reads, and the case stubs the task tools it calls on `id`.
 */
export interface ScenarioWakeTask {
  /** A fixed UUID, so stubs can match task-update / task-complete on it. */
  id: string;
  title: string;
  /** The task's intent_anchor, which the runtime injects into the system prompt. */
  intent: string;
  /** progress.notes, oldest first, as task-update appends them. */
  notes: { at: string; note: string }[];
  /** The task's tags, as Scheduler.fireJob puts them on the bound task (e.g. `debrief-pending`). */
  tags?: string[];
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
  /**
   * The agent the inbound reaches and whose turn is scored (#2025): its reply ends the run,
   * and checks read its calls unless they name another agent. Default `coordinator`. A
   * specialist is reached by a `delegate`, `bullpen` or `scheduler` inbound.
   */
  agent: string;
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
    verifications: SeedVerification[];
    principalIdentities: SeedPrincipalIdentity[];
    /** Standing tasks (#2312). */
    tasks: SeedTask[];
    /** Outreach rows (#2312). */
    outreach: SeedOutreach[];
    /** Pinned-context documents and settings (#2339). Absent: every entry reads as unset. */
    pinned?: SeedPinned;
    /**
     * What is waiting on the principal on this run's principal turn (prompt trim PR 7):
     * the counts the Dispatcher's backlog line reports. Absent means nothing is waiting.
     */
    backlog?: PrincipalBacklogCounts;
  };
  inbound: ScenarioInbound;
  toolStubs: Record<string, ToolStub[]>;
  /**
   * Tools the case stubbed itself (tool_stubs and named stub_sets), as opposed to the
   * `defaults` set every case gets. Only these must name a tool the coordinator is
   * offered — a default for a tool this registry did not load is simply unused.
   */
  explicitStubTools: string[];
  /**
   * Tools the case's own tool_stubs name, without its stub sets'. A case aimed at a
   * specialist (#2025) holds only these to the agent's reach: a shared set such as
   * human-channels stubs sends a narrow specialist never has, and those stubs go unused.
   */
  ownStubTools: string[];
  /**
   * web-search runs for real instead of answering from `defaults` (#2106): for a case
   * about searching itself. Each call spends a Tavily credit.
   */
  liveSearch?: true;
  expectedBehaviors: ExpectedBehavior[];
  failureModes: string[];
  /**
   * The office identity fixture the case runs under (#2143), from
   * tests/scenarios/identities/<name>.yaml. The stack is the run's, so every case in a
   * run shares one identity; such a case is never in the release gate.
   */
  identity?: IdentityFixture;
  /**
   * The autonomy score and gating the case runs under, laid over the database's. Unlike
   * `identity` it is the case's own (#2312): each attempt enters it, so cases under
   * different fixtures share a run, and such a case can be in the release gate.
   */
  autonomy?: AutonomyFixture;
  /**
   * Send tools run their real handlers through production's gateway review (#2312): PII
   * detection, the content filter, band review, holds and asks, outreach records. The
   * transports record instead of sending. THROUGH_GATEWAY_TOOLS skip the stub table, and the
   * gateway check kinds read what they sent. Each send calls the review's judges.
   */
  throughGateway?: true;
  /** File the case came from, for messages. */
  sourceFile: string;
}

/** A run-level office identity (tests/scenarios/identities/). */
export interface IdentityFixture {
  name: string;
  /**
   * The style the fixture sets, in plain words, for the judge. Kept apart from `config` so
   * the judge reads the same target whatever shape the identity takes.
   */
  judgeBrief: string;
  config: OfficeIdentityFixture;
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
  /** The case agent's agent.response content (NO_REPLY included verbatim). */
  reply: string | null;
  /**
   * A note for the principal cut out of the reply to a non-principal sender, which the
   * dispatcher emails to the principal (prompt trim PR 5). Absent when there was none.
   */
  principalNote?: string;
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
  /**
   * Drain points of follow-ups joined into this run (#2018). A `turn_start`
   * point fails the run: the correction arrived before the model had chosen.
   * Absent when the case publishes no follow-up.
   */
  injectionDrainPoints?: InjectionDrainPoint[];
  /** Every real specialist run the coordinator started (#2027). Absent for stubbed delegation. */
  delegations?: DelegationRecord[];
  /** What a through-gateway run sent, held and recorded (#2312). Absent for other cases. */
  gateway?: GatewayOutcome;
  /** The principal's `inbound.then` turn (#2312): the coordinator's reply to it. */
  then?: { reply: string | null };
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

/** What a through-gateway run's sends did (#2312), read when the run ends. */
export interface GatewayOutcome {
  /** Every message a recording transport took, in order. */
  deliveries: RecordedDelivery[];
  /** Approvals raised in the run's conversations, in order. */
  holds: RecordedHold[];
  /** Outreach rows the run's sends wrote, or seeded rows they added to. */
  outreach: RecordedOutreach[];
  /** The principal's answers to personal-data asks, recorded in the run's conversations. */
  decisions: RecordedDecision[];
  /**
   * Each band review of the run's sends, labels and outcome only (#2312). Absent on results
   * saved before it existed.
   */
  reviews?: RecordedReview[];
  /**
   * The band review's fail-open cap tripped in this run: its judge failed on too many sends,
   * so later sends held for want of a reviewer. The run is then an error, not a score.
   */
  reviewerFailedOpen: boolean;
}

/** Which principal-facing turn a delivery happened in (#2333): before `inbound.then`, or in or after it. */
export type DeliveryTurn = 'first' | 'then';

export interface RecordedDelivery {
  channel: DeliveryChannel;
  /** Set on a case with `inbound.then`: whether it went out before that turn began. */
  turn?: DeliveryTurn;
  /** `draft`: created, not delivered. */
  kind: 'send' | 'draft';
  to: string[];
  cc: string[];
  /** The recipients as the case names them: a seeded contact key, `principal`, or the address. */
  toNames: string[];
  ccNames: string[];
  subject?: string;
  body: string;
  /** An email reply's own text, above the quoted message; absent when nothing was quoted. */
  ownBody?: string;
  /** The quoted message below it; absent when nothing was quoted. */
  quotedBody?: string;
}

export interface RecordedHold {
  shortRef: string;
  approvalNumber: number | null;
  toolName: string;
  /** The row's outcome now: pending_approval, or how it was resolved during the run. */
  outcome: string;
  description: string | null;
  /** What the principal is shown at the top of the approval (an ask's question), when registered. */
  preamble?: string;
  extraLines?: string[];
  /**
   * The held message's own text as the approval shows it: subject, body or message, never the
   * quoted thread (#2333). Approving sends it, so a check on what is offered reads it here.
   */
  message?: string;
}

export interface RecordedOutreach {
  domains: string[];
  addresses: string[];
  confirmed: boolean;
  via: string;
  /** A seeded row the run's sends added to. */
  seeded: boolean;
}

export interface RecordedDecision {
  label: string;
  decision: 'yes' | 'no';
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
  /** The --reasoning-effort arm, e.g. "standard=low (other tiers as configured)" (ADR-048). Absent in older results. */
  reasoning?: string;
  commit?: string;
  /** With --overlay: the deployment repo's commit, whose agents and cases ran. */
  overlayCommit?: string;
  /** Cases marked release_gate: false that this run left out (#2027). */
  onDemandSkipped?: string[];
  /** The office identity fixture every case ran under (#2143). Absent: the database's own. */
  identity?: string;
  /**
   * The autonomy cases without a fixture ran under, read back from the stack at boot, e.g.
   * "84 (band gating)" or "none (no autonomy_config row)".
   */
  autonomy?: string;
  /** Cases that ran under their own autonomy fixture (#2312), by name, e.g. "74 (band gating)". */
  caseAutonomy?: Record<string, string>;
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
  /** web-search calls that reached Tavily (#2106). Absent on results saved before it existed. */
  liveSearch?: LiveSearchTally;
}

/**
 * A `critical` behavior must pass at least this share of its runs. Not unanimity: at
 * 5 runs, unanimity fails a truly 95%-reliable behavior 22.6% of the time, while
 * 0.8 (≥4/5) fails it 2.3% of the time. The arithmetic is in tests/scenarios/README.md.
 */
export const CRITICAL_PASS_THRESHOLD = 0.8;

/** Default runs per case. See CRITICAL_PASS_THRESHOLD for why not 3. */
export const DEFAULT_RUNS = 5;
