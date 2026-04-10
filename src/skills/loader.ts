// loader.ts — loads skills from the skills/ directory at startup.
//
// Each skill lives in its own subdirectory with:
//   - skill.json (manifest)
//   - handler.ts (or handler.js) (implementation)
//
// The loader reads each subdirectory, validates the manifest,
// dynamically imports the handler, and registers both in the SkillRegistry.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SkillManifest, SkillHandler } from './types.js';
import type { SkillRegistry } from './registry.js';
import type { Logger } from '../logger.js';

/**
 * Load all skills from a directory into the registry.
 *
 * Expects directory structure:
 *   skills/
 *     web-fetch/
 *       skill.json
 *       handler.ts (or handler.js)
 *
 * Returns the number of skills successfully loaded.
 */
export async function loadSkillsFromDirectory(
  skillsDir: string,
  registry: SkillRegistry,
  logger: Logger,
): Promise<number> {
  if (!fs.existsSync(skillsDir)) {
    throw new Error(`Skills directory not found: ${skillsDir}`);
  }

  const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  let loaded = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const skillDir = path.join(skillsDir, entry.name);
    const manifestPath = path.join(skillDir, 'skill.json');

    // Skip directories without a manifest
    if (!fs.existsSync(manifestPath)) {
      logger.debug({ dir: entry.name }, 'Skipping directory without skill.json');
      continue;
    }

    try {
      // Load and validate manifest
      const raw = fs.readFileSync(manifestPath, 'utf-8');
      const manifest = JSON.parse(raw) as SkillManifest;

      // Set defaults for optional fields
      manifest.timeout ??= 30000;
      manifest.sensitivity ??= 'normal';
      manifest.permissions ??= [];
      manifest.secrets ??= [];
      manifest.inputs ??= {};
      manifest.outputs ??= {};

      // Dynamically import the handler.
      // We look for handler.ts first (for tsx/development) then handler.js (for compiled).
      const handlerPath = fs.existsSync(path.join(skillDir, 'handler.ts'))
        ? path.join(skillDir, 'handler.ts')
        : path.join(skillDir, 'handler.js');

      if (!fs.existsSync(handlerPath)) {
        throw new Error(`No handler.ts or handler.js found in ${skillDir}`);
      }

      const handlerModule = await import(`file://${handlerPath}`) as Record<string, unknown>;

      // Handler can be exported as default, or as a named class.
      // Convention: export a class whose name ends in "Handler" (e.g., WebFetchHandler).
      let handler: SkillHandler;
      if (handlerModule.default && typeof (handlerModule.default as Record<string, unknown>).execute === 'function') {
        handler = handlerModule.default as SkillHandler;
      } else {
        // Find the first exported class with an execute method
        const HandlerClass = Object.values(handlerModule).find(
          (exp: unknown) => typeof exp === 'function' && (exp as { prototype?: { execute?: unknown } }).prototype?.execute,
        ) as (new () => SkillHandler) | undefined;

        if (!HandlerClass) {
          throw new Error(`No valid SkillHandler export found in ${handlerPath}`);
        }
        handler = new HandlerClass();
      }

      registry.register(manifest, handler);
      logger.info({ skill: manifest.name, version: manifest.version }, 'Skill loaded');
      loaded++;
    } catch (err) {
      logger.error({ err, dir: entry.name }, 'Failed to load skill');
      throw new Error(`Failed to load skill from ${skillDir}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return loaded;
}
