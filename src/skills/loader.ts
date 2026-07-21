// loader.ts — loads skills from the skills/ directory at startup.
//
// Each skill lives in its own subdirectory with:
//   - tool.json (manifest)
//   - handler.ts (or handler.js) (implementation)
//
// The loader reads each subdirectory, validates the manifest,
// dynamically imports the handler, and registers both in the ToolRegistry.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolManifest, ToolHandler } from './types.js';
import type { ToolRegistry } from './registry.js';
import type { Logger } from '../logger.js';
import type { ManifestMetadata } from '../registry/types.js';

/**
 * Fixed allowlist of valid capability names that skills may declare in their manifest.
 * Each name corresponds to a privileged service on ToolContext.
 *
 * This set only changes when a new service type is added to the platform —
 * not when a new skill is added. Adding a new skill that needs an existing
 * capability is a tool.json-only change.
 *
 * Services NOT in this list (contactService, entityContextAssembler, agentPersona)
 * are universal — available to every skill without declaration.
 */
export const VALID_CAPABILITIES: ReadonlySet<string> = new Set([
  'bus', 'agentRegistry', 'outboundGateway',
  'schedulerService', 'entityMemory', 'nylasCalendarClient',
  'autonomyService', 'executiveProfileService', 'officeIdentityService', 'browserService', 'bullpenService', 'toolSearch',
  'actionLogRepo', 'auditLogRepo', 'executionLayer', 'confidencePipeline', 'tempFileStore',
  'infraLlm', 'outboundContext', 'taskRepo', 'workingDocs', 'secretCapture', 'secretResolver',
  'diagnosticsRepo', 'sensitivityClassifier',
]);

/** One discovered on-disk skill: lenient parse for the registry UI + reconciliation.
 *  `metadata` is null when tool.json failed to parse (error captured). `dir` is the
 *  skill directory, needed by loadToolsFromDirectory to import the handler. */
export interface ToolDiscovery {
  name: string;
  metadata: ManifestMetadata | null;
  error?: string;
  dir: string;
  /** Full parsed+defaulted manifest, present only when metadata !== null. */
  manifest?: ToolManifest;
}

/**
 * Scan skillsDir and parse every tool.json leniently (no handler import).
 * A parse error is captured per-skill rather than thrown, so a broken DISABLED
 * skill never crashes startup. Used by the registry UI, reconciliation, and as
 * the input to loadToolsFromDirectory.
 */
export function discoverToolManifests(skillsDir: string, logger?: Logger): ToolDiscovery[] {
  if (!fs.existsSync(skillsDir)) {
    throw new Error(`Skills directory not found: ${skillsDir}`);
  }
  const out: ToolDiscovery[] = [];
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(skillsDir, entry.name);
    const manifestPath = path.join(dir, 'tool.json');
    const legacyManifestPath = path.join(dir, 'skill.json');
    if (!fs.existsSync(manifestPath)) {
      // One-shot cutover (ADR-031): directories that still have skill.json but no
      // tool.json are not loaded — warn loudly so custom overlays don't vanish silently.
      if (fs.existsSync(legacyManifestPath)) {
        logger?.error(
          { dir, legacyManifest: 'skill.json' },
          'legacy skill.json found — rename to tool.json (ADR-031); atom will not load until renamed',
        );
      }
      continue; // not a tool dir (e.g. _shared) or unmigrated legacy manifest
    }

    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as ToolManifest;
      // Apply the same defaults that loadToolsFromDirectory used to apply inline,
      // so the pre-parsed manifest is consistent with what the loader will register.
      manifest.timeout ??= 30000;
      manifest.sensitivity ??= 'normal';
      manifest.permissions ??= [];
      manifest.secrets ??= [];
      manifest.inputs ??= {};
      manifest.outputs ??= {};

      // Normalize install.requires_secrets at this single untrusted-input boundary.
      // Discovery is deliberately lenient (raw JSON.parse, no Ajv here — see the comment
      // on this function), so a hand-edited/malformed manifest could carry a non-array or
      // non-string entries. Coerce to a clean string[] (dropping non-strings) so the
      // downstream registry gate and vault scope guard are guaranteed a valid shape and
      // never iterate a string char-by-char or throw on `.filter`. Absent/empty → undefined.
      // (A genuinely malformed manifest is still caught by the schema-validation CI test.)
      const rawRequires: unknown = manifest.install?.requires_secrets;
      const requiresSecrets = Array.isArray(rawRequires)
        ? rawRequires.filter((s): s is string => typeof s === 'string')
        : undefined;
      if (entry.name !== manifest.name) {
        logger?.warn(
          { dir, manifestName: manifest.name },
          'skill discovery: directory name does not match manifest.name',
        );
      }
      out.push({
        name: manifest.name,
        dir,
        manifest,
        metadata: {
          name: manifest.name,
          description: manifest.description,
          version: manifest.version,
          actionRisk: manifest.action_risk,
          sensitivity: manifest.sensitivity,
          capabilities: manifest.capabilities,
          // PR2 (#939): surface the install-time secrets gate to the registry UI + service.
          // Normalized above to a clean string[] | undefined.
          requiresSecrets,
        },
      });
    } catch (err) {
      out.push({ name: entry.name, dir, metadata: null, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

/**
 * Register enabled skills from pre-computed discovery results.
 *
 * Only skills whose name is in `enabledNames` are imported + registered. A disabled
 * skill is skipped (info-logged). An ENABLED skill with a bad manifest (metadata null)
 * is a hard failure — a thing going live must be valid (fail closed, unchanged from
 * the old behavior). Returns the number of skills registered.
 */
export async function loadToolsFromDirectory(
  discoveries: ToolDiscovery[],
  registry: ToolRegistry,
  logger: Logger,
  enabledNames: Set<string>,
): Promise<number> {
  let loaded = 0;

  for (const disc of discoveries) {
    if (!enabledNames.has(disc.name)) {
      logger.info({ skill: disc.name }, 'Skill not enabled in registry; skipping');
      continue;
    }
    if (disc.metadata === null || !disc.manifest) {
      // Enabled but unparseable — fail closed.
      throw new Error(`Enabled skill '${disc.name}' has an invalid manifest: ${disc.error ?? 'unknown error'}`);
    }

    try {
      const manifest = disc.manifest;

      // Validate declared capabilities against the fixed allowlist.
      // Unknown names fail hard at startup — a typo in tool.json is a configuration
      // error that must surface at boot, not silently produce a skill with wrong privileges.
      if (manifest.capabilities !== undefined) {
        for (const cap of manifest.capabilities) {
          if (!VALID_CAPABILITIES.has(cap)) {
            throw new Error(
              `Tool '${manifest.name}' declares unknown capability '${cap}'. ` +
              `Valid capabilities: ${[...VALID_CAPABILITIES].join(', ')}`,
            );
          }
        }
      }

      // Dynamically import the handler.
      // We look for handler.ts first (for tsx/development) then handler.js (for compiled).
      const handlerPath = fs.existsSync(path.join(disc.dir, 'handler.ts'))
        ? path.join(disc.dir, 'handler.ts')
        : path.join(disc.dir, 'handler.js');

      if (!fs.existsSync(handlerPath)) {
        throw new Error(`No handler.ts or handler.js found in ${disc.dir}`);
      }

      const handlerModule = await import(`file://${handlerPath}`) as Record<string, unknown>;

      // Handler can be exported as default, or as a named class.
      // Convention: export a class whose name ends in "Handler" (e.g., WebFetchHandler).
      let handler: ToolHandler;
      if (handlerModule.default && typeof (handlerModule.default as Record<string, unknown>).execute === 'function') {
        handler = handlerModule.default as ToolHandler;
      } else {
        // Find the first exported class with an execute method
        const HandlerClass = Object.values(handlerModule).find(
          (exp: unknown) => typeof exp === 'function' && (exp as { prototype?: { execute?: unknown } }).prototype?.execute,
        ) as (new () => ToolHandler) | undefined;

        if (!HandlerClass) {
          throw new Error(`No valid ToolHandler export found in ${handlerPath}`);
        }
        handler = new HandlerClass();
      }

      // Freeze the manifest to prevent runtime mutation — a handler cannot
      // escalate its own privileges by pushing to capabilities[] or reassigning
      // any manifest field. Object.freeze is shallow, so we freeze array fields
      // separately before freezing the manifest itself.
      if (manifest.capabilities !== undefined) Object.freeze(manifest.capabilities);
      if (manifest.allowed_callers !== undefined) Object.freeze(manifest.allowed_callers);
      Object.freeze(manifest);

      registry.register(manifest, handler);
      logger.info({ skill: manifest.name, version: manifest.version }, 'Skill loaded');
      loaded++;
    } catch (err) {
      logger.error({ err, skill: disc.name }, 'Failed to load skill');
      throw new Error(`Failed to load skill '${disc.name}': ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return loaded;
}

/**
 * Cross-validate allowed_callers in all skill manifests against known agent names.
 * Call after both skills and agent configs are loaded. Fails on the first stale
 * or unknown reference — typos must surface at startup, not silently at runtime.
 *
 * 'system' is always a valid caller (checkpoint processor, scheduler).
 */
export function validateAllowedCallers(
  registry: ToolRegistry,
  knownAgentNames: Set<string>,
): void {
  for (const skill of registry.list()) {
    for (const caller of skill.manifest.allowed_callers ?? []) {
      if (caller === 'system') continue;
      if (!knownAgentNames.has(caller)) {
        throw new Error(
          `Tool '${skill.manifest.name}' declares unknown allowed_caller '${caller}'. ` +
          `Known agents: ${[...knownAgentNames].join(', ')}`,
        );
      }
    }
  }
}
