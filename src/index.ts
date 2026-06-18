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
import { ceoPrimaryEmailIsPlaceholder, loadConfig, loadYamlConfig, resolveChannelAccounts, resolveTasksConfig } from './config.js';
import { createLogger } from './logger.js';
import { HttpAdapter } from './channels/http/http-adapter.js';
import { createPool } from './db/connection.js';
import { EventBus } from './bus/bus.js';
import { AuditLogger } from './audit/logger.js';
import { AnthropicProvider } from './agents/llm/anthropic.js';
import { OpenRouterProvider } from './agents/llm/openrouter.js';
import { AgentRuntime } from './agents/runtime.js';
import { Dispatcher } from './dispatch/dispatcher.js';
import { CliAdapter } from './channels/cli/cli-adapter.js';
import { discoverAgentManifests, interpolateRuntimeContext } from './agents/loader.js';
import type { AgentYamlConfig, AgentDiscovery } from './agents/loader.js';
import { ModelRouter } from './agents/llm/model-router.js';
import { ModelRegistry } from './agents/llm/model-registry.js';
import { createEstimateCostUsd } from './agents/llm/pricing.js';
import type { LLMProvider } from './agents/llm/provider.js';
import { LLMProviderRouter } from './agents/llm/provider-router.js';
import { TelemetryLlmProvider } from './agents/llm/telemetry-provider.js';
import { InfraLlmService } from './skills/infra-llm.js';
import { AgentRegistry } from './agents/agent-registry.js';
import { WorkingMemory } from './memory/working-memory.js';
import { EmbeddingService } from './memory/embedding.js';
import { KnowledgeGraphStore } from './memory/knowledge-graph.js';
import { MemoryValidator } from './memory/validation.js';
import { EntityMemory } from './memory/entity-memory.js';
import { ConfigStore } from './memory/config-store.js';
import { SkillRegistry } from './skills/registry.js';
import { ExecutionLayer } from './skills/execution.js';
import { loadSkillsFromDirectory, discoverSkillManifests, validateAllowedCallers } from './skills/loader.js';
import type { SkillDiscovery } from './skills/loader.js';
import { loadMcpServers } from './skills/mcp-loader.js';
import type { McpSession } from './skills/mcp-client.js';
import { ContactService } from './contacts/contact-service.js';
import type { ChannelIdentity, Contact } from './contacts/types.js';
import { ConfidencePipeline } from './contacts/confidence-pipeline.js';
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
import { DEFAULT_ERROR_BUDGET } from './errors/types.js';
import { OutboundContentFilter } from './dispatch/outbound-filter.js';
import { OutboundLlmJudge } from './dispatch/outbound-judge.js';
import type { JudgeConfig } from './dispatch/outbound-judge.js';
import { OutboundGateway } from './skills/outbound-gateway.js';
import { InboundScanner } from './dispatch/inbound-scanner.js';
import { RateLimiter } from './dispatch/rate-limiter.js';
import { loadExtraInjectionPatterns, type ExtraInjectionPattern } from './dispatch/security-config-loader.js';
import { parseExtraPiiPatterns, getMissingBuiltInPatterns, getBuiltInPatternCount } from './pii/scrubber.js';
import type { PiiPattern } from './pii/scrubber.js';
import { PiiRedactor } from './dispatch/pii-redactor.js';
import { setErrorPiiPatterns } from './errors/classify.js';
import type { TrustScorerWeights } from './dispatch/trust-scorer.js';
import { SchedulerService } from './scheduler/scheduler-service.js';
import { Scheduler } from './scheduler/scheduler.js';
import { DriftDetector } from './scheduler/drift-detector.js';
import { SuspensionNotifier } from './scheduler/suspension-notifier.js';
import { RecoveryNotifier } from './scheduler/recovery-notifier.js';
import type { DriftConfig } from './scheduler/drift-detector.js';
import { EntityContextAssembler } from './entity-context/assembler.js';
import { bootstrapAgentIdentity } from './entity-context/bootstrap.js';
import { bootstrapCeoContact } from './contacts/ceo-bootstrap.js';
import { AutonomyService } from './autonomy/autonomy-service.js';
import { ActionLogRepo } from './autonomy/action-log-repo.js';
import { TaskRepo } from './db/task-repo.js';
import { ApprovalTriggerService } from './autonomy/approval-trigger.js';
import { AutonomyScoringPass } from './autonomy/scoring-pass.js';
import type { ScoringPassConfig } from './autonomy/scoring-pass.js';
import { BrowserService } from './browser/browser-service.js';
import { OfficeIdentityService } from './identity/service.js';
import { ExecutiveProfileService } from './executive/service.js';
import { loadEncryptionKey } from './secrets/crypto.js';
import { SecretsService } from './secrets/secrets-service.js';
import { SecretCaptureService } from './secrets/secret-capture-service.js';
import { SecretCaptureResumeSubscriber } from './secrets/secret-capture-resume-subscriber.js';
import { channelCredentialKeys } from './channels/http/routes/vault.js';
import { applyVaultSecrets } from './secrets/apply-vault-secrets.js';
import { SensitivityClassifier } from './memory/sensitivity.js';
import { DreamEngine } from './memory/dream-engine.js';
import type { DecayConfig } from './memory/dream-engine.js';
import type { AgentPersona } from './skills/types.js';
import type { ConfigChangeEvent } from './bus/events.js';
import { BullpenService } from './memory/bullpen.js';
import { BullpenDispatcher } from './dispatch/bullpen-dispatcher.js';
import { TempFileStore } from './skills/temp-file-store.js';
import { ConversationCheckpointProcessor } from './checkpoint/processor.js';
import { runStartupValidation } from './startup/validator.js';
import { runReadinessChecks } from './startup/readiness.js';
import { compileSecurityContextBlock } from './security/security-context.js';
import { OutboundContextService } from './dispatch/outbound-context.js';
import { applyTaskManagement } from './agents/task-management.js';
import { BacklogHeartbeat } from './scheduler/backlog-heartbeat.js';
import * as fs from 'node:fs';
import yaml from 'js-yaml';
import { RegistryRepo } from './registry/registry-repo.js';
import { RegistryService } from './registry/registry-service.js';
import { reconcileRegistries, type RegistryDefaults } from './registry/reconcile.js';
import type { Discovery, RegistryRow } from './registry/types.js';
import { CHANNEL_CATALOG, type ChannelDescriptor } from './channels/catalog.js';
import { channelCredentialStatus } from './channels/credential-resolver.js';
import { ChannelRegistryRepo } from './registry/channel-registry-repo.js';
import { ChannelRegistryService } from './registry/channel-registry-service.js';
import { reconcileChannelRegistry } from './registry/channel-reconcile.js';

async function main(): Promise<void> {
  // Captured at the very start of main() so the wizard's post-setup polling
  // loop can distinguish "old process still dying" from "new process up" by
  // comparing this value across requests. Exposed on GET /api/setup/status.
  // Plain ISO string — no need for a monotonic clock here, restarts always
  // produce a strictly-later wall-clock time.
  const bootStartedAt = new Date().toISOString();

  // 1. Config & logging — no dependencies, must come first.
  // loadConfig() throws synchronously if DATABASE_URL is missing, which is
  // intentional: we want a hard failure before any I/O is attempted.
  const config = loadConfig();
  const configDir = path.resolve(import.meta.dirname, '../config');
  const yamlConfig = loadYamlConfig(configDir);
  const logger = createLogger(config.logLevel);
  logger.info('Curia starting...');

  // Defense in depth for #983: keep a single stray unhandled rejection from
  // taking the whole multi-agent process down. Node's default policy on an
  // unhandledRejection is to terminate, so a rejected promise that loses its
  // awaiter (e.g. a route waiter whose client disconnected) would crash every
  // channel and agent at once. The primary fix is to never leak such rejections
  // in the first place (EventRouter.waitForResponse resolves rather than
  // rejects); this handler is the backstop. We log loudly at fatal and stay up
  // rather than exit — the structured log surfaces the offending promise so a
  // genuine bug is still loud in dev and CI.
  process.on('unhandledRejection', (reason, promise) => {
    // Normalize non-Error rejection values so the log always carries a stack. Capture
    // the originating promise too — when `reason` isn't an Error it's often the only
    // pointer back to the offending call site.
    const err = reason instanceof Error ? reason : new Error(String(reason));
    logger.fatal(
      { err, promise: String(promise), source: 'unhandledRejection' },
      'Unhandled promise rejection — process kept alive (see #983)',
    );
  });

  // Surface the `.env.example` placeholder case so it's obvious in logs why
  // CEO_PRIMARY_EMAIL appears to be ignored. loadConfig() normalized the value
  // to undefined silently because the logger doesn't exist yet at that point;
  // warn here once the logger is available.
  if (ceoPrimaryEmailIsPlaceholder()) {
    logger.warn(
      'CEO_PRIMARY_EMAIL is the literal .env.example placeholder ("you@yourdomain.com") — treating as unset. ' +
        'Comment the line out or set a real address; fresh installs should rely on the /setup wizard to create the principal.',
    );
  }

  // Compile the security context block from config at startup.
  // runStartupValidation (below) enforces the JSON schema, which requires trust_thresholds
  // whenever the `security:` block is present. But `security:` itself is optional at the
  // root (extra_injection_patterns et al. are also optional), and this block runs *before*
  // schema validation, so guard explicitly here rather than relying on a non-null assertion
  // that would crash unhelpfully.
  const rawThresholds = yamlConfig.security?.trust_thresholds;
  // Explicit undefined check first so TypeScript narrows rawThresholds below.
  if (rawThresholds === undefined) {
    logger.fatal(
      'Missing required config: security.trust_thresholds is absent from config/default.yaml — startup aborted',
    );
    process.exit(1);
  }
  const missingFields = (['information_query', 'scheduling', 'data_export', 'financial'] as const)
    .filter(f => rawThresholds[f] === undefined);
  if (missingFields.length > 0) {
    logger.fatal(
      { missingFields },
      'Missing required config fields in security.trust_thresholds in config/default.yaml — startup aborted',
    );
    process.exit(1);
  }
  // Validate ranges — schema validation (below) also checks this, but runs
  // after this block. Catching out-of-range values here gives a clearer error.
  const outOfRangeFields = (['information_query', 'scheduling', 'data_export', 'financial'] as const)
    .filter(f => {
      const v = rawThresholds[f];
      return v < 0 || v > 1;
    });
  if (outOfRangeFields.length > 0) {
    logger.fatal(
      { outOfRangeFields },
      'Invalid security.trust_thresholds values — all must be numbers in [0.0, 1.0]',
    );
    process.exit(1);
  }
  const securityContextBlock = compileSecurityContextBlock({
    information_query: rawThresholds.information_query,
    scheduling:        rawThresholds.scheduling,
    data_export:       rawThresholds.data_export,
    financial:         rawThresholds.financial,
  });

  // 1b. Startup validation — fail fast before any I/O if configs are malformed.
  // Only validates config/default.yaml and config/skills.yaml here. Agent and skill
  // manifests are validated by the registry-aware discovery pass further below — that
  // pass is lenient (it captures per-item errors) and fail-closes only for ENABLED
  // manifests, so a broken disabled/uninstalled manifest no longer aborts startup.
  try {
    await runStartupValidation({
      configDir,
      // agentsDir / skillsDir intentionally omitted — manifest schema validation now
      // happens inside discoverAgentManifests / discoverSkillManifests so that broken
      // uninstalled manifests don't block startup.
      // `schemasDir` is computed here (the entrypoint) — not inside the validator —
      // because tsup bundles every source file into a single `dist/index.js`,
      // collapsing `import.meta.dirname` to `dist/` regardless of which source file
      // referenced it. Computing the offset here means `../schemas` resolves to the
      // repo root under tsx (src/) and to `/app/schemas` under the bundled image
      // (dist/), both correct. See docs/specs/06-audit-and-security.md (Input Validation)
      // and the Dockerfile's `COPY schemas/ ./schemas/` line.
      schemasDir: path.resolve(import.meta.dirname, '../schemas'),
      logger,
    });
  } catch (err) {
    logger.fatal({ err }, 'Startup validation failed — fix the config errors above and restart');
    process.exit(1);
  }

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

  // Secrets vault — load the master key (fail closed) and construct the service (#542).
  // A missing/malformed SECRET_ENCRYPTION_KEY is a hard startup failure: the vault is a
  // core security primitive, so we never boot in a half-initialized, can't-decrypt state.
  let secretEncryptionKey: Buffer;
  try {
    secretEncryptionKey = loadEncryptionKey();
  } catch (err) {
    logger.fatal({ err }, 'SECRET_ENCRYPTION_KEY is missing or invalid');
    process.exit(1);
    throw new Error('unreachable'); // guards against process.exit mocks in test environments
  }
  const secretsService = new SecretsService(pool, secretEncryptionKey, logger);

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

  // Resolve bootstrap/config secrets from the vault now that migrations have run
  // (the `secrets` table exists) and before any consumer reads config (#911).
  // Vault-only: a missing required secret leaves config undefined, failing closed at
  // its consumer exactly as an unset env var did — there is no env fallback.
  // A vault read error (DB/decrypt failure) is a hard startup failure, surfaced
  // with a structured fatal line to match the migration/encryption-key blocks above.
  try {
    await applyVaultSecrets(config, secretsService, logger);
  } catch (err) {
    logger.fatal({ err }, 'Failed to resolve bootstrap secrets from vault');
    process.exit(1);
  }

  // api_token is a REQUIRED secret with a fail-OPEN consumer: validateBearerToken()
  // (src/channels/http/auth.ts) disables HTTP auth entirely when no token is configured
  // — a local-dev convenience. Under vault-only resolution an absent vault row would
  // silently expose every authenticated endpoint, so guard it explicitly here: fail
  // closed (refuse to boot), not open (#911). Mirror the anthropic_api_key guard below.
  if (!config.apiToken) {
    logger.fatal('api_token is missing from the vault — refusing to boot with HTTP auth disabled. Seed it with: API_TOKEN=<value> pnpm run seed-vault');
    process.exit(1);
  }

  // 3. Audit logger — must be ready before the bus starts accepting events.
  // The bus's write-ahead hook calls auditLogger.log() synchronously before
  // delivering to any subscriber, so this must exist when the bus is constructed.
  const auditLogger = new AuditLogger(pool, logger);

  // 3b. Startup scan — flag any events that were written but never acknowledged.
  // These indicate the process crashed between write-ahead and delivery on a
  // previous run. Logged at warn level for operator visibility; replay is a
  // separate future feature.
  await auditLogger.scanForUnacknowledged();

  // 4. Message bus — the write-ahead hook ensures every event is durably
  // recorded before it reaches any subscriber. Losing a message is worse
  // than slowing down delivery, hence the synchronous-before-fanout design.
  // The onDelivered hook flips acknowledged = true after all handlers have
  // been attempted, completing the delivery lifecycle record.
  const bus = new EventBus(
    logger,
    (event) => auditLogger.log(event),
    (eventId) => auditLogger.markAcknowledged(eventId),
  );

  // 4b. Office identity — System-layer service that owns the instance persona.
  // Must be initialized after migrations (schema) and bus (emits config.change events),
  // and before agents boot (the coordinator's identity block is prepended as a preamble
  // by AgentRuntime, compiled from this service).
  // Fatal on failure: without an identity, the coordinator system prompt is incomplete.
  // First boot seeds DEFAULT_OFFICE_IDENTITY from src/identity/defaults.ts; subsequent
  // boots load whichever version the wizard or API last wrote.
  const officeIdentityService = new OfficeIdentityService(pool, logger, bus);
  try {
    await officeIdentityService.initialize();
    logger.info({ name: officeIdentityService.get().assistant.name }, 'Office identity initialized');
  } catch (err) {
    logger.fatal({ err }, 'Failed to initialize office identity service');
    process.exit(1);
  }

  // 4c. Executive profile — System-layer service that owns the executive (CEO)
  // writing voice and style preferences. Separate from office identity (which is
  // the assistant's persona). The executive's identity (name, title) lives in the
  // contact system — this is purely about how the system represents them.
  // Non-fatal on failure: the profile is consumed at runtime by the
  // executive-profile-get / executive-profile-update skills (e.g. the ceo-inbox
  // specialist fetches the writing voice when drafting), not injected into any
  // system prompt. If initialization fails, those skills fall back to generic
  // voice rather than taking down startup.
  const executiveConfigPath = path.resolve(import.meta.dirname, '../config/executive-profile.yaml');
  let executiveProfileService: ExecutiveProfileService | undefined;
  try {
    executiveProfileService = new ExecutiveProfileService(pool, logger, bus, executiveConfigPath);
    await executiveProfileService.initialize();
    logger.info('Executive profile initialized');
  } catch (err) {
    logger.error({ err }, 'Failed to initialize executive profile service — CEO voice guidance unavailable; drafts will use generic voice');
    executiveProfileService = undefined;
  }

  // Capability-tier model routing (ADR-014).
  // The ModelRouter resolves tier declarations from agent YAML to concrete
  // provider + model pairs. The provider registry maps provider names to
  // LLMProvider instances. Today only 'anthropic' exists; when OpenRouter
  // lands (#379), a second entry is added here.
  const modelRoutingConfig = yamlConfig.model_routing;
  if (!modelRoutingConfig) {
    logger.fatal('model_routing config section is required in config/default.yaml');
    process.exit(1);
  }
  const modelRegistry = new ModelRegistry(logger);

  // 5. LLM provider — hard fail early rather than discovering the missing
  // key only when the first user message arrives.
  // modelRegistry must be instantiated first (above) — the provider uses it
  // to look up maxOutputTokens per model rather than using a hardcoded constant.
  if (!config.anthropicApiKey) {
    logger.fatal('ANTHROPIC_API_KEY is required');
    process.exit(1);
  }
  const llmProvider = new AnthropicProvider(config.anthropicApiKey, logger, modelRegistry);
  // estimateCostUsd is a closure pre-wired with the model registry. Passed to
  // AgentRuntime as config (dependency injection) so the runtime stays testable
  // without importing pricing.ts directly.
  // Pass the configured standard tier model as the fallback so cost estimates
  // for unrecognised models track operator routing rather than hardcoding Sonnet.
  const estimateCostUsd = createEstimateCostUsd(modelRegistry, modelRoutingConfig.tiers.standard.model);
  const modelRouter = new ModelRouter(modelRoutingConfig, modelRegistry, logger);
  const providerRegistry = new Map<string, LLMProvider>([
    ['anthropic', llmProvider],
  ]);

  // OpenRouter — optional second provider for non-Claude models.
  // Only instantiated when OPENROUTER_API_KEY is present. If absent, OpenRouter
  // models stay in the registry but aren't routable — the validation below
  // only checks models that are actually mapped to a tier.
  if (config.openrouterApiKey) {
    const openrouterProvider = new OpenRouterProvider(config.openrouterApiKey, logger, modelRegistry);
    providerRegistry.set('openrouter', openrouterProvider);
    logger.info('OpenRouter provider registered — non-Claude models available');
  }

  // Validate that every model mapped to a tier has a registered provider.
  // Models in the registry that aren't mapped to any tier are fine to leave
  // without a provider — they represent available models, not required ones.
  for (const [tierName, tierConfig] of Object.entries(modelRoutingConfig.tiers)) {
    const tierModel = (tierConfig as { model: string }).model;
    const meta = modelRegistry.getModel(tierModel);
    if (meta && !providerRegistry.has(meta.provider)) {
      logger.fatal(
        { tier: tierName, model: tierModel, provider: meta.provider },
        'Tier-mapped model references a provider that is not registered — cannot start. '
        + 'Set the provider API key or remap the tier to a model with a registered provider.',
      );
      process.exit(1);
    }
  }

  // Resolve a concrete LLMProvider for a known model string by consulting the model
  // and provider registries. Used by shared infrastructure consumers (WorkingMemory,
  // DriftDetector, AutonomyScoringPass) whose model is fixed at startup. Fails fast
  // if the model isn't registered or its provider isn't in the registry — the
  // startup validation above (lines ~312-323) already guarantees tier-mapped models
  // are valid, so this should only fail on programming errors or config drift.
  function resolveProviderForModel(model: string, context: string): LLMProvider {
    const providerName = modelRegistry.getProvider(model);
    if (!providerName) {
      logger.fatal(
        { model, context },
        'Cannot resolve provider: model not in model registry. '
        + 'Add an entry for this model to ModelRegistry, or remap the tier to a registered model in config/default.yaml.',
      );
      process.exit(1);
    }
    const provider = providerRegistry.get(providerName);
    if (!provider) {
      logger.fatal(
        { model, providerName, context },
        `Cannot resolve provider: '${providerName}' is not registered. `
        + 'Set the corresponding API key (e.g. OPENROUTER_API_KEY for openrouter) to enable this provider.',
      );
      process.exit(1);
    }
    return provider;
  }

  // Working memory — created after the pool is confirmed healthy so we know
  // the working_memory table is reachable before the first message arrives.
  // Summarization config is read from default.yaml (workingMemory.summarization).
  // If the config block is absent, summarization is disabled (no-op backend).
  const summarizationCfg = yamlConfig.workingMemory?.summarization;
  // Resolve which model tier to use for summarization. 'standard' is appropriate
  // for summarization — it's a medium-complexity task that doesn't need the full
  // flagship model but benefits from better instruction-following than a fast tier.
  const summarizationModel = modelRouter.resolve('standard').model;
  const workingMemoryTtlDays = yamlConfig.workingMemory?.ttlDays ?? 30;
  logger.info({ ttlDays: workingMemoryTtlDays, fromConfig: yamlConfig.workingMemory?.ttlDays !== undefined }, 'Working memory TTL configured');
  const memory = WorkingMemory.createWithPostgres(
    pool,
    logger,
    summarizationCfg
      ? {
          threshold: summarizationCfg.threshold ?? 20,
          keepWindow: summarizationCfg.keepWindow ?? 10,
          // Resolve the provider from the registry so that remapping 'standard' to
          // an OpenRouter model routes summarization through OpenRouterProvider, not
          // the hardwired Anthropic singleton. (#646)
          provider: resolveProviderForModel(summarizationModel, 'WorkingMemory summarization'),
          model: summarizationModel,
        }
      : undefined,
    workingMemoryTtlDays,
  );

  // Entity memory — optional, requires OPENAI_API_KEY for embeddings.
  // If not configured, agents still work — they just don't have KG access.
  let entityMemory: EntityMemory | undefined;
  if (config.openaiApiKey) {
    // Sensitivity classifier — loads rules from config/default.yaml at startup (#200).
    // Resolved from __dirname so the path is stable regardless of which directory the
    // process was launched from (systemd, Docker, worktree, test harness, etc.).
    // Fail fast with a structured log if the file is missing or malformed — the service
    // cannot safely protect sensitive data without classification rules.
    let sensitivityClassifier: SensitivityClassifier;
    const sensitivityConfigPath = path.resolve(import.meta.dirname, '../config/default.yaml');
    try {
      sensitivityClassifier = SensitivityClassifier.fromYaml(sensitivityConfigPath);
      logger.info({ configPath: sensitivityConfigPath }, 'Sensitivity classifier loaded');
    } catch (err) {
      logger.fatal(
        { err, configPath: sensitivityConfigPath },
        'Failed to load sensitivity classifier — check that config/default.yaml exists and contains a valid sensitivity_rules array',
      );
      process.exit(1);
    }

    const embeddingService = EmbeddingService.createWithOpenAI(
      config.openaiApiKey,
      logger,
      bus,           // EventBus — wired at line 234
      modelRegistry, // ModelRegistry — wired at line 281
    );
    const kgStore = KnowledgeGraphStore.createWithPostgres(pool, embeddingService, logger);
    const validator = new MemoryValidator(kgStore, embeddingService);
    entityMemory = new EntityMemory(kgStore, validator, embeddingService, logger, sensitivityClassifier);
    logger.info('Entity memory initialized with knowledge graph');
  } else {
    logger.warn('OPENAI_API_KEY not set — entity memory disabled (knowledge graph unavailable)');
  }

  // Bullpen service — Tier 2 inter-agent discussion. Always initialized (no
  // external API key required — just Postgres, which is already confirmed above).
  const bullpenService = BullpenService.createWithPostgres(pool, logger);
  logger.info('Bullpen service initialized');

  // Contact confidence scoring pipeline — needs late-binding because the
  // callback references the pipeline, which depends on contactService.
  let confidencePipeline: ConfidencePipeline | undefined;

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
    onIdentityVerified: (contactId: string) => {
      confidencePipeline?.incrementalUpdate(contactId, { type: 'pairing_confirmed' })
        .catch(err => logger.warn({ err, contactId }, 'pairing_confirmed pipeline update failed (non-fatal)'));
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

  // Now that contactService exists, wire up the confidence pipeline.
  confidencePipeline = contactService ? new ConfidencePipeline(contactService, logger) : undefined;

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
  // Also creates (or backfills) a KG person node so entity context enrichment works
  // for the CEO. See issue #380.
  //
  // Note: `config.ceoPrimaryEmail` is normalized in loadConfig() so the literal
  // `.env.example` placeholder `you@yourdomain.com` reads as undefined here — this
  // block is therefore a no-op for fresh installs that didn't customize that line.
  let ceoContactId: string | undefined;
  if (config.ceoPrimaryEmail) {
    try {
      const ceoBootstrap = await bootstrapCeoContact(config.ceoPrimaryEmail, 'CEO', pool, logger);
      // Persist the CEO's contact UUID so PiiRedactor can bypass redaction using a stable
      // UUID check rather than relying solely on trust_level. UUID is resolved once at startup
      // from ceoPrimaryEmail and is tamper-proof (unlike trust_level, which has a setter API).
      ceoContactId = ceoBootstrap.contactId;
      logger.info({ contactId: ceoBootstrap.contactId, kgNodeId: ceoBootstrap.kgNodeId }, 'CEO identity ready');
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
          'CEO contact bootstrap failed — inbound emails from CEO may route in low-trust mode',
        );
      }
    }
  } else {
    // No CEO_PRIMARY_EMAIL configured (or it was the .env.example placeholder, which
    // loadConfig() normalizes to undefined). This is the normal path for fresh
    // installs post-#771 — the in-app onboarding wizard creates the principal without
    // an email channel binding; per-channel verification flows attach identities later.
    // Only operators running the historical email-channel back-compat path need to
    // set CEO_PRIMARY_EMAIL.
    logger.info('CEO_PRIMARY_EMAIL not set — CEO contact bootstrap skipped (principal will be created via the onboarding wizard at /setup).');
  }

  // Email channel — optional. Supports N named accounts via channel_accounts.email in
  // config/default.yaml, or falls back to the legacy NYLAS_GRANT_ID + NYLAS_SELF_EMAIL
  // env vars for single-account backward compatibility.
  //
  // One NylasClient is constructed per account (needed by OutboundGateway's client map).
  // EmailAdapters are constructed further below, after OutboundGateway is ready,
  // and started after the dispatcher is registered to avoid dropping inbound messages.
  const resolvedEmailAccounts = resolveChannelAccounts(yamlConfig, config);
  const nylasClientMap = new Map<string, NylasClient>();

  if (!config.nylasApiKey) {
    if (resolvedEmailAccounts.length > 0) {
      logger.warn('NYLAS_API_KEY not set — email channel disabled despite accounts being configured');
    } else {
      logger.warn('NYLAS_API_KEY/NYLAS_GRANT_ID not set — email channel disabled');
    }
  } else if (resolvedEmailAccounts.length === 0) {
    logger.warn('No email accounts resolved — email channel disabled. Set NYLAS_GRANT_ID + NYLAS_SELF_EMAIL, or configure channel_accounts.email in config/default.yaml');
  } else {
    for (const account of resolvedEmailAccounts) {
      nylasClientMap.set(account.name, new NylasClient(config.nylasApiKey, account.nylasGrantId, logger));
    }
    logger.info(
      { accounts: [...nylasClientMap.keys()] },
      `Email channel: ${nylasClientMap.size} account(s) configured`,
    );
  }

  // Keep a reference to the first client for backward-compat code paths that
  // still use a single-client assumption (e.g. NylasCalendarClient setup below).
  const primaryNylasClient = nylasClientMap.values().next().value as NylasClient | undefined;

  // EmailAdapters are built later (post-gateway) and stored here.
  const emailAdapters: EmailAdapter[] = [];

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

  // Calendar client — uses the primary email account's Nylas credentials.
  // For multi-account deployments the calendar is always associated with the first
  // (primary) account; a future spec can extend this to per-account calendars.
  let nylasCalendarClient: NylasCalendarClient | undefined;
  if (config.nylasApiKey && primaryNylasClient && resolvedEmailAccounts.length > 0) {
    const primaryAccount = resolvedEmailAccounts[0]!;
    nylasCalendarClient = new NylasCalendarClient(config.nylasApiKey, primaryAccount.nylasGrantId, logger);
    logger.info('Nylas calendar client initialized');
  }

  // Browser service — warm Playwright Chromium instance for the web-browser skill.
  // Optional degradation: if Xvfb is unavailable on Linux, Curia boots normally
  // but web-browser skill invocations will fail at the ctx.browserService check.
  let browserService: BrowserService | undefined;
  try {
    const browserConfig = yamlConfig.browser;
    browserService = new BrowserService({
      logger,
      sessionTtlMs: browserConfig?.sessionTtlMs ?? 600_000,
      sweepIntervalMs: browserConfig?.sweepIntervalMs ?? 120_000,
      profileDir: browserConfig?.profileDir,
      channel: browserConfig?.channel,
      locale: browserConfig?.locale,
      // Align the browser timezone with the principal's configured timezone.
      timezone: config.timezone,
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
  const agentsDir = path.resolve(import.meta.dirname, '../agents');

  // --- Registry: discover everything on disk (lenient), reconcile the core set,
  // then load+register ONLY enabled skills/agents. (Spec: skill/agent registry, #541.)
  let skillDiscovery: SkillDiscovery[];
  let agentDiscovery: AgentDiscovery[];
  try {
    skillDiscovery = discoverSkillManifests(skillsDir);
    agentDiscovery = discoverAgentManifests(agentsDir);
  } catch (err) {
    logger.fatal({ err }, 'Failed to discover skills/agents on disk');
    process.exit(1);
  }

  const skillRegistryRepo = new RegistryRepo(pool, 'skill_registry');
  const agentRegistryRepo = new RegistryRepo(pool, 'agent_registry');

  // Load the trusted fresh-install core set. The file MUST exist and be valid —
  // a missing file would silently leave nothing enrolled on a fresh DB, so treat
  // absence as a fatal misconfiguration rather than defaulting to empty.
  let registryDefaults: RegistryDefaults;
  try {
    const defaultsPath = path.resolve(import.meta.dirname, '../config/registry-defaults.yaml');
    if (!fs.existsSync(defaultsPath)) {
      logger.fatal({ path: defaultsPath }, 'config/registry-defaults.yaml not found — cannot enroll core defaults');
      process.exit(1);
    }
    const loaded = yaml.load(fs.readFileSync(defaultsPath, 'utf-8'));
    if (!loaded) {
      logger.fatal({ path: defaultsPath }, 'config/registry-defaults.yaml is empty or null');
      process.exit(1);
    }
    const candidate = loaded as RegistryDefaults;
    if (!Array.isArray(candidate.skills) || !Array.isArray(candidate.agents)) {
      logger.fatal({ path: defaultsPath, loaded }, 'config/registry-defaults.yaml has wrong shape (expected {skills: [], agents: []})');
      process.exit(1);
    }
    registryDefaults = candidate;
  } catch (err) {
    logger.fatal({ err }, 'Failed to read config/registry-defaults.yaml');
    process.exit(1);
  }

  try {
    await reconcileRegistries({
      skillRepo: skillRegistryRepo,
      agentRepo: agentRegistryRepo,
      skillDiscoveryNames: new Set(skillDiscovery.map(d => d.name)),
      agentDiscoveryNames: new Set(agentDiscovery.map(d => d.name)),
      defaults: registryDefaults,
      logger,
    });
  } catch (err) {
    logger.fatal({ err }, 'Registry reconciliation failed');
    process.exit(1);
  }

  // Ghost warnings: a registry row whose files are gone never loads.
  // One listRows() call per table; used for both ghost scan and enabled-name set.
  let skillRows: RegistryRow[];
  try {
    skillRows = await skillRegistryRepo.listRows();
  } catch (err) {
    logger.fatal({ err }, 'Failed to read skill_registry rows after reconciliation');
    process.exit(1);
  }
  const skillDiscNames = new Set(skillDiscovery.map(d => d.name));
  for (const row of skillRows) {
    if (!skillDiscNames.has(row.name)) {
      logger.warn({ skill: row.name }, 'registry: enabled/installed skill has no files on disk (ghost); not loaded');
    }
  }
  const enabledSkillNames = new Set(skillRows.filter(r => r.enabled).map(r => r.name));
  try {
    const skillCount = await loadSkillsFromDirectory(skillDiscovery, skillRegistry, logger, enabledSkillNames);
    logger.info({ skillCount }, 'Skills loaded');
  } catch (err) {
    // Fail hard on skill loading errors — a broken skill.json or handler should
    // not silently degrade the system to no-tools mode. Consistent with how we
    // handle missing DATABASE_URL and ANTHROPIC_API_KEY.
    logger.fatal({ err }, 'Failed to load skills');
    process.exit(1);
  }

  // MCP server connections — connects to each server in config/skills.yaml,
  // discovers tools via tools/list, and registers them in the skill registry
  // alongside local skills. Agents don't know or care which kind they're using.
  //
  // Connection failures are warn-not-crash: a missing MCP server shouldn't
  // take down the system. The failed server's tools are simply not available
  // until the next restart.
  let mcpSessions: McpSession[] = [];
  try {
    mcpSessions = await loadMcpServers(configDir, skillRegistry, logger);
  } catch (err) {
    // Malformed skills.yaml or unexpected loader error — degrade gracefully rather
    // than crashing. The startup validator catches schema violations, but a YAML
    // parse error after the validator runs would otherwise crash here.
    // Per-server errors (connection failures, missing fixed_inputs env vars) are
    // handled inside loadMcpServers and skip the affected server only.
    logger.error({ err }, 'MCP bootstrap failed; continuing without MCP tools');
  }
  if (mcpSessions.length > 0) {
    logger.info({ mcpServers: mcpSessions.map(s => s.serverId) }, 'MCP servers connected');
  }

  // Agent registry — tracks all running agents for delegation and listing.
  const agentRegistry = new AgentRegistry();

  // Agents: ghost warnings, then keep only ENABLED, healthy agent configs.
  // agentsDir + agentDiscovery are already populated above (in the registry block).
  let agentRows: RegistryRow[];
  try {
    agentRows = await agentRegistryRepo.listRows();
  } catch (err) {
    logger.fatal({ err }, 'Failed to read agent_registry rows after reconciliation');
    process.exit(1);
  }
  const agentDiscNames = new Set(agentDiscovery.map(d => d.name));
  for (const row of agentRows) {
    if (!agentDiscNames.has(row.name)) {
      logger.warn({ agent: row.name }, 'registry: enabled/installed agent has no files on disk (ghost); not loaded');
    }
  }
  const enabledAgentNames = new Set(agentRows.filter(r => r.enabled).map(r => r.name));
  let agentConfigs: AgentYamlConfig[];
  try {
    agentConfigs = [];
    for (const disc of agentDiscovery) {
      if (!enabledAgentNames.has(disc.name)) continue;
      if (!disc.config) {
        throw new Error(`Enabled agent '${disc.name}' has an invalid config: ${disc.error ?? 'unknown error'}`);
      }
      agentConfigs.push(disc.config);
    }
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
    // CEO_PRIMARY_EMAIL is the CEO's email — used to allow their address in outbound
    // content without triggering the contact-data-leak rule. Must NOT be Curia's
    // own Nylas address (nylasSelfEmail): using Curia's address here was a bug
    // that (a) treated the CEO's email as a third-party leak and (b) routed
    // blocked-content notifications to Curia's inbox instead of the CEO's.
    const ceoEmail = config.ceoPrimaryEmail ?? '';
    if (!ceoEmail) {
      logger.warn('Outbound content filter initialized without CEO email (CEO_PRIMARY_EMAIL not set) — contact-data-leak rule may produce false positives');
    }
    if (systemPromptMarkers.length === 0) {
      logger.warn('No system prompt markers extracted — system-prompt-fragment rule will not detect prompt leakage. Check that office identity has a name and title configured.');
    }
    // Stage 2 LLM judge (issue #547). Constructed only when enabled. Routes through a
    // model→provider router so any registered model works. The judge model is validated
    // against the registry here so a typo fails fast at startup.
    let outboundJudge: OutboundLlmJudge | undefined;
    const judgeYaml = yamlConfig.filter?.llmJudge;
    const judgeEnabled = judgeYaml?.enabled ?? true;
    if (judgeEnabled) {
      const judgeConfig: JudgeConfig = {
        enabled: true,
        model: judgeYaml?.model ?? 'claude-haiku-4-5',
        timeoutMs: judgeYaml?.timeout_ms ?? 5000,
        failMode: judgeYaml?.failMode ?? 'split',
      };
      // Validate timeout_ms. local.yaml overrides are deep-merged but NOT schema-checked
      // at startup, so a 0/negative/non-integer value could slip through — with the default
      // 'split' failMode that would make every judge call time out instantly and silently
      // fail open, disabling Stage 2. Fail fast instead. The 250ms floor rejects values too
      // low for any real model round-trip (also a likely misconfiguration).
      if (!Number.isInteger(judgeConfig.timeoutMs) || judgeConfig.timeoutMs < 250) {
        logger.fatal(
          { timeoutMs: judgeConfig.timeoutMs },
          'filter.llmJudge.timeout_ms must be an integer >= 250 (ms) — fix config (default.yaml or local.yaml)',
        );
        process.exit(1);
      }
      if (!modelRegistry.isKnownModel(judgeConfig.model)) {
        logger.fatal(
          { model: judgeConfig.model },
          'filter.llmJudge.model is not in the model registry — fix config (default.yaml or local.yaml)',
        );
        process.exit(1);
      }
      const judgeProviderName = modelRegistry.getProvider(judgeConfig.model);
      if (!judgeProviderName || !providerRegistry.has(judgeProviderName)) {
        logger.fatal(
          { model: judgeConfig.model, provider: judgeProviderName },
          'filter.llmJudge.model maps to a provider that is not registered — set the corresponding API key or change the model',
        );
        process.exit(1);
      }
      // Dedicated stateless router instance for the judge (avoids depending on the
      // infra LLM router which is constructed later in bootstrap).
      const judgeRouter = new LLMProviderRouter(modelRegistry, providerRegistry);
      outboundJudge = new OutboundLlmJudge(judgeRouter, judgeConfig, bus, logger, modelRegistry);
      logger.info({ model: judgeConfig.model, failMode: judgeConfig.failMode }, 'Outbound Stage 2 LLM judge enabled');
    } else {
      logger.info('Outbound Stage 2 LLM judge disabled via config (filter.llmJudge.enabled=false)');
    }

    outboundFilter = new OutboundContentFilter({
      systemPromptMarkers,
      ceoEmail,
      judge: outboundJudge,
    });
    logger.info({ markerCount: systemPromptMarkers.length }, 'Outbound content filter initialized');
  }
  // TODO(#949, #950): Wire EscalationJudge here using escalation.judge config block.
  // The judge and its config schema are defined in src/autonomy/escalation-judge.ts.
  // Each gate constructs an EscalationJudge with a dedicated LLMProviderRouter
  // (same pattern as the outbound judge above) and validates the model at startup.

  // PII scrubbing for LLM-facing error strings — loads extra patterns from
  // config/default.yaml pii.extra_patterns and injects them into classify.ts.
  // An invalid extra pattern is treated as fatal: the operator's intent was to
  // protect a specific PII type and silently ignoring their config would mean
  // that data flows unredacted to the LLM without any warning.
  //
  // extraPatterns is also passed to PiiRedactor below for outbound redaction
  // (outbound redaction reuses the same custom patterns as the inbound scrubber).
  const piiPatternEntries = yamlConfig.pii?.extra_patterns ?? [];
  let extraPatterns: PiiPattern[] = [];
  if (piiPatternEntries.length > 0) {
    // Errors here are intentionally not caught — parseExtraPiiPatterns throws on
    // invalid regex or missing fields, which is treated as a startup-blocking misconfiguration.
    extraPatterns = parseExtraPiiPatterns(
      piiPatternEntries,
      path.join(configDir, 'default.yaml'),
    );
    setErrorPiiPatterns(extraPatterns);
  }
  const extraPiiPatternCount = extraPatterns.length;

  // Outbound PII redactor — sits between the agent response and the channel
  // adapter. Strips PII from outbound messages based on channel policy and
  // recipient trust level before content validation or delivery.
  // Config defaults: enabled=true, trust_override=['ceo'], default='block'.
  //
  // Must be constructed BEFORE OutboundGateway, which receives it as a constructor arg.
  const outboundRedactionConfig = {
    enabled: yamlConfig.pii?.outbound_redaction?.enabled ?? true,
    trust_override: yamlConfig.pii?.outbound_redaction?.trust_override ?? ['ceo'],
    default: (yamlConfig.pii?.outbound_redaction?.default ?? 'block') as 'block' | 'allow',
    // Normalize channel_policies: the YAML type allows `allow` to be optional on
    // each entry, but OutboundRedactionConfig requires it. Default to [] per entry.
    channel_policies: Object.fromEntries(
      Object.entries(yamlConfig.pii?.outbound_redaction?.channel_policies ?? {}).map(
        ([ch, policy]) => [ch, { allow: policy.allow ?? [] }],
      ),
    ),
  };
  let piiRedactor: PiiRedactor;
  try {
    piiRedactor = new PiiRedactor({
      config: outboundRedactionConfig,
      bus,
      logger,
      extraPatterns, // same patterns used by the inbound scrubber
      ceoContactId,  // resolved from ceoPrimaryEmail at bootstrap; undefined if bootstrap failed or email not set
    });
  } catch (err) {
    logger.fatal({ err }, 'Failed to initialize PiiRedactor — check pii.outbound_redaction config');
    process.exit(1);
  }
  logger.info(
    { enabled: outboundRedactionConfig.enabled, trustOverride: outboundRedactionConfig.trust_override },
    'Outbound PII redactor initialized',
  );

  // ActionLogRepo — used by OutboundGateway (autonomy gate logging, draft-linkage) and
  // later by ApprovalTriggerService and AutonomyScoringPass. Instantiated here so it
  // can be passed to the gateway at construction time.
  const actionLogRepo = new ActionLogRepo(pool, logger);

  // TaskRepo — used by task-create, task-list, task-update, task-complete skills.
  const taskRepo = new TaskRepo(pool, bus, logger, config.timezone);

  // Load principal's channel identities for the outbound gateway recipient check.
  // Cached for the lifetime of the process — restart picks up changes.
  // Load principal contact reference and cache it for the readiness check below (avoid a redundant DB query).
  let principalIdentities: ChannelIdentity[] = [];
  let principalContact: Contact | null = null;
  try {
    principalContact = await contactService.findContactBySystemRole('principal');
    if (principalContact) {
      const withIdentities = await contactService.getContactWithIdentities(principalContact.id);
      // Only use verified, active identities. Defunct/bounced addresses remain verified
      // in the DB but are no longer reachable — presenting them as authoritative in the
      // runtime prompt would cause agents to send to stale addresses with no fallback.
      principalIdentities = (withIdentities?.identities ?? []).filter(
        (id) => id.verified && id.status === 'active',
      );
    }
  } catch (err) {
    logger.fatal(
      { err },
      'Failed to load principal contact — check that migration 035 (add_system_role) has been applied',
    );
    process.exit(1);
  }

  // Note: a missing principal does NOT degrade — the readiness check below
  // converts it into a fatal startup error with a searchable `check: principal-contact`
  // log line and aborts boot. No separate warn here; that would duplicate the
  // readiness error and misleadingly imply degraded operation. The empty-string
  // fallback for ${principal_contact_id} in src/agents/loader.ts is therefore
  // pure defense-in-depth — unreachable while the readiness gate stands.

  // --- Startup readiness checks ---
  // All checks must pass before the system accepts inbound messages.
  // See docs/wip/2026-05-10-principal-identity-design.md
  const readinessChecks = [
    {
      name: 'principal-contact',
      // Reuse the principalContact already loaded above — no redundant DB query.
      check: async () => principalContact
        ? { ready: true as const }
        : { ready: false as const, reason: 'No contact with system_role=principal exists. Run setup to configure the principal user.' },
    },
  ];
  const readinessReport = await runReadinessChecks(readinessChecks);

  // setup-required mode: if every readiness failure is a recoverable-by-setup
  // one (today only `principal-contact`), keep the process running with just the
  // dispatcher + HTTP adapter so the operator can complete the onboarding wizard
  // via the web UI (issue #771 / #766). The wizard's POST /api/setup/principal
  // creates the principal contact; the next restart picks it up and brings
  // email/Signal up. Any failure NOT in the allow-list remains fatal.
  //
  // Encode this as `.every(...)` over an explicit allow-list — not as a
  // failures.length===1 check — so the moment a second readiness check is
  // added, partial setup-required mode doesn't silently disappear if both
  // checks fail. Any new check needs to be deliberately added to the allow-list
  // before it counts as recoverable-by-in-app-flow.
  const RECOVERABLE_BY_SETUP: ReadonlySet<string> = new Set(['principal-contact']);
  const setupRequiredAtBoot =
    !readinessReport.ready &&
    readinessReport.failures.length > 0 &&
    readinessReport.failures.every((f) => RECOVERABLE_BY_SETUP.has(f.name));

  if (!readinessReport.ready && !setupRequiredAtBoot) {
    for (const failure of readinessReport.failures) {
      logger.error({ check: failure.name, reason: failure.reason }, 'Startup readiness check failed');
    }
    throw new Error(`Startup readiness failed: ${readinessReport.failures.map((f) => f.name).join(', ')}`);
  }
  if (setupRequiredAtBoot) {
    // Single banner log line — the operator's main signal that the system isn't fully live.
    // External adapters skipped below; HTTP stays up to serve the onboarding wizard.
    //
    // Log the setup path only, not a fully-qualified URL: the process binds to 0.0.0.0
    // on `httpPort`, and the operator-facing origin (localhost vs Docker host vs
    // production hostname) is environment-dependent and not knowable here.
    logger.warn(
      { setupPath: '/setup', httpPort: config.httpPort },
      'SETUP-REQUIRED mode: no principal contact found. External channels (email/Signal) are NOT running. Open the wizard at the /setup path on this host, complete onboarding, then restart this process to bring external channels online.',
    );
  } else {
    logger.info('All startup readiness checks passed');
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
  const hasAnyOutboundClient = nylasClientMap.size > 0 || !!signalRpcClient;
  // Defense-in-depth for setup-required mode: even though inbound email/Signal
  // adapters are skipped (so no inbound traffic should be triggering outbound
  // replies), the OutboundGateway is also used by notifiers (suspension, recovery,
  // approval) and skills that send directly. Skipping the gateway construction
  // here closes those non-reply send paths too — there is no email/Signal
  // egress at all until the operator completes setup and restarts.
  if (setupRequiredAtBoot && hasAnyOutboundClient) {
    logger.warn(
      'SETUP-REQUIRED mode: outbound gateway NOT initialized — no email/Signal egress (notifiers, autonomy alerts) until restart',
    );
  }
  if (hasAnyOutboundClient && outboundFilter && !setupRequiredAtBoot) {
    outboundGateway = new OutboundGateway({
      nylasClients: nylasClientMap.size > 0 ? nylasClientMap : undefined,
      signalClient: signalRpcClient,
      signalPhoneNumber: config.signalPhoneNumber,
      contactService,
      contentFilter: outboundFilter,
      bus,
      // principalIdentities loaded from the DB at startup — used by isPrincipalRecipient()
      // to bypass the autonomy gate for agent-to-principal communications.
      principalIdentities,
      logger,
      autonomyService,
      piiRedactor,
      // Wire action log repo so the gateway can write autonomy_action_log rows on
      // gated sends and support two-step draft linkage (#435).
      actionLogRepo,
      confidencePipeline,
    });
    logger.info({
      emailAccounts: [...nylasClientMap.keys()],
      hasSignal: !!signalRpcClient,
    }, 'Outbound gateway initialized');
  } else if (nylasClientMap.size > 0 && !outboundFilter) {
    // Nylas clients are available but outboundFilter is missing (no coordinator config found).
    // Email skills will be unavailable because they check ctx.outboundGateway before sending.
    logger.warn('Outbound gateway NOT initialized — outboundFilter not ready (coordinator config missing?). Outbound send skills will be unavailable.');
  }

  // ── Channel registry ───────────────────────────────────────────────────────
  // Decide which channels start, from DB lifecycle state + resolvable credentials.
  // Credentials resolve vault-first, then env, then config (multi-account email).
  const channelRegistryRepo = new ChannelRegistryRepo(pool);

  // Config-satisfied keys per channel (the messy, config-shape-aware part lives here,
  // keeping the resolver pure). Email is satisfied via config when ≥1 account resolved.
  const channelConfigKeys = (descriptor: ChannelDescriptor): Set<string> => {
    if (descriptor.name === 'email' && resolvedEmailAccounts.length > 0) {
      // Email's runtime creds come from config/default.yaml accounts. Only mark a key
      // as config-resolved when it is actually present, so registry state reflects what
      // the adapter can really boot with (the API key in particular is global config,
      // not per-account, so a resolved account does not by itself imply a key exists).
      const keys = new Set<string>();
      keys.add('nylas_grant_id');
      keys.add('nylas_self_email');
      if (config.nylasApiKey) keys.add('nylas_api_key');
      return keys;
    }
    return new Set<string>();
  };

  const channelCredentialStatusFn = (descriptor: ChannelDescriptor) =>
    channelCredentialStatus(
      { secrets: secretsService, configResolvedKeys: channelConfigKeys(descriptor), logger },
      descriptor,
    );

  try {
    await reconcileChannelRegistry({
      repo: channelRegistryRepo,
      catalog: CHANNEL_CATALOG,
      credentialStatus: channelCredentialStatusFn,
      logger,
    });
  } catch (err) {
    logger.fatal({ err }, 'Channel registry reconciliation failed');
    process.exit(1);
  }

  // Compute the set of channels that should actually start this boot: enabled in the DB
  // AND credentials currently resolvable. Non-toggleable channels (http/cli) always start.
  const channelRows = await channelRegistryRepo.listRows();
  const enabledByName = new Map(channelRows.map(r => [r.name, r.enabled]));
  const channelShouldStart = new Set<string>();
  for (const descriptor of CHANNEL_CATALOG) {
    if (!descriptor.isToggleable) { channelShouldStart.add(descriptor.name); continue; }
    if (!enabledByName.get(descriptor.name)) continue;
    const status = await channelCredentialStatusFn(descriptor);
    if (status.requiredResolvable) {
      channelShouldStart.add(descriptor.name);
    } else {
      // Enabled but credentials no longer resolve: warn and skip — never crash (spec §7).
      logger.warn({ channel: descriptor.name }, 'channel enabled but required credentials missing; not starting');
    }
  }

  // Service backing /api/registry/channels/* (delete wired for uninstall vault cleanup).
  const channelRegistryService = new ChannelRegistryService(
    channelRegistryRepo,
    CHANNEL_CATALOG,
    channelCredentialStatusFn,
    secretsService,
  );
  // ───────────────────────────────────────────────────────────────────────────

  // Construct one EmailAdapter per resolved account (but don't start any yet —
  // adapters must not poll until the dispatcher is registered, otherwise inbound.message
  // events have no subscriber and are permanently dropped because each adapter advances
  // its own high-water mark on poll).
  if (outboundGateway && channelShouldStart.has('email')) {
    for (const account of resolvedEmailAccounts) {
      if (!nylasClientMap.has(account.name)) continue; // skip accounts with no client (NYLAS_API_KEY missing)

      emailAdapters.push(new EmailAdapter({
        accountId: account.name,
        bus,
        logger,
        outboundGateway,
        contactService,
        pollingIntervalMs: config.nylasPollingIntervalMs,
        selfEmail: account.selfEmail,
        excludedSenderEmails: account.excludedSenderEmails,
        ceoEmail: config.ceoPrimaryEmail,
        contactCreationMaxPerMessage: yamlConfig.contact_creation_limits?.max_per_message ?? 10,
        contactCreationMaxPerHour: yamlConfig.contact_creation_limits?.max_per_hour ?? 100,
        timezone: config.timezone,
        // Persist the poll high-water mark so restarts resume from where we left off
        // rather than silently dropping messages that arrived during downtime (#846).
        configStore: entityMemory ? new ConfigStore(entityMemory, logger) : undefined,
      }));
    }
  }

  // Construct the Signal adapter (but don't start it yet — same ordering rule as email:
  // dispatcher must be registered first so inbound.message always has a subscriber).
  if (outboundGateway && signalRpcClient && config.signalPhoneNumber && channelShouldStart.has('signal')) {
    signalAdapter = new SignalAdapter({
      bus,
      logger,
      rpcClient: signalRpcClient,
      outboundGateway,
      contactService,
      phoneNumber: config.signalPhoneNumber,
    });
  }

  // Scheduler — Postgres-backed job scheduler for cron and one-shot tasks.
  // SchedulerService is the shared service; Scheduler is the polling loop.
  // Constructed early so it can be passed to ExecutionLayer and HttpAdapter.
  const schedulerService = new SchedulerService(pool, bus, logger, config.timezone);

  // Build the drift detector if enabled in config. Requires the LLM provider
  // (already created above). If enabled but no provider is available, the config
  // is still valid — drift checks will simply never trigger.
  // The 'standard' tier is used for drift checks — they're concise JSON judgments
  // that don't need the full flagship model.
  let driftDetector: DriftDetector | undefined;
  if (yamlConfig.intentDrift?.enabled !== false) {
    // Resolve effective drift config with defaults.
    const driftConfig: DriftConfig = {
      enabled: yamlConfig.intentDrift?.enabled ?? true,
      checkEveryNBursts: yamlConfig.intentDrift?.checkEveryNBursts ?? 1,
      minConfidenceToPause: yamlConfig.intentDrift?.minConfidenceToPause ?? 'high',
      model: modelRouter.resolve('standard').model,
    };
    // Resolve the provider from the registry so remapping 'standard' to an
    // OpenRouter model routes drift checks through OpenRouterProvider. (#646)
    const driftProvider = new TelemetryLlmProvider(resolveProviderForModel(driftConfig.model, 'DriftDetector'), bus, logger, 'drift-detector', modelRegistry);
    driftDetector = new DriftDetector(driftProvider, driftConfig, logger);
    logger.info({ driftConfig }, 'Intent drift detection enabled');
  } else {
    logger.info('Intent drift detection disabled via config');
  }

  // Dream engine — background KG maintenance (spec 17 / issue #27).
  // Defaults are intentionally conservative: daily cadence, 5% archive threshold,
  // 180-day slow-decay half-life, 21-day fast-decay half-life.
  const decayConfig: DecayConfig = {
    intervalMs: yamlConfig.dreaming?.decay?.intervalMs ?? 86_400_000,
    archiveThreshold: yamlConfig.dreaming?.decay?.archiveThreshold ?? 0.05,
    halfLifeDays: {
      permanent: null,
      slow_decay: yamlConfig.dreaming?.decay?.halfLifeDays?.slow_decay ?? 180,
      fast_decay: yamlConfig.dreaming?.decay?.halfLifeDays?.fast_decay ?? 21,
    },
    edgeCountPercentile: yamlConfig.dreaming?.decay?.edgeCountPercentile ?? 0.95,
    edgeCountFloor: yamlConfig.dreaming?.decay?.edgeCountFloor ?? 5,
    warnHoldBackDays: yamlConfig.dreaming?.decay?.warnHoldBackDays ?? 7,
  };
  // Autonomy scoring pass — Phase 3 automatic score adjustment (issue #148).
  // Runs as a sibling DreamEngine pass alongside memory decay.
  // actionLogRepo is already instantiated above (before OutboundGateway) — reused here.
  // Resolve model tier from config (defaults to 'fast' — the scoring pass is non-interactive
  // and doesn't need a powerful model, so 'fast' is appropriate for cost efficiency).
  const scoringModelTier = yamlConfig.dreaming?.autonomy_scoring?.model_tier ?? 'fast';
  let scoringModel: string;
  try {
    scoringModel = modelRouter.resolve(scoringModelTier).model;
  } catch (err) {
    logger.fatal({ scoringModelTier, err }, 'autonomy_scoring.model_tier references an unknown model tier — cannot start');
    process.exit(1);
  }
  const scoringPassConfig: ScoringPassConfig = {
    intervalMs: yamlConfig.dreaming?.autonomy_scoring?.intervalMs ?? 86_400_000,  // default: daily
    model: scoringModel,
    batchSize: yamlConfig.dreaming?.autonomy_scoring?.batchSize ?? 50,
    minScoredActions: yamlConfig.dreaming?.autonomy_scoring?.minScoredActions ?? 30,
    halfLifeDays: yamlConfig.dreaming?.autonomy_scoring?.halfLifeDays ?? 30,
    weakExpiredWeight: yamlConfig.dreaming?.autonomy_scoring?.weakExpiredWeight ?? 0.3,
    ceoCooldownDays: yamlConfig.dreaming?.autonomy_scoring?.ceoCooldownDays ?? 7,
    errorRateThreshold: yamlConfig.dreaming?.autonomy_scoring?.errorRateThreshold ?? 0.20,
  };
  // Resolve the provider from the registry so remapping the scoring tier to an
  // OpenRouter model routes LLM-judge calls through OpenRouterProvider. (#646)
  const scoringProvider = new TelemetryLlmProvider(resolveProviderForModel(scoringModel, 'AutonomyScoringPass'), bus, logger, 'scoring-pass', modelRegistry);
  const scoringPass = new AutonomyScoringPass(actionLogRepo, autonomyService, scoringProvider, logger, scoringPassConfig);
  logger.info({ scoringPassConfig }, 'AutonomyScoringPass configured');

  const dreamEngine = new DreamEngine(pool, bus, logger, decayConfig, scoringPass, memory);
  logger.info({ decayConfig }, 'DreamEngine configured');

  // Outbound context bridge — delegation-aware context registry for
  // specialist-initiated outbound. Requires pool (Postgres).
  // Constructed here (before Scheduler) so the scheduler can run startup + daily cleanup.
  const outboundContextService = pool
    ? new OutboundContextService(pool, logger, {
        defaultExpiryHours: yamlConfig.contextBridge?.defaultExpiryHours,
        explicitExpiryHours: yamlConfig.contextBridge?.explicitExpiryHours,
      })
    : undefined;

  const scheduler = new Scheduler({ pool, bus, logger, schedulerService, driftDetector, dreamEngine, outboundContextService, defaultExpectedDurationSeconds: yamlConfig.scheduler?.defaultExpectedDurationSeconds });

  // SuspensionNotifier — emails the CEO when a scheduled job is auto-suspended.
  // Bypasses the LLM pipeline: notifies even when Anthropic is the thing that's down.
  // Skipped (with a warning) if outboundGateway or ceoPrimaryEmail is absent.
  if (outboundGateway && config.ceoPrimaryEmail) {
    const suspensionNotifier = new SuspensionNotifier({
      bus,
      outboundGateway,
      ceoEmail: config.ceoPrimaryEmail,
      logger,
    });
    suspensionNotifier.register();
  } else {
    logger.warn(
      { hasGateway: !!outboundGateway, hasCeoEmail: !!config.ceoPrimaryEmail },
      'SuspensionNotifier not registered — outboundGateway or ceoPrimaryEmail absent; suspended jobs will not trigger CEO email alerts',
    );
  }

  // RecoveryNotifier — emails the CEO when the watchdog auto-recovers a stuck job.
  // Bypasses the LLM pipeline for the same reason as SuspensionNotifier: the LLM
  // may be the reason the job is stuck in the first place.
  // Skipped (with a warning) if outboundGateway or ceoPrimaryEmail is absent.
  if (outboundGateway && config.ceoPrimaryEmail) {
    const recoveryNotifier = new RecoveryNotifier({
      bus,
      outboundGateway,
      ceoEmail: config.ceoPrimaryEmail,
      logger,
    });
    recoveryNotifier.register();
  } else {
    logger.warn(
      { hasGateway: !!outboundGateway, hasCeoEmail: !!config.ceoPrimaryEmail },
      'RecoveryNotifier not registered — outboundGateway or ceoPrimaryEmail absent; recovered stuck jobs will not trigger CEO email alerts',
    );
  }

  // Approval trigger — creates pending_approval rows and notifies CEO
  // when autonomy gates block a skill. See ADR-018 and issue #427.
  // Constructed unconditionally — row creation does not depend on the outbound stack.
  // outboundGateway and ceoEmail are optional: if absent, the row is created but
  // notification is skipped (CEO will see it in the next digest, #429).
  const approvalTrigger = new ApprovalTriggerService(
    actionLogRepo, outboundGateway, logger, config.ceoPrimaryEmail || undefined,
  );

  // Temp file store — secure tmpfs-backed storage for binary attachment handoff.
  // Skills declaring 'tempFileStore' capability get ctx.writeTempFile().
  // See docs/specs/2026-05-16-temp-attachment-store-design.md for security model.
  // Non-fatal: if the tmpfs mount is unavailable and the fallback dir can't be
  // created, we log and continue without this capability rather than aborting startup.
  let tempFileStore: TempFileStore | undefined;
  try {
    tempFileStore = new TempFileStore();
    await tempFileStore.init(logger);
  } catch (err) {
    logger.error({ err }, 'Temp file store init failed — continuing without tempFileStore capability');
    tempFileStore = undefined;
  }

  // InfraLlmService — constrained LLM access for infrastructure skills (#637).
  // Routes through ModelRouter + LLMProviderRouter for tier-aware model selection,
  // and publishes llm.call bus events for full telemetry. Exposes only classify()
  // and extract() — no raw chat(). The narrow API surface IS the security policy.
  //
  // Validate at startup that the tiers infra skills use (fast and standard)
  // are routable, giving the same fail-fast guarantee as the other three consumers.
  for (const infraTier of ['fast', 'standard'] as const) {
    const infraModel = modelRouter.resolve(infraTier).model;
    const infraProviderName = modelRegistry.getProvider(infraModel);
    if (!infraProviderName || !providerRegistry.has(infraProviderName)) {
      logger.fatal(
        { tier: infraTier, model: infraModel, provider: infraProviderName },
        `Infra skill tier '${infraTier}' maps to model '${infraModel}' whose provider is not registered — infra skills will fail at call time. `
        + 'Set the corresponding API key or remap the tier to a model with a registered provider.',
      );
      process.exit(1);
    }
  }
  const infraLlmRouter = new LLMProviderRouter(modelRegistry, providerRegistry);
  const infraLlmService = new InfraLlmService(infraLlmRouter, modelRouter, bus, logger, modelRegistry);

  // Execution layer — services wired here are injected per-skill based on their
  // capability-gated declarations. outboundGateway gives email skills their send path.
  // entityContextAssembler enables entity_enrichment pre-enrichment and the
  // entity-context skill. agentContactId enables entity_enrichment default='agent'.
  // infraLlmService provides constrained LLM access (classify/extract) with telemetry.
  const executionLayer = new ExecutionLayer(skillRegistry, logger, { bus, agentRegistry, contactService, outboundGateway, schedulerService, entityMemory, agentPersona, nylasCalendarClient, entityContextAssembler, agentContactId: agentIdentityContactId, autonomyService, secretsService, executiveProfileService, officeIdentityService, browserService, bullpenService, approvalTrigger, actionLogRepo, taskRepo, confidencePipeline, tempFileStore, infraLlmService, outboundContextService, timezone: config.timezone, selfEmail: resolvedEmailAccounts[0]?.selfEmail, skillOutputMaxLength: yamlConfig.skillOutput?.maxLength, defaultDelegateTimeoutMs: yamlConfig.delegate?.defaultTimeoutMs, appOrigin: config.appOrigin, httpPort: config.httpPort });

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
        expectedDurationSeconds: agentConfig.expected_duration_seconds,
      });
    }
  } catch (err) {
    logger.fatal({ err }, 'Failed during agent registration');
    process.exit(1);
  }

  // Cross-validate allowed_callers in skill manifests against known agent names.
  // Must run after both skills and agents are loaded. Unknown names → hard fail.
  try {
    // Use ALL discovered agent names (enabled + disabled), not just enabled ones, so a
    // skill that allows a currently-disabled agent as a caller doesn't trip the typo
    // check. A genuinely unknown name still throws.
    const knownAgentNames = new Set(agentDiscovery.map(d => d.name));
    validateAllowedCallers(skillRegistry, knownAgentNames);
  } catch (err) {
    logger.fatal({ err }, 'allowed_callers validation failed — fix skill manifests');
    process.exit(1);
  }

  // RegistryService backs the /api/registry/* routes. Seed it with the discovery
  // captured above so the UI can show uninstalled/ghost/error items, not just enabled.
  const registryService = new RegistryService(
    skillRegistryRepo,
    agentRegistryRepo,
    skillDiscovery as unknown as Discovery[],
    agentDiscovery.map(d => ({
      name: d.name,
      metadata: d.config
        ? { name: d.config.name, description: d.config.description ?? d.config.name, version: d.config.version ?? '0.0.0', role: d.config.role, modelTier: d.config.model?.tier, memoryScopes: d.config.memory?.scopes }
        : null,
      error: d.error,
    })),
    // PR2 (#939): backs the install/enable secrets gate — a skill declaring
    // install.requires_secrets can't go live until those keys exist in the vault.
    secretsService,
  );

  // Secret-capture service (#971) — mints one-time tokens for agent-initiated secret
  // capture and redeems submitted values into the vault. Shared by the public HTTP routes
  // and the two capture skills. The system-name allowlist is a live thunk: declared skill
  // secrets ∪ channel credential keys, reusing RegistryService's exact logic + the vault
  // route's CHANNEL_CREDENTIAL_KEYS so there's a single source of truth for writable names.
  const secretCaptureService = new SecretCaptureService(pool, secretsService, {
    getAllowedSystemNames: () =>
      new Set([...registryService.declaredSecretNames(), ...channelCredentialKeys()]),
    logger,
  });
  // Injected after construction because the ExecutionLayer is created before registryService
  // (which the allowlist thunk depends on). Mirrors setAgentContactId's post-hoc injection.
  executionLayer.setSecretCaptureService(secretCaptureService);

  // Agents with enable_task_management: true — read by the BacklogHeartbeat to
  // know which source_agent_ids it may wake (and as the fallback target list).
  const taskManagementAgents = new Set<string>();

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
    // For the coordinator, interpolate runtime context (just the principal contact ID).
    // The specialist roster and the coordinator's own contact ID are no longer resolved
    // here — they are injected per-turn by AgentRuntime (## Available Specialists block
    // and the Contact ID line in ## Your Contact Details). Date and timezone are likewise
    // appended fresh every task turn via formatTimeContextBlock() so they never go stale.
    // This runs in pass 2 so all specialists are already in the registry.
    let systemPrompt = agentConfig.system_prompt;
    if (agentConfig.role === 'coordinator') {
      // Do NOT pass officeIdentityBlock here. The coordinator YAML contains no
      // identity placeholder; the identity block is prepended per-turn as a preamble
      // in AgentRuntime.processTask() by the officeIdentityService passed below,
      // enabling hot-reload without a restart.
      systemPrompt = interpolateRuntimeContext(systemPrompt, {
        principalContactId: principalContact?.id,
      });
    } else if (agentConfig.inject_specialists) {
      // Specialists that need to know about available agents
      // opt in via inject_specialists: true in their YAML.
      // Pass agentContactId AND principalContactId so specialists can reference
      // their own identity (${agent_contact_id}) and the principal's contact ID
      // (${principal_contact_id}) without calling contact-lookup-by-role.
      try {
        systemPrompt = interpolateRuntimeContext(systemPrompt, {
          availableSpecialists: agentRegistry.specialistSummary(),
          agentContactId: agentIdentityContactId,
          principalContactId: principalContact?.id,
        });
      } catch (err) {
        logger.error({ err, agentName: agentConfig.name }, 'Failed to interpolate specialists into agent system prompt');
        throw err;
      }
    } else {
      // All other specialists: resolve ${agent_contact_id} (the agent's own
      // identity, e.g. calendar.yaml's "Your contact ID is ${agent_contact_id}")
      // and ${principal_contact_id} so both placeholders work without each
      // specialist needing inject_specialists. interpolateRuntimeContext runs
      // its full replace chain unconditionally — values not passed here would
      // be blanked to empty string by the UUID-format check, so we MUST pass
      // every contact ID the prompt could reference. Specialists list is
      // omitted because non-inject_specialists agents don't route work.
      systemPrompt = interpolateRuntimeContext(systemPrompt, {
        agentContactId: agentIdentityContactId,
        principalContactId: principalContact?.id,
      });
    }

    // Apply the enable_task_management capability: auto-pin task skills, append the
    // discipline block, and register heartbeat-eligibility. No-op when the flag is off.
    const taskMgmt = applyTaskManagement(agentConfig, systemPrompt, agentPinnedSkills);
    systemPrompt = taskMgmt.systemPrompt;
    const effectivePinnedSkills = taskMgmt.pinnedSkills;
    if (taskMgmt.heartbeatEligible) {
      taskManagementAgents.add(agentConfig.name);
    }

    // was: const agentToolDefs = skillRegistry.toToolDefinitions(agentPinnedSkills);
    const agentToolDefs = skillRegistry.toToolDefinitions(effectivePinnedSkills);

    // allow_discovery: true → inject the skill-registry discovery tool into the agent's
    // tool list. Skipped if already pinned to avoid duplicate tool definitions.
    // The skill-registry handler is loaded by the standard file loader like any other
    // skill; this only controls whether it appears in the LLM's tool list for this agent.
    if (agentConfig.allow_discovery && !effectivePinnedSkills.includes('skill-registry')) {
      const discoveryToolDefs = skillRegistry.toToolDefinitions(['skill-registry']);
      if (discoveryToolDefs.length === 0) {
        // skill-registry is not in the registry — it either failed to load (bad manifest,
        // missing handler) or was never registered. Error-level: a declared capability is
        // unavailable for this agent's entire lifetime. Root cause will be in the earlier
        // skill-loader error log; this connects the agent-level consequence to it.
        logger.error({ agent: agentConfig.name }, 'allow_discovery is true but skill-registry is not registered — discovery unavailable; check startup logs for skill load errors');
      } else {
        agentToolDefs.push(...discoveryToolDefs);
      }
    }

    // Resolve this agent's capability tier to a concrete model, then look up
    // the provider from the model registry. This decouples tier→model from
    // model→provider: the registry is the single source of truth for which
    // provider serves each model.
    const resolved = modelRouter.resolve(agentConfig.model.tier, agentConfig.model.needs);
    const resolvedProvider = modelRegistry.getProvider(resolved.model);
    if (!resolvedProvider) {
      logger.fatal({ model: resolved.model, agent: agentConfig.name, tier: resolved.tier },
        'Model not found in registry — cannot resolve provider');
      process.exit(1);
    }
    const agentProvider = providerRegistry.get(resolvedProvider);
    if (!agentProvider) {
      logger.fatal({ provider: resolvedProvider, agent: agentConfig.name, tier: resolved.tier },
        `No provider registered for model's provider`);
      process.exit(1);
    }

    const agent = new AgentRuntime({
      agentId: agentConfig.name,
      systemPrompt,
      provider: agentProvider,
      resolvedModel: resolved.model,
      bus,
      logger,
      memory,
      entityMemory,
      executionLayer,
      pinnedSkills: effectivePinnedSkills,
      skillToolDefs: agentToolDefs,
      // Registry-backed context window lookups and cost estimation (DI so runtime is testable).
      modelRegistry,
      estimateCostUsd,
      // Only the coordinator receives the autonomy service — it's the only agent
      // that needs per-task autonomy prompt injection and the autonomy skills.
      // Use role (same predicate as interpolateRuntimeContext above) so both
      // branches stay in sync if the coordinator YAML is ever reconfigured.
      autonomyService: agentConfig.role === 'coordinator' ? autonomyService : undefined,
      // All agents receive per-turn time block injection so the current date/time
      // and timezone are always accurate. Specialists need this too — scheduled
      // agents in particular make time-sensitive decisions (backoff gates, date
      // comparisons) that require a reliable "now".
      timezone: config.timezone,
      // The coordinator gets per-turn identity block injection via officeIdentityService.
      // This prepends the identity block to the system prompt as a preamble on
      // every task, so identity hot-reloads (file watcher or API PUT) take effect on the
      // next turn without a restart.
      officeIdentityService: agentConfig.role === 'coordinator' ? officeIdentityService : undefined,
      // The coordinator gets per-turn security context block injection. The block is
      // prepended to the system prompt (immediately after the identity block) on every task.
      // Specialists do not receive this — they operate in a trust-elevated context (tasks
      // arrive from the coordinator after the security layer has already evaluated the sender).
      securityContextBlock: agentConfig.role === 'coordinator' ? securityContextBlock : undefined,
      // Curia's own contact details — injected per-task so agents know which accounts to
      // use when MCP tools ask for an email address or phone number. Injected into ALL
      // agents (#387) — specialists like essay-editor need this to avoid hallucinating
      // account identifiers.
      // Email: use the first account's address for agent context injection.
      channelAccounts: {
        email: resolvedEmailAccounts[0]?.selfEmail || undefined,
        phone: config.signalPhoneNumber || undefined,
      },
      // Principal's verified channel identities — injected per-task into ALL agents so
      // every agent knows where to reach the CEO without inferring addresses. Sourced from
      // the startup-cached principalIdentities array (already filtered to verified + active).
      // Mirrors the channelAccounts pattern (#387). Fixes #786.
      principalIdentities,
      // Specialist roster — appended as "## Available Specialists" for the coordinator.
      // Specialists that opt in via inject_specialists keep the bootstrap ${available_specialists}
      // placeholder (resolved in interpolateRuntimeContext); this runtime path is coordinator-only.
      availableSpecialists: agentConfig.role === 'coordinator' ? agentRegistry.specialistSummary() : undefined,
      // The coordinator's own contact ID — surfaced in "## Your Contact Details".
      // Specialists keep the ${agent_contact_id} bootstrap placeholder.
      agentContactId: agentConfig.role === 'coordinator' ? agentIdentityContactId : undefined,
      // Agent registry — allows the runtime to look up the target agent's
      // expected_duration_seconds when injecting delegate timeouts (#387).
      agentRegistry,
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
      logger.info({ agent: agentConfig.name, skills: agentToolDefs.map(d => d.name) }, 'Agent tools configured');
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
  // Autonomous task execution: the deterministic hourly heartbeat that wakes idle/stale
  // tasks. Reads the tasks table, writes one-shot scheduled_jobs rows; the scheduler
  // dispatches them. See docs/wip/2026-06-04-task-execution-heartbeat-design.md §3.
  const tasksConfig = resolveTasksConfig(yamlConfig.tasks);
  const backlogHeartbeat = new BacklogHeartbeat({
    pool,
    logger,
    schedulerService,
    eligibleAgents: taskManagementAgents,
    intervalMinutes: tasksConfig.heartbeatIntervalMinutes,
    maxWakesPerTick: tasksConfig.heartbeatMaxWakesPerTick,
    idleThresholdHours: tasksConfig.idleThresholdHours,
    staleWaitThresholdHours: tasksConfig.staleWaitThresholdHours,
  });

  scheduler.start();
  backlogHeartbeat.start();
  logger.info('Scheduler started');

  // Log the scrubber status after the logger is available (patterns are loaded at module
  // init time, before pino exists, so any load-time failures are deferred to here).
  const missingBuiltInPatterns = getMissingBuiltInPatterns();
  if (missingBuiltInPatterns.length > 0) {
    // Library version drift — one or more built-in PII pattern types were not found
    // in openredaction. These PII types will NOT be scrubbed from
    // LLM-facing error messages. Log at error so alerting catches this.
    logger.error(
      { missingPatterns: missingBuiltInPatterns },
      'PII scrubber: built-in pattern types missing from openredaction — check library version',
    );
  }
  logger.info(
    { builtInPatterns: getBuiltInPatternCount(), extraPatterns: extraPiiPatternCount },
    'PII scrubber active',
  );

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

  // Rate limiter — enforces global and per-sender message rate limits at the dispatch layer.
  // Constructed from config/default.yaml dispatch.rate_limit section; falls back to safe defaults
  // if the section is absent (same pattern as other optional dispatch config).
  const rateLimitConfig = yamlConfig.dispatch?.rate_limit;
  const rateLimiterWindowMs = rateLimitConfig?.window_ms ?? 60_000;
  const rateLimiterMaxPerSender = rateLimitConfig?.max_per_sender ?? 15;
  const rateLimiterMaxGlobal = rateLimitConfig?.max_global ?? 100;
  const rateLimiter = new RateLimiter({
    windowMs: rateLimiterWindowMs,
    maxPerSender: rateLimiterMaxPerSender,
    maxGlobal: rateLimiterMaxGlobal,
  });
  logger.info(
    { windowMs: rateLimiterWindowMs, maxPerSender: rateLimiterMaxPerSender, maxGlobal: rateLimiterMaxGlobal },
    'Dispatch rate limiter initialized',
  );

  // 7. Dispatcher — subscribes to inbound.message + agent.response.
  // Registered after the coordinator so agent.task already has a handler
  // when the dispatcher fans the first inbound message out.
  // Content filter, externalChannels, and ceoNotification are now handled by OutboundGateway.
  // The Dispatcher only routes — it no longer contains any filter or scan logic directly.
  const dispatcher = new Dispatcher({
    bus,
    logger,
    contactResolver,
    channelPolicies: authConfig?.channelPolicies,
    injectionScanner,
    rateLimiter,
    pool,
    conversationCheckpointDebounceMs: yamlConfig.dispatch?.conversationCheckpointDebounceMs,
    trustScorerWeights,
    maxMessageBytes: yamlConfig.channels?.max_message_bytes ?? 102_400,
    confidencePipeline,
    selfEmail: resolvedEmailAccounts[0]?.selfEmail,
    outboundContextService,
  });
  dispatcher.register();

  // Resume-after-capture subscriber (#972) — listens for secret.captured (published by the
  // capture endpoint on a successful redeem) and re-enters the originating agent with a synthetic
  // agent.task so it can continue what it was blocked on. Wired AFTER the dispatcher so it can
  // seed routing for the synthetic task via registerExternalTaskRouting — without that the agent's
  // resumed reply would find no routing entry and never reach the user.
  const secretCaptureResumeSubscriber = new SecretCaptureResumeSubscriber(
    bus,
    logger,
    (taskEventId, routing) => dispatcher.registerExternalTaskRouting(taskEventId, routing),
  );
  secretCaptureResumeSubscriber.start();

  // Conversation checkpoint processor — System Layer subscriber that runs background
  // memory skills (extract-relationships, etc.) at end of each conversation.
  const checkpointProcessor = new ConversationCheckpointProcessor(bus, executionLayer, pool, logger);
  checkpointProcessor.register();

  // BullpenDispatcher — routes agent.discuss → agent.task for inter-agent Bullpen discussions.
  const bullpenDispatcher = new BullpenDispatcher(bus, logger, bullpenService);
  bullpenDispatcher.register();

  // HTTP API channel — started BEFORE channel adapters so the health check endpoint
  // is available immediately. Channel adapters (email, Signal) run their initial
  // poll synchronously and block on agent task processing; starting HTTP last meant
  // the health check fired during a multi-minute catch-up and marked the container
  // unhealthy before the API was even bound. All HTTP adapter dependencies (bus,
  // pool, services, registries) are fully initialized by this point.
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
    executiveProfileService,
    contactService,
    autonomyService,
    registryService,
    channelRegistryService,
    secretsService,
    secretCaptureService,
    setupRequiredAtBoot,
    bootStartedAt,
  });

  try {
    await httpAdapter.start();
  } catch (err) {
    logger.fatal({ err }, 'Failed to start HTTP API');
    process.exit(1);
  }

  // Graceful shutdown — stop accepting new input first, then close connections.
  // Accepts exitCode so startup-failure teardown can exit(1) while SIGTERM/SIGINT
  // exit(0). Defined before channel adapter startup so that a failure in
  // adapter.start() (after HTTP has already bound) can call shutdown(1) and ensure
  // the HTTP server, pool, and other already-started resources are closed cleanly.
  const shutdown = async (exitCode = 0) => {
    logger.info('Shutting down...');
    for (const adapter of emailAdapters) {
      try {
        await adapter.stop();
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
    if (executiveProfileService) {
      try {
        await executiveProfileService.stop();
      } catch (err) {
        logger.error({ err }, 'Error stopping executive profile file watcher during shutdown');
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
      backlogHeartbeat.stop();
    } catch (err) {
      logger.error({ err }, 'Error stopping backlog heartbeat during shutdown');
    }
    if (browserService) {
      try {
        await browserService.stop();
      } catch (err) {
        logger.error({ err }, 'Error stopping browser service during shutdown');
      }
    }
    // Close MCP server connections — each session owns a spawned process (stdio)
    // or an open HTTP connection (SSE) that must be released before exit.
    for (const session of mcpSessions) {
      try {
        await session.close();
      } catch (err) {
        logger.error({ err, server: session.serverId }, 'Error closing MCP session during shutdown');
      }
    }
    // Clear pending checkpoint timers before closing the pool — prevents in-flight
    // fireCheckpoint calls from querying a closed pool during shutdown.
    try {
      dispatcher.close();
    } catch (err) {
      logger.error({ err }, 'Error clearing checkpoint timers during shutdown');
    }
    // Purge temp files and stop the sweep timer before exit.
    if (tempFileStore) {
      try {
        await tempFileStore.shutdown();
      } catch (err) {
        logger.error({ err }, 'Error shutting down temp file store during shutdown');
      }
    }
    try {
      await pool.end();
    } catch (err) {
      logger.error({ err }, 'Error closing database pool during shutdown');
    }
    process.exit(exitCode);
  };

  process.on('SIGTERM', () => void shutdown());
  // Handle SIGINT unconditionally here rather than inside CliAdapter.start().
  // Previously SIGINT was only caught when the CLI adapter was running; with
  // the TTY guard above, non-TTY (Docker/production) deployments had no SIGINT
  // handler and would terminate uncleanly without draining the DB pool, stopping
  // the scheduler, or gracefully closing the HTTP server.
  process.on('SIGINT', () => void shutdown());

  // Start channel adapters AFTER the dispatcher is registered so inbound.message events
  // always have a subscriber. Starting before registration would drop messages arriving
  // during the startup window (each adapter advances its own high-water mark on poll,
  // so dropped messages are never retried).
  //
  // Wrapped in try/catch: if a channel adapter throws after HTTP has already bound,
  // shutdown() cleans up the HTTP server, pool, scheduler, and other started resources
  // before the process exits. Without this, the error propagates to main().catch which
  // calls process.exit(1) without any teardown.
  //
  // Skipped entirely in setup-required mode — without a principal contact there is no
  // recipient policy, no autonomy-bypass identity match, and no sane fallback for
  // received messages. The operator restarts after completing setup to bring these up.
  try {
    if (!setupRequiredAtBoot) {
      for (const adapter of emailAdapters) {
        await adapter.start();
      }
      if (emailAdapters.length > 0) {
        logger.info({ count: emailAdapters.length }, 'Email channel adapter(s) started');
      }
    } else if (emailAdapters.length > 0) {
      logger.warn(
        { count: emailAdapters.length },
        'SETUP-REQUIRED mode: skipping email adapter startup — restart after setup to enable',
      );
    }

    // SignalAdapter.start() connects to the signal-cli socket and registers the inbound listener.
    // If signal-cli is not yet running (e.g., cold start with both containers starting simultaneously),
    // the RPC client's exponential backoff will retry until the socket is available.
    if (signalAdapter && !setupRequiredAtBoot) {
      await signalAdapter.start();
      logger.info('Signal channel adapter started');
    } else if (signalAdapter && setupRequiredAtBoot) {
      logger.warn('SETUP-REQUIRED mode: skipping Signal adapter startup — restart after setup to enable');
    }
  } catch (err) {
    logger.fatal({ err }, 'Fatal error during channel adapter startup — invoking shutdown');
    await shutdown(1);
  }

  // 8. CLI channel — only started when stdin is an interactive TTY (i.e., local dev).
  // In Docker / production, stdin is closed or a pipe: readline receives EOF
  // immediately and would fire onExit, triggering shutdown before any work is done.
  // Guarding on isTTY means the HTTP API and email channel handle all production
  // input while the CLI remains available for local development sessions.
  if (process.stdin.isTTY) {
    const cli = new CliAdapter(bus, logger, () => void shutdown());
    // start() is async but performs only synchronous setup (no awaits), so the readline
    // interface is ready for prompt() immediately below. Attach a .catch() so a setup
    // failure (e.g. an unauthorized bus.subscribe) is logged and shut down fatally rather
    // than surfacing as an unhandled promise rejection.
    void cli.start().catch((err) => {
      logger.fatal({ err }, 'CLI adapter failed to start — invoking shutdown');
      void shutdown(1);
    });
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
