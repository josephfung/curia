// google-workspace-wake-reload.test.ts — a task that activated google-workspace gets
// it back when it wakes (#2024).
//
// The coordinator no longer pins google-workspace; a task activates it with
// skill-activate, which records it in progress.activeSkills. On a scheduler wake the
// runtime re-loads active skills, but skips pinned ones (they are already eager). This
// checks the whole chain with the real pieces: the coordinator's real pin list, the
// skill projected from the production tools/list snapshot, and production's
// activation check in the ExecutionLayer.
import { describe, it, expect, vi } from 'vitest';
import { resolve } from 'node:path';
import { AgentRuntime } from '../../../src/agents/runtime.js';
import { loadAgentConfig } from '../../../src/agents/loader.js';
import type { LLMProvider } from '../../../src/agents/llm/provider.js';
import { EventBus } from '../../../src/bus/bus.js';
import { createAgentTask } from '../../../src/bus/events.js';
import { createLogger } from '../../../src/logger.js';
import { ExecutionLayer } from '../../../src/skills/execution.js';
import { ToolRegistry } from '../../../src/skills/registry.js';
import { SkillRegistry } from '../../../src/skills/skill-registry.js';
import { registerSnapshotMcpServers } from '../../../src/startup/test-mode-mcp.js';

const REPO = resolve(import.meta.dirname, '../../..');

describe('coordinator wake re-loads an activated google-workspace (#2024)', () => {
  it('restores the Drive/Docs tools and the skill block from progress.activeSkills', async () => {
    const logger = createLogger('error');
    const bus = new EventBus(logger);
    bus.subscribe('agent.response', 'dispatch', () => {});

    const toolRegistry = new ToolRegistry();
    const skillRegistry = new SkillRegistry();
    registerSnapshotMcpServers({
      configDir: resolve(REPO, 'config'),
      snapshotDir: resolve(REPO, 'tests', 'fixtures', 'mcp'),
      toolRegistry,
      skillRegistry,
      skillsDir: resolve(REPO, 'skills'),
      logger,
    });
    const executionLayer = new ExecutionLayer(toolRegistry, logger, { skillRegistry });

    // The real pin list: if google-workspace were pinned, the wake path would skip it.
    const pinnedSkillNames = loadAgentConfig(resolve(REPO, 'agents', 'coordinator.yaml')).pinned_skills ?? [];
    expect(pinnedSkillNames).not.toContain('google-workspace');

    const taskId = '33333333-3333-4333-8333-333333333333';
    const activeSkills = { skills: [{ name: 'google-workspace', activatedAt: '2026-10-06T12:00:00.000Z' }] };
    const taskRepo = {
      getTask: vi.fn().mockResolvedValue({ id: taskId, status: 'open', progress: { activeSkills } }),
      setActiveSkillsBlock: vi.fn(),
    };

    const firstCall: { tools: string[]; system: string[] } = { tools: [], system: [] };
    const provider: LLMProvider = {
      id: 'mock',
      chat: async (params) => {
        if (firstCall.tools.length === 0) {
          firstCall.tools = params.tools?.map((t) => t.name) ?? [];
          firstCall.system = (params.messages as Array<{ role: string; content: unknown }>)
            .filter((m) => m.role === 'system' && typeof m.content === 'string')
            .map((m) => m.content as string);
        }
        return {
          type: 'text' as const,
          content: 'Checked.',
          usage: { inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
          provenance: { requestedModel: 'mock-model', actualModel: 'mock-model', providerRequestId: 'msg_mock' },
        };
      },
    };

    new AgentRuntime({
      agentId: 'coordinator',
      systemPrompt: 'You are an assistant.',
      provider,
      resolvedModel: 'mock-model',
      bus,
      logger,
      executionLayer,
      skillToolDefs: executionLayer.getToolDefinitions([]),
      skillRegistry,
      pinnedSkillNames,
      taskRepo: taskRepo as never,
    }).register();

    await bus.publish('system', createAgentTask({
      agentId: 'coordinator',
      conversationId: `scheduler:job-1:run-1`,
      channelId: 'scheduler',
      senderId: 'scheduler',
      content: JSON.stringify({ task_id: taskId, task_payload: { task: 'Check the board memo is shared with the principal' } }),
      intentAnchor: 'Make sure the principal can edit the Q3 board memo in Drive.',
      metadata: { boundTask: { taskId, progress: { activeSkills } } },
      parentEventId: 'parent-wake-gw',
    }));

    expect(firstCall.tools).toEqual(expect.arrayContaining(['update_drive_file', 'manage_drive_access', 'get_doc_as_markdown']));
    expect(firstCall.system.some((s) => s.includes('[Activated skill: google-workspace]'))).toBe(true);
    // Same set as stored, so the wake does not rewrite progress (#1410).
    expect(taskRepo.setActiveSkillsBlock).not.toHaveBeenCalled();
  });
});
