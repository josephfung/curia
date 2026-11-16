import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  loadEmbedderManifest,
  verifyEmbedderFiles,
  type EmbedderManifest,
} from '../../../src/memory/embedder-manifest.js';

describe('committed embedder manifest', () => {
  it('pins the three model files by revision, size and sha256', () => {
    const m = loadEmbedderManifest();
    expect(m.repo).toBe('Xenova/all-MiniLM-L6-v2');
    expect(m.revision).toBe('751bff37182d3f1213fa05d7196b954e230abad9');
    const byPath = Object.fromEntries(m.files.map((f) => [f.path, f]));
    expect(byPath['onnx/model_quantized.onnx']).toMatchObject({
      dest: 'all-MiniLM-L6-v2/model_quantized.onnx',
      bytes: 22972370,
      sha256: 'afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1',
    });
    expect(byPath['tokenizer.json']).toMatchObject({
      dest: 'all-MiniLM-L6-v2/tokenizer.json',
      bytes: 711661,
      sha256: 'da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0',
    });
    expect(byPath['tokenizer_config.json']).toMatchObject({
      dest: 'all-MiniLM-L6-v2/tokenizer_config.json',
      bytes: 366,
      sha256: '9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3',
    });
    expect(m.files).toHaveLength(3);
  });
});

describe('verifyEmbedderFiles', () => {
  let dir: string;
  let manifest: EmbedderManifest;
  const content = Buffer.from('tiny synthetic weights');

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'embedder-manifest-'));
    mkdirSync(path.join(dir, 'm'), { recursive: true });
    writeFileSync(path.join(dir, 'm', 'a.bin'), content);
    manifest = {
      model: 'm',
      repo: 'x/y',
      revision: 'r',
      files: [
        {
          path: 'a.bin',
          dest: 'm/a.bin',
          bytes: content.length,
          sha256: createHash('sha256').update(content).digest('hex'),
        },
      ],
    };
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('returns ok for matching files', async () => {
    expect(await verifyEmbedderFiles(dir, manifest)).toEqual({ ok: true });
  });

  it('names the file when a byte is flipped', async () => {
    const flipped = Buffer.from(content);
    flipped[0] = flipped[0]! ^ 0xff;
    writeFileSync(path.join(dir, 'm', 'a.bin'), flipped);
    const r = await verifyEmbedderFiles(dir, manifest);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.join('\n')).toContain('m/a.bin');
  });

  it('reports a missing file', async () => {
    rmSync(path.join(dir, 'm', 'a.bin'));
    const r = await verifyEmbedderFiles(dir, manifest);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.join('\n')).toContain('m/a.bin');
  });

  it('reports a size mismatch', async () => {
    writeFileSync(path.join(dir, 'm', 'a.bin'), Buffer.concat([content, Buffer.from('x')]));
    const r = await verifyEmbedderFiles(dir, manifest);
    expect(r.ok).toBe(false);
  });
});
