import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { TempFileStore, MAX_TEMP_FILE_BYTES } from './temp-file-store.js';

describe('TempFileStore', () => {
  let store: TempFileStore;
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'curia-tempfile-test-'));
    store = new TempFileStore({ dir: testDir, sweepIntervalMs: 0 }); // sweepIntervalMs=0 disables auto-sweep in tests
    await store.init(); // no logger in tests — suppresses the "not tmpfs" warning
  });

  afterEach(async () => {
    await store.shutdown();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('MAX_TEMP_FILE_BYTES', () => {
    it('exports a 10 MB constant', () => {
      expect(MAX_TEMP_FILE_BYTES).toBe(10 * 1024 * 1024);
    });
  });

  describe('write()', () => {
    it('writes buffer and returns a file:// URL', async () => {
      const content = Buffer.from('hello world');
      const url = await store.write(content, 'test.txt');

      expect(url).toMatch(/^file:\/\//);
      const filePath = url.replace('file://', '');
      const written = await fs.readFile(filePath);
      expect(written).toEqual(content);
    });

    it('preserves binary content exactly', async () => {
      // Random binary bytes (not valid UTF-8)
      const content = Buffer.from([0x00, 0x01, 0xFF, 0xFE, 0x89, 0x50, 0x4E, 0x47]);
      const url = await store.write(content, 'binary.bin');

      const filePath = url.replace('file://', '');
      const written = await fs.readFile(filePath);
      expect(written).toEqual(content);
    });

    it('generates unique filenames with UUID prefix', async () => {
      const urls = new Set<string>();
      for (let i = 0; i < 100; i++) {
        urls.add(await store.write(Buffer.from('x'), 'same.pdf'));
      }
      expect(urls.size).toBe(100);
    });

    it('sanitizes the extension from the original filename', async () => {
      const url = await store.write(Buffer.from('x'), 'receipt.pdf');
      expect(url).toMatch(/\.pdf$/);
    });

    it('strips path traversal from filename', async () => {
      const url = await store.write(Buffer.from('x'), '../../etc/passwd');
      const filePath = url.replace('file://', '');
      expect(filePath.startsWith(testDir)).toBe(true);
      expect(filePath).not.toContain('..');
    });

    it('strips null bytes from filename', async () => {
      const url = await store.write(Buffer.from('x'), 'file\x00.pdf');
      const filePath = url.replace('file://', '');
      expect(filePath).not.toContain('\x00');
    });

    it('falls back to .bin for filenames without extension', async () => {
      const url = await store.write(Buffer.from('x'), 'noext');
      expect(url).toMatch(/\.bin$/);
    });

    it('truncates excessively long extensions', async () => {
      const url = await store.write(Buffer.from('x'), 'file.' + 'a'.repeat(50));
      const filePath = url.replace('file://', '');
      const ext = path.extname(filePath);
      expect(ext.length).toBeLessThanOrEqual(11); // dot + 10 chars
    });

    it('rejects buffers exceeding MAX_TEMP_FILE_BYTES', async () => {
      const oversized = Buffer.alloc(MAX_TEMP_FILE_BYTES + 1);
      await expect(store.write(oversized, 'big.pdf')).rejects.toThrow(/size/i);
    });

    it('accepts buffers exactly at MAX_TEMP_FILE_BYTES', async () => {
      const maxSize = Buffer.alloc(MAX_TEMP_FILE_BYTES);
      const url = await store.write(maxSize, 'max.pdf');
      expect(url).toMatch(/^file:\/\//);
    });
  });

  describe('delete()', () => {
    it('removes the file at the given URL', async () => {
      const url = await store.write(Buffer.from('delete me'), 'del.txt');
      await store.delete(url);

      const filePath = url.replace('file://', '');
      await expect(fs.access(filePath)).rejects.toThrow();
    });

    it('is idempotent — does not throw for missing files', async () => {
      // Write a file to get a valid URL pattern, then try to delete a non-existent file
      // using the same store directory but a bogus UUID filename
      const fakeUrl = `file://${testDir}/00000000-0000-0000-0000-000000000000.bin`;
      await expect(store.delete(fakeUrl)).resolves.not.toThrow();
    });
  });

  describe('sweep()', () => {
    it('removes files older than maxAgeMs', async () => {
      const url = await store.write(Buffer.from('old'), 'old.txt');
      const filePath = url.replace('file://', '');

      // Backdate the file's mtime
      const pastTime = new Date(Date.now() - 600_000); // 10 min ago
      await fs.utimes(filePath, pastTime, pastTime);

      const removed = await store.sweep(300_000); // 5 min threshold
      expect(removed).toBe(1);
      await expect(fs.access(filePath)).rejects.toThrow();
    });

    it('preserves files newer than maxAgeMs', async () => {
      const url = await store.write(Buffer.from('recent'), 'new.txt');
      const filePath = url.replace('file://', '');

      const removed = await store.sweep(300_000);
      expect(removed).toBe(0);
      await expect(fs.access(filePath)).resolves.not.toThrow();
    });
  });

  describe('shutdown()', () => {
    it('removes all files in the directory', async () => {
      await store.write(Buffer.from('a'), 'a.txt');
      await store.write(Buffer.from('b'), 'b.txt');

      await store.shutdown();

      const remaining = await fs.readdir(testDir);
      expect(remaining).toHaveLength(0);
    });
  });
});
