// execution.ts — the execution layer runs skills within controlled boundaries.
//
// This is the security boundary between agents and the outside world.
// It resolves skills from the registry, validates permissions, provides
// a sandboxed SkillContext, enforces timeouts, and sanitizes outputs.
//
// Normal skills get: validated input, scoped secret access, a scoped logger.
// They cannot access the bus, database, or filesystem directly.
//
// Infrastructure skills (manifest.infrastructure: true) additionally receive
// bus and agent registry access. This effectively grants unrestricted bus
// publish/subscribe including layer impersonation. Only framework-internal
// skills like 'delegate' should use this — it is a privileged escape hatch.
//
// Entity enrichment (manifest.entity_enrichment): when a skill declares this,
// the execution layer assembles EntityContext for the declared input parameter
// before invoking the handler. The handler receives ctx.entityContext[] and
// never needs to call entity-context itself.

import type { SkillResult, SkillContext, CallerContext, AgentPersona } from './types.js';
import { normalizeTimestamp } from '../time/timestamp.js';
import type { SkillRegistry } from './registry.js';
import { sanitizeOutput } from './sanitize.js';
import type { Logger } from '../logger.js';
import type { EventBus } from '../bus/bus.js';
import type { AgentRegistry } from '../agents/agent-registry.js';
import type { ContactService } from '../contacts/contact-service.js';
import type { OutboundGateway } from './outbound-gateway.js';
import type { HeldMessageService } from '../contacts/held-messages.js';
import type { SchedulerService } from '../scheduler/scheduler-service.js';
import type { EntityMemory } from '../memory/entity-memory.js';
import type { NylasCalendarClient } from '../channels/calendar/nylas-calendar-client.js';
import type { EntityContextAssembler } from '../entity-context/assembler.js';
import type { AutonomyService } from '../autonomy/autonomy-service.js';

// Warn (but don't truncate) when a skill returns more than this many chars.
// Helps operators spot skills that might blow out the LLM context window.
const LARGE_OUTPUT_THRESHOLD = 50_000;

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
  /** The agent's own contactId — injected into ctx.agentContactId for entity_enrichment default='agent' */
  private agentContactId?: string;
  /** IANA timezone name used for normalizing offset-less timestamp inputs from the LLM. */
  private timezone: string;

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
    agentContactId?: string;
    timezone?: string;
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
    this.agentContactId = options?.agentContactId;
    this.timezone = options?.timezone ?? 'UTC';
  }

  /**
   * Update the agent's own contactId after bootstrap has seeded it.
   * Called from index.ts once the agent self-identity is resolved.
   */
  setAgentContactId(contactId: string): void {
    this.agentContactId = contactId;
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
  ): Promise<SkillResult> {
    const skill = this.registry.get(skillName);

    if (!skill) {
      return { success: false, error: `Skill '${skillName}' not found in registry` };
    }

    const { manifest, handler } = skill;

    // Normalize timestamp inputs to UTC Z-suffix before invoking the handler.
    // The LLM often emits offset-less ISO strings (e.g. "2026-04-06T08:00:00")
    // which new Date() on a UTC server interprets as UTC — wrong for Toronto.
    // normalizeTimestamp() interprets offset-less strings as Curia's local time.
    for (const [key, typeStr] of Object.entries(manifest.inputs)) {
      const baseType = typeStr.replace(/\?$/, '').replace(/\s*\(.*\)$/, '').trim();
      if (baseType !== 'timestamp') continue;
      const raw = input[key];
      if (typeof raw !== 'string' || raw.trim() === '') continue;
      try {
        input[key] = normalizeTimestamp(raw, this.timezone);
      } catch (err) {
        // Non-fatal: log and pass the raw value through. The handler may reject it
        // or the LLM may have sent something like "tomorrow" which is genuinely invalid.
        this.logger.warn({ skillName, key, raw, err }, 'timestamp normalization failed; passing raw value to handler');
      }
    }

    // Elevated-skill gate: enforce caller verification before building context.
    // Fail-closed — if caller context is missing, elevated skills are blocked.
    // CLI channel bypasses role check (trusted local operator; role may be null at startup).
    if (manifest.sensitivity === 'elevated') {
      if (!caller) {
        this.logger.warn({ skillName }, 'Elevated skill blocked: no caller context (fail-closed)');
        return {
          success: false,
          error: `Skill '${skillName}' requires elevated privileges — no caller context provided (fail-closed)`,
        };
      }
      if (caller.role !== 'ceo' && caller.channel !== 'cli') {
        this.logger.warn({ skillName, role: caller.role, channel: caller.channel }, 'Elevated skill blocked: unauthorized caller');
        return {
          success: false,
          error: `Skill '${skillName}' requires elevated privileges — caller role '${caller.role ?? 'none'}' on channel '${caller.channel}' is not authorized`,
        };
      }
    }

    const skillLogger = this.logger.child({ skill: skillName });

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
        // Log at debug level — info is too noisy for every secret access
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
    };

    // Infrastructure skills get bus and agent registry access.
    // This is intentionally gated behind a manifest flag so normal skills
    // cannot escalate their privileges by accessing the bus directly.
    if (manifest.infrastructure) {
      if (!this.bus || !this.agentRegistry) {
        skillLogger.error(
          { skillName },
          'Infrastructure skill invoked but ExecutionLayer was not constructed with bus/agentRegistry/contactService',
        );
        return {
          success: false,
          error: `Infrastructure skill '${skillName}' cannot run: bus, agent registry, or contactService not available in ExecutionLayer — ensure all three are passed to the ExecutionLayer constructor`,
        };
      }
      ctx.bus = this.bus;
      ctx.agentRegistry = this.agentRegistry;
      // outboundGateway is optional — only skills that send external messages need it.
      // All outbound communication goes through the gateway, which enforces contact
      // blocked checks and content filtering before dispatch.
      if (this.outboundGateway) {
        ctx.outboundGateway = this.outboundGateway;
      }
      // heldMessages is optional — only held-message skills need it
      if (this.heldMessages) {
        ctx.heldMessages = this.heldMessages;
      }
      // schedulerService is optional — only scheduler skills need it
      if (this.schedulerService) {
        ctx.schedulerService = this.schedulerService;
      }
      // entityMemory is optional — only skills that read/write the knowledge graph need it
      if (this.entityMemory) {
        ctx.entityMemory = this.entityMemory;
      }
      // nylasCalendarClient is optional — only calendar skills need it
      if (this.nylasCalendarClient) {
        ctx.nylasCalendarClient = this.nylasCalendarClient;
      }
    }

    // autonomyService is scoped to the autonomy skills only — not granted to all infrastructure skills.
    // Limiting access here reduces blast radius if any other infrastructure skill is ever compromised.
    if (this.autonomyService && (manifest.name === 'get-autonomy' || manifest.name === 'set-autonomy')) {
      ctx.autonomyService = this.autonomyService;
    }

    // entityContextAssembler — available to ALL skills (not just infrastructure).
    // The assembler is a read-only DB pipeline; granting it unconditionally is no
    // more privileged than contactService. Keeping it outside the infrastructure
    // block means the entity-context skill does not need infrastructure: true,
    // which would otherwise grant it full bus/registry access it doesn't need.
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
      // No default truncation — sanitizeOutput only strips dangerous tags and
      // redacts secrets. We log a warning for large outputs so operators can
      // spot skills that might blow out the LLM context window.
      if (result.success && typeof result.data === 'string') {
        const sanitized = sanitizeOutput(result.data);
        if (sanitized.length > LARGE_OUTPUT_THRESHOLD) {
          skillLogger.warn({ skillName, outputLength: sanitized.length }, 'Skill output exceeds large-output threshold');
        }
        return { success: true, data: sanitized };
      } else if (result.success && result.data !== null && result.data !== undefined) {
        const sanitized = sanitizeOutput(JSON.stringify(result.data));
        if (sanitized.length > LARGE_OUTPUT_THRESHOLD) {
          skillLogger.warn({ skillName, outputLength: sanitized.length }, 'Skill output exceeds large-output threshold');
        }
        try {
          return { success: true, data: JSON.parse(sanitized) };
        } catch (parseErr) {
          // Sanitization broke the JSON (e.g., truncation mid-key) — return as string
          skillLogger.warn({ err: parseErr, skillName }, 'Sanitized output is not valid JSON, returning as string');
          return { success: true, data: sanitized };
        }
      }

      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      skillLogger.error({ err }, 'Skill invocation failed');
      return { success: false, error: message };
    } finally {
      // Clean up the timeout timer whether we succeeded, failed, or timed out
      clearTimeout(timer!);
    }
  }
}
