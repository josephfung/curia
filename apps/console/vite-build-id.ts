import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/** Files served cache-first from the shell. A change to any of them must rotate BUILD_ID. */
export const SHELL_PRECACHE_FILES = [
  'offline.html',
  'offline.css',
  'offline.js',
  'icons/curia-192.png',
  'icons/curia-512.png',
] as const;

/**
 * Stable across identical builds. Chunk names already include their content hashes.
 * Precache file bytes are included so an offline-file change rotates the cache too.
 */
export function bundleBuildId(
  bundle: Record<string, unknown>,
  workerSource: string,
  publicDir = path.resolve(import.meta.dirname, 'public'),
): string {
  const hash = createHash('sha256');
  hash.update(Object.keys(bundle).sort().join('\n')).update('\0').update(workerSource);
  for (const file of SHELL_PRECACHE_FILES) {
    hash.update('\0').update(readFileSync(path.resolve(publicDir, file)));
  }
  return hash.digest('hex').slice(0, 16);
}
