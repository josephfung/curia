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

/** Load the committed manifest (default: models/embedding/manifest.json under cwd). */
export function loadEmbedderManifest(
  file: string = path.resolve(process.cwd(), 'models/embedding/manifest.json'),
): EmbedderManifest {
  const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
  // Runtime shape check: a malformed manifest must fail loudly, not at first use.
  const m = raw as Partial<EmbedderManifest> | null;
  if (
    !m ||
    typeof m.model !== 'string' ||
    typeof m.repo !== 'string' ||
    typeof m.revision !== 'string' ||
    !Array.isArray(m.files) ||
    !m.files.every(
      (f) =>
        typeof f?.path === 'string' &&
        typeof f?.dest === 'string' &&
        typeof f?.bytes === 'number' &&
        typeof f?.sha256 === 'string',
    )
  ) {
    throw new Error(`Invalid embedder manifest: ${file}`);
  }
  return m as EmbedderManifest;
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
