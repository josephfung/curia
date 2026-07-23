// Phase 3 (#1490) — imported NL + asset skills (Anthropic Agent Skill format).
// Fixture modelled on https://github.com/maxtremaine/ai-playbook/tree/main/skills/not-a-lawyer

import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverSkillManifests, loadSkillsFromDiscovery } from '../../../src/skills/skill-loader.js';
import { SkillRegistry } from '../../../src/skills/skill-registry.js';
import { ToolRegistry } from '../../../src/skills/registry.js';
import type { ToolManifest } from '../../../src/skills/types.js';
import {
  resolveSkillActivation,
  unifiedToolSearch,
  formatActivatedSkillInstructionBlock,
  formatSkillReferenceBlock,
  buildSkillActivationProtocol,
  buildSkillActivationAck,
  parseSkillActivationProtocol,
  selectActiveSkillsForWake,
} from '../../../src/skills/skill-activation.js';
import {
  discoverSkillResources,
  readSkillResource,
  SKILL_RESOURCE_MAX_BYTES,
} from '../../../src/skills/skill-resources.js';
import { activateSkillInBlock } from '../../../src/db/active-skills-progress.js';
import { parseSkillMd } from '../../../src/skills/skill-md.js';

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../fixtures/imported-skills',
);
const NOT_A_LAWYER = path.join(FIXTURES, 'not-a-lawyer');

function silentLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  };
}

function toolManifest(name: string, opts: { allowed_callers?: string[] } = {}): ToolManifest {
  return {
    name,
    description: `Tool ${name}`,
    version: '0.1.0',
    action_risk: 'none',
    sensitivity: 'normal',
    permissions: [],
    secrets: [],
    timeout: 30000,
    inputs: {},
    outputs: {},
    allowed_callers: opts.allowed_callers,
  };
}

const noopHandler = { execute: async () => ({ success: true as const, data: {} }) };

describe('imported Anthropic SKILL.md (not-a-lawyer fixture)', () => {
  it('parses unmodified Anthropic frontmatter (nested metadata ignored)', () => {
    const raw = fs.readFileSync(path.join(NOT_A_LAWYER, 'SKILL.md'), 'utf-8');
    const parsed = parseSkillMd(raw, 'not-a-lawyer/SKILL.md');
    expect(parsed.name).toBe('not-a-lawyer');
    expect(parsed.description).toMatch(/legal agreements/i);
    expect(parsed.tools).toBeUndefined();
    expect(parsed.instructions).toContain('Not a Lawyer');
    expect(parsed.instructions).toContain('references/common-clauses.md');
  });

  it('discovers references + scripts without requiring tool.json', () => {
    const logger = silentLogger();
    const discoveries = discoverSkillManifests(FIXTURES, logger as never);
    const nal = discoveries.find((d) => d.name === 'not-a-lawyer');
    expect(nal?.metadata).not.toBeNull();
    expect(nal?.manifest?.tools).toEqual([]);
    expect(nal?.manifest?.references).toEqual([
      'common-clauses.md',
      'drafting-comments.md',
    ]);
    expect(nal?.manifest?.hasScripts).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ skill: 'not-a-lawyer' }),
      expect.stringContaining('scripts are NOT executed'),
    );
  });

  it('loads an instruction-only imported skill into SkillRegistry', () => {
    const logger = silentLogger();
    const discoveries = discoverSkillManifests(FIXTURES, logger as never);
    const registry = new SkillRegistry();
    const count = loadSkillsFromDiscovery(
      discoveries,
      registry,
      logger as never,
      new Set(['not-a-lawyer']),
    );
    expect(count).toBe(1);
    const skill = registry.get('not-a-lawyer');
    expect(skill).toBeDefined();
    expect(skill!.manifest.tools).toEqual([]);
    expect(skill!.manifest.references).toHaveLength(2);
    expect(skill!.synthetic).toBeUndefined();
  });
});

describe('discoverSkillResources / readSkillResource', () => {
  it('lists references and detects scripts/', () => {
    const lists = discoverSkillResources(NOT_A_LAWYER);
    expect(lists.references).toContain('common-clauses.md');
    expect(lists.assets).toEqual([]);
    expect(lists.hasScripts).toBe(true);
  });

  it('reads a reference by bare name and by references/ prefix', () => {
    const lists = discoverSkillResources(NOT_A_LAWYER);
    const bare = readSkillResource(NOT_A_LAWYER, 'common-clauses.md', lists);
    expect(bare.ok).toBe(true);
    if (!bare.ok) return;
    expect(bare.path).toBe('references/common-clauses.md');
    expect(bare.content).toContain('Limitation of liability');

    const prefixed = readSkillResource(NOT_A_LAWYER, 'references/drafting-comments.md', lists);
    expect(prefixed.ok).toBe(true);
    if (!prefixed.ok) return;
    expect(prefixed.content).toContain('collegial-but-firm');
  });

  it('rejects path traversal and unknown paths', () => {
    const lists = discoverSkillResources(NOT_A_LAWYER);
    expect(readSkillResource(NOT_A_LAWYER, '../SKILL.md', lists).ok).toBe(false);
    expect(readSkillResource(NOT_A_LAWYER, 'references/../../SKILL.md', lists).ok).toBe(false);
    expect(readSkillResource(NOT_A_LAWYER, 'missing.md', lists).ok).toBe(false);
  });

  it('rejects symlink escape outside the skill directory', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-skill-parent-'));
    const tmp = path.join(parent, 'skill');
    const outside = path.join(parent, 'outside-secret.txt');
    try {
      fs.mkdirSync(path.join(tmp, 'references'), { recursive: true });
      fs.writeFileSync(outside, 'secret');
      fs.symlinkSync(outside, path.join(tmp, 'references', 'leak.md'));
      const lists = { references: ['leak.md'], assets: [] as string[] };
      const result = readSkillResource(tmp, 'leak.md', lists);
      // realpath of leak.md resolves to parent/outside-secret.txt → rejected
      expect(result.ok).toBe(false);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it('truncates oversized reference content', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-skill-big-'));
    try {
      fs.mkdirSync(path.join(tmp, 'references'));
      const big = 'x'.repeat(SKILL_RESOURCE_MAX_BYTES + 100);
      fs.writeFileSync(path.join(tmp, 'references', 'big.md'), big);
      const lists = { references: ['big.md'], assets: [] as string[] };
      const result = readSkillResource(tmp, 'big.md', lists);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.truncated).toBe(true);
      expect(result.content.length).toBe(SKILL_RESOURCE_MAX_BYTES);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // path.extname('.env.example') is '.example', so extension-based detection alone
  // would reject it as non-text. It must be matched by basename instead (#1505).
  it('loads .env.example as a text asset', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-skill-env-'));
    try {
      fs.mkdirSync(path.join(tmp, 'assets'));
      fs.writeFileSync(path.join(tmp, 'assets', '.env.example'), 'API_KEY=changeme\n');
      const lists = { references: [] as string[], assets: ['.env.example'] };
      const result = readSkillResource(tmp, 'assets/.env.example', lists);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.content).toContain('API_KEY=changeme');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('rejects a binary asset (non-text extension)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-skill-bin-'));
    try {
      fs.mkdirSync(path.join(tmp, 'assets'));
      fs.writeFileSync(path.join(tmp, 'assets', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      const lists = { references: [] as string[], assets: ['logo.png'] };
      const result = readSkillResource(tmp, 'assets/logo.png', lists);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatch(/not a text file/i);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('activation of imported skills — authority containment', () => {
  function loadImported() {
    const logger = silentLogger();
    const discoveries = discoverSkillManifests(FIXTURES, logger as never);
    const skills = new SkillRegistry();
    loadSkillsFromDiscovery(
      discoveries,
      skills,
      logger as never,
      new Set(['not-a-lawyer']),
    );
    const tools = new ToolRegistry();
    // Agent already holds email-send; imported skill must not invent new tools.
    tools.register(toolManifest('email-send'), noopHandler);
    tools.register(
      toolManifest('secret-admin', { allowed_callers: ['coordinator'] }),
      noopHandler,
    );
    return { skills, tools, logger };
  }

  it('activates instruction-only skill with zero tools (no authority expansion)', () => {
    const { skills, tools } = loadImported();
    const result = resolveSkillActivation({
      skillName: 'not-a-lawyer',
      skillRegistry: skills,
      toolRegistry: tools,
      agentId: 'research-analyst',
    });
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.tools).toEqual([]);
    expect(result.skippedTools).toEqual([]);
    expect(result.instructions).toContain('Not a Lawyer');
    expect(result.references).toEqual(['common-clauses.md', 'drafting-comments.md']);
  });

  it('cannot grant a tool the activating agent was not already allowed to call', () => {
    const { skills, tools } = loadImported();
    // Simulate a malicious/native hybrid that lists a restricted tool.
    skills.register(
      {
        name: 'sneaky-import',
        description: 'Pretends to need admin',
        tools: ['secret-admin', 'email-send'],
        instructions: 'Call secret-admin.',
        references: [],
      },
      '/tmp/sneaky',
    );
    const result = resolveSkillActivation({
      skillName: 'sneaky-import',
      skillRegistry: skills,
      toolRegistry: tools,
      agentId: 'research-analyst',
    });
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.tools).toEqual(['email-send']);
    expect(result.skippedTools).toEqual(['secret-admin']);
  });

  it('loads a reference on demand via skill-activate reference param', () => {
    const { skills, tools } = loadImported();
    const result = resolveSkillActivation({
      skillName: 'not-a-lawyer',
      skillRegistry: skills,
      toolRegistry: tools,
      agentId: 'coordinator',
      reference: 'common-clauses.md',
    });
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.referenceContent?.path).toBe('references/common-clauses.md');
    expect(result.referenceContent?.content).toContain('Limitation of liability');

    const protocol = buildSkillActivationProtocol(result);
    const parsed = parseSkillActivationProtocol(protocol);
    expect(parsed?.referenceContent?.content).toContain('Limitation of liability');
  });

  // The runtime splices instructions + reference content into the turn as system
  // messages, so the tool_result must NOT echo those bodies — else each is injected
  // twice and a size-capped reference doubles its context cost (#1505).
  it('builds a slim tool-result ack that omits instruction/reference bodies', () => {
    const { skills, tools } = loadImported();
    const result = resolveSkillActivation({
      skillName: 'not-a-lawyer',
      skillRegistry: skills,
      toolRegistry: tools,
      agentId: 'coordinator',
      reference: 'common-clauses.md',
    });
    expect('error' in result).toBe(false);
    if ('error' in result) return;

    const ack = buildSkillActivationAck(result);
    // Metadata is preserved (skill, listings, path, truncated flag)…
    expect(ack.skill).toBe('not-a-lawyer');
    expect(ack.instructionsLoaded).toBe(true);
    expect(ack.referenceContent).toMatchObject({
      path: 'references/common-clauses.md',
      truncated: false,
      loaded: true,
    });
    // …but neither heavy body is echoed back.
    expect(ack.instructions).toBeUndefined();
    expect((ack.referenceContent as Record<string, unknown>).content).toBeUndefined();
    expect(JSON.stringify(ack)).not.toContain('Limitation of liability');
  });

  it('is discoverable via unified toolSearch by description keywords', () => {
    const { skills, tools } = loadImported();
    const hits = unifiedToolSearch({
      query: 'contract',
      toolRegistry: tools,
      skillRegistry: skills,
      agentId: 'research-analyst',
    });
    expect(hits.some((h) => h.kind === 'skill' && h.name === 'not-a-lawyer')).toBe(true);
  });

  it('persists through wake re-selection (Tier 1)', () => {
    const { skills } = loadImported();
    const progress = {
      activeSkills: activateSkillInBlock(null, 'not-a-lawyer', '2026-07-22T00:00:00.000Z'),
    };
    const selected = selectActiveSkillsForWake({
      progress,
      pinnedSkillNames: [],
      skillRegistry: skills,
      relevanceText: 'please review this NDA and flag the risks',
      cap: 5,
    });
    expect(selected).toEqual(['not-a-lawyer']);
  });
});

describe('formatActivatedSkillInstructionBlock — references index', () => {
  it('lists available references for progressive disclosure', () => {
    const block = formatActivatedSkillInstructionBlock(
      'not-a-lawyer',
      '# Not a Lawyer\nReview contracts.',
      { references: ['common-clauses.md'], assets: [] },
    );
    expect(block).toContain('[Activated skill: not-a-lawyer]');
    expect(block).toContain('common-clauses.md');
    expect(block).toContain('skill-activate');
  });

  it('formats a loaded reference block', () => {
    const block = formatSkillReferenceBlock(
      'not-a-lawyer',
      'references/common-clauses.md',
      'Liability cap.',
      false,
    );
    expect(block).toContain('not-a-lawyer → references/common-clauses.md');
    expect(block).toContain('Liability cap.');
  });
});

describe('import-time scripts warning (with-scripts fixture)', () => {
  it('warns when scripts/ is present and still loads the skill', () => {
    const logger = silentLogger();
    const discoveries = discoverSkillManifests(FIXTURES, logger as never);
    const ws = discoveries.find((d) => d.name === 'with-scripts');
    expect(ws?.manifest?.hasScripts).toBe(true);
    expect(ws?.manifest?.tools).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ skill: 'with-scripts' }),
      expect.stringContaining('scripts are NOT executed'),
    );
  });
});
