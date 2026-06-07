// Unit tests for the pure crypto layer — no DB, no env mutation beyond a local object.
import { describe, it, expect } from 'vitest';
import { encrypt, decrypt, loadEncryptionKey } from './crypto.js';
import { randomBytes } from 'node:crypto';

const KEY = randomBytes(32);

describe('encrypt/decrypt', () => {
  it('round-trips plaintext', () => {
    const { ciphertext, iv } = encrypt('hunter2', KEY);
    expect(decrypt(ciphertext, iv, KEY)).toBe('hunter2');
  });

  it('round-trips unicode and long values', () => {
    const value = '🔐 '.repeat(1000);
    const { ciphertext, iv } = encrypt(value, KEY);
    expect(decrypt(ciphertext, iv, KEY)).toBe(value);
  });

  it('uses a fresh IV per call (same plaintext encrypts differently)', () => {
    const a = encrypt('same', KEY);
    const b = encrypt('same', KEY);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('throws on decrypt with the wrong key (does not return garbage)', () => {
    const { ciphertext, iv } = encrypt('secret', KEY);
    expect(() => decrypt(ciphertext, iv, randomBytes(32))).toThrow();
  });

  it('throws on tampered ciphertext (GCM auth failure)', () => {
    const { ciphertext, iv } = encrypt('secret', KEY);
    const raw = Buffer.from(ciphertext, 'base64');
    raw[0] = raw[0]! ^ 0xff; // flip a bit
    expect(() => decrypt(raw.toString('base64'), iv, KEY)).toThrow();
  });
});

describe('loadEncryptionKey', () => {
  it('returns a 32-byte Buffer for a valid base64 key', () => {
    const env = { SECRET_ENCRYPTION_KEY: randomBytes(32).toString('base64') };
    expect(loadEncryptionKey(env).length).toBe(32);
  });

  it('throws with a generate hint when the key is missing', () => {
    expect(() => loadEncryptionKey({})).toThrow(/openssl rand -base64 32/);
  });

  it('throws when the key does not decode to exactly 32 bytes', () => {
    const env = { SECRET_ENCRYPTION_KEY: Buffer.from('too-short').toString('base64') };
    expect(() => loadEncryptionKey(env)).toThrow(/32 bytes/);
  });
});
