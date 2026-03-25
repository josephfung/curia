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

import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createPool } from './db/connection.js';
import { EventBus } from './bus/bus.js';
import { AuditLogger } from './audit/logger.js';
import { AnthropicProvider } from './agents/llm/anthropic.js';
import { AgentRuntime } from './agents/runtime.js';
import { Dispatcher } from './dispatch/dispatcher.js';
import { CliAdapter } from './channels/cli/cli-adapter.js';

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

  // 6. Coordinator agent — subscribes to agent.task, publishes agent.response.
  // Must register before the dispatcher so there is a handler for agent.task
  // by the time the first inbound.message is converted.
  // TODO: Load system prompt from agents/coordinator.yaml instead of
  // hardcoding here; requires a yaml-parsing step at startup.
  const coordinator = new AgentRuntime({
    agentId: 'coordinator',
    systemPrompt: `You are Curia, an AI executive assistant. You are professional,
concise, and helpful. You handle all communications on behalf of the CEO.
For casual messages, respond naturally and warmly.
For tasks, acknowledge the request and describe what you would do.
Keep responses concise — a few sentences unless detail is requested.`,
    provider: llmProvider,
    bus,
    logger,
  });
  coordinator.register();

  // 7. Dispatcher — subscribes to inbound.message + agent.response.
  // Registered after the coordinator so agent.task already has a handler
  // when the dispatcher fans the first inbound message out.
  const dispatcher = new Dispatcher({ bus, logger });
  dispatcher.register();

  // 9. Graceful shutdown — stop accepting new input first, let any in-flight
  // async bus deliveries drain (they are awaited inside bus.publish), then
  // close the DB pool so Postgres cleans up server-side connections cleanly.
  const shutdown = async () => {
    logger.info('Shutting down...');
    await pool.end();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown());

  // 8. CLI channel — the last thing to start, since opening readline
  // immediately prompts for user input. Everything upstream must be
  // fully wired before the user can type their first message.
  // The onExit callback handles both /quit and Ctrl+C.
  const cli = new CliAdapter(bus, logger, () => void shutdown());
  cli.start();

  // Print a clean welcome after all the startup logs have settled
  setTimeout(() => {
    process.stdout.write('\nCuria is ready. Type a message or /quit to exit.\n\n');
    cli.prompt();
  }, 100);
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
