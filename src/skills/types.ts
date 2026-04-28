// types.ts — type definitions for the skill system.
//
// Skills are Curia's extension mechanism — how agents interact with the
// outside world. These types define the contract between skills and the
// execution layer. Skills implement SkillHandler; the execution layer
// provides SkillContext and expects SkillResult.

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
 * Skill manifest shape — loaded from skill.json files in each skill directory.
 * Declares what the skill does, what it needs, and its security classification.
 */
export interface SkillManifest {
  name: string;
  description: string;
  version: string;
  /** "normal" = auto-approvable; "elevated" = requires human approval on first use */
  sensitivity: 'normal' | 'elevated';
  /** Action risk: the minimum autonomy score required to invoke this skill without
   *  explicit CEO approval. Required on all new manifests — Phase 2 will enforce this
   *  at load time (SkillRegistry.register will reject manifests that omit it).
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
  /** Declares which privileged SkillContext services this skill needs.
   *  Only known capability names are accepted — the loader validates against
   *  a fixed allowlist at startup and rejects unknown names.
   *  The manifest is frozen after loading — capabilities cannot be mutated at runtime.
   *
   *  Valid capabilities: bus, agentRegistry, outboundGateway, heldMessages,
   *  schedulerService, entityMemory, nylasCalendarClient, autonomyService,
   *  executiveProfileService, browserService, bullpenService, skillSearch.
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
 * they receive inputs through ctx.input and return outputs via SkillResult.
 */
export interface SkillContext {
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
  /** Outbound gateway — available to skills declaring 'outboundGateway' in capabilities.
   *  All external communication (email, future Signal/Telegram) goes through the gateway,
   *  which enforces contact blocked checks and content filtering. */
  outboundGateway?: import('./outbound-gateway.js').OutboundGateway;
  /** Held message service — available to skills declaring 'heldMessages' in capabilities */
  heldMessages?: import('../contacts/held-messages.js').HeldMessageService;
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
  /** Browser service — available to skills declaring 'browserService' in capabilities.
   *  Provides a warm Playwright Chromium instance with session management.
   *  Skills use this to interact with JS-rendered pages and web forms. */
  browserService?: import('../browser/browser-service.js').BrowserService;
  /** Skill search — available to skills declaring 'skillSearch' in capabilities.
   *  Searches all registered skills by keyword, excluding skill-registry itself. */
  skillSearch?: (query: string) => Array<{ name: string; description: string }>;
  /** Arbitrary task-level metadata forwarded from the agent.task event payload.
   *  Currently used to carry observationMode (whether the task was dispatched in
   *  observation-only mode) so skills can adjust their behaviour accordingly —
   *  e.g. suppressing outbound sends when observationMode === true.
   *  Skills that do not need it can ignore this field entirely. */
  taskMetadata?: Record<string, unknown>;
  /** IANA timezone name (e.g. "America/Toronto") for formatting user-facing timestamps.
   *  Populated from the global config timezone. Skills returning timestamps for display
   *  should use toLocalIso() with this value rather than returning raw UTC strings. */
  timezone?: string;
}

/**
 * Discriminated union for skill results.
 * Skills NEVER throw — they return success or failure as a value.
 * This makes error handling explicit and prevents unhandled exceptions
 * from propagating through the execution layer.
 */
export type SkillResult =
  | { success: true; data: unknown }
  | { success: false; error: string };

/**
 * Interface that all skill handlers implement.
 * The execute method receives a sandboxed SkillContext and returns a SkillResult.
 */
export interface SkillHandler {
  execute(ctx: SkillContext): Promise<SkillResult>;
}

/**
 * Internal registry entry — combines manifest metadata with the loaded handler.
 * The registry stores these; the execution layer looks them up by name.
 */
export interface RegisteredSkill {
  manifest: SkillManifest;
  handler: SkillHandler;
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
 * Generated from SkillManifest data so agents never need to know the
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
