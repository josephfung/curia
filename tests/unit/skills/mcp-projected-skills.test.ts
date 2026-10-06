import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SkillRegistry } from '../../../src/skills/skill-registry.js';
import { ToolRegistry } from '../../../src/skills/registry.js';
import { registerMcpProjectedSkills } from '../../../src/skills/mcp-loader.js';
import { registerSyntheticSingletonSkills } from '../../../src/skills/skill-loader.js';
import { resolvePinnedSkills } from '../../../src/skills/pin-resolution.js';
import type { ToolContext, ToolManifest } from '../../../src/skills/types.js';
import skillActivate from '../../../skills/skill-activate/handler.js';

const noopHandler = { execute: async () => ({ success: true as const, data: {} }) };

const REPO_SKILLS_DIR = path.resolve(import.meta.dirname, '../../../skills');

function silentLogger(): import('../../../src/logger.js').Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  } as unknown as import('../../../src/logger.js').Logger;
}

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

    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    } as unknown as import('../../../src/logger.js').Logger;
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

  // #1960: upstream MCP tool descriptions are not ours to edit, so their how-to notes
  // live in skills/<server>/references/ and load on demand through skill-activate.
  describe('on-disk references', () => {
    function project(skillsDir?: string): { skills: SkillRegistry; tools: ToolRegistry } {
      const skills = new SkillRegistry();
      const tools = new ToolRegistry();
      tools.register(toolManifest('update_drive_file'), noopHandler);
      tools.register(toolManifest('create_drive_file'), noopHandler);
      registerMcpProjectedSkills(
        new Map([['google-workspace', ['update_drive_file', 'create_drive_file']]]),
        skills,
        silentLogger(),
        skillsDir,
      );
      return { skills, tools };
    }

    it('attaches the repo google-workspace references to the projected skill', () => {
      const { skills } = project(REPO_SKILLS_DIR);
      const gw = skills.get('google-workspace');
      expect(gw?.dir).toBe(path.join(REPO_SKILLS_DIR, 'google-workspace'));
      expect(gw?.manifest.references).toEqual(['drive-files.md']);
      // Membership still comes from tools/list, not the directory.
      expect(gw?.manifest.tools).toEqual(['update_drive_file', 'create_drive_file']);
    });

    it('lists the reference in the pinned skill block so the agent knows it exists', () => {
      const { skills, tools } = project(REPO_SKILLS_DIR);
      const r = resolvePinnedSkills(['google-workspace'], skills, tools);
      const block = r.instructionBlocks.join('\n');
      expect(block).toContain('skill-activate({ skill: "google-workspace", reference: "<path>" })');
      expect(block).toContain('- drive-files.md');
    });

    it('loads drive-files.md through skill-activate', async () => {
      const { skills, tools } = project(REPO_SKILLS_DIR);
      const result = await skillActivate.execute({
        input: { skill: 'google-workspace', reference: 'drive-files.md' },
        toolName: 'skill-activate',
        toolVersion: '0.1.1',
        agentId: 'coordinator',
        skillRegistry: skills,
        toolRegistry: tools,
        log: silentLogger(),
        secret: () => { throw new Error('no secrets'); },
      } as unknown as ToolContext);

      expect(result.success).toBe(true);
      if (!result.success) return;
      const data = result.data as {
        skill: string;
        referenceContent?: { path: string; content: string; truncated: boolean };
      };
      expect(data.skill).toBe('google-workspace');
      expect(data.referenceContent?.path).toBe('references/drive-files.md');
      expect(data.referenceContent?.truncated).toBe(false);
      // The mechanics that moved out of the coordinator prompt.
      expect(data.referenceContent?.content).toContain('add_parents');
      expect(data.referenceContent?.content).toContain('fileUrl');
      expect(data.referenceContent?.content).toContain('export_items');
    });

    it('registers with no directory when the server has none on disk', () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-refs-'));
      try {
        const { skills } = project(tmp);
        const gw = skills.get('google-workspace');
        expect(gw?.dir).toBe('');
        expect(gw?.manifest.references).toBeUndefined();
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
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
    const warn = vi.fn();
    const logger = {
      info: vi.fn(),
      warn,
      debug: vi.fn(),
      error: vi.fn(),
    } as unknown as import('../../../src/logger.js').Logger;
    const added = registerMcpProjectedSkills(
      new Map([['google-workspace', ['create_doc']]]),
      skills,
      logger,
    );
    expect(added).toBe(0);
    expect(warn).toHaveBeenCalled();
  });
});
