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
