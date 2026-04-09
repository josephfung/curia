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
import { loadConfig, loadYamlConfig } from './config.js';
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
import { DedupService } from './contacts/dedup-service.js';
import { ContactResolver } from './contacts/contact-resolver.js';
import { createContactDuplicateDetected, createContactMerged } from './bus/events.js';
import { NylasClient } from './channels/email/nylas-client.js';
import { NylasCalendarClient } from './channels/calendar/nylas-calendar-client.js';
import { EmailAdapter } from './channels/email/email-adapter.js';
import { SignalRpcClient } from './channels/signal/signal-rpc-client.js';
import { SignalAdapter } from './channels/signal/signal-adapter.js';
import { loadAuthConfig } from './contacts/config-loader.js';
import { AuthorizationService } from './contacts/authorization.js';
import { HeldMessageService } from './contacts/held-messages.js';
import { DEFAULT_ERROR_BUDGET } from './errors/types.js';
import { OutboundContentFilter } from './dispatch/outbound-filter.js';
import { OutboundGateway } from './skills/outbound-gateway.js';
import { InboundScanner } from './dispatch/inbound-scanner.js';
import { loadExtraInjectionPatterns, type ExtraInjectionPattern } from './dispatch/security-config-loader.js';
import type { TrustScorerWeights } from './dispatch/trust-scorer.js';
import { SchedulerService } from './scheduler/scheduler-service.js';
import { Scheduler } from './scheduler/scheduler.js';
import { EntityContextAssembler } from './entity-context/assembler.js';
import { bootstrapAgentIdentity } from './entity-context/bootstrap.js';
import { bootstrapCeoContact } from './contacts/ceo-bootstrap.js';
import { AutonomyService } from './autonomy/autonomy-service.js';
import { BrowserService } from './browser/browser-service.js';
import { OfficeIdentityService } from './identity/service.js';
import type { AgentPersona } from './skills/types.js';
import type { ConfigChangeEvent } from './bus/events.js';
import { BullpenService } from './memory/bullpen.js';
import { BullpenDispatcher } from './dispatch/bullpen-dispatcher.js';
import { ConversationCheckpointProcessor } from './checkpoint/processor.js';

async function main(): Promise<void> {
  // 1. Config & logging — no dependencies, must come first.
  // loadConfig() throws synchronously if DATABASE_URL is missing, which is
  // intentional: we want a hard failure before any I/O is attempted.
  const config = loadConfig();
  const configDir = path.resolve(import.meta.dirname, '../config');
  const yamlConfig = loadYamlConfig(configDir);
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

  // 4b. Office identity — System-layer service that owns the instance persona.
  // Must be initialized after migrations (schema) and bus (emits config.change events),
  // and before agents boot (coordinator needs ${office_identity_block}).
  // Fatal on failure: without an identity, the coordinator system prompt is incomplete.
  const identityConfigPath = path.resolve(import.meta.dirname, '../config/office-identity.yaml');
  const officeIdentityService = new OfficeIdentityService(pool, logger, bus, identityConfigPath);
  try {
    await officeIdentityService.initialize();
    logger.info({ name: officeIdentityService.get().assistant.name }, 'Office identity initialized');
  } catch (err) {
    logger.fatal({ err }, 'Failed to initialize office identity service');
    process.exit(1);
  }

  // 5. LLM provider — hard fail early rather than discovering the missing
  // key only when the first user message arrives.
  if (!config.anthropicApiKey) {
    logger.fatal('ANTHROPIC_API_KEY is required');
    process.exit(1);
  }
  const llmProvider = new AnthropicProvider(config.anthropicApiKey, logger);

  // Working memory — created after the pool is confirmed healthy so we know
  // the working_memory table is reachable before the first message arrives.
  // Summarization config is read from default.yaml (workingMemory.summarization).
  // llmProvider is already initialized above (step 5) so we can pass it directly.
  // If the config block is absent, summarization is disabled (no-op backend).
  const summarizationCfg = yamlConfig.workingMemory?.summarization;
  const memory = WorkingMemory.createWithPostgres(pool, logger, summarizationCfg
    ? {
        threshold: summarizationCfg.threshold ?? 20,
        keepWindow: summarizationCfg.keepWindow ?? 10,
        provider: llmProvider,
      }
    : undefined,
  );

  // Entity memory — optional, requires OPENAI_API_KEY for embeddings.
  // If not configured, agents still work — they just don't have KG access.
  let entityMemory: EntityMemory | undefined;
  if (config.openaiApiKey) {
    const embeddingService = EmbeddingService.createWithOpenAI(config.openaiApiKey, logger);
    const kgStore = KnowledgeGraphStore.createWithPostgres(pool, embeddingService, logger);
    const validator = new MemoryValidator(kgStore, embeddingService);
    entityMemory = new EntityMemory(kgStore, validator, embeddingService, logger);
    logger.info('Entity memory initialized with knowledge graph');
  } else {
    logger.warn('OPENAI_API_KEY not set — entity memory disabled (knowledge graph unavailable)');
  }

  // Bullpen service — Tier 2 inter-agent discussion. Always initialized (no
  // external API key required — just Postgres, which is already confirmed above).
  const bullpenService = BullpenService.createWithPostgres(pool, logger);
  logger.info('Bullpen service initialized');

  // Contact system — provides identity resolution and contact management.
  // Always initialized (contacts work even without entity memory / KG).
  // DedupService is wired here so that createContact() automatically checks for
  // probable duplicates and fires bus events when a match is found or merged.
  const dedupService = new DedupService();
  const contactService = ContactService.createWithPostgres(pool, entityMemory, logger, {
    dedupService,
    onDuplicateDetected: (newContactId, matchContactId, confidence, reason) => {
      // Publish to the bus for audit logging and Coordinator notification.
      // parentEventId is not available (dedup fires as a background side-effect
      // of createContact(), not in response to a specific bus event).
      const event = createContactDuplicateDetected({
        newContactId,
        probableMatchId: matchContactId,
        confidence,
        reason,
      });
      // bus.publish() is async — catch errors so a failed publish never crashes
      // the createContact() call path or silently swallows the result.
      bus.publish('dispatch', event).catch((err: unknown) =>
        logger.error({ err }, 'Failed to publish contact.duplicate_detected — audit trail may be incomplete'),
      );
    },
    onContactMerged: (primaryContactId, secondaryContactId, mergedAt) => {
      const event = createContactMerged({
        primaryContactId,
        secondaryContactId,
        // ContactMergedPayload.mergedAt is typed as Date — pass directly (no serialization here).
        mergedAt,
      });
      bus.publish('dispatch', event).catch((err: unknown) =>
        logger.error({ err }, 'Failed to publish contact.merged — audit trail may be incomplete'),
      );
    },
  });

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
  // Read display name from the identity service — now the single source of truth.
  const agentDisplayName = officeIdentityService.get().assistant.name;
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

  // Signal channel — optional, requires SIGNAL_SOCKET_PATH and SIGNAL_PHONE_NUMBER.
  // SignalRpcClient is constructed here so it can be passed to OutboundGateway (the gateway
  // needs it for outbound Signal sends). SignalAdapter is started further below, after the
  // gateway is constructed and the dispatcher is registered.
  // Ordering matters: dispatcher must be registered before any adapter starts, so inbound
  // messages never arrive without a subscriber (same rule as EmailAdapter).
  let signalRpcClient: SignalRpcClient | undefined;
  let signalAdapter: SignalAdapter | undefined;
  if (config.signalSocketPath && config.signalPhoneNumber) {
    signalRpcClient = new SignalRpcClient({
      socketPath: config.signalSocketPath,
      accountNumber: config.signalPhoneNumber,
      logger,
    });
    // SignalAdapter is constructed further below, after OutboundGateway is available.
    // Note: phone number intentionally omitted from the log — it's PII and would land
    // in any log aggregation pipeline. The socket path is sufficient for diagnostics.
    logger.info({ socketPath: config.signalSocketPath }, 'Signal RPC client created');
  } else {
    logger.warn('SIGNAL_SOCKET_PATH/SIGNAL_PHONE_NUMBER not set — Signal channel disabled');
  }

  // Calendar client — uses the same Nylas credentials as email.
  // Independent instance, no shared state with the email client.
  let nylasCalendarClient: NylasCalendarClient | undefined;
  if (config.nylasApiKey && config.nylasGrantId) {
    nylasCalendarClient = new NylasCalendarClient(config.nylasApiKey, config.nylasGrantId, logger);
    logger.info('Nylas calendar client initialized');
  }

  // Browser service — warm Playwright Chromium instance for the web-browser skill.
  // Optional degradation: if Xvfb is unavailable on Linux, Curia boots normally
  // but web-browser skill invocations will fail at the ctx.browserService check.
  let browserService: BrowserService | undefined;
  try {
    // TODO(#192): browserConfig should come from yamlConfig.browser, not this cast.
    // The cast always resolves to undefined, so these values are always the hardcoded
    // defaults and the YAML settings have no effect. Fix tracked in issue #204.
    const browserConfig = (config as unknown as { browser?: { sessionTtlMs?: number; sweepIntervalMs?: number } }).browser;
    browserService = new BrowserService({
      logger,
      sessionTtlMs: browserConfig?.sessionTtlMs ?? 600_000,
      sweepIntervalMs: browserConfig?.sweepIntervalMs ?? 120_000,
    });
    await browserService.start();
    logger.info('Browser service started');
  } catch (err) {
    logger.warn({ err }, 'Browser service failed to start — web-browser skill will be unavailable');
    // Clean up any partially started resources (e.g., Xvfb spawned before Chromium launch failed).
    // Without this, xvfbProcess stays alive for the duration of the app even though the
    // browser service never came up. stop() is safe to call after a failed start().
    if (browserService) {
      await browserService.stop().catch((stopErr: unknown) => {
        logger.error({ err: stopErr }, 'Error cleaning up partially started browser service');
      });
    }
    browserService = undefined;
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

  // Extract agent persona from the identity service — the single source of truth
  // for the agent's identity. Used by skills (via SkillContext.agentPersona) so
  // templates and outbound-facing code never hardcode the agent's name or title.
  const officeIdentity = officeIdentityService.get();
  const agentPersona: AgentPersona = {
    displayName: officeIdentity.assistant.name,
    title: officeIdentity.assistant.title,
    emailSignature: officeIdentity.assistant.emailSignature || undefined,
  };
  logger.info({ displayName: agentPersona.displayName, title: agentPersona.title }, 'Agent persona loaded from office identity service');

  // Keep agentPersona in sync with hot-reloaded identity changes.
  // ExecutionLayer holds a reference to the agentPersona object (not a snapshot),
  // so mutating its properties in-place propagates to all future skill invocations —
  // skills always see the current name/title/signature without any restart.
  bus.subscribe('config.change', 'system', (event) => {
    const configEvent = event as ConfigChangeEvent;
    if (configEvent.payload.config_type === 'office_identity') {
      const updated = officeIdentityService.get();
      agentPersona.displayName = updated.assistant.name;
      agentPersona.title = updated.assistant.title;
      agentPersona.emailSignature = updated.assistant.emailSignature || undefined;
      logger.info({ displayName: agentPersona.displayName }, 'Agent persona updated from identity hot-reload');
    }
  });

  let outboundFilter: OutboundContentFilter | undefined;
  if (coordinatorConfig) {
    const systemPromptMarkers = extractIdentityMarkers(officeIdentity);
    // CEO_PRIMARY_EMAIL is Joseph's email — used to allow his address in outbound
    // content without triggering the contact-data-leak rule. Must NOT be Curia's
    // own Nylas address (nylasSelfEmail): using Curia's address here was a bug
    // that (a) treated Joseph's email as a third-party leak and (b) routed
    // blocked-content notifications to Curia's inbox instead of Joseph's.
    const ceoEmail = config.ceoPrimaryEmail ?? '';
    if (!ceoEmail) {
      logger.warn('Outbound content filter initialized without CEO email (CEO_PRIMARY_EMAIL not set) — contact-data-leak rule may produce false positives');
    }
    if (systemPromptMarkers.length === 0) {
      logger.warn('No system prompt markers extracted — system-prompt-fragment rule will not detect prompt leakage. Check that office identity has a name and title configured.');
    }
    outboundFilter = new OutboundContentFilter({
      systemPromptMarkers,
      ceoEmail,
    });
    logger.info({ markerCount: systemPromptMarkers.length }, 'Outbound content filter initialized');
  }

  // Outbound gateway — single choke-point for all outbound external communication.
  // Runs blocked-contact checks and content filtering before any message leaves Curia.
  //
  // Initialization guard:
  //   Production assumption: Nylas + Signal are always configured together.
  //   The guard initializes the gateway when either client is available + outboundFilter
  //   is ready. This keeps the gateway functional for Signal-only setups (e.g., during
  //   initial deployment before Nylas credentials are added) and for testing scenarios.
  //
  //   TODO: If the system ever runs in a Signal-only mode in production (no Nylas), the
  //   blocked-content CEO notification path will silently degrade (no email to send it on).
  //   In that mode, log.error is the fallback — see OutboundGateway.send() comments.
  //   For now we assume Nylas + Signal together, so this path is only for dev flexibility.
  let outboundGateway: OutboundGateway | undefined;
  const hasAnyOutboundClient = !!(nylasClient || signalRpcClient);
  if (hasAnyOutboundClient && outboundFilter) {
    outboundGateway = new OutboundGateway({
      nylasClient,
      signalClient: signalRpcClient,
      signalPhoneNumber: config.signalPhoneNumber,
      contactService,
      contentFilter: outboundFilter,
      bus,
      // ceoEmail is optional in OutboundGatewayConfig; only needed for email notifications.
      // When Nylas is configured, this must be set or CEO blocked-content alerts won't send.
      // Must be the CEO's primary email (Joseph's), NOT Curia's own Nylas address —
      // notifications addressed to Curia's inbox were never visible to Joseph.
      ceoEmail: config.ceoPrimaryEmail || undefined,
      logger,
    });
    logger.info({
      hasEmail: !!nylasClient,
      hasSignal: !!signalRpcClient,
    }, 'Outbound gateway initialized');
  } else if (nylasClient && !outboundFilter) {
    // nylasClient is available but outboundFilter is missing (no coordinator config found).
    // Email skills will be unavailable because they check ctx.outboundGateway before sending.
    logger.warn('Outbound gateway NOT initialized — outboundFilter not ready (coordinator config missing?). Outbound send skills will be unavailable.');
  }

  // Construct the email adapter (but don't start it yet — it must not poll until
  // the dispatcher is registered, otherwise inbound.message events have no subscriber
  // and are permanently dropped because the adapter advances its high-water mark).
  if (outboundGateway && nylasClient && config.nylasSelfEmail) {
    emailAdapter = new EmailAdapter({
      bus,
      logger,
      outboundGateway,
      contactService,
      pollingIntervalMs: config.nylasPollingIntervalMs,
      selfEmail: config.nylasSelfEmail,
    });
  }

  // Construct the Signal adapter (but don't start it yet — same ordering rule as email:
  // dispatcher must be registered first so inbound.message always has a subscriber).
  if (outboundGateway && signalRpcClient && config.signalPhoneNumber) {
    signalAdapter = new SignalAdapter({
      bus,
      logger,
      rpcClient: signalRpcClient,
      outboundGateway,
      contactService,
      phoneNumber: config.signalPhoneNumber,
      ceoEmail: config.ceoPrimaryEmail,
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
  const executionLayer = new ExecutionLayer(skillRegistry, logger, { bus, agentRegistry, contactService, outboundGateway, heldMessages, schedulerService, entityMemory, agentPersona, nylasCalendarClient, entityContextAssembler, agentContactId: agentIdentityContactId, autonomyService, browserService, bullpenService, timezone: config.timezone, skillOutputMaxLength: yamlConfig.skillOutput?.maxLength });

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
    for (const skillName of agentPinnedSkills) {
      if (!skillRegistry.get(skillName)) {
        logger.warn(
          { agent: agentConfig.name, skill: skillName },
          'Pinned skill not found in registry; skipping tool definition',
        );
      }
    }
    const agentToolDefs = skillRegistry.toToolDefinitions(agentPinnedSkills);

    // For the coordinator, interpolate runtime context (specialist list, agent contact ID).
    // Date and timezone are no longer baked in here — they are appended fresh on every
    // task turn via AgentRuntime using formatTimeContextBlock() so they never go stale.
    // This runs in pass 2 so all specialists are already in the registry.
    let systemPrompt = agentConfig.system_prompt;
    if (agentConfig.role === 'coordinator') {
      // Do NOT pass officeIdentityBlock here — leave ${office_identity_block}
      // as a literal placeholder. It is replaced per-turn in AgentRuntime.processTask()
      // by the officeIdentityService passed below, enabling hot-reload without a restart.
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
      // Use role (same predicate as interpolateRuntimeContext above) so both
      // branches stay in sync if the coordinator YAML is ever reconfigured.
      autonomyService: agentConfig.role === 'coordinator' ? autonomyService : undefined,
      // The coordinator gets per-turn time block injection so the date/timezone are
      // always current. Specialist agents don't need this — they work with
      // structured data, not user-facing time references.
      timezone: agentConfig.role === 'coordinator' ? config.timezone : undefined,
      // The coordinator gets per-turn identity block injection via officeIdentityService.
      // This replaces the ${office_identity_block} placeholder in the system prompt on
      // every task, so identity hot-reloads (file watcher or API PUT) take effect on the
      // next turn without a restart.
      officeIdentityService: agentConfig.role === 'coordinator' ? officeIdentityService : undefined,
      // Map YAML snake_case fields to AgentConfig camelCase, falling back to
      // DEFAULT_ERROR_BUDGET values for any omitted fields.
      errorBudget: agentConfig.error_budget ? {
        maxTurns: agentConfig.error_budget.max_turns ?? DEFAULT_ERROR_BUDGET.maxTurns,
        maxConsecutiveErrors: agentConfig.error_budget.max_errors ?? DEFAULT_ERROR_BUDGET.maxConsecutiveErrors,
      } : undefined,
      bullpenService,
      bullpenWindowMinutes: 60,
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
  // Recover any jobs left stuck in 'running' from a prior crash before the
  // poll loop starts. This handles the "crash between claim and dispatch" failure mode.
  // Non-fatal: a transient DB error here should not crash startup since the watchdog
  // will retry the same recovery in 5 minutes.
  try {
    await scheduler.recoverStuckJobs();
  } catch (err) {
    // Non-fatal: watchdog will retry in 5 minutes.
    logger.error({ err }, 'Startup stuck-job recovery failed — watchdog will retry in 5 minutes');
  }
  scheduler.start();
  logger.info('Scheduler started');

  // Layer 1 inbound injection scanner — loads extra patterns from config/default.yaml
  // and constructs the scanner. Non-fatal on loader error: a broken custom pattern
  // entry should warn loudly but not prevent startup (built-in defaults still protect).
  // configDir is already defined above (used for auth config and yaml config loading).
  // Narrow the try block to loadExtraInjectionPatterns() only — the constructor and
  // logger.info are not config-loading concerns and should not be silenced by this catch.
  let extraInjectionPatterns: ExtraInjectionPattern[] = [];
  try {
    extraInjectionPatterns = loadExtraInjectionPatterns(configDir);
  } catch (err) {
    // Warn and fall back to zero extra patterns — built-in defaults still protect.
    // A misconfigured extra pattern entry should not block startup entirely.
    logger.warn({ err }, 'Failed to load extra injection patterns from config — using built-in defaults only');
  }
  const injectionScanner = new InboundScanner({ extraPatterns: extraInjectionPatterns });
  logger.info(
    { builtInPatterns: InboundScanner.DEFAULT_PATTERN_COUNT, extraPatterns: extraInjectionPatterns.length },
    'Inbound injection scanner initialized',
  );

  // Parse trust scorer weights from config (security.trust_score section in default.yaml).
  // Falls back to DEFAULT_TRUST_WEIGHTS (0.4/0.4/0.2) if the section is absent.
  const trustScoreConfig = yamlConfig.security?.trust_score;
  const trustScorerWeights: TrustScorerWeights | undefined = trustScoreConfig ? {
    channelWeight: trustScoreConfig.channel_weight ?? 0.4,
    contactWeight: trustScoreConfig.contact_weight ?? 0.4,
    maxRiskPenalty: trustScoreConfig.max_risk_penalty ?? 0.2,
  } : undefined;

  const trustScoreFloor = yamlConfig.security?.trust_score_floor ?? 0.2;

  // 7. Dispatcher — subscribes to inbound.message + agent.response.
  // Registered after the coordinator so agent.task already has a handler
  // when the dispatcher fans the first inbound message out.
  // Content filter, externalChannels, and ceoNotification are now handled by OutboundGateway.
  // The Dispatcher only routes — it no longer contains any filter or scan logic directly.
  const dispatcher = new Dispatcher({
    bus,
    logger,
    contactResolver,
    heldMessages,
    channelPolicies: authConfig?.channelPolicies,
    injectionScanner,
    pool,
    conversationCheckpointDebounceMs: yamlConfig.dispatch?.conversationCheckpointDebounceMs,
    trustScorerWeights,
    trustScoreFloor,
  });
  dispatcher.register();

  // Conversation checkpoint processor — System Layer subscriber that runs background
  // memory skills (extract-relationships, etc.) at end of each conversation.
  const checkpointProcessor = new ConversationCheckpointProcessor(bus, executionLayer, pool, logger);
  checkpointProcessor.register();

  // BullpenDispatcher — routes agent.discuss → agent.task for inter-agent Bullpen discussions.
  const bullpenDispatcher = new BullpenDispatcher(bus, logger, bullpenService);
  bullpenDispatcher.register();

  // Start the email adapter AFTER the dispatcher is registered so inbound.message
  // events always have a subscriber. Starting before registration would drop emails
  // arriving during the startup window (the adapter advances its high-water mark
  // on poll, so dropped messages are never retried).
  if (emailAdapter) {
    await emailAdapter.start();
    logger.info('Email channel adapter started');
  }

  // Start the Signal adapter AFTER the dispatcher is registered — same ordering rule as email.
  // SignalAdapter.start() connects to the signal-cli socket and registers the inbound listener.
  // If signal-cli is not yet running (e.g., cold start with both containers starting simultaneously),
  // the RPC client's exponential backoff will retry until the socket is available.
  if (signalAdapter) {
    await signalAdapter.start();
    logger.info('Signal channel adapter started');
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
    identityService: officeIdentityService,
    contactService,
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
    if (signalAdapter) {
      try {
        await signalAdapter.stop();
      } catch (err) {
        logger.error({ err }, 'Error stopping Signal adapter during shutdown');
      }
    }
    try {
      await officeIdentityService.stop();
    } catch (err) {
      logger.error({ err }, 'Error stopping office identity file watcher during shutdown');
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
    if (browserService) {
      try {
        await browserService.stop();
      } catch (err) {
        logger.error({ err }, 'Error stopping browser service during shutdown');
      }
    }
    // Clear pending checkpoint timers before closing the pool — prevents in-flight
    // fireCheckpoint calls from querying a closed pool during shutdown.
    try {
      dispatcher.close();
    } catch (err) {
      logger.error({ err }, 'Error clearing checkpoint timers during shutdown');
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
 * Extract distinctive marker phrases from the office identity that would
 * indicate system prompt leakage if they appeared in an outbound email.
 * These are identity-specific strings that wouldn't occur in normal business writing.
 *
 * @TODO: The current markers only cover name and title. The full system prompt contains
 * many more distinctive instruction phrases, but extracting arbitrary sentences risks
 * false positives. This gap is intentionally left for the Stage 2 LLM-as-judge to cover.
 */
function extractIdentityMarkers(
  identity: import('./identity/types.js').OfficeIdentity,
): string[] {
  const markers: string[] = [];

  // Full instruction phrases — distinctive enough to not appear in business email.
  // We use the full instruction form ("You are X") rather than just the name
  // to avoid false positives on email signatures.
  if (identity.assistant.name) {
    markers.push(`You are ${identity.assistant.name}`);
  }
  if (identity.assistant.name && identity.assistant.title) {
    markers.push(`${identity.assistant.name}, ${identity.assistant.title}`);
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
