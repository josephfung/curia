import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  TelnyxSignatureError,
  verifyTelnyxSignature,
} from '../../../../src/channels/sms/verify-signature.js';

function telnyxKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  const rawPublic = spki.subarray(-32);
  return {
    privateKey,
    publicKeyBase64: rawPublic.toString('base64'),
  };
}

describe('verifyTelnyxSignature', () => {
  it('accepts a valid signature within the tolerance window', () => {
    const { privateKey, publicKeyBase64 } = telnyxKeyPair();
    const rawBody = Buffer.from('{"data":{"event_type":"message.received"}}', 'utf8');
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signed = Buffer.concat([
      Buffer.from(timestamp, 'utf8'),
      Buffer.from('|', 'utf8'),
      rawBody,
    ]);
    const signature = sign(null, signed, privateKey).toString('base64');

    expect(() =>
      verifyTelnyxSignature(rawBody, signature, timestamp, publicKeyBase64),
    ).not.toThrow();
  });

  it('rejects missing headers, bad timestamps, and bad signatures', () => {
    const { privateKey, publicKeyBase64 } = telnyxKeyPair();
    const rawBody = Buffer.from('{}', 'utf8');
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signed = Buffer.concat([
      Buffer.from(timestamp, 'utf8'),
      Buffer.from('|', 'utf8'),
      rawBody,
    ]);
    const signature = sign(null, signed, privateKey).toString('base64');

    expect(() => verifyTelnyxSignature(rawBody, undefined, timestamp, publicKeyBase64))
      .toThrow(TelnyxSignatureError);
    expect(() => verifyTelnyxSignature(rawBody, signature, 'not-a-number', publicKeyBase64))
      .toThrow(TelnyxSignatureError);
    expect(() =>
      verifyTelnyxSignature(rawBody, signature, String(Math.floor(Date.now() / 1000) - 10_000), publicKeyBase64),
    ).toThrow(/tolerance/);
    expect(() =>
      verifyTelnyxSignature(rawBody, Buffer.alloc(64).toString('base64'), timestamp, publicKeyBase64),
    ).toThrow(/mismatch/);
  });
});
