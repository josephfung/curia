import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { createRulesDoc, INBOX_RULES_PATH } from '../../../src/principal-mailboxes/rules-doc.js';

const logger = pino({ level: 'silent' });

describe('createRulesDoc', () => {
  it('reads the body and writes against the version it read', async () => {
    const repo = {
      read: vi.fn(async () => ({ body: '## A', version: 4 })),
      update: vi.fn(async () => ({ ok: true })),
      create: vi.fn(async () => ({})),
      append: vi.fn(async () => ({ ok: true })),
    };
    const doc = createRulesDoc(repo as never, logger);
    expect(await doc.read()).toBe('## A');
    await doc.write('## B');
    expect(repo.update).toHaveBeenCalledWith(INBOX_RULES_PATH, { body: '## B', expectedVersion: 4 });
  });

  it('returns null for a missing document and refuses a write after a conflict', async () => {
    const repo = { read: vi.fn(async () => null), update: vi.fn(async () => ({ ok: false, conflict: true })), create: vi.fn(), append: vi.fn() };
    const doc = createRulesDoc(repo as never, logger);
    expect(await doc.read()).toBeNull();
    await expect(doc.write('x')).rejects.toThrow(/before it was read/);
    repo.read.mockResolvedValueOnce({ body: 'a', version: 1 } as never);
    await doc.read();
    await expect(doc.write('x')).rejects.toThrow(/changed/);
  });

  it('records the rewrite in the directory log, attributed to the console admin', async () => {
    const repo = {
      read: vi.fn(async (path: string) => (path.endsWith('log.md') ? { body: '', version: 2 } : { body: '## A', version: 4 })),
      update: vi.fn(async () => ({ ok: true })),
      create: vi.fn(),
      append: vi.fn(async () => ({ ok: true })),
    };
    const doc = createRulesDoc(repo as never, logger);
    await doc.read();
    await doc.write('## B', 'mailbox "work" removed: deleted rule A');
    expect(repo.append).toHaveBeenCalledTimes(1);
    const [path, params] = repo.append.mock.calls[0] as unknown as [string, { content: string }];
    expect(path).toBe('/shared/inbox/log.md');
    expect(params.content).toContain('mailbox-removal');
    expect(params.content).toContain('deleted rule A');
  });
});
