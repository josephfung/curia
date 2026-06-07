// Pure AES-256-GCM encryption helpers and key loading for the secrets vault.
// No DB, no logging, no global state — deliberately trivial to unit-test.
//
// Wire format for `encrypted_value`: base64( ciphertext-bytes || 16-byte GCM auth tag ).
// The IV is stored separately (base64) and is a fresh 12 random bytes per write.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;        // 96-bit nonce — the standard/recommended size for GCM
const AUTH_TAG_BYTES = 16;  // 128-bit GCM tag
const GENERATE_HINT = 'Generate one with: openssl rand -base64 32';

/** Encrypt a UTF-8 string. Returns base64 ciphertext (with appended auth tag) and base64 IV. */
export function encrypt(plaintext: string, key: Buffer): { ciphertext: string; iv: string } {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    ciphertext: Buffer.concat([encrypted, authTag]).toString('base64'),
    iv: iv.toString('base64'),
  };
}

/** Decrypt. Throws on a wrong key or tampered ciphertext (GCM auth failure) — never returns garbage. */
export function decrypt(ciphertext: string, iv: string, key: Buffer): string {
  const data = Buffer.from(ciphertext, 'base64');
  // Guard against corrupt DB rows that are too short to contain a valid auth tag.
  // Without this, subarray() silently wraps and Node throws a confusing ERR_CRYPTO_INVALID_AUTH_TAG.
  if (data.length < AUTH_TAG_BYTES) {
    throw new Error(
      `Ciphertext is too short (${data.length} bytes) to contain a valid GCM auth tag`,
    );
  }
  // Split the appended auth tag off the end.
  const authTag = data.subarray(data.length - AUTH_TAG_BYTES);
  const encrypted = data.subarray(0, data.length - AUTH_TAG_BYTES);
  // nosemgrep: javascript.node-crypto.security.gcm-no-tag-length.gcm-no-tag-length
  // AES-256-GCM enforces a fixed 128-bit (16-byte) auth tag — setAuthTagLength()
  // does not exist on DecipherGCM; it is only relevant for CCM/OCB modes with
  // variable tag lengths. Truncated-tag attacks are already prevented by the
  // AUTH_TAG_BYTES length check above and the fixed split of `data.subarray()`.
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

/**
 * Load the master encryption key from the environment. Required at startup —
 * a missing or malformed key is a hard failure (fail closed). The vault stores
 * a 32-byte AES-256 key as base64.
 */
export function loadEncryptionKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env.SECRET_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(`SECRET_ENCRYPTION_KEY environment variable is required. ${GENERATE_HINT}`);
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error(
      `SECRET_ENCRYPTION_KEY must decode to exactly 32 bytes (got ${key.length}). ${GENERATE_HINT}`,
    );
  }
  return key;
}
