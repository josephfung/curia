import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { runStartupValidation } from '../../../src/startup/validator.js';
// createSilentLogger is purpose-built for tests: writes to /dev/null, level 'silent'
import { createSilentLogger } from '../../../src/logger.js';

const F = path.resolve(import.meta.dirname, 'fixtures');
// The real repo schemas dir — four levels up from this file
// (tests/unit/startup/validator.test.ts → tests/unit/startup → tests/unit → tests → repo root).
// Tests use the real schemas because they're the source of truth and are stable;
// fixturing them would just duplicate the production JSON.
const REAL_SCHEMAS = path.resolve(import.meta.dirname, '../../../schemas');
const logger = createSilentLogger();

// Shorthand: run validation with specific fixture directories.
// For components not under test, point at a valid fixture to avoid false positives.
function runWith(opts: { agents?: string; skills?: string; config?: string; schemas?: string }) {
  return runStartupValidation({
    agentsDir: opts.agents ?? path.join(F, 'agents/valid'),
    skillsDir: opts.skills ?? path.join(F, 'skills/valid-skill'),
    configDir: opts.config ?? path.join(F, 'config/empty'),
    schemasDir: opts.schemas ?? REAL_SCHEMAS,
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

  it('throws when agent YAML is missing model.tier', async () => {
    await expect(
      runWith({ agents: path.join(F, 'agents/missing-model-provider') }),
    ).rejects.toThrow(/tier/);
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

  it('throws when agent YAML is empty', async () => {
    await expect(
      runWith({ agents: path.join(F, 'agents/empty') }),
    ).rejects.toThrow(/empty/);
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

  it('throws for an out-of-range numeric action_risk (150)', async () => {
    await expect(
      runWith({ skills: path.join(F, 'skills/bad-action-risk-numeric') }),
    ).rejects.toThrow(/action_risk/);
  });

  it('passes for a valid numeric action_risk (75)', async () => {
    await expect(
      runWith({ skills: path.join(F, 'skills/valid-skill-numeric') }),
    ).resolves.toBeUndefined();
  });

  it('passes for a manifest declaring install.requires_secrets', async () => {
    await expect(
      runWith({ skills: path.join(F, 'skills/valid-skill-requires-secrets') }),
    ).resolves.toBeUndefined();
  });

  it('throws for an unknown key inside the install block (additionalProperties)', async () => {
    await expect(
      runWith({ skills: path.join(F, 'skills/bad-install-key') }),
    ).rejects.toThrow(/requires_config/);
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

  it('throws when max_message_bytes is the wrong type (string)', async () => {
    await expect(
      runWith({ config: path.join(F, 'config/wrong-type') }),
    ).rejects.toThrow(/max_message_bytes/);
  });

  it('throws for unknown top-level keys (e.g. trust-policy typo)', async () => {
    await expect(
      runWith({ config: path.join(F, 'config/unknown-key') }),
    ).rejects.toThrow(/trust-policy/);
  });
});

// ── skills.yaml (MCP server config) validation ──────────────────────────────

describe('startup validator — skills.yaml', () => {
  it('passes for a valid skills.yaml', async () => {
    await expect(
      runWith({ config: path.join(F, 'skills-config/valid') }),
    ).resolves.toBeUndefined();
  });

  it('passes when skills.yaml is absent (no MCP servers configured)', async () => {
    // config/empty has no skills.yaml — should pass silently.
    await expect(runWith({ config: path.join(F, 'config/empty') })).resolves.toBeUndefined();
  });

  it('passes when skills.yaml is empty', async () => {
    await expect(
      runWith({ config: path.join(F, 'skills-config/empty') }),
    ).resolves.toBeUndefined();
  });

  it('throws when a server entry is missing action_risk', async () => {
    await expect(
      runWith({ config: path.join(F, 'skills-config/missing-action-risk') }),
    ).rejects.toThrow(/action_risk/);
  });

  it('throws for unknown keys in a server entry (additionalProperties)', async () => {
    await expect(
      runWith({ config: path.join(F, 'skills-config/unknown-key') }),
    ).rejects.toThrow(/typo_key/);
  });
});

// ── Real project files ───────────────────────────────────────────────────────
//
// Validates the actual config/default.yaml, agents/*.yaml, and skills/*/skill.json
// against the schemas. This catches schema/config drift before it reaches prod —
// the incident that prompted this test: dispatch.rate_limit was added to default.yaml
// but not to the schema, causing every deploy to fail on startup validation.

const ROOT = path.resolve(import.meta.dirname, '../../..');

describe('startup validator — real project files', () => {
  it('config/default.yaml passes schema validation', async () => {
    await expect(
      runStartupValidation({
        configDir: path.join(ROOT, 'config'),
        // Point agents/skills at valid fixtures so only the config is under test.
        agentsDir: path.join(F, 'agents/valid'),
        skillsDir: path.join(F, 'skills/valid-skill'),
        schemasDir: REAL_SCHEMAS,
        logger,
      }),
    ).resolves.toBeUndefined();
  });

  it('all agents/*.yaml pass schema validation', async () => {
    await expect(
      runStartupValidation({
        agentsDir: path.join(ROOT, 'agents'),
        configDir: path.join(F, 'config/empty'),
        skillsDir: path.join(F, 'skills/valid-skill'),
        schemasDir: REAL_SCHEMAS,
        logger,
      }),
    ).resolves.toBeUndefined();
  });

  it('all skills/*/skill.json pass schema validation', async () => {
    await expect(
      runStartupValidation({
        skillsDir: path.join(ROOT, 'skills'),
        configDir: path.join(F, 'config/empty'),
        agentsDir: path.join(F, 'agents/valid'),
        schemasDir: REAL_SCHEMAS,
        logger,
      }),
    ).resolves.toBeUndefined();
  });

  it('throws a clear ENOENT when schemasDir is wrong (regression test for #805 bug 3)', async () => {
    // Previously the validator computed `schemasDir` from `import.meta.dirname` of
    // validator.ts. That resolved correctly under tsx (`src/startup/` → `../../schemas`
    // = repo root schemas) but tsup bundled all source into a single `dist/index.js`,
    // collapsing `import.meta.dirname` to `dist/` — so the same relative path landed
    // at filesystem root `/schemas`, which doesn't exist in the container, and the
    // validator threw ENOENT with no useful context once pino's async transport ate
    // the log. Threading `schemasDir` from the entrypoint avoids the bundle problem;
    // this test pins the failure mode if someone ever passes a wrong dir again.
    await expect(
      runStartupValidation({
        configDir: path.join(F, 'config/empty'),
        agentsDir: path.join(F, 'agents/valid'),
        skillsDir: path.join(F, 'skills/valid-skill'),
        schemasDir: '/nonexistent/schemas/path',
        logger,
      }),
    ).rejects.toThrow(/ENOENT|no such file/);
  });
});
