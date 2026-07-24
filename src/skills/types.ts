// types.ts — type definitions for the skill system.
//
// Skills are Curia's extension mechanism — how agents interact with the
// outside world. These types define the contract between skills and the
// execution layer. Skills implement ToolHandler; the execution layer
// provides ToolContext and expects ToolResult.

import type { Logger } from '../logger.js';

/**
 * The risk level of a skill's actions, expressed as the minimum autonomy score
 * required before the skill may run without explicit CEO approval.
 *
 * Named labels map to score thresholds:
 *   none     →  0  — read-only, no side effects (always safe)
 *   low      → 60  — internal state writes (memory, contacts)
 *   medium   → 70  — outbound communications
 *   high     → 80  — calendar writes, commitments on behalf of CEO
 *   critical → 90  — financial / destructive / irreversible
 *
 * A raw number (0–100) may be used for precision (e.g. 75 for a skill that
 * should unlock just above approval-required but below spot-check).
 * Numbers outside [0, 100] produce a validation error at skill load time.
 */
export type ActionRisk = 'none' | 'low' | 'medium' | 'high' | 'critical' | number;

/**
 * Skill manifest shape — loaded from tool.json files in each skill directory.
 * Declares what the skill does, what it needs, and its security classification.
 */
export interface ToolManifest {
  name: string;
  description: string;
  version: string;
  /** "normal" = auto-approvable; "elevated" = requires human approval on first use */
  sensitivity: 'normal' | 'elevated';
  /** Action risk: the minimum autonomy score required to invoke this skill without
   *  explicit CEO approval. Required on all new manifests — Phase 2 will enforce this
   *  at load time (ToolRegistry.register will reject manifests that omit it).
   *  See ActionRisk for the named label → score mapping. */
  action_risk: ActionRisk;
  /** JSON Schema-ish description of expected inputs */
  inputs: Record<string, string>;
  /** JSON Schema-ish description of outputs */
  outputs: Record<string, string>;
  /** Declared capabilities — validated at load time */
  permissions: string[];
  /** Env var names the skill needs access to via ctx.secret() */
  secrets: string[];
  /** Per-invocation timeout in ms. Default 30000. */
  timeout: number;
  /** Declares which privileged ToolContext services this skill needs.
   *  Only known capability names are accepted — the loader validates against
   *  a fixed allowlist at startup and rejects unknown names.
   *  The manifest is frozen after loading — capabilities cannot be mutated at runtime.
   *
   *  Valid capabilities: bus, agentRegistry, outboundGateway,
   *  schedulerService, entityMemory, nylasCalendarClient, autonomyService,
   *  executiveProfileService, officeIdentityService, browserService, bullpenService, toolSearch,
   *  actionLogRepo, auditLogRepo, executionLayer, confidencePipeline, tempFileStore, infraLlm, outboundContext,
   *  taskRepo, workingDocs, secretCapture, secretResolver.
   *
   *  Services NOT listed here (contactService, entityContextAssembler, agentPersona)
   *  are universal — available to every skill without declaration. */
  capabilities?: string[];
  /** Declares that the execution layer should automatically assemble entity context
   *  before invoking this skill's handler. The assembled EntityContext[] is injected
   *  into ctx.entityContext so the handler doesn't need to call entity-context directly.
   *
   *  param:    the input key containing the list of contact/entity IDs to enrich.
   *  default:  what to use when that input is not provided:
   *              'caller' → ctx.caller.contactId
   *              'agent'  → the seeded agent contactId (ctx.agentContactId)
   */
  entity_enrichment?: {
    param: string;
    default: 'caller' | 'agent';
  };
  /** Optional list of agent names allowed to invoke this skill.
   *  Omitted or empty = unrestricted (any agent or system layer may invoke).
   *  'system' is a reserved name for system-layer invocations (checkpoint processor,
   *  scheduler) where no agentId is present.
   *  Validated at load time against known agent names — typos fail at startup. */
  allowed_callers?: string[];
  /** Optional declarative install block (spec: skill/agent registry, #541).
   *  PR2 (#939) defines `requires_secrets`: the vault keys that must be configured
   *  before this skill can be installed or enabled. This is the install/enable GATE,
   *  distinct from the top-level `secrets` field above (the runtime allowlist that
   *  ctx.secret() reads from) — they overlap often but answer different questions. */
  install?: {
    /** Vault secret keys that must exist before install/enable. Enforced by RegistryService. */
    requires_secrets?: string[];
  };
  /** Reserved uninstall block — PARSED BUT INERT. PR3 (config) will define its contents. */
  uninstall?: Record<string, unknown>;
  /** When true, this skill's output bypasses ONLY the broad generic-long-hex secret scrub in
   *  sanitize.ts (the structured credential patterns — API keys, JWT/Bearer, AWS — still apply).
   *  For skills whose output legitimately carries a high-entropy hex capability token that must
   *  reach the LLM to be relayed (e.g. the secret-capture one-time links). Tag-stripping and
   *  truncation still apply. Gated at registration to skills declaring the 'secretCapture'
   *  capability. Default false/undefined. */
  skip_secret_redaction?: boolean;
}

/**
 * Minimal caller identity passed through the execution layer.
 * Used for elevated-skill gate checks and audit fields (e.g., grantedBy).
 * Intentionally lean — no KG facts, no authorization result.
 */
export interface CallerContext {
  /** 'primary-user' for CLI, actual contact ID otherwise */
  contactId: string;
  /** 'ceo', 'cfo', null, etc. */
  role: string | null;
  /** Originating channel: 'cli', 'email', 'signal', etc. */
  channel: string;
}

/**
 * The agent persona — display name, title, and optional email signature.
 * Sourced from the coordinator's persona config in agents/coordinator.yaml.
 * Universal (not capability-gated) so templates and outbound-facing skills
 * can reference the agent's identity without
 * hardcoding it.
 */
export interface AgentPersona {
  displayName: string;
  title: string;
  /** Full email signature block. If not set, skills should construct a
   *  default from displayName + title. */
  emailSignature?: string;
}

/**
 * The sandboxed context passed to every skill invocation.
 * Skills cannot access the bus, database, or filesystem directly —
 * they receive inputs through ctx.input and return outputs via ToolResult.
 */
export interface ToolContext {
  /** The invoking skill's manifest name and version (from tool.json). Populated by the
   *  execution layer at context build time so handlers never need to hardcode their own
   *  version — it stays in sync with tool.json automatically. */
  toolName: string;
  toolVersion: string;
  /** Validated input matching the manifest's inputs declaration */
  input: Record<string, unknown>;
  /** Scoped secret access — only secrets declared in the manifest are accessible */
  secret(name: string): string;
  /** Scoped pino child logger */
  log: Logger;
  /** Bus access — available to skills declaring 'bus' in capabilities */
  bus?: import('../bus/bus.js').EventBus;
  /** Agent registry — available to skills declaring 'agentRegistry' in capabilities */
  agentRegistry?: import('../agents/agent-registry.js').AgentRegistry;
  /** Contact service — available to all skills for caller-scoped lookups
   *  (e.g., resolving a caller's registered calendars, looking up contacts).
   *  Populated whenever the ExecutionLayer has a contactService instance. */
  contactService?: import('../contacts/contact-service.js').ContactService;
  /** Contact confidence scoring pipeline — available to skills declaring 'confidencePipeline'
   *  in capabilities. Skills that modify trust-related data (trust level, identity pairings)
   *  should declare this capability and fire scoring signals through it. */
  confidencePipeline?: import('../contacts/confidence-pipeline.js').ConfidencePipeline;
  /** Outbound gateway — available to skills declaring 'outboundGateway' in capabilities.
   *  All external communication (email, future Signal/Telegram) goes through the gateway,
   *  which enforces contact blocked checks and content filtering. */
  outboundGateway?: import('./outbound-gateway.js').OutboundGateway;
  /** Scheduler service — available to skills declaring 'schedulerService' in capabilities */
  schedulerService?: import('../scheduler/scheduler-service.js').SchedulerService;
  /** Entity memory (knowledge graph) — available to skills declaring 'entityMemory' in capabilities.
   *  Provides semantic search, entity CRUD, and fact storage for skills that
   *  need to read or write long-term knowledge (templates, preferences, etc.). */
  entityMemory?: import('../memory/entity-memory.js').EntityMemory;
  /** Agent persona — display name, title, and email signature from the
   *  coordinator's persona config. Universal (not capability-gated)
   *  so templates can reference the agent's identity without hardcoding it. */
  agentPersona?: AgentPersona;
  /** Nylas calendar client — available to skills declaring 'nylasCalendarClient' in capabilities.
   *  Provides CRUD operations on calendar events and free/busy queries
   *  via the Nylas unified API (provider-agnostic). */
  nylasCalendarClient?: import('../channels/calendar/nylas-calendar-client.js').NylasCalendarClient;
  /** Bullpen service — available to skills declaring 'bullpenService' in capabilities for inter-agent discussion threads */
  bullpenService?: import('../memory/bullpen.js').BullpenService;
  /** ID of the agent invoking this skill — injected by the execution layer */
  agentId?: string;
  /** ID of the originating agent.task event — for causal chain tracing in event payloads */
  taskEventId?: string;
  /** Conversation ID from the originating task event. Used by skills that need to
   *  thread this through to other system events (e.g. outbound delivery audit). */
  conversationId?: string;
  /** True when re-invoked after CEO approval via approve-action (ADR-018, #201). */
  humanApproved?: boolean;
  /** Channel ID from the originating task event (e.g. "http", "internal", "signal").
   *  Used with agentId and taskEventId to construct the memory write source key. */
  channelId?: string;
  /** Pre-constructed source key for entityMemory.storeFact() calls, matching the
   *  format that AgentRuntime.resetRateLimit() uses: `agent:{id}/task:{id}/channel:{id}`.
   *  Skills writing to entity memory should use this as the `source` parameter so the
   *  per-task rate limit counter is correctly scoped and reset after each task. */
  memoryWriteSource?: string;
  /** Caller identity — populated from the task event's sender context.
   *  Guaranteed to be defined for elevated skills (execution layer rejects without it).
   *  Available but optional for normal skills. */
  caller?: CallerContext;
  /** Entity context assembler — available to all skills (universal, not capability-gated).
   *  Used by the entity-context skill to assemble EntityContext payloads on demand.
   *  Also used by the execution layer for entity_enrichment pre-enrichment. */
  entityContextAssembler?: import('../entity-context/assembler.js').EntityContextAssembler;
  /** Pre-assembled entity context — populated automatically by the execution layer
   *  when the skill's manifest declares entity_enrichment. Skills that declare
   *  entity_enrichment receive this instead of calling entity-context themselves. */
  entityContext?: import('../entity-context/types.js').EntityContext[];
  /** The agent's own contactId — used by entity_enrichment when default is 'agent'.
   *  Seeded at bootstrap and injected by the execution layer. */
  agentContactId?: string;
  /** Autonomy service — available to skills declaring 'autonomyService' in capabilities.
   *  Manages the global autonomy score (get-autonomy, set-autonomy). */
  autonomyService?: import('../autonomy/autonomy-service.js').AutonomyService;
  /** Executive profile service — available to skills declaring 'executiveProfileService' in capabilities.
   *  Manages the CEO's writing voice profile. */
  executiveProfileService?: import('../executive/service.js').ExecutiveProfileService;
  /** Office identity service — available to skills declaring 'officeIdentityService' in capabilities.
   *  Manages the Curia instance identity including behavioral preferences. */
  officeIdentityService?: import('../identity/service.js').OfficeIdentityService;
  /** Browser service — available to skills declaring 'browserService' in capabilities.
   *  Provides a warm Playwright Chromium instance with session management.
   *  Skills use this to interact with JS-rendered pages and web forms. */
  browserService?: import('../browser/browser-service.js').BrowserService;
  /** Search tools and skills by keyword. Used by tool-registry (Phase 3a unified discovery). */
  toolSearch?: (query: string) => Array<{
    name: string;
    description: string;
    /** 'tool' (atom) or 'skill' (bundle). Omitted → treat as tool. */
    kind?: 'tool' | 'skill';
  }>;
  /** Skill (bundle) registry — available to tools declaring 'skillRegistry' in capabilities.
   *  Used by skill-activate for Tier-2 activation (#1495). */
  skillRegistry?: import('./skill-registry.js').SkillRegistry;
  /** Atom tool catalog — injected alongside skillRegistry for activation resolution.
   *  Not a separate capability; accompanies skillRegistry. */
  toolRegistry?: import('./registry.js').ToolRegistry;
  /** Arbitrary task-level metadata forwarded from the agent.task event payload.
   *  Skills that do not need it can ignore this field entirely. */
  taskMetadata?: Record<string, unknown>;
  /** Live-principal-turn signal (#1126) — true when the current turn originated from a fresh
   *  principal inbound (directly, or via a SYNCHRONOUS delegation that forwarded it). Distinct
   *  from taskMetadata so it is never persisted. Only `delegate` reads this (to forward it to a
   *  synchronously-delegated specialist); other skills can ignore it. The elevated-skill gate is
   *  the real consumer, in the execution layer. */
  liveTurn?: boolean;
  /** IANA timezone name (e.g. "America/Toronto") for formatting user-facing timestamps.
   *  Populated from the global config timezone. Skills returning timestamps for display
   *  should use toLocalIso() with this value rather than returning raw UTC strings. */
  timezone?: string;
  /** Curia's own email address — used by email skills to filter self from CC lists. */
  selfEmail?: string;
  /** Action log repo — available to skills declaring 'actionLogRepo' in capabilities.
   *  Provides read/write access to the autonomy_action_log table for approval lifecycle
   *  management. Used by approve-action, deny-action, dismiss-action, list-pending-actions. */
  actionLogRepo?: import('../autonomy/action-log-repo.js').ActionLogRepo;
  /** Audit log repo — available to skills declaring 'auditLogRepo' in capabilities. */
  auditLogRepo?: import('../audit/audit-log-repo.js').AuditLogRepo;
  /** Diagnostics read repo — available to skills declaring 'diagnosticsRepo' in capabilities.
   *  Read-only access to the operational + agent-state tables (scheduled_jobs, held_messages,
   *  autonomy_action_log, outbound_context, working_memory) for the diagnostics agent (#1356). */
  diagnosticsRepo?: import('../diagnostics/diagnostics-repo.js').DiagnosticsRepo;
  /** Task repo — available to skills declaring 'taskRepo' in capabilities.
   *  Provides CRUD access to the tasks table and manages linked wake-up scheduled_jobs rows.
   *  Used by task-create, task-list, task-update, task-complete. */
  taskRepo?: import('../db/task-repo.js').TaskRepo;
  /** Working document repo — available to skills declaring 'workingDocs' in capabilities.
   *  OKF-serialized document workspace backed by Postgres (#1208). */
  workingDocs?: import('../db/working-docs-repo.js').WorkingDocsRepo;
  /** Execution layer — available to skills declaring 'executionLayer' in capabilities.
   *  Allows re-invocation of skills with humanApproved bypass. Only approve-action (#428)
   *  should declare this capability; it is sensitivity: "elevated" (CEO-only). */
  executionLayer?: import('./execution.js').ExecutionLayer;
  /** Temp file store — available to skills declaring 'tempFileStore' in capabilities.
   *  Writes binary buffers to a secure tmpfs mount and returns file:// URLs for
   *  MCP tools that accept file paths. Used by email download skills to hand off
   *  attachment bytes to Google Drive uploads without corruption. */
  writeTempFile?(buffer: Buffer, filename: string): Promise<string>;
  /** Constrained LLM access — available to skills declaring 'infraLlm' in capabilities.
   *  Provides classify() and extract() operations routed through the ModelRouter
   *  with full telemetry (llm.call bus events). Does NOT expose raw chat().
   *  The narrow API surface is the security policy: any skill can declare this
   *  capability, but all it gets is classification and extraction, not arbitrary
   *  LLM access. See #637. */
  infraLlm?: import('./infra-llm.js').InfraLlm;
  /** Outbound context bridge — available to skills declaring 'outboundContext' in capabilities.
   *  Provides a narrow surface (register + release) for managing outbound context bridge entries.
   *  Pre-scoped with conversationId by the execution layer. */
  outboundContext?: import('../dispatch/outbound-context.js').OutboundContextCapability;
  /** Configurable fallback timeout for specialist delegations when no timeout_ms is supplied.
   *  Sourced from config.delegate.defaultTimeoutMs. Relevant to the delegate skill only. */
  defaultDelegateTimeoutMs?: number;
  /** Resumable / plan-adaptive ceiling defaults from tasks.resumableCeilings (#1266). */
  resumableCeilings?: import('../config.js').ResumableCeilingsConfig;
  /** Secret-capture minter — available to skills declaring 'secretCapture' in capabilities.
   *  Mints one-time tokenized links for agent-initiated secret capture (#971). Deliberately
   *  a MINT-ONLY surface: there is no method that returns a stored secret value, so the
   *  "LLM never sees secrets" guarantee is structural rather than prompt-enforced. */
  secretCapture?: import('../secrets/secret-capture-service.js').SecretCaptureMinter;
  /** Resolve a `user.*` secret by reference at runtime — available only to skills declaring
   *  'secretResolver' in capabilities AND on the execution-layer allowlist (#973). Unlike
   *  ctx.secret() (which is restricted to manifest-declared static names), this resolves
   *  DYNAMIC `user.<slug>` names chosen per activity. Guardrails: only `user.*` references
   *  resolve (system/channel keys are rejected); each call emits secret.accessed (name only,
   *  byReference: true). The returned value is for runtime use only — handlers MUST NOT place
   *  it in ToolResult.data, error strings, or logs. */
  resolveSecretRef?: (ref: string) => Promise<string>;
  /** Operator-facing origin of the console (e.g. "https://curia.example.com"), used by the
   *  capture skills to build the magic-link URL. Undefined in local dev — fall back to
   *  http://localhost:{httpPort}. Sourced from config.appOrigin. */
  appOrigin?: string;
  /** Local HTTP port the SPA is served on, used as the dev fallback origin when appOrigin
   *  is unset. Sourced from config.httpPort. */
  httpPort?: number;
  /** Per-task-turn guard against blind identical re-delegation (#1171). Populated by the
   *  agent runtime and read by the delegate skill. */
  delegationGuard?: import('../agents/delegation-guard.js').DelegationGuard;
  /** Shared sensitivity classifier — available to skills declaring 'sensitivityClassifier'.
   *  Classifies free text against config sensitivity_rules. */
  sensitivityClassifier?: import('../memory/sensitivity.js').SensitivityClassifier;
}

/**
 * Discriminated union for skill results.
 * Skills NEVER throw — they return success or failure as a value.
 * This makes error handling explicit and prevents unhandled exceptions
 * from propagating through the execution layer.
 *
 * `errorType` is optional and additive (#1381): when the execution layer
 * classifies a thrown failure (e.g. DATABASE_UNAVAILABLE), it attaches the
 * type so the runtime can track DB outages separately from the consecutive
 * error budget. Handlers may omit it — absence means a generic SKILL_ERROR.
 */
export type ToolResult =
  | { success: true; data: unknown }
  | {
      success: false;
      error: string;
      /** Structured classification when known (e.g. DATABASE_UNAVAILABLE). */
      errorType?: import('../errors/types.js').ErrorType;
    };

/**
 * Interface that all skill handlers implement.
 * The execute method receives a sandboxed ToolContext and returns a ToolResult.
 */
export interface ToolHandler {
  execute(ctx: ToolContext): Promise<ToolResult>;
}

/**
 * Internal registry entry — combines manifest metadata with the loaded handler.
 * The registry stores these; the execution layer looks them up by name.
 */
export interface RegisteredTool {
  manifest: ToolManifest;
  handler: ToolHandler;
  /**
   * Raw MCP input schema from the MCP server's tools/list response.
   * Present only for MCP-sourced tools. When set, toToolDefinitions() uses this
   * directly instead of parsing manifest.inputs via the shorthand notation —
   * preserving the full JSON Schema fidelity from the MCP server's documentation.
   */
  mcpInputSchema?: ToolDefinition['input_schema'];
}

/**
 * Tool definition format expected by LLM providers (Anthropic, OpenAI).
 * Generated from ToolManifest data so agents never need to know the
 * internal manifest format.
 *
 * Defined here (not in provider.ts) because it's the canonical shared type
 * between the skill registry and the LLM provider layer.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  // input_schema is a JSON Schema object. Properties are typed as Record<string, unknown>
  // to accommodate both the simple shorthand used by local skills and the full JSON Schema
  // objects returned by MCP servers (which may include allOf, oneOf, pattern, enum, etc.).
  // required is optional because MCP tools may omit it for parameter-less tools.
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}
