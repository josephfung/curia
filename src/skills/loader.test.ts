// loader.test.ts — tests for capability validation and manifest freeze in the skill loader.
//
// Covers three security-critical properties:
//   1. Unknown capability names cause a hard load failure at startup
//   2. Valid capabilities load successfully and the manifest is frozen
//   3. Frozen manifests reject mutation attempts at runtime

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import pino from 'pino';
import { loadSkillsFromDirectory } from './loader.js';
import { SkillRegistry } from './registry.js';

// Silent logger — these tests do not assert on log output
const logger = pino({ level: 'silent' });

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
// Test 1: Unknown capability name causes load failure
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
      // The loader wraps the inner error; the bad capability name must appear
      // in the final message so operators know what to fix.
      await expect(loadSkillsFromDirectory(tmpDir, registry, logger))
        .rejects.toThrow('notARealCapability');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------------
  // Test 2: Valid capabilities load successfully and manifest is frozen
  // ---------------------------------------------------------------------------

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
      const count = await loadSkillsFromDirectory(tmpDir, registry, logger);
      expect(count).toBe(1);

      const skill = registry.get('good-skill');
      // Both the manifest and its capabilities array must be frozen after loading
      expect(Object.isFrozen(skill?.manifest.capabilities)).toBe(true);
      expect(Object.isFrozen(skill?.manifest)).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------------
  // Test 3: Manifest is frozen even when no capabilities are declared
  // ---------------------------------------------------------------------------

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
      const count = await loadSkillsFromDirectory(tmpDir, registry, logger);
      expect(count).toBe(1);

      const skill = registry.get('nocap-skill');
      // capabilities should be absent (not defaulted to []), and manifest must still be frozen
      expect(skill?.manifest.capabilities).toBeUndefined();
      expect(Object.isFrozen(skill?.manifest)).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------------
  // Test 4: Frozen manifest cannot be mutated at runtime
  // ---------------------------------------------------------------------------

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
      await loadSkillsFromDirectory(tmpDir, registry, logger);

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
