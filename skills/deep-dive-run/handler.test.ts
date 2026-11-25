import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import * as yaml from 'js-yaml';
import pino from 'pino';
import { DeepDiveRunHandler } from './handler.js';
import { loadRegistryDefaults } from '../../src/registry/reconcile.js';
import { SkillRegistry } from '../../src/skills/skill-registry.js';
import { ToolRegistry } from '../../src/skills/registry.js';
import { unifiedToolSearch } from '../../src/skills/skill-activation.js';
import type { ToolContext, ToolManifest } from '../../src/skills/types.js';
import type { StartResult } from '../../src/onboarding/deep-dive/service.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const logger = pino({ level: 'silent' });

function run(result: StartResult) {
  const deepDiveService = { startOnce: vi.fn(async () => result) };
  const out = new DeepDiveRunHandler().execute({ input: {}, log: logger, deepDiveService } as unknown as ToolContext);
  return { out, deepDiveService };
}

describe('deep-dive-run', () => {
  it('starts a forced re-run', async () => {
    const { out, deepDiveService } = run({ started: true });
    const result = await out;
    expect(deepDiveService.startOnce).toHaveBeenCalledWith({ force: true });
    expect(result).toEqual({ success: true, data: { started: true } });
  });

  it('refuses a re-run while running', async () => {
    const result = await run({ started: false, reason: 'running' }).out;
    expect(result.success).toBe(false);
    expect(!result.success && result.error).toMatch(/already running/);
  });

  it('says a mailbox must be connected first', async () => {
    const result = await run({ started: false, reason: 'no_mailbox' }).out;
    expect(!result.success && result.error).toMatch(/mailbox/);
  });

  it('is reached by the coordinator through discovery, not pinned', () => {
    const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, 'skills/deep-dive-run/tool.json'), 'utf8')) as ToolManifest;
    const tools = new ToolRegistry();
    tools.register(manifest, { execute: async () => ({ success: true as const, data: {} }) });
    const hits = unifiedToolSearch({ query: 'deep dive', toolRegistry: tools, skillRegistry: new SkillRegistry(), agentId: 'coordinator' });
    expect(hits.map((h) => h.name)).toContain('deep-dive-run');
    expect(loadRegistryDefaults(path.join(REPO_ROOT, 'config/registry-defaults.yaml')).tools).toContain('deep-dive-run');
    const pins = (yaml.load(readFileSync(path.join(REPO_ROOT, 'agents/coordinator.yaml'), 'utf8')) as { pinned_skills?: string[] }).pinned_skills ?? [];
    expect(pins).not.toContain('deep-dive-run');
  });
});
