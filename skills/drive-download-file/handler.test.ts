import { vi, describe, it, expect, beforeEach } from 'vitest';
import { Readable } from 'node:stream';
import type { SkillContext } from '../../src/skills/types.js';
import { createSilentLogger } from '../../src/logger.js';
import { MAX_TEMP_FILE_BYTES } from '../../src/skills/temp-file-store.js';

// vi.hoisted ensures these are available inside the vi.mock factories,
// which are hoisted before top-level variable declarations.
const { mockFilesGet, mockFilesExport } = vi.hoisted(() => ({
  mockFilesGet: vi.fn(),
  mockFilesExport: vi.fn(),
}));

vi.mock('googleapis', () => ({
  google: {
    drive: vi.fn(() => ({ files: { get: mockFilesGet, export: mockFilesExport } })),
  },
}));

vi.mock('../../src/google/drive-auth.js', () => ({
  getDriveClient: vi.fn().mockResolvedValue({}),
}));

import { DriveDownloadFileHandler } from './handler.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReadable(content: Buffer): Readable {
  return Readable.from([content]);
}

function makeCtx(overrides?: Partial<SkillContext>): SkillContext {
  return {
    input: { file_id_or_url: '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms' },
    secret: () => { throw new Error('no secret in test'); },
    log: createSilentLogger(),
    writeTempFile: vi.fn().mockResolvedValue('file:///run/curia-tempfiles/abc123.pdf'),
    taskMetadata: {},
    taskEventId: undefined,
    ...overrides,
  } as unknown as SkillContext;
}

function setupMetadata(opts: { name: string; mimeType: string; size?: string | null }) {
  mockFilesGet.mockResolvedValueOnce({
    data: { name: opts.name, mimeType: opts.mimeType, size: opts.size ?? null },
  });
}

function setupDownloadStream(content: Buffer) {
  mockFilesGet.mockResolvedValueOnce({ data: makeReadable(content) });
}

function setupExportStream(content: Buffer) {
  mockFilesExport.mockResolvedValueOnce({ data: makeReadable(content) });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe('DriveDownloadFileHandler — input validation', () => {
  it('returns error when writeTempFile is missing', async () => {
    const handler = new DriveDownloadFileHandler();
    const result = await handler.execute(makeCtx({ writeTempFile: undefined }));
    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('tempFileStore');
  });

  it('returns error when file_id_or_url is missing', async () => {
    const handler = new DriveDownloadFileHandler();
    const result = await handler.execute(makeCtx({ input: {} }));
    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('file_id_or_url');
  });

  it('returns error when file_id_or_url is empty string', async () => {
    const handler = new DriveDownloadFileHandler();
    const result = await handler.execute(makeCtx({ input: { file_id_or_url: '   ' } }));
    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('file_id_or_url');
  });
});

// ---------------------------------------------------------------------------
// URL extraction — covered by ensuring metadata is fetched with correct ID
// ---------------------------------------------------------------------------

describe('DriveDownloadFileHandler — URL extraction', () => {
  const pdfContent = Buffer.from('PDF bytes');

  it('extracts file ID from /file/d/<id>/view URL', async () => {
    setupMetadata({ name: 'doc.pdf', mimeType: 'application/pdf', size: '9' });
    setupDownloadStream(pdfContent);
    const handler = new DriveDownloadFileHandler();
    await handler.execute(makeCtx({ input: { file_id_or_url: 'https://drive.google.com/file/d/FILE_ID_123/view' } }));
    expect(mockFilesGet).toHaveBeenNthCalledWith(1, expect.objectContaining({ fileId: 'FILE_ID_123' }));
  });

  it('extracts file ID from ?id=<id> URL', async () => {
    setupMetadata({ name: 'doc.pdf', mimeType: 'application/pdf', size: '9' });
    setupDownloadStream(pdfContent);
    const handler = new DriveDownloadFileHandler();
    await handler.execute(makeCtx({ input: { file_id_or_url: 'https://drive.google.com/open?id=FILE_ID_456' } }));
    expect(mockFilesGet).toHaveBeenNthCalledWith(1, expect.objectContaining({ fileId: 'FILE_ID_456' }));
  });

  it('treats a bare string as a raw file ID', async () => {
    setupMetadata({ name: 'doc.pdf', mimeType: 'application/pdf', size: '9' });
    setupDownloadStream(pdfContent);
    const handler = new DriveDownloadFileHandler();
    await handler.execute(makeCtx({ input: { file_id_or_url: 'RAW_FILE_ID' } }));
    expect(mockFilesGet).toHaveBeenNthCalledWith(1, expect.objectContaining({ fileId: 'RAW_FILE_ID' }));
  });
});

// ---------------------------------------------------------------------------
// Metadata errors
// ---------------------------------------------------------------------------

describe('DriveDownloadFileHandler — metadata errors', () => {
  it('returns not-found error on 404', async () => {
    mockFilesGet.mockRejectedValueOnce({ response: { status: 404 } });
    const handler = new DriveDownloadFileHandler();
    const result = await handler.execute(makeCtx());
    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('not found or not shared');
  });

  it('returns access-denied error on 403', async () => {
    mockFilesGet.mockRejectedValueOnce({ response: { status: 403 } });
    const handler = new DriveDownloadFileHandler();
    const result = await handler.execute(makeCtx());
    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('does not have access');
  });

  it('returns error when getDriveClient throws (bad token cache)', async () => {
    const { getDriveClient } = await import('../../src/google/drive-auth.js');
    vi.mocked(getDriveClient).mockRejectedValueOnce(
      new Error('Google OAuth token cache not found at /root/.google_workspace_mcp/credentials/curia@test.com.json. Complete the Drive auth setup (docs/dev/google-drive.md).'),
    );
    const handler = new DriveDownloadFileHandler();
    const result = await handler.execute(makeCtx());
    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('token cache not found');
  });
});

// ---------------------------------------------------------------------------
// Pre-download size check (declared size in metadata)
// ---------------------------------------------------------------------------

describe('DriveDownloadFileHandler — size pre-check', () => {
  it('rejects before download when declared size exceeds 10 MB', async () => {
    const oversizeBytes = (MAX_TEMP_FILE_BYTES + 1).toString();
    setupMetadata({ name: 'huge.zip', mimeType: 'application/zip', size: oversizeBytes });
    const handler = new DriveDownloadFileHandler();
    const result = await handler.execute(makeCtx());
    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('exceeds the 10 MB download limit');
    // Drive download should NOT have been called (only 1 call: metadata)
    expect(mockFilesGet).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Successful native binary download
// ---------------------------------------------------------------------------

describe('DriveDownloadFileHandler — native binary download', () => {
  it('downloads a PDF and returns temp_file_url, filename, content_type, size', async () => {
    const pdfContent = Buffer.from('PDF content here');
    setupMetadata({ name: 'report.pdf', mimeType: 'application/pdf', size: String(pdfContent.length) });
    setupDownloadStream(pdfContent);

    const handler = new DriveDownloadFileHandler();
    const result = await handler.execute(makeCtx());

    expect(result.success).toBe(true);
    const data = (result as { data: Record<string, unknown> }).data;
    expect(data.temp_file_url).toBe('file:///run/curia-tempfiles/abc123.pdf');
    expect(data.filename).toBe('report.pdf');
    expect(data.content_type).toBe('application/pdf');
    expect(data.size).toBe(pdfContent.length);
  });

  it('uses hint filename over Drive metadata name', async () => {
    const content = Buffer.from('bytes');
    setupMetadata({ name: 'original.pdf', mimeType: 'application/pdf', size: '5' });
    setupDownloadStream(content);

    const handler = new DriveDownloadFileHandler();
    const result = await handler.execute(
      makeCtx({ input: { file_id_or_url: 'FILE_ID', filename: 'custom-name.pdf' } }),
    );
    const data = (result as { data: Record<string, unknown> }).data;
    expect(data.filename).toBe('custom-name.pdf');
  });

  it('returns error when stream exceeds 10 MB (no declared size)', async () => {
    setupMetadata({ name: 'sneaky.bin', mimeType: 'application/octet-stream', size: null });
    // Stream that emits one chunk just over the limit
    const bigChunk = Buffer.alloc(MAX_TEMP_FILE_BYTES + 1);
    mockFilesGet.mockResolvedValueOnce({ data: makeReadable(bigChunk) });

    const handler = new DriveDownloadFileHandler();
    const result = await handler.execute(makeCtx());
    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('10 MB download limit');
  });

  it('returns error when drive.files.get download throws', async () => {
    setupMetadata({ name: 'file.pdf', mimeType: 'application/pdf', size: '100' });
    mockFilesGet.mockRejectedValueOnce(new Error('Network error'));
    const handler = new DriveDownloadFileHandler();
    const result = await handler.execute(makeCtx());
    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('Failed to download');
    expect((result as { error: string }).error).toContain('Network error');
  });
});

// ---------------------------------------------------------------------------
// Google-native export
// ---------------------------------------------------------------------------

describe('DriveDownloadFileHandler — Google-native export', () => {
  it('exports a Google Doc to PDF by default and appends .pdf extension', async () => {
    const pdfBytes = Buffer.from('exported PDF');
    setupMetadata({ name: 'My Bio', mimeType: 'application/vnd.google-apps.document', size: null });
    setupExportStream(pdfBytes);

    const handler = new DriveDownloadFileHandler();
    const result = await handler.execute(makeCtx());

    expect(result.success).toBe(true);
    const data = (result as { data: Record<string, unknown> }).data;
    expect(data.filename).toBe('My Bio.pdf');
    expect(data.content_type).toBe('application/pdf');
    expect(mockFilesExport).toHaveBeenCalledWith(
      expect.objectContaining({ mimeType: 'application/pdf' }),
      expect.objectContaining({ responseType: 'stream' }),
    );
  });

  it('respects export_mime_type override (Doc → DOCX)', async () => {
    const docxBytes = Buffer.from('DOCX content');
    setupMetadata({ name: 'My Bio', mimeType: 'application/vnd.google-apps.document', size: null });
    setupExportStream(docxBytes);

    const docxMime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    const handler = new DriveDownloadFileHandler();
    const result = await handler.execute(
      makeCtx({ input: { file_id_or_url: 'FILE_ID', export_mime_type: docxMime } }),
    );

    const data = (result as { data: Record<string, unknown> }).data;
    expect(data.filename).toBe('My Bio.docx');
    expect(data.content_type).toBe(docxMime);
  });

  it('returns error when export stream exceeds 10 MB', async () => {
    setupMetadata({ name: 'Big Doc', mimeType: 'application/vnd.google-apps.document', size: null });
    const bigChunk = Buffer.alloc(MAX_TEMP_FILE_BYTES + 1);
    mockFilesExport.mockResolvedValueOnce({ data: makeReadable(bigChunk) });

    const handler = new DriveDownloadFileHandler();
    const result = await handler.execute(makeCtx());
    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('10 MB download limit');
  });
});

// ---------------------------------------------------------------------------
// writeTempFile failure
// ---------------------------------------------------------------------------

describe('DriveDownloadFileHandler — writeTempFile failure', () => {
  it('returns error when writeTempFile throws', async () => {
    const content = Buffer.from('PDF');
    setupMetadata({ name: 'file.pdf', mimeType: 'application/pdf', size: '3' });
    setupDownloadStream(content);

    const failingWriteTempFile = vi.fn().mockRejectedValue(new Error('disk full'));
    const handler = new DriveDownloadFileHandler();
    const result = await handler.execute(makeCtx({ writeTempFile: failingWriteTempFile }));
    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('temp storage');
    expect((result as { error: string }).error).toContain('disk full');
  });
});
