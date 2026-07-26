// Shared containment check for SPA static handlers (console, antfarm).
// Lexical relative() alone misses symlink escapes; realpath catches those.

import { relative, resolve, isAbsolute } from 'node:path';
import { realpath, stat } from 'node:fs/promises';

/** True when `abs` is outside `root` (path-traversal / absolute escape). */
export function outsideRoot(root: string, abs: string): boolean {
  const rel = relative(root, abs);
  return rel !== '' && (rel.startsWith('..') || isAbsolute(rel));
}

/**
 * If `urlPath` names a regular file contained under `rootDir` after symlink
 * resolution, return `{ rootReal, safeRel }` for `reply.sendFile`. Otherwise
 * `null` (missing, not a file, or escape) — caller should SPA-fallback.
 * Unexpected fs errors (EACCES, EMFILE, …) propagate.
 */
export async function containedStaticFile(
  rootDir: string,
  urlPath: string,
): Promise<{ rootReal: string; safeRel: string } | null> {
  const absPath = resolve(rootDir, urlPath);
  // Cheap lexical reject before touching the filesystem.
  if (outsideRoot(rootDir, absPath)) return null;

  const rootReal = await realpath(rootDir);

  let targetReal: string;
  try {
    // Follows symlinks — a link inside rootDir that points outside is rejected below.
    targetReal = await realpath(absPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }

  if (outsideRoot(rootReal, targetReal)) return null;

  const s = await stat(targetReal);
  if (!s.isFile()) return null;

  return { rootReal, safeRel: relative(rootReal, targetReal) };
}
