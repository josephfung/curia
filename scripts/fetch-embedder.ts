// Downloads the bundled embedder weights pinned in models/embedding/manifest.json.
// This is the ONLY code in the repo that downloads weights; runtime never does.
// Usage: pnpm fetch:embedder [--dir <path>]
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  loadEmbedderManifest,
  verifyEmbedderFiles,
  type EmbedderManifest,
} from '../src/memory/embedder-manifest.js';

function parseDir(argv: string[]): string {
  const i = argv.indexOf('--dir');
  if (i !== -1) {
    const v = argv[i + 1];
    if (!v) throw new Error('--dir requires a path');
    return path.resolve(v);
  }
  return path.resolve(process.cwd(), 'models/embedding');
}

async function downloadOne(
  manifest: EmbedderManifest,
  file: EmbedderManifest['files'][number],
  dir: string,
): Promise<void> {
  const url = `https://huggingface.co/${manifest.repo}/resolve/${manifest.revision}/${file.path}`;
  const dest = path.join(dir, file.dest);
  const tmp = `${dest}.part`;
  await mkdir(path.dirname(dest), { recursive: true });

  // Node's fetch follows redirects by default (HF resolve/ redirects to a CDN).
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`${file.path}: HTTP ${res.status} from ${url}`);

  // Hash while streaming to a temp file; rename only after verification.
  const hash = createHash('sha256');
  let bytes = 0;
  const source = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream);
  source.on('data', (chunk: Buffer) => {
    hash.update(chunk);
    bytes += chunk.length;
  });
  try {
    await pipeline(source, createWriteStream(tmp));
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  const digest = hash.digest('hex');
  if (bytes !== file.bytes || digest !== file.sha256) {
    await rm(tmp, { force: true });
    throw new Error(
      `${file.path}: verification failed (bytes ${bytes}/${file.bytes}, sha256 ${digest})`,
    );
  }
  await rename(tmp, dest);
}

async function main(): Promise<void> {
  const dir = parseDir(process.argv.slice(2));
  const manifest = loadEmbedderManifest();

  const before = await verifyEmbedderFiles(dir, manifest);
  if (before.ok) {
    process.stdout.write(`embedder weights already verified in ${dir}\n`);
    return;
  }

  for (const file of manifest.files) {
    process.stdout.write(`fetching ${file.path} ...\n`);
    await downloadOne(manifest, file, dir);
  }

  // Belt and braces: re-verify what landed on disk.
  const after = await verifyEmbedderFiles(dir, manifest);
  if (!after.ok) throw new Error(`post-download verification failed:\n${after.problems.join('\n')}`);
  process.stdout.write(`embedder weights fetched and verified in ${dir}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`fetch:embedder failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
