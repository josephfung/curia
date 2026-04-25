// execution.ts — the execution layer runs skills within controlled boundaries.
//
// This is the security boundary between agents and the outside world.
// It resolves skills from the registry, validates permissions, provides
// a sandboxed SkillContext, enforces timeouts, and sanitizes outputs.
//
// Normal skills get: validated input, scoped secret access, a scoped logger,
// and universal services (contactService, entityContextAssembler, agentPersona).
//
// Privileged services (bus, outboundGateway, entityMemory, etc.) are only
// injected when the skill declares them in manifest.capabilities[]. The loader
// validates capability names against a fixed allowlist and freezes the manifest
// at startup — skills cannot self-escalate at runtime.
//
// Entity enrichment (manifest.entity_enrichment): when a skill declares this,
// the execution layer assembles EntityContext for the declared input parameter
// before invoking the handler. The handler receives ctx.entityContext[] and
// never needs to call entity-context itself.

import type { SkillResult, SkillContext, CallerContext, AgentPersona, ToolDefinition } from './types.js';
import { normalizeTimestamp } from '../time/timestamp.js';
import type { SkillRegistry } from './registry.js';
import { sanitizeOutput } from './sanitize.js';
import { createSecretAccessed } from '../bus/events.js';
import type { Logger } from '../logger.js';
import type { EventBus } from '../bus/bus.js';
import type { AgentRegistry } from '../agents/agent-registry.js';
import type { ContactService } from '../contacts/contact-service.js';
import type { OutboundGateway } from './outbound-gateway.js';
import type { HeldMessageService } from '../contacts/held-messages.js';
import type { SchedulerService } from '../scheduler/scheduler-service.js';
import type { EntityMemory, CreateEntityOptions, StoreFactResult } from '../memory/entity-memory.js';
import type { StoreFactOptions } from '../memory/types.js';
import { createMemoryStore } from '../bus/events.js';
import type { NylasCalendarClient } from '../channels/calendar/nylas-calendar-client.js';
import type { EntityContextAssembler } from '../entity-context/assembler.js';
import type { AutonomyService } from '../autonomy/autonomy-service.js';
import type { BrowserService } from '../browser/browser-service.js';

// Default max output length — used when no value is configured in default.yaml.
// Skills returning more than this will have their output truncated before it
// reaches the LLM context window.
const DEFAULT_SKILL_OUTPUT_MAX_LENGTH = 200_000;

/** Options passed to ExecutionLayer.invoke() by the agent runtime. */
export interface InvokeOptions {
  taskEventId?: string;
  agentId?: string;
  conversationId?: string;
  parentEventId?: string;
  /** Task-level metadata forwarded from the agent.task event payload.
   *  Used by skill handlers to inspect task-wide signals (e.g. observationMode). */
  taskMetadata?: Record<string, unknown>;
}

export class ExecutionLayer {
  private registry: SkillRegistry;
  private logger: Logger;
  private bus?: EventBus;
  private agentRegistry?: AgentRegistry;
  private contactService?: ContactService;
  private outboundGateway?: OutboundGateway;
  private heldMessages?: HeldMessageService;
  private schedulerService?: SchedulerService;
  private entityMemory?: EntityMemory;
  private agentPersona?: AgentPersona;
  private nylasCalendarClient?: NylasCalendarClient;
  private entityContextAssembler?: EntityContextAssembler;
  private autonomyService?: AutonomyService;
  private browserService?: BrowserService;
  private bullpenService?: import('../memory/bullpen.js').BullpenService;
  /** The agent's own contactId — injected into ctx.agentContactId for entity_enrichment default='agent' */
  private agentContactId?: string;
  /** IANA timezone name used for normalizing offset-less timestamp inputs from the LLM. */
  private timezone: string;
  /** Max character length for sanitized skill output before truncation. */
  private skillOutputMaxLength: number;

  constructor(registry: SkillRegistry, logger: Logger, options?: {
    bus?: EventBus;
    agentRegistry?: AgentRegistry;
    contactService?: ContactService;
    outboundGateway?: OutboundGateway;
    heldMessages?: HeldMessageService;
    schedulerService?: SchedulerService;
    entityMemory?: EntityMemory;
    agentPersona?: AgentPersona;
    nylasCalendarClient?: NylasCalendarClient;
    entityContextAssembler?: EntityContextAssembler;
    autonomyService?: AutonomyService;
    browserService?: BrowserService;
    bullpenService?: import('../memory/bullpen.js').BullpenService;
    agentContactId?: string;
    timezone?: string;
    skillOutputMaxLength?: number;
  }) {
    this.registry = registry;
    this.logger = logger;
    this.bus = options?.bus;
    this.agentRegistry = options?.agentRegistry;
    this.contactService = options?.contactService;
    this.outboundGateway = options?.outboundGateway;
    this.heldMessages = options?.heldMessages;
    this.schedulerService = options?.schedulerService;
    this.entityMemory = options?.entityMemory;
    this.agentPersona = options?.agentPersona;
    this.nylasCalendarClient = options?.nylasCalendarClient;
    this.entityContextAssembler = options?.entityContextAssembler;
    this.autonomyService = options?.autonomyService;
    this.browserService = options?.browserService;
    this.bullpenService = options?.bullpenService;
    this.agentContactId = options?.agentContactId;
    this.timezone = options?.timezone ?? 'UTC';
    this.skillOutputMaxLength = options?.skillOutputMaxLength ?? DEFAULT_SKILL_OUTPUT_MAX_LENGTH;
  }

  /**
   * Sanitize a skill error message and wrap it in <skill_error> tags.
   *
   * Wrapping in a structured tag serves two purposes:
   * 1. The skill.result bus event carries clearly-typed error data for the audit log.
   * 2. If the error string ever reaches the LLM directly, it reads as structured data
   *    rather than a free-form instruction that could be mistaken for a system directive.
   *
   * The downstream runtime pipeline (classifySkillError → formatTaskError) will further
   * sanitize and XML-escape this before injecting it into LLM history — the skill_error
   * tag passes through sanitizeOutput() unchanged because it is not on the dangerous-tag
   * list (system/instruction/prompt/role/script), so the full tagged string ends up in the
   * <message> field of the <task_error> block where the LLM can interpret it correctly.
   */
  private wrapSkillError(message: string): string {
    // Strip dangerous tags and redact secrets from the error message itself before
    // wrapping — error messages can contain user-supplied values (e.g., timestamp
    // inputs) or external content (e.g., HTTP response bodies) that are injection risks.
    const sanitized = sanitizeOutput(message, { maxLength: this.skillOutputMaxLength });
    return `<skill_error>${sanitized}</skill_error>`;
  }

  /**
   * Update the agent's own contactId after bootstrap has seeded it.
   * Called from index.ts once the agent self-identity is resolved.
   */
  setAgentContactId(contactId: string): void {
    this.agentContactId = contactId;
  }

  /**
   * Return LLM tool definitions for the named skills.
   *
   * Used by AgentRuntime to expand the per-task working tool list after a
   * skill-registry discovery call — the runtime calls this with the names
   * returned by skill-registry, gets back full tool schemas, and appends
   * them so the LLM can call the newly-discovered skills in subsequent turns.
   *
   * Unknown names are silently skipped (same as toToolDefinitions).
   */
  getToolDefinitions(skillNames: string[]): ToolDefinition[] {
    return this.registry.toToolDefinitions(skillNames);
  }

  /**
   * Invoke a skill by name with the given input.
   *
   * Steps:
   * 1. Resolve the skill from the registry
   * 2. Build a sandboxed SkillContext with scoped secret access
   * 3. If manifest declares entity_enrichment, pre-assemble EntityContext
   * 4. Execute the handler with a timeout
   * 5. Sanitize the output (strip injection vectors, redact secrets, truncate)
   * 6. Return the result
   *
   * Never throws — always returns a SkillResult.
   */
  async invoke(
    skillName: string,
    input: Record<string, unknown>,
    caller?: CallerContext,
    options?: InvokeOptions,
  ): Promise<SkillResult> {
    const skill = this.registry.get(skillName);

    if (!skill) {
      return { success: false, error: this.wrapSkillError(`Skill '${skillName}' not found in registry`) };
    }

    const { manifest, handler } = skill;

    // Declare skillLogger here (before the normalization loop) so it is in scope
    // for both the normalization error path and the rest of the method.
    const skillLogger = this.logger.child({ skill: skillName });

    // Normalize timestamp inputs to UTC Z-suffix before invoking the handler.
    // The LLM often emits offset-less ISO strings (e.g. "2026-04-06T08:00:00")
    // which new Date() on a UTC server interprets as UTC — wrong for Toronto.
    // normalizeTimestamp() interprets offset-less strings as Curia's local time.
    for (const [key, typeStr] of Object.entries(manifest.inputs)) {
      // Strip parenthetical description first, then optional marker.
      // Order matters: "timestamp? (desc)" must become "timestamp", not "timestamp?".
      const baseType = typeStr.replace(/\s*\(.*\)$/, '').replace(/\?$/, '').trim();
      if (baseType !== 'timestamp') continue;
      const raw = input[key];
      if (typeof raw !== 'string' || raw.trim() === '') continue;
      try {
        input[key] = normalizeTimestamp(raw, this.timezone);
      } catch (err) {
        // Hard fail — passing a non-normalized timestamp to a calendar/scheduler handler
        // would silently create events at the wrong time (the server runs UTC, so an
        // offset-less string passed to new Date() is interpreted as UTC, not local time).
        // Return a skill error so the LLM can re-emit the value with an explicit offset.
        skillLogger.error({ err, key, raw }, 'timestamp normalization failed; refusing to invoke handler with unnormalized value');
        return {
          success: false,
          error: this.wrapSkillError(`Input '${key}' could not be parsed as a valid datetime: "${raw}". Please provide an ISO 8601 string with a UTC offset (e.g. "2026-04-06T08:00:00-04:00").`),
        };
      }
    }

    // Elevated-skill gate: enforce caller verification before building context.
    // Fail-closed — if caller context is missing, elevated skills are blocked.
    // Role is authoritative — contact-resolver.ts already maps CLI callers to role: 'ceo'.
    if (manifest.sensitivity === 'elevated') {
      if (!caller) {
        this.logger.warn({ skillName }, 'Elevated skill blocked: no caller context (fail-closed)');
        return {
          success: false,
          error: this.wrapSkillError(`Skill '${skillName}' requires elevated privileges — no caller context provided (fail-closed)`),
        };
      }
      if (caller.role !== 'ceo') {
        this.logger.warn({ skillName, role: caller.role, channel: caller.channel }, 'Elevated skill blocked: unauthorized caller');
        return {
          success: false,
          error: this.wrapSkillError(`Skill '${skillName}' requires elevated privileges — caller role '${caller.role ?? 'none'}' on channel '${caller.channel}' is not authorized`),
        };
      }
    }

    // Build the sandboxed context — secret access is restricted to
    // only the secrets declared in the skill's manifest
    const declaredSecrets = new Set(manifest.secrets);
    const ctx: SkillContext = {
      input,
      secret: (name: string): string => {
        if (!declaredSecrets.has(name)) {
          throw new Error(`Secret '${name}' is not declared in the manifest for skill '${skillName}'`);
        }
        // Env vars are uppercase by convention; manifest keys are lowercase.
        // e.g. manifest "tavily_api_key" → reads process.env.TAVILY_API_KEY
        const value = process.env[name.toUpperCase()];
        if (!value) {
          throw new Error(`Secret '${name}' is declared but not set in the environment`);
        }
        // Audit log — fire-and-forget so ctx.secret() stays synchronous.
        // Records skill name, secret name, and causal IDs — never the secret value.
        // Falls back to debug-only logging if the bus is not wired (e.g. test environments).
        if (this.bus) {
          this.bus.publish('execution', createSecretAccessed({
            skillName,
            secretName: name,
            agentId: options?.agentId,
            taskEventId: options?.taskEventId,
          })).catch((err) => {
            // Error (not warn) — a dropped audit event on a security-critical path must
            // surface at error level so it reaches SIEM/alerting dashboards. The debug
            // log below still fires, but it is not a durable audit record.
            skillLogger.error(
              { err, secretName: name, skillName, agentId: options?.agentId, taskEventId: options?.taskEventId },
              'AUDIT FAILURE: secret.accessed event could not be published — secret was returned but access may not be recorded',
            );
          });
        }
        skillLogger.debug({ secretName: name }, 'Secret accessed');
        return value;
      },
      log: skillLogger,
      agentPersona: this.agentPersona,
      caller,
      agentContactId: this.agentContactId,
      // contactService is available to all skills — read-only contact lookups
      // (calendars, display names, etc.) are not a privilege escalation.
      contactService: this.contactService,
      // Thread agentId and taskEventId into context unconditionally — capability-gated
      // skills (bullpen) need these for event publishing; harmless for others.
      agentId: options?.agentId,
      taskEventId: options?.taskEventId,
      // Forward task-level metadata (e.g. observationMode) so skills can adjust
      // their behaviour without needing a separate out-of-band signalling channel.
      taskMetadata: options?.taskMetadata,
    };

    // Capability-gated service injection.
    // Skills declare which privileged services they need in manifest.capabilities.
    // The loader validates the names and freezes the manifest at startup.
    // We inject only the declared services — skills cannot escalate privilege.
    const caps = manifest.capabilities ?? [];

    // Explicit lookup map — enumerates every capability-gated service by name.
    // Using a map rather than `(this as Record<string, unknown>)[cap]` keeps TypeScript
    // aware that each field is read, satisfying noUnusedLocals.
    // Field names here MUST match the VALID_CAPABILITIES set in loader.ts.
    const capabilityServices: Record<string, unknown> = {
      bus: this.bus,
      agentRegistry: this.agentRegistry,
      outboundGateway: this.outboundGateway,
      heldMessages: this.heldMessages,
      schedulerService: this.schedulerService,
      entityMemory: this.entityMemory,
      nylasCalendarClient: this.nylasCalendarClient,
      autonomyService: this.autonomyService,
      browserService: this.browserService,
      bullpenService: this.bullpenService,
    };

    // Fail-closed: if a declared capability is not available on this ExecutionLayer,
    // refuse to run the skill. This catches configuration errors at invocation time.
    const missingCaps = caps.filter(cap => {
      if (cap === 'skillSearch') return false; // skillSearch is synthesized, not a field on `this`
      return capabilityServices[cap] === undefined;
    });
    if (missingCaps.length > 0) {
      skillLogger.error(
        { skillName, missingCapabilities: missingCaps },
        'Skill declares capabilities not available on ExecutionLayer',
      );
      return {
        success: false,
        error: this.wrapSkillError(
          `Skill '${skillName}' requires capabilities [${missingCaps.join(', ')}] ` +
          `but they are not configured on the ExecutionLayer`,
        ),
      };
    }

    // Compute audit context for entityMemory observer (before the loop — used inside it).
    const memAudit = options?.agentId && options?.conversationId && options?.parentEventId
      ? { agentId: options.agentId, conversationId: options.conversationId, parentEventId: options.parentEventId, taskEventId: options.taskEventId }
      : undefined;

    for (const cap of caps) {
      if (cap === 'entityMemory') {
        // Special case: wrap with audit observer when audit context is available.
        // Uses this.bus (ExecutionLayer's bus), not the skill's ctx.bus — the observer
        // needs bus access for audit events even if the skill didn't declare 'bus'.
        ctx.entityMemory = memAudit && this.bus
          ? buildEntityMemoryObserver(this.entityMemory!, this.bus, memAudit, skillLogger)
          : this.entityMemory;
      } else if (cap === 'skillSearch') {
        // Special case: skillSearch is a closure over the registry, not a service field.
        // Filters out skill-registry itself to avoid circular self-discovery results.
        ctx.skillSearch = (query: string) =>
          this.registry.search(query)
            .filter(s => s.manifest.name !== 'skill-registry')
            .map(s => ({ name: s.manifest.name, description: s.manifest.description }));
      } else {
        (ctx as unknown as Record<string, unknown>)[cap] = capabilityServices[cap];
      }
    }

    // entityContextAssembler — universal (not capability-gated).
    // The assembler is a read-only DB pipeline; granting it unconditionally is no
    // more privileged than contactService. Keeping it universal means the
    // entity-context skill needs no capabilities declaration at all.
    if (this.entityContextAssembler) {
      ctx.entityContextAssembler = this.entityContextAssembler;
    }

    // Entity enrichment: if the manifest declares entity_enrichment, pre-assemble
    // EntityContext before invoking the handler. This makes enrichment deterministic
    // and invisible to the LLM — it never sees raw calendar IDs or KG node IDs.
    if (manifest.entity_enrichment && !this.entityContextAssembler) {
      // A skill declared entity_enrichment but the assembler was not wired in —
      // this is a configuration mistake, not a designed degradation path.
      skillLogger.warn(
        { skillName },
        'entity_enrichment declared in manifest but EntityContextAssembler not configured — skipping pre-enrichment; ctx.entityContext will be undefined',
      );
    }
    if (manifest.entity_enrichment && this.entityContextAssembler) {
      const enrichment = manifest.entity_enrichment;
      const rawIds = input[enrichment.param];

      // Resolve the IDs to enrich: explicit input > default (caller/agent)
      let idsToEnrich: string[] = [];
      if (Array.isArray(rawIds) && rawIds.length > 0) {
        idsToEnrich = rawIds.filter((id): id is string => typeof id === 'string');
      } else {
        // Use the declared default
        if (enrichment.default === 'caller' && caller?.contactId) {
          idsToEnrich = [caller.contactId];
        } else if (enrichment.default === 'agent' && this.agentContactId) {
          idsToEnrich = [this.agentContactId];
        } else {
          // No IDs to enrich — log and continue without pre-enrichment
          skillLogger.debug({ skillName, enrichmentDefault: enrichment.default }, 'entity_enrichment: no IDs to resolve, skipping pre-enrichment');
        }
      }

      if (idsToEnrich.length > 0) {
        try {
          // Run assembleMany under the same timeout budget as the skill itself.
          // Without this, a hung DB query in the assembler would block indefinitely
          // because the invocation timeout race (further below) hasn't been set up yet.
          let enrichmentTimer: NodeJS.Timeout | undefined;
          const enrichmentResult = await Promise.race([
            this.entityContextAssembler.assembleMany(idsToEnrich, { includeRelationships: true }),
            new Promise<never>((_, reject) => {
              enrichmentTimer = setTimeout(
                () => reject(new Error(`entity_enrichment timed out after ${manifest.timeout}ms`)),
                manifest.timeout,
              );
            }),
          ]).finally(() => { clearTimeout(enrichmentTimer); });

          if (enrichmentResult.unresolved.length > 0) {
            skillLogger.warn({ skillName, unresolved: enrichmentResult.unresolved }, 'entity_enrichment: some IDs could not be resolved');
          }
          ctx.entityContext = enrichmentResult.entities;
          skillLogger.debug({ skillName, enrichedCount: enrichmentResult.entities.length }, 'entity_enrichment: pre-enrichment complete');
        } catch (err) {
          // Non-fatal: log and continue without ctx.entityContext.
          // The handler should check ctx.entityContext and handle its absence gracefully.
          skillLogger.error({ err, skillName }, 'entity_enrichment: pre-enrichment failed, continuing without entity context');
        }
      }
    }

    skillLogger.info({ input: Object.keys(input) }, 'Invoking skill');

    // Track the timeout timer so we can clean it up after the race resolves.
    // Without cleanup, successful skill invocations leak timers that keep the
    // process alive during graceful shutdown.
    let timer: NodeJS.Timeout;
    const timeoutPromise = new Promise<SkillResult>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Skill '${skillName}' timed out after ${manifest.timeout}ms`)),
        manifest.timeout,
      );
    });

    try {
      const result = await Promise.race([
        handler.execute(ctx),
        timeoutPromise,
      ]);

      // Sanitize successful output before returning.
      // Strips dangerous tags, redacts secrets, and truncates to the configured limit.
      if (result.success && typeof result.data === 'string') {
        const sanitized = sanitizeOutput(result.data, { maxLength: this.skillOutputMaxLength });
        // Check the original length — post-sanitize length includes the suffix so >=
        // would fire a false positive when output is exactly skillOutputMaxLength chars.
        if (result.data.length > this.skillOutputMaxLength) {
          skillLogger.warn({ skillName, outputLength: result.data.length }, 'Skill output truncated to configured limit');
        }
        return { success: true, data: sanitized };
      } else if (result.success && result.data !== null && result.data !== undefined) {
        const raw = JSON.stringify(result.data);
        const sanitized = sanitizeOutput(raw, { maxLength: this.skillOutputMaxLength });
        if (raw.length > this.skillOutputMaxLength) {
          skillLogger.warn({ skillName, outputLength: raw.length }, 'Skill output truncated to configured limit');
        }
        try {
          return { success: true, data: JSON.parse(sanitized) };
        } catch (parseErr) {
          // Sanitization truncated the JSON mid-structure — return as string rather
          // than silently dropping the truncation marker.
          skillLogger.warn({ err: parseErr, skillName }, 'Sanitized output is not valid JSON, returning as string');
          return { success: true, data: sanitized };
        }
      }

      // Handler returned { success: false, error } directly (did not throw).
      // Sanitize and wrap the error message — handler errors can contain
      // user-supplied values or external content that poses injection risk.
      if (!result.success && result.error) {
        return { success: false, error: this.wrapSkillError(result.error) };
      }

      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      skillLogger.error({ err }, 'Skill invocation failed');
      return { success: false, error: this.wrapSkillError(message) };
    } finally {
      // Clean up the timeout timer whether we succeeded, failed, or timed out
      clearTimeout(timer!);
    }
  }
}

/**
 * Wrap an EntityMemory instance with an observer that emits memory.store audit
 * events after each successful node creation (issue #200 / Phase 6).
 *
 * Uses prototype delegation: the returned object inherits all EntityMemory methods
 * from the original instance and only overrides storeFact and createEntity.
 *
 * Audit event emission is best-effort — a bus failure logs a warning but does not
 * fail the skill invocation. The skill's own result is always returned intact.
 */
function buildEntityMemoryObserver(
  entityMemory: EntityMemory,
  bus: EventBus,
  // All three audit fields are required by createMemoryStore. The call site guards
  // all three before invoking this function, so requiring them here eliminates
  // the unsafe `as string` casts that were needed when the type was optional.
  invokeOptions: { agentId: string; conversationId: string; parentEventId: string; taskEventId?: string },
  logger: Logger,
): EntityMemory {
  const { agentId, conversationId, parentEventId } = invokeOptions;

  // Object.create(instance) produces an object whose [[Prototype]] is the EntityMemory
  // instance, so all non-overridden methods are inherited and run with correct 'this'
  // binding (they find store, validator, etc. on the prototype).
  const observer = Object.create(entityMemory) as EntityMemory;

  observer.storeFact = async (options: StoreFactOptions): Promise<StoreFactResult> => {
    const result = await entityMemory.storeFact(options);
    if (result.stored && result.nodeId && result.sensitivity) {
      // sensitivityFallback means the stored node was unreadable after the update —
      // the audit event sensitivity is re-classified from incoming content and may
      // not match what is on the stored node. Log so operators can investigate.
      if (result.sensitivityFallback) {
        logger.warn(
          { nodeId: result.nodeId, fallbackSensitivity: result.sensitivity },
          'memory.store: sensitivity in audit event may be inaccurate — stored node was unreadable after update (race/transient error)',
        );
      }
      try {
        await bus.publish('agent', createMemoryStore({
          agentId,
          conversationId,
          nodeId: result.nodeId,
          nodeType: 'fact',
          label: options.label,
          source: options.source,
          sensitivity: result.sensitivity,
          parentEventId,
        }));
      } catch (err) {
        // Audit event failure must not fail the skill — log and continue.
        logger.warn({ err, nodeId: result.nodeId }, 'memory.store audit event failed to emit');
      }
    }
    return result;
  };

  observer.createEntity = async (options: CreateEntityOptions) => {
    const result = await entityMemory.createEntity(options);
    const { entity, created } = result;
    // Only emit for new nodes. On upsert (created === false), entity.temporal.source
    // is the original creation provenance — emitting it here would point the audit
    // log at the wrong task/channel. Callers can rely on the original creation event.
    if (!created) return result;
    try {
      await bus.publish('agent', createMemoryStore({
        agentId,
        conversationId,
        nodeId: entity.id,
        nodeType: entity.type,
        label: entity.label,
        source: options.source,
        sensitivity: entity.sensitivity,
        parentEventId,
      }));
    } catch (err) {
      logger.warn({ err, nodeId: entity.id }, 'memory.store audit event failed to emit');
    }
    return result;
  };

  return observer;
}
