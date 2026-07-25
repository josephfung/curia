import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  AUDIT_GENESIS_SEED,
  GENESIS_HASH,
  canonicalJson,
  computeEntryHash,
} from '../../../src/audit/hash-chain.js';

describe('hash-chain', () => {
  it('genesis hash is SHA-256 of the fixed seed', () => {
    expect(GENESIS_HASH).toBe(
      createHash('sha256').update(AUDIT_GENESIS_SEED).digest('hex'),
    );
  });

  it('canonicalJson sorts object keys and omits whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      '{"a":{"c":3,"d":2},"b":1}',
    );
  });

  it('canonicalJson round-trips Date to the same ISO string JSONB will store', () => {
    const ts = new Date('2026-04-10T08:30:00.000Z');
    // Live Date objects must hash identically to the ISO string that ends up
    // in audit_log.payload — otherwise verify recomputes a different hash.
    expect(canonicalJson({ mergedAt: ts })).toBe(
      canonicalJson({ mergedAt: '2026-04-10T08:30:00.000Z' }),
    );
    expect(canonicalJson({ mergedAt: ts })).toBe(
      '{"mergedAt":"2026-04-10T08:30:00.000Z"}',
    );
  });

  it('computeEntryHash is deterministic and changes when previous hash changes', () => {
    const fields = {
      id: '00000000-0000-4000-8000-000000000001',
      timestamp: '2026-07-24T12:00:00.000Z',
      event_type: 'inbound.message',
      source_layer: 'channel',
      source_id: 'email',
      payload: { conversationId: 'c1', content: 'hi' },
      conversation_id: 'c1',
      task_id: null,
      parent_event_id: null,
      action: 'receive',
      outcome: 'success',
      target_type: 'conversation',
      target_id: 'c1',
      initiator_type: 'human',
      initiator_id: 'u1',
    };

    const h1 = computeEntryHash(fields, GENESIS_HASH);
    const h2 = computeEntryHash(fields, GENESIS_HASH);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[a-f0-9]{64}$/);

    const h3 = computeEntryHash(fields, h1);
    expect(h3).not.toBe(h1);
  });
});
