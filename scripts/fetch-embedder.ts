// Downloads the bundled embedder weights pinned in models/embedding/manifest.json.
// This is the ONLY code in the repo that downloads weights; runtime never does.
// Usage: pnpm fetch:embedder [--dir <path>]
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
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

/**
 * Downloads one manifest file to `<dir>/<dest>`, via a `.part` file renamed only once its
 * size and sha256 match. Exported, with `fetchImpl` as a seam, for the unit test.
 */
export async function downloadOne(
  manifest: EmbedderManifest,
  file: EmbedderManifest['files'][number],
  dir: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const url = `https://huggingface.co/${manifest.repo}/resolve/${manifest.revision}/${file.path}`;
  const dest = path.join(dir, file.dest);
  const tmp = `${dest}.part`;
  await mkdir(path.dirname(dest), { recursive: true });

  // Node's fetch follows redirects by default (HF resolve/ redirects to a CDN).
  const controller = new AbortController();
  const res = await fetchImpl(url, { redirect: 'follow', signal: controller.signal });
  if (!res.ok || !res.body) throw new Error(`${file.path}: HTTP ${res.status} from ${url}`);

  // Hash while streaming to a temp file; rename only after verification. The byte count is
  // checked as it streams: a response larger than the manifest says (a wrong or hostile
  // server) is cut off at the first chunk past the limit, not written to disk in full.
  const hash = createHash('sha256');
  let bytes = 0;
  const source = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream);
  const limit = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > file.bytes) {
        callback(new Error(`${file.path}: download exceeded the manifest's ${file.bytes} bytes; aborted`));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    // pipeline() destroys every stream on an error, the source included.
    await pipeline(source, limit, createWriteStream(tmp));
  } catch (err) {
    // Tear the connection down too, so nothing more is read from the server.
    controller.abort();
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
  // Validated against the directory the files are written to, so no `dest` can escape it.
  const manifest = loadEmbedderManifest(undefined, dir);

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

// Run only as the entry point, so the unit test can import downloadOne.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    process.stderr.write(`fetch:embedder failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
