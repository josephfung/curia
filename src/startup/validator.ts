// src/startup/validator.ts
//
// Centralized startup validation — runs before any services are initialized.
// Validates config/default.yaml, all agents/*.yaml, and all skills/*/skill.json
// against JSON Schema using Ajv. Any failure throws with a descriptive message
// and causes process.exit(1) in the bootstrap orchestrator (src/index.ts).
//
// Spec: docs/specs/06-audit-and-security.md — Input Validation

import * as fs from 'node:fs';
import * as path from 'node:path';
// Ajv v6 is a plain CJS module: `module.exports = Ajv`. Under ESM (nodenext),
// the constructor is the default export — the named destructured form
// `import { Ajv }` returns undefined and causes "Ajv is not a constructor".
import Ajv from 'ajv';
import yaml from 'js-yaml';
import type { Logger } from '../logger.js';

// Schemas live at the project root in schemas/, sibling of config/ and agents/.
// Resolving two levels up from src/startup/ reaches the project root.
// This works from both tsx (src/startup/) and compiled dist (dist/startup/).
const SCHEMAS_DIR = path.resolve(import.meta.dirname, '../../schemas');

function loadSchema(name: string): object {
  const schemaPath = path.join(SCHEMAS_DIR, name);
  return JSON.parse(fs.readFileSync(schemaPath, 'utf-8')) as object;
}

/**
 * Format Ajv errors into a human-readable string that includes field paths and
 * values. Handles `additionalProperties` violations specially to surface the
 * offending property name (which lives in `params.additionalProperty`).
 */
function formatErrors(errors: Ajv.ErrorObject[]): string {
  return errors
    .map(e => {
      const fieldPath = e.dataPath || '(root)';  // Ajv v6 uses dataPath; v8+ renamed it instancePath
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
 *   2. all *.yaml and *.yml files in agentsDir
 *   3. all skill.json files in skillsDir (one per skill subdirectory)
 */
export async function runStartupValidation(opts: {
  configDir: string;
  agentsDir: string;
  skillsDir: string;
  logger: Logger;
  /** Override config filename for testing. Defaults to 'default.yaml'. */
  configFileName?: string;
}): Promise<void> {
  const { configDir, agentsDir, skillsDir, logger } = opts;
  const configFileName = opts.configFileName ?? 'default.yaml';

  // Compile schemas once — Ajv compilation is expensive; reuse across files.
  const ajv = new Ajv({ allErrors: true });
  const validateConfig = ajv.compile(loadSchema('default-config.schema.json'));
  const validateAgent = ajv.compile(loadSchema('agent-config.schema.json'));
  const validateSkill = ajv.compile(loadSchema('skill-manifest.schema.json'));

  // 1. Validate config/default.yaml (absent file is OK — all fields are optional)
  const configPath = path.join(configDir, configFileName);
  if (fs.existsSync(configPath)) {
    const raw = yaml.load(fs.readFileSync(configPath, 'utf-8'));
    // null/empty YAML is valid (same as no config)
    if (raw != null) {
      if (!validateConfig(raw)) {
        throw new Error(
          `Startup validation failed for ${configPath}:\n  - ${formatErrors(validateConfig.errors ?? [])}`,
        );
      }
    }
  }

  // 2. Validate all agents/*.yaml
  if (fs.existsSync(agentsDir)) {
    const agentFiles = fs
      .readdirSync(agentsDir)
      .filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));

    for (const file of agentFiles) {
      const filePath = path.join(agentsDir, file);
      const raw = yaml.load(fs.readFileSync(filePath, 'utf-8'));
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

  // 3. Validate all skills/*/skill.json
  //
  // Supports two layouts:
  //   a) skillsDir is a parent containing multiple skill subdirectories (production):
  //        skills/web-search/skill.json, skills/email-send/skill.json, ...
  //   b) skillsDir is a single skill directory directly containing skill.json (tests):
  //        skills/valid-skill/skill.json — tests pass path.join(F, 'skills/valid-skill')
  //
  // In case (b), the directory is checked first for a direct skill.json, then
  // subdirectories are scanned as in case (a).
  if (fs.existsSync(skillsDir)) {
    // Case (b): direct skill.json in skillsDir itself
    const directManifest = path.join(skillsDir, 'skill.json');
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
        const manifestPath = path.join(skillsDir, entry.name, 'skill.json');
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
