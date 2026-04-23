import { randomUUID } from 'node:crypto';
import type { ErrorType } from '../errors/types.js';
import type { DedupConfidence } from '../contacts/types.js';
import type { Sensitivity } from '../memory/types.js';

// -- Base event shape --
// Every event on the bus shares these fields; parentEventId forms the causal chain.

interface BaseEvent {
  id: string;
  timestamp: Date;
  parentEventId?: string;
}

// -- Layer type --
// Describes which architectural layer produced the event.

export type Layer = 'channel' | 'dispatch' | 'agent' | 'execution' | 'system';

// -- Event payloads --

interface InboundMessagePayload {
  conversationId: string;
  channelId: string;
  /** Which named account received this message (e.g. "curia", "joseph").
   *  Set by the channel adapter; used by the dispatcher to route replies back
   *  to the same account. Absent for channels without multi-account support
   *  (Signal, CLI). */
  accountId?: string;
  senderId: string;
  content: string;
  metadata?: Record<string, unknown>;
}

interface AgentTaskPayload {
  agentId: string;
  conversationId: string;
  channelId: string;
  /** Propagated from the originating inbound.message — identifies which email account
   *  to reply from. Absent for Signal, CLI, and other single-account channels. */
  accountId?: string;
  senderId: string;
  content: string;
  metadata?: Record<string, unknown>;
  /** Resolved sender context from the contact resolver. Undefined if contacts not configured. */
  senderContext?: import('../contacts/types.js').InboundSenderContext;
  /** Original task intent for persistent scheduler tasks. Undefined for one-shot and direct tasks.
   *  Injected into effectiveSystemPrompt by the runtime to prevent multi-burst drift. */
  intentAnchor?: string;
  /** Computed message trust score (0.0–1.0). Present when trust scoring is configured.
   *  Combines channel trust, contact confidence, and content risk signal.
   *  Not present on tasks created without a contact resolver (e.g. bullpen tasks). */
  messageTrustScore?: number;
  /** Expected duration hint from the scheduler, in seconds. Set when the originating
   *  scheduled_job has an explicit expected_duration_seconds value. The runtime uses this
   *  to automatically widen the delegate skill timeout for long-running scheduled tasks.
   *  Absent for interactive tasks (direct messages, bullpen, etc.). */
  expectedDurationSeconds?: number;
}

interface AgentResponsePayload {
  agentId: string;
  conversationId: string;
  content: string;
}

interface OutboundMessagePayload {
  conversationId: string;
  channelId: string;
  /** Which named account should send this reply. Propagated from the inbound routing
   *  table so the email adapter uses the same account that received the original message.
   *  Absent for Signal, CLI, and other single-account channels. */
  accountId?: string;
  content: string;
}

// OutboundBlockedPayload — emitted by the dispatch layer's content filter when an outbound
// message is blocked before delivery. `findings` lists each rule that triggered and why,
// providing an audit trail for security review and incident response.
interface OutboundBlockedPayload {
  blockId: string;
  conversationId: string;
  channelId: string;
  content: string;         // the blocked content (stored for forensics)
  recipientId: string;     // the intended external recipient that was protected
  reason: string;          // human-readable summary of why the message was blocked
  findings: Array<{ rule: string; detail: string }>;
}

interface SkillInvokePayload {
  agentId: string;
  conversationId: string;
  skillName: string;
  input: Record<string, unknown>;
  taskEventId: string;  // traces back to the agent.task that triggered this
}

interface SkillResultPayload {
  agentId: string;
  conversationId: string;
  skillName: string;
  result: { success: true; data: unknown } | { success: false; error: string };
  durationMs: number;
}

// Agent error payload — published by the agent runtime when an error occurs
// that the user needs to know about (budget exceeded, unrecoverable failure, etc.)
interface AgentErrorPayload {
  agentId: string;
  conversationId: string;
  errorType: ErrorType;
  source: string;
  message: string;
  retryable: boolean;
  context: Record<string, unknown>;
}

// AgentDiscussPayload — emitted by the agent layer when a Bullpen message is posted.
// `participants` is the full thread membership; `mentionedAgentIds` is the subset
// that BullpenDispatcher will create tasks for (may be empty for broadcast messages).
interface AgentDiscussPayload {
  threadId: string;
  messageId: string;           // DB row ID — for audit traceability
  topic: string;               // denormalized for SSE display without a DB hit
  senderAgentId: string;
  participants: string[];      // all thread participants
  mentionedAgentIds: string[]; // subset that get reply-expected tasks (empty = broadcast)
  content: string;
}

// Contact event payloads — emitted by the dispatch layer during contact resolution (Contacts Phase A).

interface ContactResolvedPayload {
  contactId: string;
  displayName: string;
  role: string | null;
  kgNodeId: string | null;
  // 'verified' means the contact has been confirmed via an authoritative source (e.g. KG match);
  // 'unverified' means the identity was inferred but not confirmed.
  verificationStatus: 'verified' | 'unverified';
  channel: string;
  channelIdentifier: string;
}

interface ContactUnknownPayload {
  channel: string;
  senderId: string;
  /** Channel trust level — required for trust score audit trail. */
  channelTrustLevel: 'low' | 'medium' | 'high';
  /** Computed message trust score for this unknown sender's message. */
  messageTrustScore: number;
  /** Routing decision applied to this unknown sender — mirrors the configured per-channel policy. */
  routingDecision: 'allow' | 'hold_and_notify' | 'ignore';
}

// contact.duplicate_detected — published when a newly-created contact scores above
// the 'certain' threshold against an existing contact. Fires non-blocking from
// ContactService.createContact() when a DedupService is wired.
interface ContactDuplicateDetectedPayload {
  newContactId: string;
  probableMatchId: string;
  confidence: DedupConfidence;
  reason: string;
}

// contact.merged — published when two contacts have been successfully merged.
interface ContactMergedPayload {
  primaryContactId: string;
  secondaryContactId: string;
  mergedAt: Date;
}

interface MessageHeldPayload {
  heldMessageId: string;
  channel: string;
  senderId: string;
  subject: string | null;
}

// MessageRejectedPayload — emitted by the dispatch layer when a message is rejected
// due to an unknown_sender: ignore policy (or a blocked sender). The conversationId
// is included so the HTTP adapter can immediately resolve the pending response
// with an error rather than hanging until the 120-second timeout.
interface MessageRejectedPayload {
  conversationId: string;
  channelId: string;
  senderId: string;
  /** Why the message was rejected — used by the HTTP adapter to select the status code.
   * 'message_too_large' is set when the message body exceeds the configured size limit.
   * 'global_rate_limited' / 'sender_rate_limited' are set when rate limits are exceeded. */
  reason: 'unknown_sender' | 'provisional_sender' | 'blocked_sender' | 'message_too_large' | 'global_rate_limited' | 'sender_rate_limited';
  /** UTF-8 byte size of the rejected message content. Present when reason is 'message_too_large'. */
  size?: number;
  /** Configured max_message_bytes limit at the time of rejection. Present when reason is 'message_too_large'. */
  limit?: number;
}

// Memory event payloads — used for the knowledge graph audit trail (Phase 6).
// `source` is a structured provenance string (e.g. "agent:coordinator/task:task-1/channel:cli").

interface MemoryStorePayload {
  agentId: string;
  conversationId: string;
  nodeId: string;
  nodeType: string;
  label: string;
  source: string;
  /** Sensitivity level assigned to the node at creation time (#200). */
  sensitivity: Sensitivity;
}

interface MemoryQueryPayload {
  agentId: string;
  conversationId: string;
  queryType: string; // 'entity' | 'search' | 'facts'
  queryParams: Record<string, unknown>;
  resultCount: number;
}

// Schedule event payloads — emitted by the scheduler (system layer) for audit trail.

interface ScheduleCreatedPayload {
  jobId: string;
  agentId: string;
  cronExpr: string | null;
  runAt: string | null;
  taskPayload: Record<string, unknown>;
  createdBy: string;
}

interface ScheduleFiredPayload {
  jobId: string;
  agentId: string;
  agentTaskId: string | null;
}

interface ScheduleSuspendedPayload {
  jobId: string;
  agentId: string;
  lastError: string;
  consecutiveFailures: number;
}

interface ScheduleRecoveredPayload {
  jobId: string;
  agentId: string;
  /** ISO timestamp when the job entered 'running' state. Null if pre-migration. */
  runStartedAt: string | null;
  /** Computed timeout threshold that was exceeded, in seconds. */
  timeoutSeconds: number;
  /** Value of consecutive_failures after incrementing for this recovery. */
  consecutiveFailures: number;
  /** True if the job was suspended rather than reset to pending. */
  suspended: boolean;
}

interface ScheduleDriftPausedPayload {
  jobId: string;
  agentId: string;
  agentTaskId: string;
  intentAnchor: string;
  taskPayload: Record<string, unknown>;
  lastRunSummary: string | null;
  verdict: {
    drifted: boolean;
    reason: string;
    confidence: 'high' | 'medium' | 'low';
  };
}

// ConfigChangePayload — emitted by the System layer whenever a config object changes.
// Currently only used by OfficeIdentityService (config_type: 'office_identity').
// The diff_summary is a human-readable description of what changed; it is not machine-parseable.
interface ConfigChangePayload {
  config_type: string;          // e.g. 'office_identity'
  version: number;              // new version number
  previous_version: number;     // previous version number (0 if this is the first)
  changed_by: string;           // 'wizard' | 'api' | 'file_load'
  note?: string;                // optional human-readable reason
  diff_summary: string;         // human-readable summary of what changed
}

// LlmCallPayload — emitted by the agent runtime after every LLM API call completes.
// Provides model provenance, token accounting, timing, and content fingerprints for audit.
// Spec 10 (audit log hardening): required by NIST AI 600-1, EU AI Act Article 12, OWASP LLM10.
// Multiple llm.call events may share the same agent.task parent (one per LLM round-trip in
// multi-turn tool-use loops).
interface LlmCallPayload {
  agentId: string;
  conversationId: string;
  // Model provenance — what was requested vs. what actually ran (provider may alias)
  requestedModel: string;       // e.g. 'claude-sonnet-4-6'
  actualModel: string;          // from the API response (may differ if provider aliases)
  provider: string;             // 'anthropic' | 'openai' | 'ollama'
  // Token accounting
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;     // computed from provider pricing at call time
  // Timing
  latencyMs: number;
  // Upstream correlation — enables cross-referencing with the provider's own audit logs
  providerRequestId: string;    // Anthropic: x-request-id header; OpenAI: x-request-id header
  // Content fingerprints — SHA-256 of full prompt/response (not raw content;
  // full prompts/responses go in llm_call_archive, see spec 10)
  promptHash: string;
  responseHash: string;
}

// SecretAccessedPayload — emitted by the execution layer whenever a skill calls ctx.secret().
// Records which skill accessed which secret, from which agent/task — never the secret value.
// This is the primary audit trail for secrets isolation (spec 06, Secrets Isolation).
interface SecretAccessedPayload {
  skillName: string;
  secretName: string;     // the declared key name — never the resolved value
  agentId?: string;       // agent that invoked the skill
  taskEventId?: string;   // causal chain: the agent.task that triggered this invocation
}

// HumanDecisionPayload — emitted by the dispatch layer when a human approves, denies, or
// reviews an agent action. Captures the full decision context for compliance and audit.
// Spec 10 (audit log hardening): required by EU AI Act Article 14, HITL audit standards.
// Used for: outbound email approval gates, unknown-sender decisions, elevated skill approvals,
// and any future human-in-the-loop gate. Timeout decisions use decision: 'timeout'.
interface HumanDecisionPayload {
  // What was decided
  decision: 'approve' | 'deny' | 'modify' | 'escalate' | 'timeout';
  // Who decided
  deciderId: string;            // sender ID of the human who made the decision
  deciderChannel: string;       // channel through which the decision was made
  // What they were deciding on
  subjectEventId: string;       // audit event ID of the action that required human review
  subjectSummary: string;       // human-readable description of what was being decided
  // Decision context
  contextShown: string[];       // list of information items presented to the human
  rationale?: string;           // optional: reason provided by the human
  // Timing — presentedAt/decidedAt captures time-to-decide for compliance analysis
  presentedAt: Date;            // when the decision was presented to the human
  decidedAt: Date;              // when the human responded (or timeout fired)
  // What would have happened without intervention
  defaultAction: string;        // 'block' | 'allow' | 'queue' — system's default if no response
  // Autonomy context
  autonomyTier?: string;        // which autonomy tier was in effect (e.g., 'unknown_sender')
}


// -- Discriminated union --
// The `type` field is the discriminant; `sourceLayer` records which layer emitted the event.

export interface InboundMessageEvent extends BaseEvent {
  type: 'inbound.message';
  sourceLayer: 'channel';
  payload: InboundMessagePayload;
}

export interface AgentTaskEvent extends BaseEvent {
  type: 'agent.task';
  sourceLayer: 'dispatch';
  payload: AgentTaskPayload;
}

export interface AgentResponseEvent extends BaseEvent {
  type: 'agent.response';
  sourceLayer: 'agent';
  payload: AgentResponsePayload;
}

export interface OutboundMessageEvent extends BaseEvent {
  type: 'outbound.message';
  sourceLayer: 'dispatch';
  payload: OutboundMessagePayload;
}

// OutboundBlockedEvent — published by the dispatch layer when the content filter
// intercepts and blocks an outbound message. Channel adapters subscribe to this so
// they can surface a failure signal to the user (e.g., "message could not be sent").
// System layer subscribes for audit logging and security monitoring.
export interface OutboundBlockedEvent extends BaseEvent {
  type: 'outbound.blocked';
  sourceLayer: 'dispatch';
  payload: OutboundBlockedPayload;
}

export interface SkillInvokeEvent extends BaseEvent {
  type: 'skill.invoke';
  sourceLayer: 'agent';
  payload: SkillInvokePayload;
}

export interface SkillResultEvent extends BaseEvent {
  type: 'skill.result';
  // sourceLayer is 'execution' because the result logically comes from the execution layer,
  // even though the agent layer publishes it on behalf (execution layer has no bus access in Phase 3).
  sourceLayer: 'execution';
  payload: SkillResultPayload;
}

export interface AgentErrorEvent extends BaseEvent {
  type: 'agent.error';
  sourceLayer: 'agent';
  payload: AgentErrorPayload;
}

export interface AgentDiscussEvent extends BaseEvent {
  type: 'agent.discuss';
  sourceLayer: 'agent';
  payload: AgentDiscussPayload;
}

// Contact events — emitted by the dispatch layer during the contact resolution step.
// contact.resolved fires when a sender maps to a known contact; contact.unknown fires when no match is found.

export interface ContactResolvedEvent extends BaseEvent {
  type: 'contact.resolved';
  sourceLayer: 'dispatch';
  payload: ContactResolvedPayload;
}

export interface ContactUnknownEvent extends BaseEvent {
  type: 'contact.unknown';
  sourceLayer: 'dispatch';
  payload: ContactUnknownPayload;
}

export interface ContactDuplicateDetectedEvent extends BaseEvent {
  type: 'contact.duplicate_detected';
  sourceLayer: 'dispatch';
  payload: ContactDuplicateDetectedPayload;
}

export interface ContactMergedEvent extends BaseEvent {
  type: 'contact.merged';
  sourceLayer: 'dispatch';
  payload: ContactMergedPayload;
}

export interface MessageHeldEvent extends BaseEvent {
  type: 'message.held';
  sourceLayer: 'dispatch';
  payload: MessageHeldPayload;
}

export interface MessageRejectedEvent extends BaseEvent {
  type: 'message.rejected';
  sourceLayer: 'dispatch';
  payload: MessageRejectedPayload;
}


// Memory events — emitted by the agent layer whenever the knowledge graph is written to or queried.
// These form the audit trail for memory operations (Phase 6).

export interface MemoryStoreEvent extends BaseEvent {
  type: 'memory.store';
  sourceLayer: 'agent';
  payload: MemoryStorePayload;
}

export interface MemoryQueryEvent extends BaseEvent {
  type: 'memory.query';
  sourceLayer: 'agent';
  payload: MemoryQueryPayload;
}

export interface ScheduleCreatedEvent extends BaseEvent {
  type: 'schedule.created';
  sourceLayer: 'system';
  payload: ScheduleCreatedPayload;
}

export interface ScheduleFiredEvent extends BaseEvent {
  type: 'schedule.fired';
  sourceLayer: 'system';
  payload: ScheduleFiredPayload;
}

export interface ScheduleSuspendedEvent extends BaseEvent {
  type: 'schedule.suspended';
  sourceLayer: 'system';
  payload: ScheduleSuspendedPayload;
}

export interface ScheduleRecoveredEvent extends BaseEvent {
  type: 'schedule.recovered';
  sourceLayer: 'system';
  payload: ScheduleRecoveredPayload;
}

export interface ScheduleDriftPausedEvent extends BaseEvent {
  type: 'schedule.drift_paused';
  sourceLayer: 'system';
  payload: ScheduleDriftPausedPayload;
}

export interface ConfigChangeEvent extends BaseEvent {
  type: 'config.change';
  sourceLayer: 'system';
  payload: ConfigChangePayload;
}

// LlmCallEvent — published by the agent layer after every LLM API call.
// parentEventId references the agent.task that triggered it.
export interface LlmCallEvent extends BaseEvent {
  type: 'llm.call';
  sourceLayer: 'agent';
  payload: LlmCallPayload;
}

// HumanDecisionEvent — published by the dispatch layer when a human resolves an approval gate.
// parentEventId references the event (e.g., outbound.message, message.held) that triggered the gate.
export interface HumanDecisionEvent extends BaseEvent {
  type: 'human.decision';
  sourceLayer: 'dispatch';
  payload: HumanDecisionPayload;
}

// SecretAccessedEvent — published by the execution layer for every ctx.secret() call.
// Goes through the write-ahead audit logger like all bus events, giving a durable
// record of which skill accessed which secret without the value ever leaving the process.
export interface SecretAccessedEvent extends BaseEvent {
  type: 'secret.accessed';
  sourceLayer: 'execution';
  payload: SecretAccessedPayload;
}

interface ConversationCheckpointPayload {
  conversationId: string;
  agentId: string;
  channelId: string;
  /** ISO timestamp — turns created after this point are included. Empty string on first checkpoint. */
  since: string;
  /** ISO timestamp of the newest turn in this batch. Used as the new watermark value
   *  in conversation_checkpoints.last_checkpoint_at; avoids advancing the watermark past
   *  turns that arrived between the DB read and the upsert. */
  through: string;
  /** Ordered chronologically (oldest first). Contains only turns since `since`. */
  turns: Array<{ role: 'user' | 'assistant'; content: string }>;
}

export interface ConversationCheckpointEvent extends BaseEvent {
  type: 'conversation.checkpoint';
  sourceLayer: 'dispatch';
  payload: ConversationCheckpointPayload;
}

export type BusEvent =
  | InboundMessageEvent
  | AgentTaskEvent
  | AgentResponseEvent
  | OutboundMessageEvent
  | SkillInvokeEvent
  | SkillResultEvent
  | AgentErrorEvent          // Error recovery: structured error events for audit and user notification
  | AgentDiscussEvent        // Bullpen: inter-agent discussion message
  | MemoryStoreEvent      // Phase 6: knowledge graph write audit
  | MemoryQueryEvent      // Phase 6: knowledge graph read audit
  | ContactResolvedEvent  // Contacts Phase A: sender matched to a known contact
  | ContactUnknownEvent   // Contacts Phase A: sender has no contact record
  | ContactDuplicateDetectedEvent   // Dedup: new contact matches an existing one
  | ContactMergedEvent              // Dedup: two contacts have been merged
  | MessageHeldEvent      // Unknown sender policy: message held for CEO review
  | MessageRejectedEvent  // Unknown sender policy: message rejected, signals HTTP adapter to return 403
  | OutboundBlockedEvent  // Outbound content filter: message blocked before delivery (#38)
  | ScheduleCreatedEvent   // Scheduler: job created
  | ScheduleFiredEvent     // Scheduler: job fired
  | ScheduleSuspendedEvent   // Scheduler: job auto-suspended
  | ScheduleRecoveredEvent   // Scheduler: stuck job auto-recovered
  | ScheduleDriftPausedEvent  // Scheduler: job paused due to intent drift detection
  | ConfigChangeEvent        // System: config object changed (office identity, etc.)
  | ConversationCheckpointEvent // Checkpoint pipeline: Dispatch fires after inactivity window
  | LlmCallEvent             // Spec 10: LLM API call provenance (model, tokens, cost, hashes)
  | HumanDecisionEvent       // Spec 10: human-in-the-loop decision record (approve/deny/etc.)
  | SecretAccessedEvent;     // Spec 06: secrets isolation audit trail (name only, never value)

// Convenience alias for use in handler maps / switch statements.
export type EventType = BusEvent['type'];

// -- Factory functions --
// Factories assign UUIDs and timestamps so callers never need to provide them.

export function createInboundMessage(
  payload: InboundMessagePayload,
  parentEventId?: string,
): InboundMessageEvent {
  return {
    id: randomUUID(),
    timestamp: new Date(),
    type: 'inbound.message',
    sourceLayer: 'channel',
    payload,
    parentEventId,
  };
}

export function createAgentTask(
  // parentEventId is required for agent.task — every task must trace back to a trigger event.
  payload: AgentTaskPayload & { parentEventId: string },
): AgentTaskEvent {
  const { parentEventId, ...rest } = payload;
  return {
    id: randomUUID(),
    timestamp: new Date(),
    type: 'agent.task',
    sourceLayer: 'dispatch',
    payload: rest,
    parentEventId,
  };
}

export function createAgentResponse(
  // parentEventId is required — responses must reference the task that prompted them.
  payload: AgentResponsePayload & { parentEventId: string },
): AgentResponseEvent {
  const { parentEventId, ...rest } = payload;
  return {
    id: randomUUID(),
    timestamp: new Date(),
    type: 'agent.response',
    sourceLayer: 'agent',
    payload: rest,
    parentEventId,
  };
}

export function createOutboundMessage(
  // parentEventId is required — outbound messages must trace back to the response that generated them.
  payload: OutboundMessagePayload & { parentEventId: string },
): OutboundMessageEvent {
  const { parentEventId, ...rest } = payload;
  return {
    id: randomUUID(),
    timestamp: new Date(),
    type: 'outbound.message',
    sourceLayer: 'dispatch',
    payload: rest,
    parentEventId,
  };
}

export function createOutboundBlocked(
  // parentEventId is required — every blocked event must trace back to the agent.response that was intercepted.
  payload: OutboundBlockedPayload & { parentEventId: string },
): OutboundBlockedEvent {
  const { parentEventId, ...rest } = payload;
  return {
    id: randomUUID(),
    timestamp: new Date(),
    type: 'outbound.blocked',
    sourceLayer: 'dispatch',
    payload: rest,
    parentEventId,
  };
}

export function createSkillInvoke(
  // parentEventId is required — every skill invocation must trace back to the agent.task that triggered it.
  payload: SkillInvokePayload & { parentEventId: string },
): SkillInvokeEvent {
  const { parentEventId, ...rest } = payload;
  return {
    id: randomUUID(),
    timestamp: new Date(),
    type: 'skill.invoke',
    sourceLayer: 'agent',
    payload: rest,
    parentEventId,
  };
}

export function createSkillResult(
  // parentEventId is required — results must reference the skill.invoke event they respond to.
  payload: SkillResultPayload & { parentEventId: string },
): SkillResultEvent {
  const { parentEventId, ...rest } = payload;
  return {
    id: randomUUID(),
    timestamp: new Date(),
    type: 'skill.result',
    sourceLayer: 'execution',
    payload: rest,
    parentEventId,
  };
}

export function createAgentError(
  // parentEventId is required — error events must trace back to the task that triggered them.
  payload: AgentErrorPayload & { parentEventId: string },
): AgentErrorEvent {
  const { parentEventId, ...rest } = payload;
  return {
    id: randomUUID(),
    timestamp: new Date(),
    type: 'agent.error',
    sourceLayer: 'agent',
    payload: rest,
    parentEventId,
  };
}

export function createAgentDiscuss(
  // parentEventId is required — every discuss event must trace back to the agent.task that triggered it.
  payload: AgentDiscussPayload & { parentEventId: string },
): AgentDiscussEvent {
  const { parentEventId, ...rest } = payload;
  return {
    id: randomUUID(),
    timestamp: new Date(),
    type: 'agent.discuss',
    sourceLayer: 'agent',
    payload: rest,
    parentEventId,
  };
}

export function createMemoryStore(
  // parentEventId is required — every memory write must trace back to the agent.task that triggered it.
  payload: MemoryStorePayload & { parentEventId: string },
): MemoryStoreEvent {
  const { parentEventId, ...rest } = payload;
  return {
    id: randomUUID(),
    timestamp: new Date(),
    type: 'memory.store',
    sourceLayer: 'agent',
    payload: rest,
    parentEventId,
  };
}

export function createMemoryQuery(
  // parentEventId is required — every memory read must trace back to the agent.task that triggered it.
  payload: MemoryQueryPayload & { parentEventId: string },
): MemoryQueryEvent {
  const { parentEventId, ...rest } = payload;
  return {
    id: randomUUID(),
    timestamp: new Date(),
    type: 'memory.query',
    sourceLayer: 'agent',
    payload: rest,
    parentEventId,
  };
}

export function createContactResolved(
  // parentEventId is required — every resolution must trace back to the inbound event that triggered it.
  payload: ContactResolvedPayload & { parentEventId: string },
): ContactResolvedEvent {
  const { parentEventId, ...rest } = payload;
  return {
    id: randomUUID(),
    timestamp: new Date(),
    type: 'contact.resolved',
    sourceLayer: 'dispatch',
    payload: rest,
    parentEventId,
  };
}

export function createContactUnknown(
  // parentEventId is required — unknown-contact signals must trace back to the inbound event.
  payload: ContactUnknownPayload & { parentEventId: string },
): ContactUnknownEvent {
  const { parentEventId, ...rest } = payload;
  return {
    id: randomUUID(),
    timestamp: new Date(),
    type: 'contact.unknown',
    sourceLayer: 'dispatch',
    payload: rest,
    parentEventId,
  };
}

export function createContactDuplicateDetected(
  payload: ContactDuplicateDetectedPayload & { parentEventId?: string },
): ContactDuplicateDetectedEvent {
  const { parentEventId, ...rest } = payload;
  return {
    id: randomUUID(),
    timestamp: new Date(),
    type: 'contact.duplicate_detected',
    sourceLayer: 'dispatch',
    payload: rest,
    parentEventId,
  };
}

export function createContactMerged(
  payload: ContactMergedPayload & { parentEventId?: string },
): ContactMergedEvent {
  const { parentEventId, ...rest } = payload;
  return {
    id: randomUUID(),
    timestamp: new Date(),
    type: 'contact.merged',
    sourceLayer: 'dispatch',
    payload: rest,
    parentEventId,
  };
}

export function createMessageHeld(
  // parentEventId is required — held-message events must trace back to the inbound event.
  payload: MessageHeldPayload & { parentEventId: string },
): MessageHeldEvent {
  const { parentEventId, ...rest } = payload;
  return {
    id: randomUUID(),
    timestamp: new Date(),
    type: 'message.held',
    sourceLayer: 'dispatch',
    payload: rest,
    parentEventId,
  };
}

export function createMessageRejected(
  // parentEventId is required — rejection events must trace back to the inbound event.
  payload: MessageRejectedPayload & { parentEventId: string },
): MessageRejectedEvent {
  const { parentEventId, ...rest } = payload;
  return {
    id: randomUUID(),
    timestamp: new Date(),
    type: 'message.rejected',
    sourceLayer: 'dispatch',
    payload: rest,
    parentEventId,
  };
}

export function createScheduleCreated(
  payload: ScheduleCreatedPayload & { parentEventId?: string },
): ScheduleCreatedEvent {
  const { parentEventId, ...rest } = payload;
  return {
    id: randomUUID(),
    timestamp: new Date(),
    type: 'schedule.created',
    sourceLayer: 'system',
    payload: rest,
    parentEventId,
  };
}

export function createScheduleFired(
  payload: ScheduleFiredPayload & { parentEventId?: string },
): ScheduleFiredEvent {
  const { parentEventId, ...rest } = payload;
  return {
    id: randomUUID(),
    timestamp: new Date(),
    type: 'schedule.fired',
    sourceLayer: 'system',
    payload: rest,
    parentEventId,
  };
}

export function createScheduleSuspended(
  payload: ScheduleSuspendedPayload & { parentEventId?: string },
): ScheduleSuspendedEvent {
  const { parentEventId, ...rest } = payload;
  return {
    id: randomUUID(),
    timestamp: new Date(),
    type: 'schedule.suspended',
    sourceLayer: 'system',
    payload: rest,
    parentEventId,
  };
}

export function createScheduleRecovered(
  payload: ScheduleRecoveredPayload & { parentEventId?: string },
): ScheduleRecoveredEvent {
  const { parentEventId, ...rest } = payload;
  return {
    id: randomUUID(),
    timestamp: new Date(),
    type: 'schedule.recovered',
    sourceLayer: 'system',
    payload: rest,
    parentEventId,
  };
}

export function createScheduleDriftPaused(
  payload: ScheduleDriftPausedPayload & { parentEventId?: string },
): ScheduleDriftPausedEvent {
  const { parentEventId, ...rest } = payload;
  return {
    id: randomUUID(),
    timestamp: new Date(),
    type: 'schedule.drift_paused',
    sourceLayer: 'system',
    payload: rest,
    parentEventId,
  };
}

export function createConfigChange(
  payload: ConfigChangePayload & { parentEventId?: string },
): ConfigChangeEvent {
  const { parentEventId, ...rest } = payload;
  return {
    id: randomUUID(),
    timestamp: new Date(),
    type: 'config.change',
    sourceLayer: 'system',
    payload: rest,
    parentEventId,
  };
}

export function createConversationCheckpoint(
  payload: ConversationCheckpointPayload,
): ConversationCheckpointEvent {
  return {
    id: randomUUID(),
    timestamp: new Date(),
    sourceLayer: 'dispatch',
    type: 'conversation.checkpoint',
    payload,
  };
}

export function createLlmCall(
  // parentEventId is required — every LLM call must trace back to the agent.task that triggered it.
  payload: LlmCallPayload & { parentEventId: string },
): LlmCallEvent {
  const { parentEventId, ...rest } = payload;
  return {
    id: randomUUID(),
    timestamp: new Date(),
    type: 'llm.call',
    sourceLayer: 'agent',
    payload: rest,
    parentEventId,
  };
}

export function createHumanDecision(
  // parentEventId is required — every decision must trace back to the event that triggered the gate.
  payload: HumanDecisionPayload & { parentEventId: string },
): HumanDecisionEvent {
  const { parentEventId, ...rest } = payload;
  return {
    id: randomUUID(),
    timestamp: new Date(),
    type: 'human.decision',
    sourceLayer: 'dispatch',
    payload: rest,
    parentEventId,
  };
}

export function createSecretAccessed(
  payload: SecretAccessedPayload,
  parentEventId?: string,
): SecretAccessedEvent {
  return {
    id: randomUUID(),
    timestamp: new Date(),
    type: 'secret.accessed',
    sourceLayer: 'execution',
    payload,
    parentEventId,
  };
}
