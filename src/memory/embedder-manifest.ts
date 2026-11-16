// Pinned manifest for the bundled embedding model (all-MiniLM-L6-v2 ONNX + tokenizer).
// Runtime code only LOADS and VERIFIES these files; the only code that ever downloads
// them is scripts/fetch-embedder.ts (`pnpm fetch:embedder`).
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

export interface EmbedderManifest {
  model: string;
  repo: string;
  revision: string;
  files: Array<{ path: string; dest: string; bytes: number; sha256: string }>;
}

export type VerifyResult = { ok: true } | { ok: false; problems: string[] };

// What a well-formed manifest holds (#2023 review). The manifest is the trust anchor the
// weights are verified against, and its fields end up in a download URL and a file path,
// so a malformed or hostile value is refused here rather than used.
const REVISION_RE = /^[0-9a-f]{40}$/; // a full git commit sha, never a branch name
const SHA256_RE = /^[0-9a-f]{64}$/;
const REPO_RE = /^[\w.-]+\/[\w.-]+$/; // owner/name on the Hugging Face hub

function invalid(source: string, field: string, problem: string): Error {
  return new Error(`Invalid embedder manifest ${source}: ${field} ${problem}`);
}

/** A relative path with no `..` segment: it may name a file under a directory, never escape it. */
function checkRelative(value: unknown, source: string, field: string): string {
  if (typeof value !== 'string' || value === '') throw invalid(source, field, 'must be a non-empty string');
  // win32 too: a backslash or drive-letter path must not slip past on Linux.
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) throw invalid(source, field, 'must be a relative path');
  if (value.split(/[\\/]/).includes('..')) throw invalid(source, field, 'must not contain a ".." segment');
  return value;
}

/**
 * Validates a parsed manifest and returns it typed. `dir` is the directory the `dest`
 * paths resolve under (where the weights are written and read); every one must stay
 * strictly inside it. Throws an Error naming the offending field.
 */
export function validateEmbedderManifest(raw: unknown, dir: string, source = 'manifest'): EmbedderManifest {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw invalid(source, 'root', 'must be an object');
  const m = raw as Record<string, unknown>;
  if (typeof m.model !== 'string' || m.model === '') throw invalid(source, 'model', 'must be a non-empty string');
  // REPO_RE alone admits "../name"; a dot segment would rewrite the URL path, so it is refused.
  if (typeof m.repo !== 'string' || !REPO_RE.test(m.repo) || m.repo.split('/').some(part => part === '.' || part === '..')) {
    throw invalid(source, 'repo', 'must look like "owner/name"');
  }
  if (typeof m.revision !== 'string' || !REVISION_RE.test(m.revision)) {
    throw invalid(source, 'revision', 'must be a 40-character lowercase hex commit sha');
  }
  if (!Array.isArray(m.files) || m.files.length === 0) throw invalid(source, 'files', 'must be a non-empty array');

  const root = path.resolve(dir);
  m.files.forEach((entry: unknown, i: number) => {
    const at = `files[${i}]`;
    if (typeof entry !== 'object' || entry === null) throw invalid(source, at, 'must be an object');
    const f = entry as Record<string, unknown>;
    checkRelative(f.path, source, `${at}.path`);
    const dest = checkRelative(f.dest, source, `${at}.dest`);
    // Belt and braces after the segment check: resolved, dest must land strictly inside dir.
    const rel = path.relative(root, path.resolve(root, dest));
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      throw invalid(source, `${at}.dest`, `must resolve to a file inside ${root}`);
    }
    if (typeof f.bytes !== 'number' || !Number.isSafeInteger(f.bytes) || f.bytes <= 0) {
      throw invalid(source, `${at}.bytes`, 'must be a positive integer');
    }
    if (typeof f.sha256 !== 'string' || !SHA256_RE.test(f.sha256)) {
      throw invalid(source, `${at}.sha256`, 'must be 64 lowercase hex characters');
    }
  });
  // Every field the interface declares was checked above.
  return m as unknown as EmbedderManifest;
}

/**
 * Load and validate the committed manifest (default: models/embedding/manifest.json under
 * cwd). `dir` is where its `dest` paths resolve, by default the manifest's own directory.
 */
export function loadEmbedderManifest(
  file: string = path.resolve(process.cwd(), 'models/embedding/manifest.json'),
  dir: string = path.dirname(file),
): EmbedderManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`Invalid embedder manifest ${file}: ${(err as Error).message}`, { cause: err });
  }
  // A malformed manifest must fail loudly here, not at first use.
  return validateEmbedderManifest(raw, dir, file);
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** Check every manifest file under `dir` for presence, size and sha256. */
export async function verifyEmbedderFiles(
  dir: string,
  manifest: EmbedderManifest,
): Promise<VerifyResult> {
  const problems: string[] = [];
  for (const f of manifest.files) {
    const full = path.join(dir, f.dest);
    let size: number;
    try {
      size = (await stat(full)).size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        problems.push(`${f.dest}: missing`);
        continue;
      }
      throw err;
    }
    if (size !== f.bytes) {
      problems.push(`${f.dest}: size ${size} != expected ${f.bytes}`);
      continue;
    }
    const digest = await sha256File(full);
    if (digest !== f.sha256) problems.push(`${f.dest}: sha256 mismatch (got ${digest})`);
  }
  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}
