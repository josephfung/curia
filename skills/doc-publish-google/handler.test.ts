import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ToolContext } from '../../src/skills/types.js';
import type { UpdateWorkingDocParams, WorkingDocRow, WorkingDocWriteResult } from '../../src/db/working-docs-repo.js';
import { createHash } from 'node:crypto';
import { createSilentLogger } from '../../src/logger.js';

const drive = vi.hoisted(() => ({
  create: vi.fn(),
  get: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  export: vi.fn(),
  commentsList: vi.fn(),
}));

vi.mock('googleapis', () => ({
  google: {
    drive: vi.fn(() => ({
      files: { create: drive.create, get: drive.get, update: drive.update, delete: drive.delete, export: drive.export },
      comments: { list: drive.commentsList },
    })),
  },
}));

const getDriveClient = vi.hoisted(() => vi.fn());
vi.mock('../../src/google/drive-auth.js', () => ({ getDriveClient }));

import { DocPublishGoogleHandler } from './handler.js';

const GDOC = 'application/vnd.google-apps.document';
const DOC_ID = '11111111-1111-4111-8111-111111111111';
const PATH = '/projects/board-prep/brief.md';
const BODY = '# Brief\n\nSome **bold** text.\n';

const SECRETS: Record<string, string> = {
  google_oauth_client_id: 'id.apps.googleusercontent.com',
  google_oauth_client_secret: 'GOCSPX-test',
  curia_google_email: 'curia@test.com',
};

function makeDoc(overrides: Partial<WorkingDocRow> = {}): WorkingDocRow {
  return {
    id: DOC_ID,
    path: PATH,
    type: 'brief',
    frontmatter: { title: 'Board brief' },
    body: BODY,
    version: 3,
    sectionVersions: {},
    byteSize: 100,
    taskId: null,
    conversationId: null,
    agentId: null,
    createdAt: '2026-11-25T12:00:00.000Z',
    updatedAt: '2026-11-25T12:00:00.000Z',
    archivedAt: null,
    ...overrides,
  };
}

/** An in-memory store holding one document, with doc-write's optimistic version check. */
function makeRepo(initial: WorkingDocRow | null) {
  let current = initial;
  const updates: UpdateWorkingDocParams[] = [];
  return {
    updates,
    get current() { return current; },
    set current(doc: WorkingDocRow | null) { current = doc; },
    read: vi.fn(async (path: string) => (current && current.path === path ? current : null)),
    update: vi.fn(async (_path: string, params: UpdateWorkingDocParams): Promise<WorkingDocWriteResult> => {
      updates.push(params);
      if (!current || current.version !== params.expectedVersion || current.id !== params.expectedId) {
        return { ok: false, conflict: true, document: current! };
      }
      current = {
        ...current,
        frontmatter: params.frontmatter ?? current.frontmatter,
        body: params.body ?? current.body,
        version: current.version + 1,
      };
      return { ok: true, document: current };
    }),
  };
}

function makeCtx(repo: ReturnType<typeof makeRepo> | null, input: Record<string, unknown>, overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    input,
    secret: vi.fn((name: string) => {
      const value = SECRETS[name];
      if (value === undefined) throw new Error(`Secret '${name}' is declared but not set`);
      return value;
    }),
    log: createSilentLogger(),
    workingDocs: repo ?? undefined,
    agentId: 'coordinator',
    ...overrides,
  } as unknown as ToolContext;
}

/** What the handler records for a Doc whose Markdown export is `text`. */
const hashOf = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);
/** The doc_version a refusal names for that export and those open comments (`id@modifiedTime`). */
const versionOf = (text: string, states: string[] = []) => hashOf(`${text}\n\u0000open-comments:${[...states].sort().join(',')}`);
const PUBLISHED_EXPORT = '# Brief\n\nSome **bold** text.\n';
const EDITED_EXPORT = '# Brief\n\nSome **bold** text, edited by the principal.\n';

const RECORD = {
  id: 'gdoc-1',
  url: 'https://docs.google.com/document/d/gdoc-1/edit',
  published_at: '2026-11-24T10:00:00.000Z',
  content_hash: hashOf(PUBLISHED_EXPORT),
};

beforeEach(() => {
  vi.clearAllMocks();
  getDriveClient.mockResolvedValue({});
  drive.commentsList.mockResolvedValue({ data: { comments: [] } });
  drive.export.mockResolvedValue({ data: PUBLISHED_EXPORT });
});

describe('doc-publish-google — input and document checks', () => {
  it('requires path', async () => {
    const result = await new DocPublishGoogleHandler().execute(makeCtx(makeRepo(makeDoc()), {}));
    expect(result).toEqual({ success: false, error: expect.stringContaining('path') });
  });

  it('rejects a non-boolean overwrite', async () => {
    const result = await new DocPublishGoogleHandler().execute(makeCtx(makeRepo(makeDoc()), { path: PATH, overwrite: 'yes' }));
    expect(result).toEqual({ success: false, error: expect.stringContaining('overwrite') });
  });

  it('errors when the workspace is not configured', async () => {
    const result = await new DocPublishGoogleHandler().execute(makeCtx(null, { path: PATH }));
    expect(result.success).toBe(false);
  });

  it('errors on an unknown path without calling Drive', async () => {
    const result = await new DocPublishGoogleHandler().execute(makeCtx(makeRepo(makeDoc()), { path: '/projects/x/missing.md' }));
    expect(result).toEqual({ success: false, error: expect.stringContaining('No document at /projects/x/missing.md') });
    expect(drive.create).not.toHaveBeenCalled();
  });

  it('errors on an empty body', async () => {
    const result = await new DocPublishGoogleHandler().execute(makeCtx(makeRepo(makeDoc({ body: '  \n' })), { path: PATH }));
    expect(result).toEqual({ success: false, error: expect.stringContaining('no body') });
  });

  it('refuses a console-only document (it cannot record the Doc there)', async () => {
    const repo = makeRepo(makeDoc({ frontmatter: { editable_by: 'console' } }));
    const result = await new DocPublishGoogleHandler().execute(makeCtx(repo, { path: PATH }));
    expect(result).toEqual({ success: false, error: expect.stringContaining('console') });
    expect(drive.create).not.toHaveBeenCalled();
  });

  it('refuses a /shared/ document the calling agent does not declare', async () => {
    const repo = makeRepo(makeDoc({ path: '/shared/principal/priorities.md' }));
    const ctx = makeCtx(repo, { path: '/shared/principal/priorities.md' }, {
      agentRegistry: { get: () => ({ pinnedDocPaths: [] }) } as unknown as ToolContext['agentRegistry'],
    });
    const result = await new DocPublishGoogleHandler().execute(ctx);
    expect(result).toEqual({ success: false, error: expect.stringContaining('shared document') });
    expect(drive.create).not.toHaveBeenCalled();
  });

  it('refuses the principal-mailbox send ledger', async () => {
    const ledger = '/scratch/principal-mailbox-sends/2026-11.md';
    const repo = makeRepo(makeDoc({ path: ledger }));
    const result = await new DocPublishGoogleHandler().execute(makeCtx(repo, { path: ledger }));
    expect(result).toEqual({ success: false, error: expect.stringContaining('only the send path writes') });
    expect(drive.create).not.toHaveBeenCalled();
  });

  it('refuses a malformed google_doc record rather than starting a second Doc', async () => {
    const repo = makeRepo(makeDoc({ frontmatter: { google_doc: { id: 'gdoc-1' } } }));
    const result = await new DocPublishGoogleHandler().execute(makeCtx(repo, { path: PATH }));
    expect(result).toEqual({ success: false, error: expect.stringContaining('malformed') });
    expect(drive.create).not.toHaveBeenCalled();
  });

  it('reports a missing Google sign-in as a tool error', async () => {
    getDriveClient.mockRejectedValueOnce(new Error('Failed to read Google OAuth token cache at /home/x: SyntaxError "refresh_tok…'));
    const result = await new DocPublishGoogleHandler().execute(makeCtx(makeRepo(makeDoc()), { path: PATH }));
    expect(result).toEqual({ success: false, error: expect.stringContaining('not signed in') });
    // The detail can quote the token file; it stays in the logs.
    expect((result as { error: string }).error).not.toContain('refresh_tok');
  });
});

describe('doc-publish-google — first publish', () => {
  function createOk(overrides: Record<string, unknown> = {}) {
    drive.create.mockResolvedValueOnce({
      data: { id: 'gdoc-new', webViewLink: 'https://docs.google.com/document/d/gdoc-new/edit', mimeType: GDOC, ...overrides },
    });
  }

  it('uploads the body (no frontmatter) as Markdown converted to a Google Doc, bound to the document', async () => {
    createOk();
    const repo = makeRepo(makeDoc());
    const result = await new DocPublishGoogleHandler().execute(makeCtx(repo, { path: PATH, folder_id: 'folder-9' }));
    // There is no folder input: a new Doc always goes to Curia's My Drive.

    expect(result).toEqual({
      success: true,
      data: { action: 'created', document_id: 'gdoc-new', url: 'https://docs.google.com/document/d/gdoc-new/edit', path: PATH },
    });
    const request = drive.create.mock.calls[0]![0];
    expect(request.requestBody).toEqual({
      name: 'Board brief',
      mimeType: GDOC,
      appProperties: { curiaDocumentId: DOC_ID },
    });
    expect(request.media).toEqual({ mimeType: 'text/markdown', body: BODY });
    expect(request.media.body).not.toContain('title:');
  });

  it('records the Doc in frontmatter, keeping the other keys and leaving the body alone', async () => {
    createOk();
    const repo = makeRepo(makeDoc());
    await new DocPublishGoogleHandler().execute(makeCtx(repo, { path: PATH }));

    expect(repo.updates).toHaveLength(1);
    expect(repo.updates[0]).toMatchObject({ expectedVersion: 3, expectedId: DOC_ID });
    expect(repo.updates[0]!.body).toBeUndefined();
    expect(repo.current!.frontmatter).toEqual({
      title: 'Board brief',
      google_doc: {
        id: 'gdoc-new',
        url: 'https://docs.google.com/document/d/gdoc-new/edit',
        published_at: expect.any(String),
        content_hash: hashOf(PUBLISHED_EXPORT),
      },
    });
  });

  it('defaults the title to the file name when the frontmatter has none, and honours an explicit title', async () => {
    createOk();
    await new DocPublishGoogleHandler().execute(makeCtx(makeRepo(makeDoc({ frontmatter: {} })), { path: PATH }));
    expect(drive.create.mock.calls[0]![0].requestBody.name).toBe('brief');

    createOk();
    await new DocPublishGoogleHandler().execute(makeCtx(makeRepo(makeDoc()), { path: PATH, title: 'Q4 brief' }));
    expect(drive.create.mock.calls[1]![0].requestBody.name).toBe('Q4 brief');
  });

  it('deletes an upload Drive did not convert, records nothing and fails', async () => {
    createOk({ mimeType: 'text/markdown' });
    drive.delete.mockResolvedValueOnce({});
    const repo = makeRepo(makeDoc());
    const result = await new DocPublishGoogleHandler().execute(makeCtx(repo, { path: PATH }));

    expect(result).toEqual({ success: false, error: expect.stringContaining('did not convert') });
    expect(drive.delete).toHaveBeenCalledWith({ fileId: 'gdoc-new' }, { timeout: 20_000 });
    expect((result as { error: string }).error).not.toContain('still in');
    expect(repo.updates).toHaveLength(0);
  });

  it('names a leftover unconverted upload when deleting it fails', async () => {
    createOk({ mimeType: 'text/markdown' });
    drive.delete.mockRejectedValueOnce(new Error('backend error'));
    const result = await new DocPublishGoogleHandler().execute(makeCtx(makeRepo(makeDoc()), { path: PATH }));
    expect(result).toEqual({ success: false, error: expect.stringContaining('file ID gdoc-new) is still in') });
  });

  it('hashes the Doc\'s own Markdown export, read back after the write', async () => {
    createOk();
    await new DocPublishGoogleHandler().execute(makeCtx(makeRepo(makeDoc()), { path: PATH }));
    expect(drive.export).toHaveBeenCalledWith({ fileId: 'gdoc-new', mimeType: 'text/markdown' }, { timeout: 20_000, responseType: 'text' });
    // Every Drive call carries the per-request bound.
    expect(drive.create.mock.calls[0]![1]).toEqual({ timeout: 20_000 });
  });

  it('records an unknown hash when the export fails, and says so', async () => {
    createOk();
    drive.export.mockRejectedValueOnce(new Error('export failed'));
    const repo = makeRepo(makeDoc());
    const result = await new DocPublishGoogleHandler().execute(makeCtx(repo, { path: PATH }));
    expect(result.success).toBe(true);
    expect((result as { data: { note?: string } }).data.note).toContain('could not read the Doc back');
    expect(repo.current!.frontmatter.google_doc).toMatchObject({ content_hash: 'unknown' });
  });

  it('reports a Drive failure and records nothing', async () => {
    drive.create.mockRejectedValueOnce(Object.assign(new Error('quota exceeded'), { code: 429 }));
    const repo = makeRepo(makeDoc());
    const result = await new DocPublishGoogleHandler().execute(makeCtx(repo, { path: PATH }));
    expect(result).toEqual({ success: false, error: expect.stringContaining('quota exceeded') });
    expect(repo.updates).toHaveLength(0);
  });

  it('reports an unconfirmed create as unknown, never as a plain failure to retry', async () => {
    for (const err of [new Error('timeout of 20000ms exceeded'), Object.assign(new Error('Backend Error'), { code: 503 })]) {
      drive.create.mockRejectedValueOnce(err);
      const repo = makeRepo(makeDoc());
      const result = await new DocPublishGoogleHandler().execute(makeCtx(repo, { path: PATH }));
      expect(result).toEqual({ success: false, error: expect.stringContaining('may or may not have been created') });
      expect((result as { error: string }).error).toContain('"Board brief"');
      expect(repo.updates).toHaveLength(0);
    }
  });

  it('names a full Drive or a rate limit as such', async () => {
    drive.create.mockRejectedValueOnce(Object.assign(new Error('The user has exceeded their Drive storage quota'), {
      code: 403, errors: [{ reason: 'storageQuotaExceeded' }],
    }));
    const result = await new DocPublishGoogleHandler().execute(makeCtx(makeRepo(makeDoc()), { path: PATH }));
    expect(result).toEqual({ success: false, error: expect.stringContaining('out of storage or rate-limited (storageQuotaExceeded)') });
  });

  it('retries the record on a concurrent write and notes that the Doc shows earlier text', async () => {
    createOk();
    const repo = makeRepo(makeDoc());
    // Another writer bumps the document between our read and the record.
    repo.update.mockImplementationOnce(async (_p: string, params: UpdateWorkingDocParams) => {
      repo.updates.push(params);
      repo.current = makeDoc({ version: 4, body: `${BODY}\nNew line.\n` });
      return { ok: false, conflict: true, document: repo.current };
    });
    const result = await new DocPublishGoogleHandler().execute(makeCtx(repo, { path: PATH }));

    expect(result.success).toBe(true);
    expect((result as { data: { note?: string } }).data.note).toContain('changed while it was being published');
    expect(repo.current!.frontmatter.google_doc).toMatchObject({ id: 'gdoc-new' });
    expect(repo.current!.body).toContain('New line.');
  });

  it('returns the Doc link in the error when recording fails', async () => {
    createOk();
    const repo = makeRepo(makeDoc());
    repo.update.mockRejectedValueOnce(new Error('connection reset'));
    const result = await new DocPublishGoogleHandler().execute(makeCtx(repo, { path: PATH }));
    expect(result).toEqual({ success: false, error: expect.stringContaining('https://docs.google.com/document/d/gdoc-new/edit') });
  });
});

describe('doc-publish-google — publishing again', () => {
  function recordedRepo() {
    return makeRepo(makeDoc({ frontmatter: { title: 'Board brief', google_doc: RECORD } }));
  }
  function docUnchanged(overrides: Record<string, unknown> = {}) {
    drive.get.mockResolvedValueOnce({
      data: {
        id: 'gdoc-1', mimeType: GDOC, trashed: false,
        appProperties: { curiaDocumentId: DOC_ID }, webViewLink: RECORD.url, ...overrides,
      },
    });
  }
  function updateOk() {
    drive.update.mockResolvedValueOnce({
      data: { id: 'gdoc-1', webViewLink: RECORD.url, mimeType: GDOC },
    });
  }

  it('replaces an unchanged Doc from the current body and refreshes the record', async () => {
    docUnchanged();
    updateOk();
    const repo = recordedRepo();
    const result = await new DocPublishGoogleHandler().execute(makeCtx(repo, { path: PATH }));

    expect(result).toEqual({ success: true, data: { action: 'updated', document_id: 'gdoc-1', url: RECORD.url, path: PATH } });
    expect(drive.create).not.toHaveBeenCalled();
    const request = drive.update.mock.calls[0]![0];
    expect(request).toMatchObject({ fileId: 'gdoc-1', media: { mimeType: 'text/markdown', body: BODY } });
    expect(request.requestBody).toBeUndefined();
    expect(repo.current!.frontmatter.google_doc).toMatchObject({ id: 'gdoc-1', content_hash: hashOf(PUBLISHED_EXPORT) });
  });

  it('renames the Doc when a title is given', async () => {
    docUnchanged();
    updateOk();
    await new DocPublishGoogleHandler().execute(makeCtx(recordedRepo(), { path: PATH, title: 'Renamed' }));
    expect(drive.update.mock.calls[0]![0].requestBody).toEqual({ name: 'Renamed' });
  });

  it('refuses when the Doc was edited since the last publish', async () => {
    docUnchanged();
    drive.export.mockResolvedValueOnce({ data: EDITED_EXPORT });
    const result = await new DocPublishGoogleHandler().execute(makeCtx(recordedRepo(), { path: PATH }));
    expect(result).toEqual({ success: false, error: expect.stringContaining('it was edited') });
    expect((result as { error: string }).error).toContain('get_doc_as_markdown');
    expect((result as { error: string }).error).toContain(`doc_version: "${versionOf(EDITED_EXPORT)}"`);
    expect(drive.update).not.toHaveBeenCalled();
  });

  it('goes through with the doc_version a refusal named while the Doc is still at it', async () => {
    docUnchanged();
    updateOk();
    drive.export.mockResolvedValueOnce({ data: EDITED_EXPORT });
    const result = await new DocPublishGoogleHandler().execute(makeCtx(recordedRepo(), { path: PATH, doc_version: versionOf(EDITED_EXPORT) }));
    expect(result.success).toBe(true);
    // The version covers the open comments too, so they are read.
    expect(drive.commentsList).toHaveBeenCalledTimes(1);
  });

  it('refuses a doc_version the Doc has moved past', async () => {
    docUnchanged();
    drive.export.mockResolvedValueOnce({ data: `${EDITED_EXPORT}More.\n` });
    const result = await new DocPublishGoogleHandler().execute(makeCtx(recordedRepo(), { path: PATH, doc_version: versionOf(EDITED_EXPORT) }));
    expect(result).toEqual({ success: false, error: expect.stringContaining('changed after it was read back') });
    expect((result as { error: string }).error).toContain(`doc_version: "${versionOf(`${EDITED_EXPORT}More.\n`)}"`);
    expect(drive.update).not.toHaveBeenCalled();
  });

  it('refuses a doc_version when a comment was opened after the read-back, though the text is the same', async () => {
    docUnchanged();
    drive.export.mockResolvedValueOnce({ data: EDITED_EXPORT });
    drive.commentsList.mockResolvedValueOnce({ data: { comments: [{ id: 'c-new', resolved: false, modifiedTime: '2026-11-25T12:00:00.000Z' }] } });
    const result = await new DocPublishGoogleHandler().execute(makeCtx(recordedRepo(), { path: PATH, doc_version: versionOf(EDITED_EXPORT) }));
    expect(result).toEqual({ success: false, error: expect.stringContaining('open comments changed') });
    expect((result as { error: string }).error).toContain(`doc_version: "${versionOf(EDITED_EXPORT, ['c-new@2026-11-25T12:00:00.000Z'])}"`);
  });

  it('refuses a doc_version when an open comment was answered after the read-back', async () => {
    const before = { id: 'c-1', resolved: false, modifiedTime: '2026-11-25T12:00:00.000Z' };
    const answered = { ...before, modifiedTime: '2026-11-25T12:30:00.000Z' };
    docUnchanged();
    drive.export.mockResolvedValueOnce({ data: EDITED_EXPORT });
    drive.commentsList.mockResolvedValueOnce({ data: { comments: [answered] } });
    const version = versionOf(EDITED_EXPORT, ['c-1@2026-11-25T12:00:00.000Z']);
    const result = await new DocPublishGoogleHandler().execute(makeCtx(recordedRepo(), { path: PATH, doc_version: version }));
    expect(result).toEqual({ success: false, error: expect.stringContaining('open comments changed') });
    expect(drive.update).not.toHaveBeenCalled();
  });

  it('fails closed on an open comment Drive returns without an id or a time', async () => {
    for (const comment of [{ resolved: false, modifiedTime: '2026-11-25T12:00:00.000Z' }, { id: 'c-1', resolved: false }]) {
      docUnchanged();
      drive.commentsList.mockResolvedValueOnce({ data: { comments: [comment] } });
      const result = await new DocPublishGoogleHandler().execute(makeCtx(recordedRepo(), { path: PATH }));
      expect(result).toEqual({ success: false, error: expect.stringContaining('could not read the Doc\'s open comments in full') });
    }
    expect(drive.update).not.toHaveBeenCalled();
    expect(drive.update).not.toHaveBeenCalled();
  });

  it('asks for a read-back when the recorded hash is unknown', async () => {
    docUnchanged();
    const repo = makeRepo(makeDoc({ frontmatter: { google_doc: { ...RECORD, content_hash: 'unknown' } } }));
    const result = await new DocPublishGoogleHandler().execute(makeCtx(repo, { path: PATH }));
    expect(result).toEqual({ success: false, error: expect.stringContaining('could not tell') });
  });

  it('refuses on a comment opened since the last publish, not on resolved, deleted or older ones', async () => {
    const NEW = '2026-11-24T12:00:00.000Z';
    const OLD = '2026-11-23T12:00:00.000Z';
    docUnchanged();
    drive.commentsList.mockResolvedValueOnce({ data: { comments: [{ resolved: true, modifiedTime: NEW }, { deleted: true, modifiedTime: NEW }, { id: 'c-3', resolved: false, modifiedTime: NEW }] } });
    const result = await new DocPublishGoogleHandler().execute(makeCtx(recordedRepo(), { path: PATH }));
    expect(result).toEqual({ success: false, error: expect.stringContaining('new or answered open comments') });

    docUnchanged();
    updateOk();
    drive.commentsList.mockResolvedValueOnce({ data: { comments: [{ resolved: true, modifiedTime: NEW }, { deleted: true, modifiedTime: NEW }, { id: 'c-3', resolved: false, modifiedTime: OLD }] } });
    const second = await new DocPublishGoogleHandler().execute(makeCtx(recordedRepo(), { path: PATH }));
    expect(second.success).toBe(true);
  });

  it('reads every comment page', async () => {
    docUnchanged();
    drive.commentsList
      .mockResolvedValueOnce({ data: { comments: [{ resolved: true }], nextPageToken: 'p2' } })
      .mockResolvedValueOnce({ data: { comments: [{ id: 'c-9', resolved: false, modifiedTime: '2026-11-25T12:00:00.000Z' }] } });
    const result = await new DocPublishGoogleHandler().execute(makeCtx(recordedRepo(), { path: PATH }));
    expect(result).toEqual({ success: false, error: expect.stringContaining('open comments') });
    expect(drive.commentsList.mock.calls[1]![0]).toMatchObject({ pageToken: 'p2' });
  });

  it('treats more comment pages than it reads as blocking (fail closed)', async () => {
    docUnchanged();
    drive.commentsList.mockResolvedValue({ data: { comments: [{ resolved: true }], nextPageToken: 'more' } });
    const result = await new DocPublishGoogleHandler().execute(makeCtx(recordedRepo(), { path: PATH }));
    expect(result).toEqual({ success: false, error: expect.stringContaining('could not read the Doc\'s open comments in full') });
    expect(drive.commentsList).toHaveBeenCalledTimes(10);
    expect(drive.update).not.toHaveBeenCalled();
  });

  it('reports an update Drive refuses, without touching the record', async () => {
    docUnchanged();
    drive.update.mockRejectedValueOnce(Object.assign(new Error('Invalid media'), { code: 400 }));
    const repo = recordedRepo();
    const result = await new DocPublishGoogleHandler().execute(makeCtx(repo, { path: PATH }));
    expect(result).toEqual({ success: false, error: expect.stringContaining('refused to update the Doc') });
    expect(repo.updates).toHaveLength(0);
  });

  it('reports an unconfirmed update as unknown, without touching the record', async () => {
    docUnchanged();
    drive.update.mockRejectedValueOnce(new Error('socket hang up'));
    const repo = recordedRepo();
    const result = await new DocPublishGoogleHandler().execute(makeCtx(repo, { path: PATH }));
    expect(result).toEqual({ success: false, error: expect.stringContaining('may or may not show the new text') });
    expect(repo.updates).toHaveLength(0);
  });

  it('fails when the update does not confirm a Google Doc', async () => {
    docUnchanged();
    drive.update.mockResolvedValueOnce({ data: { id: 'gdoc-1' } });
    const repo = recordedRepo();
    const result = await new DocPublishGoogleHandler().execute(makeCtx(repo, { path: PATH }));
    expect(result).toEqual({ success: false, error: expect.stringContaining('did not confirm') });
    expect(repo.updates).toHaveLength(0);
  });

  it('reports a record failure after an update without telling the agent to overwrite', async () => {
    docUnchanged();
    updateOk();
    const repo = recordedRepo();
    repo.update.mockRejectedValueOnce(new Error('connection reset'));
    const result = await new DocPublishGoogleHandler().execute(makeCtx(repo, { path: PATH }));
    expect(result).toEqual({ success: false, error: expect.stringContaining('was updated') });
    expect((result as { error: string }).error).toContain('Read the Doc back');
    expect((result as { error: string }).error).not.toContain('overwrite');
  });

  it('overwrites an edited, commented Doc when overwrite is true', async () => {
    docUnchanged();
    updateOk();
    drive.export.mockResolvedValueOnce({ data: EDITED_EXPORT });
    const result = await new DocPublishGoogleHandler().execute(makeCtx(recordedRepo(), { path: PATH, overwrite: true }));
    expect(result.success).toBe(true);
    expect(drive.commentsList).not.toHaveBeenCalled();
  });

  it('never overwrites a Doc that was not published from this document, even with overwrite', async () => {
    docUnchanged({ appProperties: {} });
    const result = await new DocPublishGoogleHandler().execute(makeCtx(recordedRepo(), { path: PATH, overwrite: true }));
    expect(result).toEqual({ success: false, error: expect.stringContaining('was not published from this document') });
    expect(drive.update).not.toHaveBeenCalled();

    docUnchanged({ appProperties: { curiaDocumentId: 'another-document' } });
    const other = await new DocPublishGoogleHandler().execute(makeCtx(recordedRepo(), { path: PATH, overwrite: true }));
    expect(other.success).toBe(false);
    expect(drive.update).not.toHaveBeenCalled();
  });

  it('refuses a trashed Doc', async () => {
    docUnchanged({ trashed: true });
    const result = await new DocPublishGoogleHandler().execute(makeCtx(recordedRepo(), { path: PATH }));
    expect(result).toEqual({ success: false, error: expect.stringContaining('trash') });
    expect(drive.update).not.toHaveBeenCalled();
  });

  it('never starts a second Doc when the recorded one is gone or out of reach', async () => {
    for (const code of [404, 403]) {
      drive.get.mockRejectedValueOnce(Object.assign(new Error('File not found'), { code }));
      const repo = recordedRepo();
      const result = await new DocPublishGoogleHandler().execute(makeCtx(repo, { path: PATH }));
      expect(result).toEqual({ success: false, error: expect.stringContaining('deleted, or Curia can no longer open it') });
      expect(repo.updates).toHaveLength(0);
    }
    expect(drive.create).not.toHaveBeenCalled();
  });

  it('reports a rate limit on the lookup as a rate limit, not lost access', async () => {
    drive.get.mockRejectedValueOnce(Object.assign(new Error('Rate limit exceeded'), { code: 403, errors: [{ reason: 'userRateLimitExceeded' }] }));
    const result = await new DocPublishGoogleHandler().execute(makeCtx(recordedRepo(), { path: PATH }));
    expect(result).toEqual({ success: false, error: expect.stringContaining('rate-limited') });
  });

  it('fails without overwriting when the Doc cannot be exported for the edit check', async () => {
    docUnchanged();
    drive.export.mockRejectedValueOnce(new Error('export failed'));
    const result = await new DocPublishGoogleHandler().execute(makeCtx(recordedRepo(), { path: PATH }));
    expect(result).toEqual({ success: false, error: expect.stringContaining('check it for edits') });
    expect(drive.update).not.toHaveBeenCalled();
  });

  it('fails without overwriting when the comment check errors', async () => {
    docUnchanged();
    drive.commentsList.mockRejectedValueOnce(new Error('backend error'));
    const result = await new DocPublishGoogleHandler().execute(makeCtx(recordedRepo(), { path: PATH }));
    expect(result).toEqual({ success: false, error: expect.stringContaining('backend error') });
    expect(drive.update).not.toHaveBeenCalled();
  });

  it('rejects a doc_version when no Doc is recorded, rather than creating one', async () => {
    const result = await new DocPublishGoogleHandler().execute(makeCtx(makeRepo(makeDoc()), { path: PATH, doc_version: 'abc123' }));
    expect(result).toEqual({ success: false, error: expect.stringContaining('doc_version does not apply') });
    expect(drive.create).not.toHaveBeenCalled();
  });

  it('records the comment cutoff from before the write, not after it', async () => {
    docUnchanged();
    let writeAt = '';
    drive.update.mockImplementationOnce(async () => {
      writeAt = new Date().toISOString();
      await new Promise((r) => setTimeout(r, 5));
      return { data: { id: 'gdoc-1', webViewLink: RECORD.url, mimeType: GDOC } };
    });
    const repo = recordedRepo();
    await new DocPublishGoogleHandler().execute(makeCtx(repo, { path: PATH }));
    const publishedAt = (repo.current!.frontmatter.google_doc as { published_at: string }).published_at;
    expect(Date.parse(publishedAt)).toBeLessThanOrEqual(Date.parse(writeAt));
  });

  it('stops before writing when the call is short of time, changing nothing', async () => {
    docUnchanged();
    const ctx = makeCtx(recordedRepo(), { path: PATH }, { deadline: Date.now() + 5_000 } as Partial<ToolContext>);
    const result = await new DocPublishGoogleHandler().execute(ctx);
    expect(result).toEqual({ success: false, error: expect.stringContaining('nothing was changed') });
    expect(drive.update).not.toHaveBeenCalled();

    const created = await new DocPublishGoogleHandler().execute(makeCtx(makeRepo(makeDoc()), { path: PATH }, { deadline: Date.now() + 5_000 } as Partial<ToolContext>));
    expect(created.success).toBe(false);
    expect(drive.create).not.toHaveBeenCalled();
  });

  it('passes the call\'s abort signal and remaining time to Drive', async () => {
    docUnchanged();
    updateOk();
    const controller = new AbortController();
    // Well above the 45 s write reserve, so the clock moving during the test can't trip it.
    const ctx = makeCtx(recordedRepo(), { path: PATH }, { signal: controller.signal, deadline: Date.now() + 80_000 } as Partial<ToolContext>);
    await new DocPublishGoogleHandler().execute(ctx);
    const opts = drive.update.mock.calls[0]![1] as { timeout: number; signal: AbortSignal };
    expect(opts.signal).toBe(controller.signal);
    expect(opts.timeout).toBeLessThanOrEqual(20_000);
  });

  it('keeps time to record after the write: the export stops short of the deadline, or is skipped', async () => {
    docUnchanged();
    const ctx = makeCtx(recordedRepo(), { path: PATH }, { deadline: Date.now() + 60_000 } as Partial<ToolContext>);
    // A slow update leaves 12 s: the export after it may use at most 7 s of them.
    drive.update.mockImplementationOnce(async () => {
      (ctx as { deadline: number }).deadline = Date.now() + 12_000;
      return { data: { id: 'gdoc-1', webViewLink: RECORD.url, mimeType: GDOC } };
    });
    const result = await new DocPublishGoogleHandler().execute(ctx);
    expect(result.success).toBe(true);
    const exportOpts = drive.export.mock.calls.at(-1)![1] as { timeout: number };
    expect(exportOpts.timeout).toBeLessThanOrEqual(7_000);

    // One that leaves under 5 s: no export at all, an unknown hash, and a note saying so.
    docUnchanged();
    const repo = recordedRepo();
    const tight = makeCtx(repo, { path: PATH }, { deadline: Date.now() + 60_000 } as Partial<ToolContext>);
    drive.update.mockImplementationOnce(async () => {
      (tight as { deadline: number }).deadline = Date.now() + 3_000;
      return { data: { id: 'gdoc-1', webViewLink: RECORD.url, mimeType: GDOC } };
    });
    drive.export.mockClear();
    const second = await new DocPublishGoogleHandler().execute(tight);
    expect(second.success).toBe(true);
    expect(drive.export).toHaveBeenCalledTimes(1); // the pre-write check only
    expect(repo.current!.frontmatter.google_doc).toMatchObject({ content_hash: 'unknown' });
  });

  it('leaves a google_doc record cleared during the publish as it is', async () => {
    docUnchanged();
    updateOk();
    const repo = recordedRepo();
    repo.update.mockImplementationOnce(async (_p: string, params: UpdateWorkingDocParams) => {
      repo.updates.push(params);
      repo.current = { ...repo.current!, version: repo.current!.version + 1, frontmatter: { title: 'Board brief', google_doc: null } };
      return { ok: false, conflict: true, document: repo.current };
    });
    const result = await new DocPublishGoogleHandler().execute(makeCtx(repo, { path: PATH }));
    expect(result).toEqual({ success: false, error: expect.stringContaining('cleared or replaced while publishing') });
    expect((result as { error: string }).error).toContain('Do not publish the document again unless the principal wants a new Doc');
    expect((result as { error: string }).error).not.toContain('doc_version');
    expect(repo.current!.frontmatter.google_doc).toBeNull();
    expect(repo.updates).toHaveLength(1);
  });
});
