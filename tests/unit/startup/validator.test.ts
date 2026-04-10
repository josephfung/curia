import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { runStartupValidation } from '../../../src/startup/validator.js';
// createSilentLogger is purpose-built for tests: writes to /dev/null, level 'silent'
import { createSilentLogger } from '../../../src/logger.js';

const F = path.resolve(import.meta.dirname, 'fixtures');
const logger = createSilentLogger();

// Shorthand: run validation with specific fixture directories.
// For components not under test, point at a valid fixture to avoid false positives.
function runWith(opts: { agents?: string; skills?: string; config?: string }) {
  return runStartupValidation({
    agentsDir: opts.agents ?? path.join(F, 'agents/valid'),
    skillsDir: opts.skills ?? path.join(F, 'skills/valid-skill'),
    configDir: opts.config ?? path.join(F, 'config/empty'),
    logger,
  });
}

// ── Agent config validation ──────────────────────────────────────────────────

describe('startup validator — agent configs', () => {
  it('passes for a valid agent YAML', async () => {
    await expect(runWith({ agents: path.join(F, 'agents/valid') })).resolves.toBeUndefined();
  });

  it('throws when agent YAML is missing description', async () => {
    await expect(
      runWith({ agents: path.join(F, 'agents/missing-description') }),
    ).rejects.toThrow(/description/);
  });

  it('throws when agent YAML is missing model.provider', async () => {
    await expect(
      runWith({ agents: path.join(F, 'agents/missing-model-provider') }),
    ).rejects.toThrow(/provider/);
  });

  it('includes the file path in the error message', async () => {
    await expect(
      runWith({ agents: path.join(F, 'agents/missing-description') }),
    ).rejects.toThrow(/coordinator\.yaml/);
  });

  it('throws for unknown top-level keys (additionalProperties)', async () => {
    await expect(
      runWith({ agents: path.join(F, 'agents/unknown-key') }),
    ).rejects.toThrow(/typo_key/);
  });
});

// ── Skill manifest validation ────────────────────────────────────────────────

describe('startup validator — skill manifests', () => {
  it('passes for a valid skill manifest', async () => {
    await expect(runWith({ skills: path.join(F, 'skills/valid-skill') })).resolves.toBeUndefined();
  });

  it('throws when skill manifest is missing version', async () => {
    await expect(
      runWith({ skills: path.join(F, 'skills/missing-version') }),
    ).rejects.toThrow(/version/);
  });

  it('throws when skill manifest is missing action_risk', async () => {
    await expect(
      runWith({ skills: path.join(F, 'skills/missing-action-risk') }),
    ).rejects.toThrow(/action_risk/);
  });

  it('throws for an invalid action_risk string value', async () => {
    await expect(
      runWith({ skills: path.join(F, 'skills/bad-action-risk') }),
    ).rejects.toThrow(/action_risk/);
  });
});

// ── default-config.yaml validation ──────────────────────────────────────────

describe('startup validator — default config', () => {
  it('passes for a valid config', async () => {
    await expect(runWith({ config: path.join(F, 'config/valid') })).resolves.toBeUndefined();
  });

  it('passes for an empty config (all fields optional)', async () => {
    await expect(runWith({ config: path.join(F, 'config/empty') })).resolves.toBeUndefined();
  });

  it('throws when trust_score_floor is out of range (1.5)', async () => {
    await expect(
      runWith({ config: path.join(F, 'config/invalid-trust-floor') }),
    ).rejects.toThrow(/trust_score_floor/);
  });

  it('throws when maxMessageBytes is the wrong type (string)', async () => {
    await expect(
      runWith({ config: path.join(F, 'config/wrong-type') }),
    ).rejects.toThrow(/maxMessageBytes/);
  });

  it('throws for unknown top-level keys (e.g. trust-policy typo)', async () => {
    await expect(
      runWith({ config: path.join(F, 'config/unknown-key') }),
    ).rejects.toThrow(/trust-policy/);
  });
});
