// tests/smoke/harness.ts
//
// Headless bus stack harness for smoke tests. Boots the real Curia bus stack
// (same components as src/index.ts) but WITHOUT the HTTP and CLI channels.
// Provides a sendMessage() method that publishes inbound.message events and
// waits for outbound.message responses.

import * as path from 'node:path';
import { loadConfig } from '../../src/config.js';
import { createLogger } from '../../src/logger.js';
import { createPool } from '../../src/db/connection.js';
import { EventBus } from '../../src/bus/bus.js';
import { AuditLogger } from '../../src/audit/logger.js';
import { AnthropicProvider } from '../../src/agents/llm/anthropic.js';
import { AgentRuntime } from '../../src/agents/runtime.js';
import { Dispatcher } from '../../src/dispatch/dispatcher.js';
import { loadAllAgentConfigs, interpolateRuntimeContext } from '../../src/agents/loader.js';
import { AgentRegistry } from '../../src/agents/agent-registry.js';
import { WorkingMemory } from '../../src/memory/working-memory.js';
import { EmbeddingService } from '../../src/memory/embedding.js';
import { KnowledgeGraphStore } from '../../src/memory/knowledge-graph.js';
import { MemoryValidator } from '../../src/memory/validation.js';
import { EntityMemory } from '../../src/memory/entity-memory.js';
import { SkillRegistry } from '../../src/skills/registry.js';
import { ExecutionLayer } from '../../src/skills/execution.js';
import { loadSkillsFromDirectory } from '../../src/skills/loader.js';
import { ContactService } from '../../src/contacts/contact-service.js';
import { ContactResolver } from '../../src/contacts/contact-resolver.js';
import { NylasClient } from '../../src/channels/email/nylas-client.js';
import { OutboundContentFilter } from '../../src/dispatch/outbound-filter.js';
import { OutboundGateway } from '../../src/skills/outbound-gateway.js';
import { createInboundMessage, type OutboundMessageEvent } from '../../src/bus/events.js';
import type { Logger } from '../../src/logger.js';

// How long each sendMessage() call waits for an outbound.message response.
// Agentic flows that invoke multiple skills (contact lookup → KG search →
// calendar check) can legitimately take 60-90s. Default is 120s, tunable
// via SMOKE_TIMEOUT_MS without code changes.
export const RESPONSE_TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? '120000');

export interface CuriaHarness {
  bus: EventBus;
  logger: Logger;
  /**
   * Send a single user message and wait for the outbound response.
   * Rejects if no response arrives within RESPONSE_TIMEOUT_MS.
   */
  sendMessage(options: {
    conversationId: string;
    content: string;
    senderId?: string;
    channelId?: string;
  }): Promise<{ content: string; durationMs: number }>;
  /**
   * Send a no-op warm-up message to absorb cold-start latency (DB pool
   * warm-up, first LLM API round-trip) before real test cases run.
   * The response is discarded — we only care that the stack is primed.
   */
  warmUp(): Promise<void>;
  shutdown(): Promise<void>;
}

export async function createHarness(): Promise<CuriaHarness> {
  // 1. Config & logging — suppress non-error output during tests.
  const config = loadConfig();
  const logger = createLogger('error');

  // 2. Database — same probe as src/index.ts to catch misconfigured URLs early.
  const pool = createPool(config.databaseUrl, logger);
  await pool.query('SELECT 1');

  // 3. Audit logger — must be ready before the bus starts accepting events.
  const auditLogger = new AuditLogger(pool, logger);

  // 4. Message bus — write-ahead hook ensures every event is durably recorded.
  const bus = new EventBus(logger, (event) => auditLogger.log(event));

  // 5. LLM provider — smoke tests require a real API key since they exercise
  //    the full agent stack end-to-end.
  if (!config.anthropicApiKey) throw new Error('ANTHROPIC_API_KEY required for smoke tests');
  const llmProvider = new AnthropicProvider(config.anthropicApiKey, logger);

  // Working memory — Postgres-backed, same as production.
  const memory = WorkingMemory.createWithPostgres(pool, logger);

  // Entity memory — optional, same as src/index.ts. Agents still work without it.
  let entityMemory: EntityMemory | undefined;
  if (config.openaiApiKey) {
    const embeddingService = EmbeddingService.createWithOpenAI(config.openaiApiKey, logger);
    const kgStore = KnowledgeGraphStore.createWithPostgres(pool, embeddingService, logger);
    const validator = new MemoryValidator(kgStore, embeddingService);
    entityMemory = new EntityMemory(kgStore, validator, embeddingService, logger);
  }

  // Contact system — provides identity resolution and contact management.
  // Always initialized (contacts work even without entity memory / KG).
  const contactService = ContactService.createWithPostgres(pool, entityMemory, logger);
  const contactResolver = new ContactResolver(contactService, entityMemory, undefined, logger);

  // Skill registry — loads all skills from the skills/ directory.
  // Resolve relative to this file's location, up to project root, into skills/.
  const skillRegistry = new SkillRegistry();
  const skillsDir = path.resolve(import.meta.dirname, '../../skills');
  await loadSkillsFromDirectory(skillsDir, skillRegistry, logger);

  // Agent registry — tracks all running agents for delegation and listing.
  const agentRegistry = new AgentRegistry();

  // Nylas clients — optional, same as src/index.ts. EmailAdapter is intentionally
  // skipped here: smoke tests should not start polling for real emails during runs.
  // The nylasClientMap is used to construct an OutboundGateway so email skills can
  // be invoked if a smoke test explicitly exercises email-send or email-reply.
  // Keyed by grantId, mirroring how src/index.ts builds its nylasClientMap.
  const nylasClientMap = new Map<string, NylasClient>();
  if (config.nylasApiKey && config.nylasGrantId) {
    // Key must match the backward-compat account name from resolveChannelAccounts
    // (which resolves to 'curia', not the raw grant ID). Skills pass a logical
    // account name as accountId when targeting a specific account; the primary-client
    // path (no accountId) uses the first map entry regardless of key.
    nylasClientMap.set('curia', new NylasClient(config.nylasApiKey, config.nylasGrantId, logger));
  }

  // Outbound gateway — wraps nylasClients with contact-blocked checks and content
  // filtering. Constructed here (without Nylas credentials) using an empty content
  // filter so smoke tests that don't exercise email sending don't crash.
  // When Nylas credentials ARE present the gateway is fully functional.
  //
  // OutboundContentFilter with empty markers is safe for smoke testing:
  // no real markers → the system-prompt-fragment rule simply never fires.
  const contentFilter = new OutboundContentFilter({
    systemPromptMarkers: [],
    ceoEmail: config.nylasSelfEmail ?? '',
  });
  let outboundGateway: OutboundGateway | undefined;
  if (nylasClientMap.size > 0 && config.nylasSelfEmail) {
    outboundGateway = new OutboundGateway({
      nylasClients: nylasClientMap,
      contactService,
      contentFilter,
      bus,
      ceoEmail: config.nylasSelfEmail,
      logger,
    });
  }

  // Execution layer — with bus, agent registry, and outbound gateway for
  // infrastructure skills. outboundGateway passed through so email skills
  // work in tests that exercise them.
  const executionLayer = new ExecutionLayer(skillRegistry, logger, { bus, agentRegistry, contactService, outboundGateway, heldMessages: undefined });

  // Load all agent configs from the agents/ directory.
  const agentsDir = path.resolve(import.meta.dirname, '../../agents');
  const agentConfigs = loadAllAgentConfigs(agentsDir);

  // Two-pass agent registration (same as src/index.ts):
  // Pass 1: Populate registry so specialistSummary() is complete before
  //         the coordinator's system prompt is interpolated.
  for (const agentConfig of agentConfigs) {
    agentRegistry.register(agentConfig.name, {
      role: agentConfig.role ?? 'specialist',
      description: agentConfig.description ?? agentConfig.name,
    });
  }

  // Pass 2: Create AgentRuntime instances with fully interpolated prompts.
  for (const agentConfig of agentConfigs) {
    const agentPinnedSkills = agentConfig.pinned_skills ?? [];
    const agentToolDefs = skillRegistry.toToolDefinitions(agentPinnedSkills);

    let systemPrompt = agentConfig.system_prompt;
    if (agentConfig.role === 'coordinator') {
      // currentDate and timezone are no longer baked in here — AgentRuntime injects
      // them fresh on every task turn via the timezone option below, keeping them
      // current for long-running smoke runs. See src/index.ts pass-2 comment.
      systemPrompt = interpolateRuntimeContext(systemPrompt, {
        availableSpecialists: agentRegistry.specialistSummary(),
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
      // Coordinator gets per-turn date/timezone injection so the agent always
      // has a current date (replacing the old baked-in currentDate approach).
      timezone: agentConfig.role === 'coordinator' ? config.timezone : undefined,
    });
    agent.register();
  }

  // Dispatcher — subscribes to inbound.message + agent.response.
  // Registered after agents so agent.task already has handlers.
  const dispatcher = new Dispatcher({ bus, logger, contactResolver, heldMessages: undefined, channelPolicies: undefined });
  dispatcher.register();

  // -- No HTTP adapter, no CLI adapter, no SIGTERM handler --
  // This harness is headless: the only way to inject messages is sendMessage().

  // Single persistent listener for outbound messages. Uses a Map to dispatch
  // responses to the correct sendMessage() caller by conversationId.
  // This avoids accumulating dead handlers (bus.subscribe returns void —
  // there is no unsubscribe mechanism).
  const pendingResponses = new Map<string, {
    resolve: (value: { content: string; durationMs: number }) => void;
    reject: (reason: Error) => void;
    start: number;
    timeout: ReturnType<typeof setTimeout>;
  }>();

  bus.subscribe('outbound.message', 'channel', (event) => {
    const outbound = event as OutboundMessageEvent;
    const pending = pendingResponses.get(outbound.payload.conversationId);
    if (pending) {
      pendingResponses.delete(outbound.payload.conversationId);
      clearTimeout(pending.timeout);
      pending.resolve({
        content: outbound.payload.content,
        durationMs: Date.now() - pending.start,
      });
    }
  });

  async function sendMessage(options: {
    conversationId: string;
    content: string;
    senderId?: string;
    channelId?: string;
  }): Promise<{ content: string; durationMs: number }> {
    return new Promise((resolve, reject) => {
      const start = Date.now();

      const timeoutSec = Math.round(RESPONSE_TIMEOUT_MS / 1000);
      const timeout = setTimeout(() => {
        if (pendingResponses.has(options.conversationId)) {
          pendingResponses.delete(options.conversationId);
          reject(new Error(`Timeout waiting for response (${timeoutSec}s)`));
        }
      }, RESPONSE_TIMEOUT_MS);

      pendingResponses.set(options.conversationId, { resolve, reject, start, timeout });

      // Publish the inbound message
      try {
        const inbound = createInboundMessage({
          conversationId: options.conversationId,
          channelId: options.channelId ?? 'smoke-test',
          senderId: options.senderId ?? 'smoke-test-user',
          content: options.content,
        });
        bus.publish('channel', inbound).catch((err) => {
          if (pendingResponses.has(options.conversationId)) {
            pendingResponses.delete(options.conversationId);
            clearTimeout(timeout);
            reject(err);
          }
        });
      } catch (err) {
        if (pendingResponses.has(options.conversationId)) {
          pendingResponses.delete(options.conversationId);
          clearTimeout(timeout);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      }
    });
  }

  async function warmUp(): Promise<void> {
    // Send a throwaway message to absorb cold-start latency: DB connection pool
    // warm-up, first Anthropic API round-trip, skill registry init, etc.
    // Failures are swallowed — if the stack is broken, real test cases will
    // surface it with clearer context.
    try {
      await sendMessage({
        conversationId: `smoke-warmup-${Date.now()}`,
        content: 'hello',
      });
    } catch {
      // intentionally ignored — warm-up is best-effort
    }
  }

  async function shutdown(): Promise<void> {
    await pool.end();
  }

  return { bus, logger, sendMessage, warmUp, shutdown };
}
