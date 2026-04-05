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
   *  explicit CEO approval. Used by Phase 2 gate wiring to enforce autonomy-aware
   *  skill access. Optional — existing manifests that predate spec 12 don't have
   *  this field. See ActionRisk for the named label → score mapping. */
  action_risk?: ActionRisk;
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
  /** If true, this skill receives bus and agent registry access in its context.
   *  This grants unrestricted bus publish/subscribe including layer impersonation.
   *  Only for framework-internal skills like 'delegate' — external skills should never set this. */
  infrastructure?: boolean;
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
 * Available to all skills (not gated behind infrastructure) so templates
 * and outbound-facing skills can reference the agent's identity without
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
  /** Bus access — only available to infrastructure skills (manifest.infrastructure: true) */
  bus?: import('../bus/bus.js').EventBus;
  /** Agent registry — only available to infrastructure skills */
  agentRegistry?: import('../agents/agent-registry.js').AgentRegistry;
  /** Contact service — available to all skills for caller-scoped lookups
   *  (e.g., resolving a caller's registered calendars, looking up contacts).
   *  Populated whenever the ExecutionLayer has a contactService instance. */
  contactService?: import('../contacts/contact-service.js').ContactService;
  /** Outbound gateway — only available to infrastructure skills. All external
   *  communication (email, future Signal/Telegram) goes through the gateway,
   *  which enforces contact blocked checks and content filtering. */
  outboundGateway?: import('./outbound-gateway.js').OutboundGateway;
  /** Held message service for infrastructure skills that manage held messages */
  heldMessages?: import('../contacts/held-messages.js').HeldMessageService;
  /** Scheduler service — only available to infrastructure skills */
  schedulerService?: import('../scheduler/scheduler-service.js').SchedulerService;
  /** Entity memory (knowledge graph) — only available to infrastructure skills.
   *  Provides semantic search, entity CRUD, and fact storage for skills that
   *  need to read or write long-term knowledge (templates, preferences, etc.). */
  entityMemory?: import('../memory/entity-memory.js').EntityMemory;
  /** Agent persona — display name, title, and email signature from the
   *  coordinator's persona config. Available to all skills (not infrastructure-gated)
   *  so templates can reference the agent's identity without hardcoding it. */
  agentPersona?: AgentPersona;
  /** Nylas calendar client — only available to infrastructure skills.
   *  Provides CRUD operations on calendar events and free/busy queries
   *  via the Nylas unified API (provider-agnostic). */
  nylasCalendarClient?: import('../channels/calendar/nylas-calendar-client.js').NylasCalendarClient;
  /** Caller identity — populated from the task event's sender context.
   *  Guaranteed to be defined for elevated skills (execution layer rejects without it).
   *  Available but optional for normal skills. */
  caller?: CallerContext;
  /** Entity context assembler — available to infrastructure skills.
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
  /** Autonomy service — available to infrastructure skills that manage the global
   *  autonomy score (get-autonomy, set-autonomy). Not available to normal skills. */
  autonomyService?: import('../autonomy/autonomy-service.js').AutonomyService;
  /** Browser service — available to all skills (not infrastructure-gated).
   *  Provides a warm Playwright Chromium instance with session management.
   *  Skills use this to interact with JS-rendered pages and web forms. */
  browserService?: import('../browser/browser-service.js').BrowserService;
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
  input_schema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string } | { type: 'array'; items: { type: string }; description?: string }>;
    required: string[];
  };
}
