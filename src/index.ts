/**
 * Curia Bootstrap Orchestrator
 *
 * Initializes all services in dependency order:
 * 1. Config + logging (no dependencies)
 * 2. Database connection (needs config)
 * 2b. Migrations (needs DB connection — runs automatically on startup)
 * 3. Audit logger (needs DB)
 * 4. Message bus (needs logger, audit hook)
 * 5. LLM provider (needs config)
 * 6. Coordinator agent (needs bus, LLM provider)
 * 7. Dispatcher (needs bus)
 * 8. CLI channel (needs bus)
 *
 * This ordering ensures each component has its dependencies available
 * at construction time. The bus must exist before anything subscribes,
 * and the audit logger must be connected before events start flowing.
 */

import * as path from 'node:path';
import { runner } from 'node-pg-migrate';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { HttpAdapter } from './channels/http/http-adapter.js';
import { createPool } from './db/connection.js';
import { EventBus } from './bus/bus.js';
import { AuditLogger } from './audit/logger.js';
import { AnthropicProvider } from './agents/llm/anthropic.js';
import { AgentRuntime } from './agents/runtime.js';
import { Dispatcher } from './dispatch/dispatcher.js';
import { CliAdapter } from './channels/cli/cli-adapter.js';
import { loadAllAgentConfigs, interpolateRuntimeContext } from './agents/loader.js';
import { AgentRegistry } from './agents/agent-registry.js';
import { WorkingMemory } from './memory/working-memory.js';
import { EmbeddingService } from './memory/embedding.js';
import { KnowledgeGraphStore } from './memory/knowledge-graph.js';
import { MemoryValidator } from './memory/validation.js';
import { EntityMemory } from './memory/entity-memory.js';
import { SkillRegistry } from './skills/registry.js';
import { ExecutionLayer } from './skills/execution.js';
import { loadSkillsFromDirectory } from './skills/loader.js';
import { ContactService } from './contacts/contact-service.js';
import { ContactResolver } from './contacts/contact-resolver.js';
import { NylasClient } from './channels/email/nylas-client.js';
import { NylasCalendarClient } from './channels/calendar/nylas-calendar-client.js';
import { EmailAdapter } from './channels/email/email-adapter.js';
import { loadAuthConfig } from './contacts/config-loader.js';
import { AuthorizationService } from './contacts/authorization.js';
import { HeldMessageService } from './contacts/held-messages.js';
import { DEFAULT_ERROR_BUDGET } from './errors/types.js';
import { OutboundContentFilter } from './dispatch/outbound-filter.js';
import { OutboundGateway } from './skills/outbound-gateway.js';
import { SchedulerService } from './scheduler/scheduler-service.js';
import { Scheduler } from './scheduler/scheduler.js';
import { EntityContextAssembler } from './entity-context/assembler.js';
import { bootstrapAgentIdentity } from './entity-context/bootstrap.js';
import { bootstrapCeoContact } from './contacts/ceo-bootstrap.js';
import { AutonomyService } from './autonomy/autonomy-service.js';
import type { AgentPersona } from './skills/types.js';

async function main(): Promise<void> {
  // 1. Config & logging — no dependencies, must come first.
  // loadConfig() throws synchronously if DATABASE_URL is missing, which is
  // intentional: we want a hard failure before any I/O is attempted.
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  logger.info('Curia starting...');

  // 2. Database — needed by audit logger before the bus can accept events.
  // We probe with SELECT 1 to distinguish a misconfigured URL (fast fail)
  // from a legitimate connection that might be retried later.
  const pool = createPool(config.databaseUrl, logger);
  try {
    await pool.query('SELECT 1');
    logger.info('Database connected');
  } catch (err) {
    logger.fatal({ err }, 'Database connection failed');
    process.exit(1);
  }

  // Autonomy service — manages the global autonomy score (0–100).
  // Instantiated early (right after DB connect) so it's ready before agents start.
  const autonomyService = new AutonomyService(pool, logger);

  // Run pending migrations so the schema is always current when the process starts.
  // Uses node-pg-migrate's programmatic runner with the same DATABASE_URL.
  // This is safe for single-process deployments; node-pg-migrate acquires an
  // advisory lock to prevent concurrent migration runs.
  try {
    // Resolve from the project root (one level up from src/ or dist/) so the
    // path works both in dev (tsx src/index.ts) and production (node dist/index.js).
    const migrationsDir = path.resolve(import.meta.dirname, '..', 'src', 'db', 'migrations');
    const applied = await runner({
      databaseUrl: config.databaseUrl,
      dir: migrationsDir,
      migrationsTable: 'pgmigrations',
      direction: 'up',
      log: (msg: string) => logger.debug({ migration: true }, msg),
    });
    if (applied.length > 0) {
      logger.info({ count: applied.length, migrations: applied.map(m => m.name) }, 'Database migrations applied');
    } else {
      logger.debug('Database schema up to date');
    }
  } catch (err) {
    logger.fatal({ err }, 'Database migration failed');
    process.exit(1);
  }

  // 3. Audit logger — must be ready before the bus starts accepting events.
  // The bus's write-ahead hook calls auditLogger.log() synchronously before
  // delivering to any subscriber, so this must exist when the bus is constructed.
  const auditLogger = new AuditLogger(pool, logger);

  // 4. Message bus — the write-ahead hook ensures every event is durably
  // recorded before it reaches any subscriber. Losing a message is worse
  // than slowing down delivery, hence the synchronous-before-fanout design.
  const bus = new EventBus(logger, (event) => auditLogger.log(event));

  // 5. LLM provider — hard fail early rather than discovering the missing
  // key only when the first user message arrives.
  if (!config.anthropicApiKey) {
    logger.fatal('ANTHROPIC_API_KEY is required');
    process.exit(1);
  }
  const llmProvider = new AnthropicProvider(config.anthropicApiKey, logger);

  // Working memory — created after the pool is confirmed healthy so we know
  // the working_memory table is reachable before the first message arrives.
  const memory = WorkingMemory.createWithPostgres(pool, logger);

  // Entity memory — optional, requires OPENAI_API_KEY for embeddings.
  // If not configured, agents still work — they just don't have KG access.
  let entityMemory: EntityMemory | undefined;
  if (config.openaiApiKey) {
    const embeddingService = EmbeddingService.createWithOpenAI(config.openaiApiKey, logger);
    const kgStore = KnowledgeGraphStore.createWithPostgres(pool, embeddingService, logger);
    const validator = new MemoryValidator(kgStore, embeddingService);
    entityMemory = new EntityMemory(kgStore, validator, embeddingService);
    logger.info('Entity memory initialized with knowledge graph');
  } else {
    logger.warn('OPENAI_API_KEY not set — entity memory disabled (knowledge graph unavailable)');
  }

  // Contact system — provides identity resolution and contact management.
  // Always initialized (contacts work even without entity memory / KG).
  const contactService = ContactService.createWithPostgres(pool, entityMemory, logger);

  // Authorization config — load role defaults, permissions, and channel trust.
  // These YAML files define the deterministic permission model.
  // Fatal on failure: authorization is a security boundary. Silent degradation
  // would mean unreviewed senders get the wrong permissions. Fail loudly instead.
  let authService: AuthorizationService | undefined;
  let authConfig: ReturnType<typeof loadAuthConfig> | undefined;
  try {
    const configDir = path.resolve(import.meta.dirname, '../config');
    authConfig = loadAuthConfig(configDir);
    authService = new AuthorizationService(authConfig);
    logger.info('Authorization config loaded');
  } catch (err) {
    logger.fatal({ err }, 'Failed to load authorization config');
    process.exit(1);
  }

  const contactResolver = new ContactResolver(contactService, entityMemory, authService, logger);
  logger.info('Contact system initialized');

  // Entity context assembler — assembles EntityContext payloads from the KG, contacts,
  // and connected accounts. Created here (after contact system) so it can query the DB
  // for facts, calendars, and relationships. Passed to ExecutionLayer for pre-enrichment.
  const entityContextAssembler = new EntityContextAssembler(pool, logger);

  // Agent self-identity — seed Curia's KG node and contact record at startup.
  // Idempotent: safe to call every startup (uses INSERT ... ON CONFLICT).
  // Fatal on failure: without a contactId, "your calendar" cannot be resolved
  // and entity_enrichment default='agent' would silently produce no results.
  let agentIdentityContactId: string | undefined;
  const agentDisplayName = 'Curia'; // @TODO: read from coordinatorConfig.persona.display_name after agentConfigs are loaded
  try {
    const agentIdentity = await bootstrapAgentIdentity(agentDisplayName, pool, logger);
    agentIdentityContactId = agentIdentity.contactId;
    logger.info({ contactId: agentIdentityContactId }, 'Agent self-identity ready');
  } catch (err) {
    // Non-fatal: warn and continue. Three things degrade:
    // 1. entity_enrichment default='agent' will return no results
    // 2. The coordinator's ${agent_contact_id} prompt placeholder will be empty
    // 3. Interactive entity-context lookups for "you"/"your" will fail to resolve
    logger.warn({ err }, 'Agent self-identity bootstrap failed — entity_enrichment default=agent will not resolve; coordinator system prompt ${agent_contact_id} will be empty');
  }

  // CEO contact bootstrap — ensures the CEO's primary email contact exists with
  // status=confirmed and verified=true before the email adapter starts polling.
  // Without this, the first inbound email from the CEO auto-creates them as
  // provisional (the extractParticipants default), causing their messages to be held.
  if (config.ceoPrimaryEmail) {
    try {
      await bootstrapCeoContact(config.ceoPrimaryEmail, 'CEO', pool, logger);
    } catch (err) {
      // Non-fatal: log and continue. Severity depends on whether the email adapter is active:
      // - With email configured: the CEO's first message will be held if the contact doesn't
      //   exist yet — escalate to error so it shows up in log aggregators.
      // - Without email: no adapter polls, so the risk is deferred and a warn suffices.
      // A unique constraint violation (23505) indicates inconsistent DB state (e.g. a
      // channel identity row with no matching contact), not a transient failure — flag it
      // separately so operators know to inspect contact_channel_identities directly.
      const pgCode = (err as { code?: string }).code;
      if (pgCode === '23505') {
        logger.error(
          { err, ceoPrimaryEmail: config.ceoPrimaryEmail },
          'CEO contact bootstrap failed with unique constraint violation — possible inconsistent DB state. Inspect contact_channel_identities for orphaned rows.',
        );
      } else if (config.nylasApiKey && config.nylasGrantId) {
        logger.error(
          { err, ceoPrimaryEmail: config.ceoPrimaryEmail },
          'CEO contact bootstrap failed with email adapter active — CEO emails WILL be held if contact does not exist',
        );
      } else {
        logger.warn(
          { err, ceoPrimaryEmail: config.ceoPrimaryEmail },
          'CEO contact bootstrap failed — CEO emails may be held if contact is provisional',
        );
      }
    }
  } else {
    logger.warn('CEO_PRIMARY_EMAIL not set — CEO contact bootstrap skipped. Set this to prevent CEO emails from being held on first contact.');
  }

  // Held messages — stores messages from unknown senders pending CEO review.
  const heldMessages = HeldMessageService.createWithPostgres(pool, logger);
  logger.info('Held message service initialized');

  // Email channel — optional, requires NYLAS_API_KEY, NYLAS_GRANT_ID, and NYLAS_SELF_EMAIL.
  // NylasClient is constructed here (needed by OutboundGateway), but EmailAdapter is
  // started later after the gateway is fully wired (adapter needs the gateway, not raw client).
  let nylasClient: NylasClient | undefined;
  let emailAdapter: EmailAdapter | undefined;
  if (config.nylasApiKey && config.nylasGrantId) {
    nylasClient = new NylasClient(config.nylasApiKey, config.nylasGrantId, logger);
    if (!config.nylasSelfEmail) {
      logger.warn('NYLAS_SELF_EMAIL not set — email adapter disabled (required to filter self-sent messages)');
    }
    // EmailAdapter is started further below, after OutboundGateway is constructed.
  } else {
    logger.warn('NYLAS_API_KEY/NYLAS_GRANT_ID not set — email channel disabled');
  }

  // Calendar client — uses the same Nylas credentials as email.
  // Independent instance, no shared state with the email client.
  let nylasCalendarClient: NylasCalendarClient | undefined;
  if (config.nylasApiKey && config.nylasGrantId) {
    nylasCalendarClient = new NylasCalendarClient(config.nylasApiKey, config.nylasGrantId, logger);
    logger.info('Nylas calendar client initialized');
  }

  // Skill registry — loads all skills from the skills/ directory.
  // Skills are the framework's extension mechanism; agents invoke them
  // via the LLM's tool-use API through the execution layer.
  const skillRegistry = new SkillRegistry(config.timezone);
  const skillsDir = path.resolve(import.meta.dirname, '../skills');
  try {
    const skillCount = await loadSkillsFromDirectory(skillsDir, skillRegistry, logger);
    logger.info({ skillCount }, 'Skills loaded');
  } catch (err) {
    // Fail hard on skill loading errors — a broken skill.json or handler should
    // not silently degrade the system to no-tools mode. Consistent with how we
    // handle missing DATABASE_URL and ANTHROPIC_API_KEY.
    logger.fatal({ err }, 'Failed to load skills');
    process.exit(1);
  }

  // Agent registry — tracks all running agents for delegation and listing.
  const agentRegistry = new AgentRegistry();

  // Load all agent configs from the agents/ directory.
  // Fail hard on errors — consistent with skill loading and DB connection checks.
  const agentsDir = path.resolve(import.meta.dirname, '../agents');
  let agentConfigs;
  try {
    agentConfigs = loadAllAgentConfigs(agentsDir);
    logger.info({ agents: agentConfigs.map(c => c.name) }, 'Agent configs loaded');
  } catch (err) {
    logger.fatal({ err }, 'Failed to load agent configs');
    process.exit(1);
  }

  // Outbound content filter — extracts distinctive marker phrases from the
  // coordinator's persona config and uses them to detect prompt leakage in
  // outbound emails. Markers are derived dynamically so they stay in sync
  // as the persona evolves.
  //
  // @TODO: The current marker extraction only covers persona fields (display_name,
  // title, tone). It does NOT extract markers from the full system prompt text,
  // which contains many more distinctive instruction phrases. Extracting arbitrary
  // sentences would risk false positives, so this gap is intentionally left for
  // the Stage 2 LLM-as-judge to cover. When Stage 2 is implemented, revisit
  // whether additional deterministic markers should be extracted from the prompt.
  // Look up by name (not role) — agent YAML files use `name: coordinator` as the
  // canonical identifier. Role is an optional field and may not match "coordinator"
  // if the config uses a different role value (e.g., "chief-of-staff").
  const coordinatorConfig = agentConfigs.find(c => c.name === 'coordinator');

  // Extract agent persona from the coordinator config. This is the single source
  // of truth for the agent's identity — used by the system prompt (via YAML
  // interpolation) and by skills (via SkillContext.agentPersona) so templates
  // and outbound-facing code never hardcode the agent's name or title.
  let agentPersona: AgentPersona | undefined;
  if (coordinatorConfig?.persona) {
    agentPersona = {
      displayName: coordinatorConfig.persona.display_name ?? 'Curia',
      title: coordinatorConfig.persona.title ?? 'Agent Chief of Staff',
      emailSignature: coordinatorConfig.persona.email_signature ?? undefined,
    };
    logger.info({ displayName: agentPersona.displayName, title: agentPersona.title }, 'Agent persona extracted from coordinator config');
  } else {
    logger.warn('No coordinator persona found — skills will not have agent identity context');
  }

  let outboundFilter: OutboundContentFilter | undefined;
  if (coordinatorConfig) {
    const systemPromptMarkers = extractSystemPromptMarkers(coordinatorConfig);
    const ceoEmail = config.nylasSelfEmail ?? '';
    if (!ceoEmail) {
      logger.warn('Outbound content filter initialized without CEO email — contact-data-leak rule may produce false positives');
    }
    if (systemPromptMarkers.length === 0) {
      logger.warn('No system prompt markers extracted — system-prompt-fragment rule will not detect prompt leakage. Check that coordinator has persona.display_name and persona.tone configured.');
    }
    outboundFilter = new OutboundContentFilter({
      systemPromptMarkers,
      ceoEmail,
    });
    logger.info({ markerCount: systemPromptMarkers.length }, 'Outbound content filter initialized');
  }

  // Outbound gateway — single choke-point for all outbound external communication.
  // Wraps nylasClient with blocked-contact checks and content filtering before
  // any message leaves Curia. Only instantiated when nylasClient is available
  // (i.e., Nylas credentials are configured). Skills receive it via SkillContext.
  let outboundGateway: OutboundGateway | undefined;
  if (nylasClient && outboundFilter && config.nylasSelfEmail) {
    outboundGateway = new OutboundGateway({
      nylasClient,
      contactService,
      contentFilter: outboundFilter,
      bus,
      ceoEmail: config.nylasSelfEmail,
      logger,
    });
    logger.info('Outbound gateway initialized');
  } else if (nylasClient) {
    // nylasClient is available but outboundFilter or ceoEmail is missing — log a warning.
    // Email skills will be unavailable because they check ctx.outboundGateway before sending.
    logger.warn('Outbound gateway NOT initialized — missing outboundFilter or nylasSelfEmail. Email send/reply skills will be unavailable.');
  }

  // Construct the email adapter (but don't start it yet — it must not poll until
  // the dispatcher is registered, otherwise inbound.message events have no subscriber
  // and are permanently dropped because the adapter advances its high-water mark).
  if (outboundGateway && config.nylasSelfEmail) {
    emailAdapter = new EmailAdapter({
      bus,
      logger,
      outboundGateway,
      contactService,
      pollingIntervalMs: config.nylasPollingIntervalMs,
      selfEmail: config.nylasSelfEmail,
    });
  }

  // Scheduler — Postgres-backed job scheduler for cron and one-shot tasks.
  // SchedulerService is the shared service; Scheduler is the polling loop.
  // Constructed early so it can be passed to ExecutionLayer and HttpAdapter.
  const schedulerService = new SchedulerService(pool, bus, logger, config.timezone);
  const scheduler = new Scheduler({ pool, bus, logger, schedulerService });

  // Execution layer — now with bus, agent registry, and outbound gateway for
  // infrastructure skills. outboundGateway gives email skills their send path.
  // entityContextAssembler enables entity_enrichment pre-enrichment and the
  // entity-context skill. agentContactId enables entity_enrichment default='agent'.
  const executionLayer = new ExecutionLayer(skillRegistry, logger, { bus, agentRegistry, contactService, outboundGateway, heldMessages, schedulerService, entityMemory, agentPersona, nylasCalendarClient, entityContextAssembler, agentContactId: agentIdentityContactId, autonomyService, timezone: config.timezone });

  // Two-pass agent registration:
  // Pass 1: Register all agents in the registry so specialistSummary() is complete
  //         before the Coordinator's system prompt is interpolated.
  // Pass 2: Create AgentRuntime instances with fully interpolated prompts.
  // Without this split, the coordinator (alphabetically first) would be interpolated
  // before any specialists are registered, resulting in an empty specialist list.

  // Pass 1: Populate registry with all agent names, roles, and descriptions
  try {
    for (const agentConfig of agentConfigs) {
      agentRegistry.register(agentConfig.name, {
        role: agentConfig.role ?? 'specialist',
        description: agentConfig.description ?? agentConfig.name,
      });
    }
  } catch (err) {
    logger.fatal({ err }, 'Failed during agent registration');
    process.exit(1);
  }

  // Pass 2: Create AgentRuntime for each config (now all specialists are known)
  for (const agentConfig of agentConfigs) {
    // Build tool definitions from pinned skills
    const agentPinnedSkills = agentConfig.pinned_skills ?? [];
    const agentToolDefs = skillRegistry.toToolDefinitions(agentPinnedSkills);

    // For the coordinator, interpolate runtime context (specialist list, agent contact ID).
    // Date and timezone are no longer baked in here — they are appended fresh on every
    // task turn via AgentRuntime using formatTimeContextBlock() so they never go stale.
    // This runs in pass 2 so all specialists are already in the registry.
    let systemPrompt = agentConfig.system_prompt;
    if (agentConfig.role === 'coordinator') {
      systemPrompt = interpolateRuntimeContext(systemPrompt, {
        availableSpecialists: agentRegistry.specialistSummary(),
        agentContactId: agentIdentityContactId,
      });
    }

    const agent = new AgentRuntime({
      agentId: agentConfig.name,
      systemPrompt,
      provider: llmProvider,
      bus,
      logger,
      memory,
      entityMemory,
      executionLayer,
      pinnedSkills: agentPinnedSkills,
      skillToolDefs: agentToolDefs,
      // Only the coordinator receives the autonomy service — it's the only agent
      // that needs per-task autonomy prompt injection and the autonomy skills.
      // Use name (not role) — role is optional in agent YAML and may not be set.
      autonomyService: agentConfig.name === 'coordinator' ? autonomyService : undefined,
      // The coordinator gets per-turn time block injection so the date/timezone are
      // always current. Specialist agents don't need this — they work with
      // structured data, not user-facing time references.
      timezone: agentConfig.name === 'coordinator' ? config.timezone : undefined,
      // Map YAML snake_case fields to AgentConfig camelCase, falling back to
      // DEFAULT_ERROR_BUDGET values for any omitted fields.
      errorBudget: agentConfig.error_budget ? {
        maxTurns: agentConfig.error_budget.max_turns ?? DEFAULT_ERROR_BUDGET.maxTurns,
        maxConsecutiveErrors: agentConfig.error_budget.max_errors ?? DEFAULT_ERROR_BUDGET.maxConsecutiveErrors,
      } : undefined,
    });
    agent.register();

    if (agentToolDefs.length > 0) {
      logger.info({ agent: agentConfig.name, skills: agentPinnedSkills }, 'Agent tools configured');
    }
  }

  // Verify we have a coordinator — the system requires exactly one.
  if (!agentRegistry.has('coordinator')) {
    logger.fatal('No coordinator agent found in agents/ directory');
    process.exit(1);
  }

  // Load declarative schedules from agent YAML configs and start the scheduler loop.
  // Runs after agent registration so all agents are known when jobs are upserted.
  await scheduler.loadDeclarativeJobs(agentConfigs);
  scheduler.start();
  logger.info('Scheduler started');

  // 7. Dispatcher — subscribes to inbound.message + agent.response.
  // Registered after the coordinator so agent.task already has a handler
  // when the dispatcher fans the first inbound message out.
  // Content filter, externalChannels, and ceoNotification are now handled by OutboundGateway.
  // The Dispatcher only routes — it no longer contains any filter logic.
  const dispatcher = new Dispatcher({
    bus,
    logger,
    contactResolver,
    heldMessages,
    channelPolicies: authConfig?.channelPolicies,
  });
  dispatcher.register();

  // Start the email adapter AFTER the dispatcher is registered so inbound.message
  // events always have a subscriber. Starting before registration would drop emails
  // arriving during the startup window (the adapter advances its high-water mark
  // on poll, so dropped messages are never retried).
  if (emailAdapter) {
    await emailAdapter.start();
    logger.info('Email channel adapter started');
  }

  // HTTP API channel — REST + SSE endpoints for external clients.
  // Runs alongside the CLI channel so both can be used simultaneously.
  const httpAdapter = new HttpAdapter({
    bus,
    logger,
    pool,
    agentRegistry,
    port: config.httpPort,
    apiToken: config.apiToken,
    webAppBootstrapSecret: config.webAppBootstrapSecret,
    appOrigin: config.appOrigin,
    agentNames: agentConfigs.map(c => c.name),
    skillNames: skillRegistry.list().map(s => s.manifest.name),
    schedulerService,
  });

  try {
    await httpAdapter.start();
  } catch (err) {
    logger.fatal({ err }, 'Failed to start HTTP API');
    process.exit(1);
  }

  // Graceful shutdown — stop accepting new input first, then close connections.
  const shutdown = async () => {
    logger.info('Shutting down...');
    if (emailAdapter) {
      try {
        await emailAdapter.stop();
      } catch (err) {
        logger.error({ err }, 'Error stopping email adapter during shutdown');
      }
    }
    try {
      await httpAdapter.stop();
    } catch (err) {
      logger.error({ err }, 'Error stopping HTTP API during shutdown');
    }
    try {
      scheduler.stop();
    } catch (err) {
      logger.error({ err }, 'Error stopping scheduler during shutdown');
    }
    try {
      await pool.end();
    } catch (err) {
      logger.error({ err }, 'Error closing database pool during shutdown');
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown());
  // Handle SIGINT unconditionally here rather than inside CliAdapter.start().
  // Previously SIGINT was only caught when the CLI adapter was running; with
  // the TTY guard above, non-TTY (Docker/production) deployments had no SIGINT
  // handler and would terminate uncleanly without draining the DB pool, stopping
  // the scheduler, or gracefully closing the HTTP server.
  process.on('SIGINT', () => void shutdown());

  // 8. CLI channel — only started when stdin is an interactive TTY (i.e., local dev).
  // In Docker / production, stdin is closed or a pipe: readline receives EOF
  // immediately and would fire onExit, triggering shutdown before any work is done.
  // Guarding on isTTY means the HTTP API and email channel handle all production
  // input while the CLI remains available for local development sessions.
  if (process.stdin.isTTY) {
    const cli = new CliAdapter(bus, logger, () => void shutdown());
    cli.start();
    // Print welcome directly to stdout (logger writes to curia.log in dev mode)
    process.stdout.write('\nCuria is ready. Type a message, /quit to exit, or Ctrl+C.\n\n');
    cli.prompt();
  }
}

/**
 * Extract distinctive marker phrases from the coordinator config that would
 * indicate system prompt leakage if they appeared in an outbound email.
 * These are persona-specific strings that wouldn't occur in normal business writing.
 */
function extractSystemPromptMarkers(
  config: import('./agents/loader.js').AgentYamlConfig,
): string[] {
  const markers: string[] = [];

  // Full instruction phrases — distinctive enough to not appear in business email.
  // We use the full instruction form ("You are X") rather than just the name/title
  // to avoid false positives on email signatures.
  if (config.persona?.display_name) {
    markers.push(`You are ${config.persona.display_name}`);
  }
  if (config.persona?.display_name && config.persona?.title) {
    markers.push(`${config.persona.display_name}, the ${config.persona.title}`);
  }
  if (config.persona?.tone) {
    markers.push(config.persona.tone);
  }

  return markers;
}

// Pre-logger fallback — if main() throws during config loading (before the
// proper logger is constructed), pino may not be initialized. We create a
// minimal error-level logger here so fatal startup errors are still structured
// JSON rather than an unhandled exception dumped to stderr.
const fallbackLogger = createLogger('error');
main().catch((err) => {
  fallbackLogger.fatal({ err }, 'Fatal startup error');
  process.exit(1);
});
