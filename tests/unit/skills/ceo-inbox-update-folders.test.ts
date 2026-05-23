import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';
import type { SkillContext } from '../../../src/skills/types.js';
import { CeoInboxUpdateFoldersHandler } from '../../../skills/ceo-inbox-update-folders/handler.js';

const logger = pino({ level: 'silent' });

// CeoNylasClient uses global fetch — spy on it rather than mocking the constructor.
// This avoids ESM constructor-mock complications and follows the ceo-nylas-client.test.ts pattern.

function makeCtx(input: Record<string, unknown>): SkillContext {
  return {
    input,
    secret: (key: string) => `fake-${key}`,
    log: logger,
  } as unknown as SkillContext;
}

/** Build a successful Nylas JSON envelope response. */
function nylasOk(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Build a minimal Nylas message object (only fields the handler cares about). */
function nylasMsg(id: string, folders: string[]) {
  return { id, thread_id: 'thread-1', subject: 'Test', from: [], to: [], cc: [], snippet: '', date: 0, unread: false, folders };
}

describe('CeoInboxUpdateFoldersHandler', () => {
  const handler = new CeoInboxUpdateFoldersHandler();

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // ── Input validation ──────────────────────────────────────────────────────

  it('returns failure when message_id is missing', async () => {
    const result = await handler.execute(makeCtx({ add_folders: ['INBOX'] }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('message_id');
  });

  it('returns failure when both add_folders and remove_folders are empty', async () => {
    const result = await handler.execute(makeCtx({ message_id: 'msg-1' }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('at least one');
  });

  // ── Normal path ───────────────────────────────────────────────────────────

  it('returns the folders from the Nylas response when non-empty', async () => {
    vi.spyOn(globalThis, 'fetch')
      // First call: getMessage → current folders are INBOX, SENT
      .mockResolvedValueOnce(nylasOk(nylasMsg('msg-1', ['INBOX', 'SENT'])))
      // Second call: updateMessageFolders → Nylas confirms new folder set
      .mockResolvedValueOnce(nylasOk(nylasMsg('msg-1', ['INBOX', 'SENT', 'IMPORTANT'])));

    const result = await handler.execute(
      makeCtx({ message_id: 'msg-1', add_folders: ['IMPORTANT'] }),
    );

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { folders: string[] };
      expect(data.folders).toEqual(['INBOX', 'SENT', 'IMPORTANT']);
    }
  });

  it('removes the specified folder from the current set', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(nylasOk(nylasMsg('msg-1', ['INBOX', 'SPAM'])))
      .mockResolvedValueOnce(nylasOk(nylasMsg('msg-1', ['INBOX'])));

    const result = await handler.execute(
      makeCtx({ message_id: 'msg-1', remove_folders: ['SPAM'] }),
    );

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { folders: string[] };
      expect(data.folders).toEqual(['INBOX']);
    }
  });

  // ── Empty-folders guard (the bug fixed by issue #596) ────────────────────

  it('falls back to the computed folder list when Nylas returns empty folders', async () => {
    // Nylas omits the folders field — CeoNylasClient normalises it to [] via `data.folders ?? []`.
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(nylasOk(nylasMsg('msg-1', ['INBOX'])))
      // Nylas PUT response with folders omitted — normalises to []
      .mockResolvedValueOnce(nylasOk({ id: 'msg-1' }));

    const result = await handler.execute(
      makeCtx({ message_id: 'msg-1', add_folders: ['IMPORTANT'] }),
    );

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { folders: string[] };
      // Must return the computed set (INBOX + IMPORTANT), not the empty Nylas response.
      expect(data.folders).toEqual(['INBOX', 'IMPORTANT']);
    }
  });

  it('does not duplicate a folder that is already present', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(nylasOk(nylasMsg('msg-1', ['INBOX', 'IMPORTANT'])))
      .mockResolvedValueOnce(nylasOk(nylasMsg('msg-1', ['INBOX', 'IMPORTANT'])));

    const result = await handler.execute(
      makeCtx({ message_id: 'msg-1', add_folders: ['IMPORTANT'] }),
    );

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { folders: string[] };
      expect(data.folders).toEqual(['INBOX', 'IMPORTANT']);
    }
  });

  // ── Error handling ────────────────────────────────────────────────────────

  it('returns failure when getMessage throws', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Nylas 404'));

    const result = await handler.execute(
      makeCtx({ message_id: 'msg-missing', add_folders: ['INBOX'] }),
    );

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('Failed to update');
  });
});
