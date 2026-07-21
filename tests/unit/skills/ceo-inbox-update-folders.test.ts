import { describe, it, expect, vi, afterEach } from 'vitest';
import pino from 'pino';
import type { ToolContext } from '../../../src/skills/types.js';
import { CeoInboxUpdateFoldersHandler } from '../../../skills/ceo-inbox/tools/ceo-inbox-update-folders/handler.js';

const logger = pino({ level: 'silent' });

// CeoNylasClient uses global fetch. The handler now resolves label display names to
// Gmail label IDs, so it calls listFolders (GET /folders), optionally createFolder
// (POST /folders), then getMessage (GET /messages/:id), then updateMessageFolders
// (PUT /messages/:id). Route the fetch mock by URL + method so tests are robust to
// the call order/count rather than relying on a fixed mockResolvedValueOnce sequence.

interface FolderFixture {
  id: string;
  name: string;
}

function jsonResponse(obj: unknown): Response {
  return new Response(JSON.stringify({ data: obj }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockNylas(opts: {
  folders: FolderFixture[];
  messageFolders: string[];
  getMessageThrows?: boolean;
  putEmptyFolders?: boolean;
  putError?: { status: number; body: string };
}) {
  const folders = [...opts.folders];
  const calls: { putFolders: string[] | null; createdNames: string[] } = {
    putFolders: null,
    createdNames: [],
  };

  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();

    if (url.endsWith('/folders') && method === 'GET') {
      return jsonResponse(folders);
    }
    if (url.endsWith('/folders') && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as { name: string };
      const created = { id: `Label_new_${calls.createdNames.length}`, name: body.name };
      calls.createdNames.push(body.name);
      folders.push(created);
      return jsonResponse(created);
    }
    if (url.includes('/messages/') && method === 'GET') {
      if (opts.getMessageThrows) throw new Error('Nylas 404');
      return jsonResponse({ id: 'msg-1', folders: opts.messageFolders });
    }
    if (url.includes('/messages/') && method === 'PUT') {
      const body = JSON.parse(String(init?.body)) as { folders: string[] };
      calls.putFolders = body.folders;
      if (opts.putError) {
        return new Response(opts.putError.body, {
          status: opts.putError.status,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      // putEmptyFolders models Nylas omitting the folders field on the PUT echo.
      return jsonResponse(opts.putEmptyFolders ? { id: 'msg-1' } : { id: 'msg-1', folders: body.folders });
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });

  return { spy, calls };
}

function makeCtx(input: Record<string, unknown>): ToolContext {
  return {
    input,
    secret: (key: string) => `fake-${key}`,
    log: logger,
  } as unknown as ToolContext;
}

// System folders (id === name) plus the emoji triage labels (id !== name).
const FOLDERS: FolderFixture[] = [
  { id: 'INBOX', name: 'INBOX' },
  { id: 'SENT', name: 'SENT' },
  { id: 'IMPORTANT', name: 'IMPORTANT' },
  { id: 'SPAM', name: 'SPAM' },
  { id: 'Label_43', name: '⏳ In Progress' },
  { id: 'Label_39', name: '✍️ Drafted' },
];

describe('CeoInboxUpdateFoldersHandler', () => {
  const handler = new CeoInboxUpdateFoldersHandler();

  afterEach(() => vi.restoreAllMocks());

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

  // ── Normal path (system folders, id === name) ─────────────────────────────

  it('returns the folders from the Nylas response when non-empty', async () => {
    mockNylas({ folders: FOLDERS, messageFolders: ['INBOX', 'SENT'] });

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
    mockNylas({ folders: FOLDERS, messageFolders: ['INBOX', 'SPAM'] });

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
    mockNylas({ folders: FOLDERS, messageFolders: ['INBOX'], putEmptyFolders: true });

    const result = await handler.execute(
      makeCtx({ message_id: 'msg-1', add_folders: ['IMPORTANT'] }),
    );

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { folders: string[] };
      expect(data.folders).toEqual(['INBOX', 'IMPORTANT']);
    }
  });

  it('does not duplicate a folder that is already present', async () => {
    mockNylas({ folders: FOLDERS, messageFolders: ['INBOX', 'IMPORTANT'] });

    const result = await handler.execute(
      makeCtx({ message_id: 'msg-1', add_folders: ['IMPORTANT'] }),
    );

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { folders: string[] };
      expect(data.folders).toEqual(['INBOX', 'IMPORTANT']);
    }
  });

  // ── Label name → ID resolution (issue #1216) ──────────────────────────────

  it('resolves a display-name remove_folders to its label ID and removes it', async () => {
    const { calls } = mockNylas({ folders: FOLDERS, messageFolders: ['INBOX', 'Label_43'] });

    const result = await handler.execute(
      makeCtx({ message_id: 'msg-1', remove_folders: ['⏳ In Progress'] }),
    );

    expect(result.success).toBe(true);
    expect(calls.putFolders).not.toContain('Label_43');
    expect(calls.putFolders).not.toContain('⏳ In Progress');
    expect(calls.putFolders).toContain('INBOX');
  });

  it('resolves an ID token to the ID even when another label is named that ID', async () => {
    // Pathological: a user label whose display name is literally another label's ID.
    // An ID token must resolve to the ID folder, not the name-collision folder.
    const folders: FolderFixture[] = [
      { id: 'INBOX', name: 'INBOX' },
      { id: 'Label_43', name: '⏳ In Progress' },
      { id: 'Label_77', name: 'Label_43' }, // display name collides with the ID above
    ];
    const { calls } = mockNylas({
      folders,
      messageFolders: ['INBOX', 'Label_43', 'Label_77'],
    });

    const result = await handler.execute(
      makeCtx({ message_id: 'msg-1', remove_folders: ['Label_43'] }),
    );

    expect(result.success).toBe(true);
    expect(calls.putFolders).not.toContain('Label_43'); // the ID was removed
    expect(calls.putFolders).toContain('Label_77'); // the name-collision label untouched
    expect(calls.putFolders).toContain('INBOX');
  });

  it('resolves a display-name add_folders to an existing label ID', async () => {
    const { calls } = mockNylas({ folders: FOLDERS, messageFolders: ['INBOX'] });

    const result = await handler.execute(
      makeCtx({ message_id: 'msg-1', add_folders: ['✍️ Drafted'] }),
    );

    expect(result.success).toBe(true);
    expect(calls.putFolders).toContain('Label_39');
    expect(calls.putFolders).not.toContain('✍️ Drafted');
    expect(calls.createdNames).toEqual([]);
  });

  it('creates a missing label for add_folders and writes the new ID', async () => {
    const { calls } = mockNylas({ folders: FOLDERS, messageFolders: ['INBOX'] });

    const result = await handler.execute(
      makeCtx({ message_id: 'msg-1', add_folders: ['🚀 Brand New'] }),
    );

    expect(result.success).toBe(true);
    expect(calls.createdNames).toEqual(['🚀 Brand New']);
    expect(calls.putFolders).toContain('Label_new_0');
    expect(calls.putFolders).not.toContain('🚀 Brand New');
  });

  it('combines add + remove in a single write', async () => {
    const { calls } = mockNylas({ folders: FOLDERS, messageFolders: ['INBOX', 'Label_43'] });

    const result = await handler.execute(
      makeCtx({
        message_id: 'msg-1',
        add_folders: ['✍️ Drafted'],
        remove_folders: ['⏳ In Progress'],
      }),
    );

    expect(result.success).toBe(true);
    expect(calls.putFolders).toContain('Label_39');
    expect(calls.putFolders).not.toContain('Label_43');
    expect(calls.putFolders).toContain('INBOX');
  });

  it('reports remove tokens that match no folder in removed_unresolved', async () => {
    const { calls } = mockNylas({ folders: FOLDERS, messageFolders: ['INBOX', 'Label_43'] });

    const result = await handler.execute(
      makeCtx({
        message_id: 'msg-1',
        remove_folders: ['⏳ In Progress', '🤷 Does Not Exist'],
      }),
    );

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { removed_unresolved: string[] };
      expect(data.removed_unresolved).toEqual(['🤷 Does Not Exist']);
    }
    expect(calls.putFolders).not.toContain('Label_43');
  });

  // ── Error handling ────────────────────────────────────────────────────────

  it('returns failure when getMessage throws', async () => {
    mockNylas({ folders: FOLDERS, messageFolders: [], getMessageThrows: true });

    const result = await handler.execute(
      makeCtx({ message_id: 'msg-missing', add_folders: ['INBOX'] }),
    );

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('Failed to update');
  });

  it('surfaces the underlying error detail when the folder write fails', async () => {
    mockNylas({
      folders: FOLDERS,
      messageFolders: ['INBOX'],
      putError: {
        status: 400,
        body: JSON.stringify({ error: { message: 'Invalid label: ⏳ In Progress' } }),
      },
    });

    const result = await handler.execute(
      makeCtx({ message_id: 'msg-1', add_folders: ['✍️ Drafted'] }),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Failed to update CEO inbox message folders');
      expect(result.error).toContain('400');
    }
  });
});
