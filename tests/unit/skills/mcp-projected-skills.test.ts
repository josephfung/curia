import { describe, it, expect, vi } from 'vitest';
import { SkillRegistry } from '../../../src/skills/skill-registry.js';
import { ToolRegistry } from '../../../src/skills/registry.js';
import { registerMcpProjectedSkills } from '../../../src/skills/mcp-loader.js';
import { registerSyntheticSingletonSkills } from '../../../src/skills/skill-loader.js';
import { resolvePinnedSkills } from '../../../src/skills/pin-resolution.js';
import type { ToolManifest } from '../../../src/skills/types.js';

const noopHandler = { execute: async () => ({ success: true as const, data: {} }) };

function toolManifest(name: string): ToolManifest {
  return {
    name,
    description: `Tool ${name}`,
    version: '1.0.0',
    action_risk: 'low',
    sensitivity: 'normal',
    permissions: [],
    secrets: [],
    timeout: 30000,
    inputs: {},
    outputs: {},
  };
}

describe('registerMcpProjectedSkills (ADR-032)', () => {
  it('projects each MCP server as a non-synthetic skill with live membership', () => {
    const skills = new SkillRegistry();
    const tools = new ToolRegistry();
    tools.register(toolManifest('create_doc'), noopHandler);
    tools.register(toolManifest('search_drive_files'), noopHandler);

    const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } as never;
    const projected = new Map<string, string[]>([
      ['google-workspace', ['create_doc', 'search_drive_files']],
      ['atproto-mcp', ['create_post']],
    ]);
    // atproto tool not loaded — pin resolution will skip missing members
    const added = registerMcpProjectedSkills(projected, skills, logger);
    expect(added).toBe(2);

    const gw = skills.get('google-workspace');
    expect(gw?.synthetic).toBeUndefined();
    expect(gw?.manifest.tools).toEqual(['create_doc', 'search_drive_files']);

    // Synthetic singletons must not wrap tools owned by the projected skill.
    registerSyntheticSingletonSkills(tools, skills);
    expect(skills.get('create_doc')).toBeUndefined();
    expect(skills.toolOwner('create_doc')?.manifest.name).toBe('google-workspace');

    const r = resolvePinnedSkills(['google-workspace'], skills, tools);
    expect(r.toolNames).toEqual(['create_doc', 'search_drive_files']);
  });

  it('skips projection when a skill name is already taken', () => {
    const skills = new SkillRegistry();
    skills.register(
      {
        name: 'google-workspace',
        description: 'native collision',
        tools: [],
        instructions: '',
      },
      '/tmp/gw',
    );
    const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } as never;
    const added = registerMcpProjectedSkills(
      new Map([['google-workspace', ['create_doc']]]),
      skills,
      logger,
    );
    expect(added).toBe(0);
    expect(logger.warn).toHaveBeenCalled();
  });
});
