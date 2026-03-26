/**
 * Curia Bootstrap Orchestrator
 *
 * Initializes all services in dependency order:
 * 1. Config + logging (no dependencies)
 * 2. Database connection (needs config)
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

  // TODO: Run node-pg-migrate programmatically on startup so the schema is
  // always current when the process starts (no manual migration step required).

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
  const contactResolver = new ContactResolver(contactService, entityMemory, logger);
  logger.info('Contact system initialized');

  // Skill registry — loads all skills from the skills/ directory.
  // Skills are the framework's extension mechanism; agents invoke them
  // via the LLM's tool-use API through the execution layer.
  const skillRegistry = new SkillRegistry();
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

  // Execution layer — now with bus and agent registry for infrastructure skills.
  const executionLayer = new ExecutionLayer(skillRegistry, logger, { bus, agentRegistry, contactService });

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

    // For the coordinator, interpolate runtime context (specialist list, date, timezone).
    // This runs in pass 2 so all specialists are already in the registry.
    // Date is formatted as "YYYY-MM-DD, DayName" in the configured timezone
    // so agents can resolve relative references like "next Friday".
    let systemPrompt = agentConfig.system_prompt;
    if (agentConfig.role === 'coordinator') {
      const now = new Date();
      const currentDate = now.toLocaleDateString('en-CA', {
        timeZone: config.timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        weekday: 'long',
      });
      systemPrompt = interpolateRuntimeContext(systemPrompt, {
        availableSpecialists: agentRegistry.specialistSummary(),
        currentDate,
        timezone: config.timezone,
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

  // 7. Dispatcher — subscribes to inbound.message + agent.response.
  // Registered after the coordinator so agent.task already has a handler
  // when the dispatcher fans the first inbound message out.
  const dispatcher = new Dispatcher({ bus, logger, contactResolver });
  dispatcher.register();

  // HTTP API channel — REST + SSE endpoints for external clients.
  // Runs alongside the CLI channel so both can be used simultaneously.
  const httpAdapter = new HttpAdapter({
    bus,
    logger,
    pool,
    agentRegistry,
    port: config.httpPort,
    apiToken: config.apiToken,
    agentNames: agentConfigs.map(c => c.name),
    skillNames: skillRegistry.list().map(s => s.manifest.name),
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
    try {
      await httpAdapter.stop();
    } catch (err) {
      logger.error({ err }, 'Error stopping HTTP API during shutdown');
    }
    try {
      await pool.end();
    } catch (err) {
      logger.error({ err }, 'Error closing database pool during shutdown');
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown());

  // 8. CLI channel — the last thing to start, since opening readline
  // immediately prompts for user input. Everything upstream must be
  // fully wired before the user can type their first message.
  // The onExit callback handles both /quit and Ctrl+C.
  const cli = new CliAdapter(bus, logger, () => void shutdown());
  cli.start();

  // Print welcome directly to stdout (logger writes to curia.log in dev mode)
  process.stdout.write('\nCuria is ready. Type a message, /quit to exit, or Ctrl+C.\n\n');
  cli.prompt();
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
