// Voice's own tool list (#1968). Spoken turns used to carry the coordinator's 73
// tool definitions; these tests keep the list a small, real, curated subset.

import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { VOICE_TOOL_NAMES } from '../../../../src/channels/voice/voice-tools.js';
import { measureAgentContext } from '../../../../src/agents/prompt-budget.js';
import { discoverToolManifests } from '../../../../src/skills/loader.js';
import { ToolRegistry } from '../../../../src/skills/registry.js';
import { createLogger } from '../../../../src/logger.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../../..');
const SKILLS_DIR = resolve(REPO_ROOT, 'skills');
const SOURCES = {
  agentsDir: resolve(REPO_ROOT, 'agents'),
  skillsDir: SKILLS_DIR,
  configDir: resolve(REPO_ROOT, 'config'),
};

/**
 * Measured 12,686 bytes over 9 tools when the list was set (#1968), against the
 * coordinator's 81,624 over 73. Small headroom for description edits; a new tool needs
 * the evidence voice-tools.ts asks for, and a raise here.
 */
const VOICE_TOOL_DEFINITION_BYTES_BUDGET = 13_000;

function catalog(): ToolRegistry {
  const registry = new ToolRegistry('America/Toronto');
  const noop = { execute: async () => ({ success: true as const, data: {} }) };
  for (const disc of discoverToolManifests(SKILLS_DIR, createLogger('silent'))) {
    if (disc.manifest) registry.register(disc.manifest, noop);
  }
  return registry;
}

describe('VOICE_TOOL_NAMES', () => {
  const registry = catalog();

  it('names only tools that exist in the catalog', () => {
    const missing = VOICE_TOOL_NAMES.filter(name => !registry.get(name));
    expect(missing).toEqual([]);
  });

  it('has no duplicates', () => {
    expect(new Set(VOICE_TOOL_NAMES).size).toBe(VOICE_TOOL_NAMES.length);
  });

  it('carries what a live call needs within the round cap', () => {
    expect(VOICE_TOOL_NAMES).toEqual(expect.arrayContaining(['delegate', 'date-resolve', 'async-offramp']));
  });

  it('leaves out the discovery tools, which a fixed per-turn tool list cannot honor', () => {
    expect(VOICE_TOOL_NAMES).not.toContain('tool-registry');
    expect(VOICE_TOOL_NAMES).not.toContain('skill-activate');
  });

  it('is a subset of what the coordinator can do, plus the voice-only off-ramp', () => {
    const coordinatorTools = new Set(measureAgentContext('coordinator', SOURCES).localToolNames);
    // async-offramp hands work TO the coordinator, so the coordinator must not carry it.
    expect(coordinatorTools.has('async-offramp')).toBe(false);
    const beyondCoordinator = VOICE_TOOL_NAMES.filter(name => name !== 'async-offramp' && !coordinatorTools.has(name));
    expect(beyondCoordinator).toEqual([]);
  });

  it(`keeps the tool definitions under ${VOICE_TOOL_DEFINITION_BYTES_BUDGET} bytes`, () => {
    const bytes = registry
      .toToolDefinitions([...VOICE_TOOL_NAMES])
      .reduce((sum, def) => sum + Buffer.byteLength(JSON.stringify(def), 'utf8'), 0);
    expect(bytes).toBeLessThanOrEqual(VOICE_TOOL_DEFINITION_BYTES_BUDGET);
  });
});
