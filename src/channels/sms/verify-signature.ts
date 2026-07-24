// verify-signature.ts — Telnyx Ed25519 webhook signature verification.
//
// Telnyx signs `{timestamp}|{rawBody}` with Ed25519. Headers:
//   telnyx-signature-ed25519 — base64 signature
//   telnyx-timestamp — Unix seconds
// Public key: Mission Control → Account Settings → Keys & Credentials (base64, 32-byte raw).

import { createPublicKey, verify, timingSafeEqual } from 'node:crypto';

const DEFAULT_TOLERANCE_SECONDS = 300;

/** SPKI DER prefix for a raw 32-byte Ed25519 public key. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export class TelnyxSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TelnyxSignatureError';
  }
}

function buildPublicKey(publicKeyBase64: string) {
  const raw = Buffer.from(publicKeyBase64, 'base64');
  if (raw.length !== 32) {
    throw new TelnyxSignatureError(
      `Telnyx webhook public key must decode to 32 bytes (got ${raw.length})`,
    );
  }
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  });
}

/**
 * Verify a Telnyx Messaging webhook signature.
 *
 * @param rawBody — exact request body bytes (or utf8 string) as received
 * @param signatureHeader — `telnyx-signature-ed25519` (base64)
 * @param timestampHeader — `telnyx-timestamp` (Unix seconds as string)
 * @param publicKeyBase64 — account public key from Mission Control
 * @param toleranceSeconds — replay window (default 300s)
 */
export function verifyTelnyxSignature(
  rawBody: Buffer | string,
  signatureHeader: string | undefined,
  timestampHeader: string | undefined,
  publicKeyBase64: string,
  toleranceSeconds: number = DEFAULT_TOLERANCE_SECONDS,
): void {
  if (!signatureHeader || !timestampHeader) {
    throw new TelnyxSignatureError('Missing Telnyx signature or timestamp header');
  }

  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp)) {
    throw new TelnyxSignatureError('Invalid Telnyx timestamp header');
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) {
    throw new TelnyxSignatureError('Telnyx webhook timestamp outside tolerance window');
  }

  const bodyBuf = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
  const signed = Buffer.concat([
    Buffer.from(String(timestamp), 'utf8'),
    Buffer.from('|', 'utf8'),
    bodyBuf,
  ]);

  let signature: Buffer;
  try {
    signature = Buffer.from(signatureHeader, 'base64');
  } catch {
    throw new TelnyxSignatureError('Invalid Telnyx signature encoding');
  }

  if (signature.length !== 64) {
    throw new TelnyxSignatureError(`Telnyx signature must be 64 bytes (got ${signature.length})`);
  }

  const key = buildPublicKey(publicKeyBase64);
  const ok = verify(null, signed, key, signature);
  if (!ok) {
    throw new TelnyxSignatureError('Telnyx webhook signature mismatch');
  }
}

/**
 * Constant-time compare of two utf8 secrets (for tests / misc). Prefer
 * verifyTelnyxSignature for webhook auth.
 */
export function timingSafeStringEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
