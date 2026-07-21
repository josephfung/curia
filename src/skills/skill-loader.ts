// skill-loader.ts — discover and load skills (bundles) from skills/<name>/SKILL.md.
//
// Nested tools live at skills/<skill>/tools/<tool>/{tool.json,handler.ts}.
// Flat skills/<atom>/tool.json dirs remain valid tools; orphans become synthetic
// singleton skills after tools are loaded (see registerSyntheticSingletonSkills).

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseSkillMd } from './skill-md.js';
import type { SkillDiscovery, SkillManifest } from './skill-types.js';
import type { SkillRegistry } from './skill-registry.js';
import type { ToolRegistry } from './registry.js';
import type { Logger } from '../logger.js';
/** Discover SKILL.md bundles under skillsDir (immediate children only). */
export function discoverSkillManifests(skillsDir: string, logger?: Logger): SkillDiscovery[] {
  if (!fs.existsSync(skillsDir)) {
    throw new Error(`Skills directory not found: ${skillsDir}`);
  }
  const out: SkillDiscovery[] = [];
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('_')) continue; // _shared
    const dir = path.join(skillsDir, entry.name);
    const skillMdPath = path.join(dir, 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) continue;

    try {
      const raw = fs.readFileSync(skillMdPath, 'utf-8');
      const parsed = parseSkillMd(raw, skillMdPath);

      // Prefer tools declared in frontmatter (authoritative). Fall back to tools/
      // scan only when frontmatter omits tools: (instruction-only / Phase 3 imports).
      let tools = parsed.tools;
      const nested = discoverNestedToolNames(dir);
      if (!tools) {
        tools = nested;
      } else {
        // Bidirectional drift: frontmatter ↔ tools/ dirs must agree when both exist.
        const declared = new Set(tools);
        const nestedSet = new Set(nested);
        for (const n of nested) {
          if (!declared.has(n)) {
            logger?.warn(
              { skill: parsed.name, tool: n },
              'skill tools/ contains tool not listed in SKILL.md frontmatter.tools',
            );
          }
        }
        for (const t of tools) {
          if (nested.length > 0 && !nestedSet.has(t)) {
            logger?.warn(
              { skill: parsed.name, tool: t },
              'SKILL.md frontmatter.tools lists tool with no matching tools/ directory',
            );
          }
        }
      }

      if (entry.name !== parsed.name) {
        logger?.warn(
          { dir, manifestName: parsed.name },
          'skill discovery: directory name does not match SKILL.md name',
        );
      }

      const manifest: SkillManifest = {
        name: parsed.name,
        description: parsed.description,
        version: parsed.version,
        tools,
        instructions: parsed.instructions,
        heartbeat: parsed.heartbeat,
        document_workspace: parsed.document_workspace,
      };

      out.push({
        name: manifest.name,
        dir,
        manifest,
        metadata: {
          name: manifest.name,
          description: manifest.description,
          version: manifest.version ?? '0.0.0',
          tools: [...manifest.tools],
          heartbeat: manifest.heartbeat,
          documentWorkspace: manifest.document_workspace,
        },
      });
    } catch (err) {
      out.push({
        name: entry.name,
        dir,
        metadata: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}

/** Read tool.json name fields from skills/<skill>/tools/<tool>/tool.json. */
export function discoverNestedToolNames(skillDir: string): string[] {
  const toolsDir = path.join(skillDir, 'tools');
  if (!fs.existsSync(toolsDir)) return [];
  const names: string[] = [];
  for (const entry of fs.readdirSync(toolsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(toolsDir, entry.name, 'tool.json');
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as { name?: unknown };
      if (typeof raw.name === 'string' && raw.name.trim()) {
        names.push(raw.name.trim());
      }
    } catch {
      // Lenient: broken nested tool is reported when tool discovery runs.
    }
  }
  return names;
}

/**
 * Register enabled skills into SkillRegistry.
 * Returns the number registered.
 */
export function loadSkillsFromDiscovery(
  discoveries: SkillDiscovery[],
  registry: SkillRegistry,
  logger: Logger,
  enabledNames: Set<string>,
): number {
  let loaded = 0;
  for (const disc of discoveries) {
    if (!enabledNames.has(disc.name)) {
      logger.info({ skill: disc.name }, 'Skill bundle not enabled in registry; skipping');
      continue;
    }
    if (disc.metadata === null || !disc.manifest) {
      throw new Error(`Enabled skill '${disc.name}' has an invalid SKILL.md: ${disc.error ?? 'unknown error'}`);
    }
    registry.register(disc.manifest, disc.dir);
    logger.info(
      { skill: disc.manifest.name, tools: disc.manifest.tools.length, version: disc.manifest.version },
      'Skill bundle loaded',
    );
    loaded++;
  }
  return loaded;
}

/**
 * For every tool in ToolRegistry that no real skill owns, register a synthetic
 * singleton skill so `pinned_skills` can always resolve through SkillRegistry.
 * MCP tools and remaining flat atoms are covered.
 */
export function registerSyntheticSingletonSkills(
  toolRegistry: ToolRegistry,
  skillRegistry: SkillRegistry,
  logger?: Logger,
): number {
  let added = 0;
  for (const tool of toolRegistry.list()) {
    const name = tool.manifest.name;
    if (skillRegistry.toolOwner(name)) continue;
    if (skillRegistry.get(name)) continue; // already a skill with this name
    skillRegistry.register(
      {
        name,
        description: tool.manifest.description,
        version: tool.manifest.version,
        tools: [name],
        instructions: '',
      },
      '', // no on-disk skill dir
      { synthetic: true },
    );
    added++;
  }
  logger?.debug?.({ count: added }, 'Synthetic singleton skills registered');
  return added;
}
