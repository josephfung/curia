// Resolve a file:// URL handed from one tool to another (download → extract → parse).
// Only paths under the temp store are accepted, and symlinks are resolved so a
// link inside the store cannot point at a file outside it.

import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Validate and resolve a file:// URL to an absolute filesystem path.
 * Returns null when the URL is not a file:// URL under a temp-store directory,
 * or when its real path (after symlinks) escapes that directory.
 * A missing file returns the logical path so the caller can report expiry.
 */
export async function resolveTempFileUrl(url: string): Promise<string | null> {
  if (!url.startsWith('file://')) return null;

  const filePath = path.resolve(url.slice('file://'.length));

  // Production tmpfs, the local-dev fallback, and CURIA_TEMPFILE_DIR when set.
  // TempFileStore is the only writer in these directories.
  const allowedPrefixes = ['/run/curia-tempfiles/', '/tmp/curia-tempfiles/'];
  const customDir = process.env.CURIA_TEMPFILE_DIR;
  if (customDir) {
    const normalized = path.resolve(customDir);
    allowedPrefixes.push(normalized.endsWith('/') ? normalized : normalized + '/');
  }
  const logicallyAllowed = allowedPrefixes.some((prefix) => filePath.startsWith(prefix));
  if (!logicallyAllowed) return null;

  let realPath: string;
  try {
    realPath = await fs.realpath(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // Missing file — the caller's read produces the "expired" error.
      return filePath;
    }
    // Can't verify the real path (EACCES, EIO, …). Don't fall back to the
    // logical path; that would skip the symlink check.
    return null;
  }

  // On macOS /tmp is a symlink to /private/tmp, so resolve the prefixes too.
  const resolvedPrefixes = await Promise.all(
    allowedPrefixes.map(async (prefix) => {
      try {
        return await fs.realpath(prefix.slice(0, -1)) + '/';
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          // Unexpected error resolving a prefix we control — keep the original
          // string rather than failing every URL.
        }
        return prefix;
      }
    }),
  );
  const allPrefixes = [...new Set([...allowedPrefixes, ...resolvedPrefixes])];
  const reallyAllowed = allPrefixes.some((prefix) => realPath.startsWith(prefix));
  if (!reallyAllowed) return null;

  return realPath;
}
