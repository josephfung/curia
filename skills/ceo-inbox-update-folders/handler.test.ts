// handler.test.ts — unit tests for ceo-inbox-update-folders skill.
//
// Mocks globalThis.fetch and routes by URL + method, so the test is robust to
// the number/order of Nylas calls the handler makes. The key behaviour under
// test: add_folders / remove_folders are display names (e.g. "⏳ In Progress")
// and must be resolved to Gmail label IDs (e.g. "Label_43") before the PUT —
// otherwise Gmail rejects the write with "Invalid label".

import { describe, it, expect, vi, afterEach } from 'vitest';
import { CeoInboxUpdateFoldersHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';
import { createSilentLogger } from '../../src/logger.js';

interface NylasFolderFixture {
  id: string;
  name: string;
}

function jsonResponse(obj: unknown): Response {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Route fetch by URL + method against an in-memory folder list and message.
 * Returns the spy plus a `calls` record capturing the PUT body and any
 * createFolder POSTs, for assertions.
 */
function mockNylas(opts: {
  folders: NylasFolderFixture[];
  messageFolders: string[];
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
      return jsonResponse({ data: folders });
    }
    if (url.endsWith('/folders') && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as { name: string };
      const created = { id: `Label_new_${calls.createdNames.length}`, name: body.name };
      calls.createdNames.push(body.name);
      folders.push(created); // visible to any subsequent resolution in the same run
      return jsonResponse({ data: created });
    }
    if (url.includes('/messages/') && method === 'GET') {
      return jsonResponse({ data: { id: 'msg-1', folders: opts.messageFolders } });
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
      return jsonResponse({ data: { id: 'msg-1', folders: body.folders } });
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });

  return { spy, calls };
}

function makeCtx(input: Record<string, unknown>): SkillContext {
  return {
    input,
    secret: (_name: string) => 'test-secret',
    log: createSilentLogger(),
    taskMetadata: {},
    taskEventId: undefined,
  } as unknown as SkillContext;
}

const FOLDERS: NylasFolderFixture[] = [
  { id: 'INBOX', name: 'INBOX' },
  { id: 'Label_43', name: '⏳ In Progress' },
  { id: 'Label_39', name: '✍️ Drafted' },
  { id: 'Label_55', name: '✅ Handled' },
];

describe('CeoInboxUpdateFoldersHandler — label name/ID resolution', () => {
  afterEach(() => vi.restoreAllMocks());

  it('resolves a display-name in remove_folders to its label ID and removes it', async () => {
    const { calls } = mockNylas({ folders: FOLDERS, messageFolders: ['INBOX', 'Label_43'] });
    const handler = new CeoInboxUpdateFoldersHandler();

    const result = await handler.execute(
      makeCtx({ message_id: 'msg-1', remove_folders: ['⏳ In Progress'] }),
    );

    expect(result.success).toBe(true);
    expect(calls.putFolders).not.toBeNull();
    // The ID for "⏳ In Progress" must be gone, and the raw display name must
    // never appear in the folder set written to Gmail.
    expect(calls.putFolders).not.toContain('Label_43');
    expect(calls.putFolders).not.toContain('⏳ In Progress');
    expect(calls.putFolders).toContain('INBOX');
  });

  it('resolves a display-name in add_folders to an existing label ID', async () => {
    const { calls } = mockNylas({ folders: FOLDERS, messageFolders: ['INBOX'] });
    const handler = new CeoInboxUpdateFoldersHandler();

    const result = await handler.execute(
      makeCtx({ message_id: 'msg-1', add_folders: ['✍️ Drafted'] }),
    );

    expect(result.success).toBe(true);
    expect(calls.putFolders).toContain('Label_39');
    expect(calls.putFolders).not.toContain('✍️ Drafted');
    expect(calls.createdNames).toEqual([]); // existing label — no creation
  });

  it('creates a missing label for add_folders and writes the new ID', async () => {
    const { calls } = mockNylas({ folders: FOLDERS, messageFolders: ['INBOX'] });
    const handler = new CeoInboxUpdateFoldersHandler();

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
    const handler = new CeoInboxUpdateFoldersHandler();

    const result = await handler.execute(
      makeCtx({
        message_id: 'msg-1',
        add_folders: ['✍️ Drafted'],
        remove_folders: ['⏳ In Progress'],
      }),
    );

    expect(result.success).toBe(true);
    expect(calls.putFolders).toContain('Label_39'); // ✍️ Drafted added
    expect(calls.putFolders).not.toContain('Label_43'); // ⏳ In Progress removed
    expect(calls.putFolders).toContain('INBOX'); // untouched
  });

  it('reports remove tokens that match no folder in removed_unresolved', async () => {
    const { calls } = mockNylas({ folders: FOLDERS, messageFolders: ['INBOX', 'Label_43'] });
    const handler = new CeoInboxUpdateFoldersHandler();

    const result = await handler.execute(
      makeCtx({
        message_id: 'msg-1',
        remove_folders: ['⏳ In Progress', '🤷 Does Not Exist'],
      }),
    );

    expect(result.success).toBe(true);
    const data = (result as { data: Record<string, unknown> }).data;
    expect(data.removed_unresolved).toEqual(['🤷 Does Not Exist']);
    // The resolvable one is still removed.
    expect(calls.putFolders).not.toContain('Label_43');
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
    const handler = new CeoInboxUpdateFoldersHandler();

    const result = await handler.execute(
      makeCtx({ message_id: 'msg-1', add_folders: ['✍️ Drafted'] }),
    );

    expect(result.success).toBe(false);
    // The generic prefix is kept, but the real Nylas/Gmail detail is appended so
    // the agent can adapt instead of seeing an opaque "Bad Request".
    const error = (result as { error: string }).error;
    expect(error).toContain('Failed to update CEO inbox message folders');
    expect(error).toContain('400');
  });
});
