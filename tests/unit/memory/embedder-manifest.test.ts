import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  loadEmbedderManifest,
  validateEmbedderManifest,
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

describe('validateEmbedderManifest', () => {
  const dir = path.resolve(tmpdir(), 'embedder-validate');
  // An invented, well-formed manifest; each case below breaks one field.
  const valid = () => ({
    model: 'invented-model',
    repo: 'some-org/invented-model',
    revision: 'a'.repeat(40),
    files: [{ path: 'onnx/model.onnx', dest: 'invented-model/model.onnx', bytes: 1024, sha256: 'b'.repeat(64) }],
  });
  const withFile = (patch: Record<string, unknown>) => {
    const m = valid();
    return { ...m, files: [{ ...m.files[0]!, ...patch }] };
  };

  it('accepts a well-formed manifest', () => {
    expect(validateEmbedderManifest(valid(), dir)).toEqual(valid());
  });

  it('accepts the committed manifest against its own directory', () => {
    expect(() => loadEmbedderManifest()).not.toThrow();
  });

  it.each([
    ['revision', { ...valid(), revision: 'main' }],
    ['revision', { ...valid(), revision: 'A'.repeat(40) }],
    ['revision', { ...valid(), revision: 'a'.repeat(39) }],
    ['repo', { ...valid(), repo: 'no-slash' }],
    ['repo', { ...valid(), repo: 'org/name/extra' }],
    ['repo', { ...valid(), repo: 'org/na me' }],
    ['repo', { ...valid(), repo: '../evil' }],
    ['model', { ...valid(), model: 42 }],
    ['files', { ...valid(), files: [] }],
    ['files', { ...valid(), files: 'nope' }],
    ['files[0].sha256', withFile({ sha256: 'b'.repeat(63) })],
    ['files[0].sha256', withFile({ sha256: 'B'.repeat(64) })],
    ['files[0].sha256', withFile({ sha256: 'g'.repeat(64) })],
    ['files[0].bytes', withFile({ bytes: 0 })],
    ['files[0].bytes', withFile({ bytes: -5 })],
    ['files[0].bytes', withFile({ bytes: 1.5 })],
    ['files[0].bytes', withFile({ bytes: '1024' })],
    ['files[0].path', withFile({ path: '/etc/passwd' })],
    ['files[0].path', withFile({ path: '../model.onnx' })],
    ['files[0].path', withFile({ path: 'onnx/../../model.onnx' })],
    ['files[0].path', withFile({ path: '' })],
    ['files[0].dest', withFile({ dest: '/tmp/model.onnx' })],
    ['files[0].dest', withFile({ dest: '../outside.onnx' })],
    ['files[0].dest', withFile({ dest: 'a/../../outside.onnx' })],
    ['files[0].dest', withFile({ dest: 'a\\..\\..\\outside.onnx' })],
    ['files[0].dest', withFile({ dest: 'C:\\outside.onnx' })],
    ['files[0].dest', withFile({ dest: '.' })],
    ['root', null],
    ['root', []],
  ])('rejects a bad %s, naming it', (field, manifest) => {
    expect(() => validateEmbedderManifest(manifest, dir, 'test-manifest'))
      .toThrow(`Invalid embedder manifest test-manifest: ${field} `);
  });

  it('names the file when the manifest is not valid JSON', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'embedder-manifest-json-'));
    try {
      const file = path.join(tmp, 'manifest.json');
      writeFileSync(file, '{ not json');
      expect(() => loadEmbedderManifest(file)).toThrow(file);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
