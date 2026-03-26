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
import { createInboundMessage, type OutboundMessageEvent } from '../../src/bus/events.js';
import type { DbPool } from '../../src/db/connection.js';
import type { Logger } from '../../src/logger.js';

export interface CuriaHarness {
  bus: EventBus;
  logger: Logger;
  sendMessage(options: {
    conversationId: string;
    content: string;
    senderId?: string;
    channelId?: string;
  }): Promise<{ content: string; durationMs: number }>;
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
    entityMemory = new EntityMemory(kgStore, validator, embeddingService);
  }

  // Skill registry — loads all skills from the skills/ directory.
  // Resolve relative to this file's location, up to project root, into skills/.
  const skillRegistry = new SkillRegistry();
  const skillsDir = path.resolve(import.meta.dirname, '../../skills');
  await loadSkillsFromDirectory(skillsDir, skillRegistry, logger);

  // Agent registry — tracks all running agents for delegation and listing.
  const agentRegistry = new AgentRegistry();

  // Execution layer — with bus and agent registry for infrastructure skills.
  const executionLayer = new ExecutionLayer(skillRegistry, logger, { bus, agentRegistry });

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
    });
    agent.register();
  }

  // Dispatcher — subscribes to inbound.message + agent.response.
  // Registered after agents so agent.task already has handlers.
  const dispatcher = new Dispatcher({ bus, logger });
  dispatcher.register();

  // -- No HTTP adapter, no CLI adapter, no SIGTERM handler --
  // This harness is headless: the only way to inject messages is sendMessage().

  /**
   * Publish an inbound.message and wait for the corresponding outbound.message.
   *
   * IMPORTANT: bus.subscribe() returns void — there is no unsubscribe mechanism.
   * We use a `resolved` boolean flag inside the handler to ignore events after
   * the first match or timeout. The handler stays registered but becomes a no-op.
   */
  async function sendMessage(options: {
    conversationId: string;
    content: string;
    senderId?: string;
    channelId?: string;
  }): Promise<{ content: string; durationMs: number }> {
    const start = Date.now();

    return new Promise((resolve, reject) => {
      let resolved = false;

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          reject(new Error('Timeout waiting for response (60s)'));
        }
      }, 60_000);

      // Subscribe to outbound.message as the channel layer (matching how
      // real channel adapters receive responses). The handler filters by
      // conversationId so concurrent sendMessage() calls don't cross-talk.
      bus.subscribe('outbound.message', 'channel', (event) => {
        if (resolved) return;
        const outbound = event as OutboundMessageEvent;
        if (outbound.payload.conversationId === options.conversationId) {
          resolved = true;
          clearTimeout(timeout);
          resolve({
            content: outbound.payload.content,
            durationMs: Date.now() - start,
          });
        }
      });

      // Publish the inbound message as the channel layer.
      const inbound = createInboundMessage({
        conversationId: options.conversationId,
        channelId: options.channelId ?? 'smoke-test',
        senderId: options.senderId ?? 'smoke-test-user',
        content: options.content,
      });
      bus.publish('channel', inbound).catch((err) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          reject(err);
        }
      });
    });
  }

  async function shutdown(): Promise<void> {
    await pool.end();
  }

  return { bus, logger, sendMessage, shutdown };
}
