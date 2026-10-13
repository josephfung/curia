// tests/scenarios/overlay.ts — run the suite over a deployment's own agents (#2025,
// josephfung/curia-deploy#276).
//
// A deployment image layers its `custom/` directory over core's: custom/agents and
// custom/skills are copied over core's agents/ and skills/, custom/config/skills.yaml
// replaces core's, and custom/config/local.yaml is added (curia-deploy's
// deploy/compose/Dockerfile.curia). `--overlay <custom dir>` builds the same tree in a temp
// directory, so the stack loads exactly the agents, tools and config that deployment runs.
//
// Each tree is mirrored as real directories holding symlinks to the files: discovery skips
// a symlinked directory (Dirent.isDirectory is false for a link), while Node imports a
// symlinked file from its real path, so a custom skill's relative imports still resolve
// inside the deployment repo.
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { StackSources } from './harness.js';

/** The parts of a deployment's `custom/` directory the image lays over core. */
const LAYERS = ['agents', 'skills', 'config'] as const;

export interface Overlay extends Required<StackSources> {
  /** Remove the temp tree (the overlay's own files are untouched). */
  cleanup(): void;
}

/** Mirror `source` into `target`: real directories, one symlink per file. A file already in `target` is replaced. */
function mirror(source: string, target: string): void {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) {
      mirror(from, to);
      continue;
    }
    try {
      if (lstatSync(to).isSymbolicLink()) rmSync(to);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    symlinkSync(from, to);
  }
}

/**
 * Core's agents, skills and config with `overlayDir` (a deployment's `custom/`) laid over
 * them. A layer the overlay lacks is core's alone.
 */
export function buildOverlay(overlayDir: string, repoRoot: string): Overlay {
  const root = mkdtempSync(path.join(tmpdir(), 'curia-scenarios-overlay-'));
  try {
    for (const layer of LAYERS) {
      mirror(path.join(repoRoot, layer), path.join(root, layer));
      const custom = path.join(overlayDir, layer);
      let present = false;
      try {
        present = lstatSync(custom).isDirectory();
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      if (present) mirror(custom, path.join(root, layer));
    }
  } catch (err) {
    rmSync(root, { recursive: true, force: true });
    throw err;
  }
  return {
    agentsDir: path.join(root, 'agents'),
    skillsDir: path.join(root, 'skills'),
    configDir: path.join(root, 'config'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
