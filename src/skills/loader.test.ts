// loader.test.ts — tests for skill discovery, gated loading, capability validation,
// and manifest freeze in the skill loader.
//
// Covers:
//   1. discoverSkillManifests: parses manifests without importing handlers
//   2. discoverSkillManifests: captures parse errors leniently
//   3. loadSkillsFromDirectory: only registers enabled skills (gated)
//   4. loadSkillsFromDirectory: hard-fails on enabled skill with bad manifest
//   5. loadSkillsFromDirectory: skips disabled skill with bad manifest
//   6. Unknown capability names cause a hard load failure at startup
//   7. Valid capabilities load successfully and the manifest is frozen
//   8. Frozen manifests reject mutation attempts at runtime
//   9. allowed_callers freeze and startup validation

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import pino from 'pino';
import { discoverSkillManifests, loadSkillsFromDirectory, validateAllowedCallers } from './loader.js';
import { SkillRegistry } from './registry.js';
import { createLogger } from '../logger.js';

// Silent logger — these tests do not assert on log output
const logger = pino({ level: 'silent' });
const silentLogger = createLogger('silent');

/**
 * Write a minimal skill directory (skill.json + trivial handler) into tmpDir.
 *
 * The handler is written as a .js (ESM) file — not .ts — because the loader
 * imports handlers via `import('file://...')` which bypasses vitest's transform
 * pipeline. Plain ESM .js files work natively with Node's module loader.
 *
 * The loader checks for handler.ts first; since we only write handler.js,
 * it falls back to the .js path (the correct fallback behavior).
 */
function setupSkillDir(tmpDir: string, skillName: string, manifest: Record<string, unknown>): void {
  const skillDir = path.join(tmpDir, skillName);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'skill.json'), JSON.stringify(manifest));
  // Named export matching the HandlerClass path in loader.ts
  fs.writeFileSync(
    path.join(skillDir, 'handler.js'),
    "export class Handler {\n  async execute() { return { success: true, data: 'ok' }; }\n}\n",
  );
}

// ---------------------------------------------------------------------------
// Helper: write a skill with an inline handler string
// ---------------------------------------------------------------------------

function writeSkill(dir: string, name: string, manifest: object, handler: string) {
  const sdir = path.join(dir, name);
  fs.mkdirSync(sdir, { recursive: true });
  fs.writeFileSync(path.join(sdir, 'skill.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(sdir, 'handler.js'), handler);
}

// ---------------------------------------------------------------------------
// Discovery tests (no handler import)
// ---------------------------------------------------------------------------

describe('discoverSkillManifests', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('returns metadata without importing handlers', () => {
    writeSkill(dir, 'good', { name: 'good', description: 'd', version: '1.0.0', action_risk: 'low' }, 'throw new Error("should not import");');
    const found = discoverSkillManifests(dir);
    expect(found).toHaveLength(1);
    expect(found[0]!.name).toBe('good');
    expect(found[0]!.metadata?.actionRisk).toBe('low');
    expect(found[0]!.error).toBeUndefined();
  });

  it('captures a parse error instead of throwing', () => {
    const sdir = path.join(dir, 'broken');
    fs.mkdirSync(sdir);
    fs.writeFileSync(path.join(sdir, 'skill.json'), '{ not json');
    const found = discoverSkillManifests(dir);
    expect(found[0]!.metadata).toBeNull();
    expect(found[0]!.error).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Gated loading tests (enabledNames gate)
// ---------------------------------------------------------------------------

describe('loadSkillsFromDirectory (gated)', () => {
  let dir: string;
  let registry: SkillRegistry;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));
    registry = new SkillRegistry('UTC');
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const HANDLER = 'export default { async execute() { return { success: true, data: {} }; } };';

  it('registers only enabled skills', async () => {
    writeSkill(dir, 'on',  { name: 'on',  description: 'd', version: '1.0.0', action_risk: 'none' }, HANDLER);
    writeSkill(dir, 'off', { name: 'off', description: 'd', version: '1.0.0', action_risk: 'none' }, HANDLER);
    const discoveries = discoverSkillManifests(dir);
    const loaded = await loadSkillsFromDirectory(discoveries, registry, silentLogger, new Set(['on']));
    expect(loaded).toBe(1);
    expect(registry.get('on')).toBeDefined();
    expect(registry.get('off')).toBeUndefined();
  });

  it('hard-fails on an ENABLED skill with a bad manifest', async () => {
    const discoveries = [{ name: 'bad', metadata: null, error: 'bad json', dir: path.join(dir, 'bad') }];
    await expect(
      loadSkillsFromDirectory(discoveries as never, registry, silentLogger, new Set(['bad'])),
    ).rejects.toThrow();
  });

  it('skips a DISABLED skill with a bad manifest (no throw)', async () => {
    const discoveries = [{ name: 'bad', metadata: null, error: 'bad json', dir: path.join(dir, 'bad') }];
    const loaded = await loadSkillsFromDirectory(discoveries as never, registry, silentLogger, new Set());
    expect(loaded).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Capability validation tests
// ---------------------------------------------------------------------------

describe('loader: capability validation', () => {
  it('rejects unknown capability names with a hard error at load time', async () => {
    const tmpDir = path.join(import.meta.dirname, '__test_cap_unknown__');
    fs.mkdirSync(tmpDir, { recursive: true });
    try {
      setupSkillDir(tmpDir, 'bad-skill', {
        name: 'bad-skill',
        description: 'test skill',
        version: '1.0.0',
        action_risk: 'none',
        inputs: {},
        outputs: {},
        capabilities: ['outboundGateway', 'notARealCapability'],
      });
      const registry = new SkillRegistry();
      const discoveries = discoverSkillManifests(tmpDir);
      const enabledNames = new Set(discoveries.map(d => d.name));
      // The loader wraps the inner error; the bad capability name must appear
      // in the final message so operators know what to fix.
      await expect(loadSkillsFromDirectory(discoveries, registry, logger, enabledNames))
        .rejects.toThrow('notARealCapability');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('accepts valid capability names and freezes both manifest and capabilities array', async () => {
    const tmpDir = path.join(import.meta.dirname, '__test_cap_valid__');
    fs.mkdirSync(tmpDir, { recursive: true });
    try {
      setupSkillDir(tmpDir, 'good-skill', {
        name: 'good-skill',
        description: 'test skill',
        version: '1.0.0',
        action_risk: 'none',
        inputs: {},
        outputs: {},
        capabilities: ['outboundGateway'],
      });
      const registry = new SkillRegistry();
      const discoveries = discoverSkillManifests(tmpDir);
      const enabledNames = new Set(discoveries.map(d => d.name));
      const count = await loadSkillsFromDirectory(discoveries, registry, logger, enabledNames);
      expect(count).toBe(1);

      const skill = registry.get('good-skill');
      // Both the manifest and its capabilities array must be frozen after loading
      expect(Object.isFrozen(skill?.manifest.capabilities)).toBe(true);
      expect(Object.isFrozen(skill?.manifest)).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('freezes the manifest even when no capabilities field is present', async () => {
    const tmpDir = path.join(import.meta.dirname, '__test_cap_none__');
    fs.mkdirSync(tmpDir, { recursive: true });
    try {
      setupSkillDir(tmpDir, 'nocap-skill', {
        name: 'nocap-skill',
        description: 'test skill with no capabilities',
        version: '1.0.0',
        action_risk: 'none',
        inputs: {},
        outputs: {},
        // no 'capabilities' key — skill uses only universal services
      });
      const registry = new SkillRegistry();
      const discoveries = discoverSkillManifests(tmpDir);
      const enabledNames = new Set(discoveries.map(d => d.name));
      const count = await loadSkillsFromDirectory(discoveries, registry, logger, enabledNames);
      expect(count).toBe(1);

      const skill = registry.get('nocap-skill');
      // capabilities should be absent (not defaulted to []), and manifest must still be frozen
      expect(skill?.manifest.capabilities).toBeUndefined();
      expect(Object.isFrozen(skill?.manifest)).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('throws when attempting to mutate a frozen capabilities array', async () => {
    const tmpDir = path.join(import.meta.dirname, '__test_cap_freeze__');
    fs.mkdirSync(tmpDir, { recursive: true });
    try {
      setupSkillDir(tmpDir, 'frozen-skill', {
        name: 'frozen-skill',
        description: 'test skill',
        version: '1.0.0',
        action_risk: 'none',
        inputs: {},
        outputs: {},
        capabilities: ['outboundGateway'],
      });
      const registry = new SkillRegistry();
      const discoveries = discoverSkillManifests(tmpDir);
      const enabledNames = new Set(discoveries.map(d => d.name));
      await loadSkillsFromDirectory(discoveries, registry, logger, enabledNames);

      const skill = registry.get('frozen-skill');
      // ESM modules run in strict mode — pushing to a frozen array throws TypeError.
      // This verifies that a handler cannot self-escalate privileges at runtime.
      expect(() => {
        skill!.manifest.capabilities!.push('bus');
      }).toThrow(TypeError);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// allowed_callers: freeze and startup validation
// ---------------------------------------------------------------------------

describe('loader: allowed_callers', () => {
  it('freezes allowed_callers array after loading', async () => {
    const tmpDir = path.join(import.meta.dirname, '__test_ac_freeze__');
    fs.mkdirSync(tmpDir, { recursive: true });
    try {
      setupSkillDir(tmpDir, 'restricted-skill', {
        name: 'restricted-skill',
        description: 'test skill',
        version: '1.0.0',
        action_risk: 'none',
        inputs: {},
        outputs: {},
        allowed_callers: ['coordinator'],
      });
      const registry = new SkillRegistry();
      const discoveries = discoverSkillManifests(tmpDir);
      const enabledNames = new Set(discoveries.map(d => d.name));
      await loadSkillsFromDirectory(discoveries, registry, logger, enabledNames);

      const skill = registry.get('restricted-skill');
      expect(Object.isFrozen(skill?.manifest.allowed_callers)).toBe(true);
      // A handler cannot escalate by adding itself to the caller list
      expect(() => {
        skill!.manifest.allowed_callers!.push('rogue-agent');
      }).toThrow(TypeError);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('validateAllowedCallers', () => {
  it('passes when all callers are known agents', async () => {
    const tmpDir = path.join(import.meta.dirname, '__test_ac_valid__');
    fs.mkdirSync(tmpDir, { recursive: true });
    try {
      setupSkillDir(tmpDir, 'governed-skill', {
        name: 'governed-skill',
        description: 'test skill',
        version: '1.0.0',
        action_risk: 'none',
        inputs: {},
        outputs: {},
        allowed_callers: ['coordinator'],
      });
      const registry = new SkillRegistry();
      const discoveries = discoverSkillManifests(tmpDir);
      const enabledNames = new Set(discoveries.map(d => d.name));
      await loadSkillsFromDirectory(discoveries, registry, logger, enabledNames);

      const knownAgents = new Set(['coordinator', 'calendar', 'ceo-inbox']);
      expect(() => validateAllowedCallers(registry, knownAgents)).not.toThrow();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('always accepts "system" as a valid caller without it being a known agent', async () => {
    const tmpDir = path.join(import.meta.dirname, '__test_ac_system__');
    fs.mkdirSync(tmpDir, { recursive: true });
    try {
      setupSkillDir(tmpDir, 'infra-skill', {
        name: 'infra-skill',
        description: 'test skill',
        version: '1.0.0',
        action_risk: 'none',
        inputs: {},
        outputs: {},
        allowed_callers: ['system'],
      });
      const registry = new SkillRegistry();
      const discoveries = discoverSkillManifests(tmpDir);
      const enabledNames = new Set(discoveries.map(d => d.name));
      await loadSkillsFromDirectory(discoveries, registry, logger, enabledNames);

      // 'system' is not in the known agents set — but it's always valid
      const knownAgents = new Set(['coordinator']);
      expect(() => validateAllowedCallers(registry, knownAgents)).not.toThrow();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('throws on unknown agent name (catches typos at startup)', async () => {
    const tmpDir = path.join(import.meta.dirname, '__test_ac_typo__');
    fs.mkdirSync(tmpDir, { recursive: true });
    try {
      setupSkillDir(tmpDir, 'typo-skill', {
        name: 'typo-skill',
        description: 'test skill',
        version: '1.0.0',
        action_risk: 'none',
        inputs: {},
        outputs: {},
        allowed_callers: ['coordinatorrr'],
      });
      const registry = new SkillRegistry();
      const discoveries = discoverSkillManifests(tmpDir);
      const enabledNames = new Set(discoveries.map(d => d.name));
      await loadSkillsFromDirectory(discoveries, registry, logger, enabledNames);

      const knownAgents = new Set(['coordinator', 'calendar']);
      expect(() => validateAllowedCallers(registry, knownAgents)).toThrow('coordinatorrr');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('passes when allowed_callers is omitted', async () => {
    const tmpDir = path.join(import.meta.dirname, '__test_ac_omit__');
    fs.mkdirSync(tmpDir, { recursive: true });
    try {
      setupSkillDir(tmpDir, 'open-skill', {
        name: 'open-skill',
        description: 'test skill',
        version: '1.0.0',
        action_risk: 'none',
        inputs: {},
        outputs: {},
      });
      const registry = new SkillRegistry();
      const discoveries = discoverSkillManifests(tmpDir);
      const enabledNames = new Set(discoveries.map(d => d.name));
      await loadSkillsFromDirectory(discoveries, registry, logger, enabledNames);

      const knownAgents = new Set(['coordinator']);
      expect(() => validateAllowedCallers(registry, knownAgents)).not.toThrow();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('passes when allowed_callers is an explicit empty array', async () => {
    const tmpDir = path.join(import.meta.dirname, '__test_ac_empty__');
    fs.mkdirSync(tmpDir, { recursive: true });
    try {
      // An explicit [] means "unrestricted" (same as omitted) — not "no one can call it".
      // The ?? operator in validateAllowedCallers does not replace [] since it is not nullish.
      setupSkillDir(tmpDir, 'open-skill', {
        name: 'open-skill',
        description: 'test skill',
        version: '1.0.0',
        action_risk: 'none',
        inputs: {},
        outputs: {},
        allowed_callers: [],
      });
      const registry = new SkillRegistry();
      const discoveries = discoverSkillManifests(tmpDir);
      const enabledNames = new Set(discoveries.map(d => d.name));
      await loadSkillsFromDirectory(discoveries, registry, logger, enabledNames);

      const knownAgents = new Set(['coordinator']);
      expect(() => validateAllowedCallers(registry, knownAgents)).not.toThrow();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
