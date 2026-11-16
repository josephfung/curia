// Unit tests for the embedder weight download (#2023): the size cap and the .part handling.
// No network: downloadOne takes a fetch seam, handed a synthetic response here.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { downloadOne } from './fetch-embedder.js';
import type { EmbedderManifest } from '../src/memory/embedder-manifest.js';

const CHUNK = Buffer.alloc(1024, 7);

/** A response streaming `chunks` copies of CHUNK, counting how many the reader pulled. */
function streamingResponse(chunks: number): { res: Response; pulled: () => number; cancelled: () => boolean } {
  let sent = 0;
  let wasCancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= chunks) {
        controller.close();
        return;
      }
      sent++;
      controller.enqueue(new Uint8Array(CHUNK));
    },
    cancel() {
      wasCancelled = true;
    },
  });
  return { res: new Response(body, { status: 200 }), pulled: () => sent, cancelled: () => wasCancelled };
}

describe('downloadOne', () => {
  let dir: string;
  const manifest = (bytes: number, sha256: string): EmbedderManifest => ({
    model: 'invented-model',
    repo: 'some-org/invented-model',
    revision: 'a'.repeat(40),
    files: [{ path: 'model.onnx', dest: 'invented-model/model.onnx', bytes, sha256 }],
  });

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'fetch-embedder-'));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes a file whose size and sha256 match, and leaves no .part behind', async () => {
    const expected = Buffer.concat([CHUNK, CHUNK]);
    const m = manifest(expected.length, createHash('sha256').update(expected).digest('hex'));
    const { res } = streamingResponse(2);
    await downloadOne(m, m.files[0]!, dir, vi.fn().mockResolvedValue(res));

    const dest = path.join(dir, 'invented-model/model.onnx');
    expect(readFileSync(dest)).toEqual(expected);
    expect(existsSync(`${dest}.part`)).toBe(false);
  });

  it('aborts as soon as the body exceeds the manifest size, naming the file and removing the .part', async () => {
    // Declared as two chunks; the server would send 1000.
    const m = manifest(2 * CHUNK.length, 'c'.repeat(64));
    const { res, pulled, cancelled } = streamingResponse(1000);

    await expect(downloadOne(m, m.files[0]!, dir, vi.fn().mockResolvedValue(res)))
      .rejects.toThrow(/model\.onnx: download exceeded the manifest's 2048 bytes/);

    const dest = path.join(dir, 'invented-model/model.onnx');
    expect(existsSync(`${dest}.part`)).toBe(false);
    expect(existsSync(dest)).toBe(false);
    // Stopped early: the stream was cancelled long before the server ran out of data.
    expect(cancelled()).toBe(true);
    expect(pulled()).toBeLessThan(20);
  });

  it('refuses a body of the right size whose sha256 differs, removing the .part', async () => {
    const m = manifest(CHUNK.length, 'd'.repeat(64));
    const { res } = streamingResponse(1);
    await expect(downloadOne(m, m.files[0]!, dir, vi.fn().mockResolvedValue(res)))
      .rejects.toThrow(/model\.onnx: verification failed/);
    expect(existsSync(path.join(dir, 'invented-model/model.onnx.part'))).toBe(false);
  });
});
