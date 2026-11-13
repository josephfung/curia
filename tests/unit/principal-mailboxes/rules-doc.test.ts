import { describe, it, expect, vi } from 'vitest';
import { createRulesDoc, INBOX_RULES_PATH } from '../../../src/principal-mailboxes/rules-doc.js';

describe('createRulesDoc', () => {
  it('reads the body and writes against the version it read', async () => {
    const repo = {
      read: vi.fn(async () => ({ body: '## A', version: 4 })),
      update: vi.fn(async () => ({ ok: true })),
    };
    const doc = createRulesDoc(repo as never);
    expect(await doc.read()).toBe('## A');
    await doc.write('## B');
    expect(repo.update).toHaveBeenCalledWith(INBOX_RULES_PATH, { body: '## B', expectedVersion: 4 });
  });

  it('returns null for a missing document and refuses a write after a conflict', async () => {
    const repo = { read: vi.fn(async () => null), update: vi.fn(async () => ({ ok: false, conflict: true })) };
    const doc = createRulesDoc(repo as never);
    expect(await doc.read()).toBeNull();
    await expect(doc.write('x')).rejects.toThrow(/before it was read/);
    repo.read.mockResolvedValueOnce({ body: 'a', version: 1 } as never);
    await doc.read();
    await expect(doc.write('x')).rejects.toThrow(/changed/);
  });
});
