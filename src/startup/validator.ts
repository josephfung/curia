// src/startup/validator.ts
//
// Centralized startup validation — runs before any services are initialized.
// Validates config/default.yaml, all agents/*.yaml, and all skills/*/tool.json
// against JSON Schema using Ajv. Any failure throws with a descriptive message
// and causes process.exit(1) in the bootstrap orchestrator (src/index.ts).
//
// Spec: docs/specs/06-audit-and-security.md — Input Validation

import * as fs from 'node:fs';
import * as path from 'node:path';
// Ajv v8 is a CJS module with __esModule:true and named exports (exports.Ajv = class).
// Under ESM (nodenext), the named import `{ Ajv }` is the constructor; the default
// import gives a non-constructable value in TypeScript 6 strict mode.
import { Ajv, type ErrorObject } from 'ajv';
import * as yaml from 'js-yaml';
import type { Logger } from '../logger.js';

// js-yaml v5 throws on empty or comment-only input (no actual YAML document) instead
// of returning undefined. This helper restores the v4 contract: a file with no
// non-comment, non-whitespace content is treated as null (= no document = skip).
function loadYamlNullable(content: string): unknown {
  const hasContent = content.split('\n').some(l => { const t = l.trim(); return t !== '' && !t.startsWith('#'); });
  return hasContent ? yaml.load(content) : null;
}

// loadSchema takes the schemas dir as a parameter rather than computing it from
// `import.meta.dirname`. The tsup bundle collapses every source file into a single
// `dist/index.js`, so a file-local relative path that resolves correctly under tsx
// (src/startup/ → ../../schemas → repo root) resolves *wrong* in the bundle
// (dist/ → ../../schemas → filesystem root /schemas — ENOENT). Callers compute
// `schemasDir` from `src/index.ts` (the entrypoint), where `../schemas` lands at
// the right place under both tsx and the bundle. Tests pass an explicit fixture
// or the real repo schemas dir.
function loadSchema(schemasDir: string, name: string): object {
  const schemaPath = path.join(schemasDir, name);
  return JSON.parse(fs.readFileSync(schemaPath, 'utf-8')) as object;
}

/**
 * Format Ajv errors into a human-readable string that includes field paths and
 * values. Handles `additionalProperties` violations specially to surface the
 * offending property name (which lives in `params.additionalProperty`).
 */
function formatErrors(errors: ErrorObject[]): string {
  return errors
    .map(e => {
      const fieldPath = e.instancePath || '(root)';
      // additionalProperties errors put the unknown key in params.additionalProperty —
      // standard errorsText() omits it, so we add it explicitly here.
      const extra =
        e.keyword === 'additionalProperties' && e.params && 'additionalProperty' in e.params
          ? ` (unknown property: ${String(e.params.additionalProperty)})`
          : '';
      return `${fieldPath} ${e.message ?? 'invalid'}${extra}`;
    })
    .join('\n  - ');
}

/**
 * Run all startup validation checks. Throws with a descriptive error on any
 * failure — callers should catch, log fatal, and call process.exit(1).
 *
 * Validation order:
 *   1. config/default.yaml (or configFileName override)
 *   2. config/skills.yaml (absent file is OK — no MCP servers configured)
 *   3. all *.yaml and *.yml files in agentsDir
 *   4. all tool.json files in skillsDir (one per skill subdirectory)
 */
export async function runStartupValidation(opts: {
  configDir: string;
  /** When omitted, agent manifests are not validated in this pass. */
  agentsDir?: string;
  /** When omitted, skill manifests are not validated in this pass. */
  skillsDir?: string;
  schemasDir: string;
  logger: Logger;
  /** Override config filename for testing. Defaults to 'default.yaml'. */
  configFileName?: string;
}): Promise<void> {
  const { configDir, agentsDir, skillsDir, schemasDir, logger } = opts;
  const configFileName = opts.configFileName ?? 'default.yaml';

  // Compile schemas once — Ajv compilation is expensive; reuse across files.
  const ajv = new Ajv({ allErrors: true });
  const validateConfig = ajv.compile(loadSchema(schemasDir, 'default-config.schema.json'));
  const validateSkillsConfig = ajv.compile(loadSchema(schemasDir, 'skills-config.json'));
  const validateAgent = ajv.compile(loadSchema(schemasDir, 'agent-config.schema.json'));
  const validateSkill = ajv.compile(loadSchema(schemasDir, 'tool-manifest.schema.json'));

  // 1. Validate config/default.yaml (absent file is OK — all fields are optional)
  const configPath = path.join(configDir, configFileName);
  if (fs.existsSync(configPath)) {
    const content = fs.readFileSync(configPath, 'utf-8');
    const raw = loadYamlNullable(content);
    // null/empty YAML is valid (same as no config)
    if (raw != null) {
      if (!validateConfig(raw)) {
        throw new Error(
          `Startup validation failed for ${configPath}:\n  - ${formatErrors(validateConfig.errors ?? [])}`,
        );
      }
    }
  }

  // 2. Validate config/skills.yaml (absent file is OK — no MCP servers configured)
  const skillsConfigPath = path.join(configDir, 'skills.yaml');
  if (fs.existsSync(skillsConfigPath)) {
    const content = fs.readFileSync(skillsConfigPath, 'utf-8');
    const raw = loadYamlNullable(content);
    if (raw != null) {
      if (!validateSkillsConfig(raw)) {
        throw new Error(
          `Startup validation failed for ${skillsConfigPath}:\n  - ${formatErrors(validateSkillsConfig.errors ?? [])}`,
        );
      }
    }
  }

  // 3. Validate all agents/*.yaml (skipped when agentsDir is omitted)
  if (agentsDir && fs.existsSync(agentsDir)) {
    const agentFiles = fs
      .readdirSync(agentsDir)
      .filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));

    for (const file of agentFiles) {
      const filePath = path.join(agentsDir, file);
      const content = fs.readFileSync(filePath, 'utf-8');
      const raw = loadYamlNullable(content);
      if (raw == null) {
        throw new Error(`Startup validation failed: agent config file is empty: ${filePath}`);
      }
      if (!validateAgent(raw)) {
        throw new Error(
          `Startup validation failed for ${filePath}:\n  - ${formatErrors(validateAgent.errors ?? [])}`,
        );
      }
    }
  }

  // 4. Validate all skills/*/tool.json (skipped when skillsDir is omitted)
  //
  // Supports two layouts:
  //   a) skillsDir is a parent containing multiple skill subdirectories (production):
  //        skills/web-search/tool.json, skills/email-send/tool.json, ...
  //   b) skillsDir is a single skill directory directly containing tool.json (tests):
  //        skills/valid-skill/tool.json — tests pass path.join(F, 'skills/valid-skill')
  //
  // In case (b), the directory is checked first for a direct tool.json, then
  // subdirectories are scanned as in case (a).
  if (skillsDir && fs.existsSync(skillsDir)) {
    // Case (b): direct tool.json in skillsDir itself
    const directManifest = path.join(skillsDir, 'tool.json');
    if (fs.existsSync(directManifest)) {
      const raw = JSON.parse(fs.readFileSync(directManifest, 'utf-8')) as unknown;
      if (!validateSkill(raw)) {
        throw new Error(
          `Startup validation failed for ${directManifest}:\n  - ${formatErrors(validateSkill.errors ?? [])}`,
        );
      }
    } else {
      // Case (a): parent directory — iterate subdirectories
      const skillEntries = fs
        .readdirSync(skillsDir, { withFileTypes: true })
        .filter(e => e.isDirectory());

      for (const entry of skillEntries) {
        const manifestPath = path.join(skillsDir, entry.name, 'tool.json');
        if (!fs.existsSync(manifestPath)) continue;

        const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as unknown;
        if (!validateSkill(raw)) {
          throw new Error(
            `Startup validation failed for ${manifestPath}:\n  - ${formatErrors(validateSkill.errors ?? [])}`,
          );
        }
      }
    }
  }

  logger.info('Startup validation passed');
}
