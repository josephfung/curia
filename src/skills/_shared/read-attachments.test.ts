import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readAttachmentFiles } from './read-attachments.js';
import type { OutboundAttachmentInput } from './read-attachments.js';
import { readFile } from 'node:fs/promises';

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));

const mockReadFile = readFile as ReturnType<typeof vi.fn>;

const MAX_20MB = 20 * 1024 * 1024;

// Pass /tmp as the allowed store dir for all fixture-based tests so file URLs
// like file:///tmp/... pass the directory boundary check.
const STORE_DIR = '/tmp';

describe('readAttachmentFiles', () => {
  beforeEach(() => {
    mockReadFile.mockReset();
  });

  it('returns empty array for empty input', async () => {
    const result = await readAttachmentFiles([], MAX_20MB, STORE_DIR);
    expect(result).toEqual([]);
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it('reads a file and returns AttachmentContent', async () => {
    const buf = Buffer.from('hello pdf');
    mockReadFile.mockResolvedValue(buf);

    const input: OutboundAttachmentInput[] = [
      { fileUrl: 'file:///tmp/abc123.pdf', filename: 'report.pdf', contentType: 'application/pdf' },
    ];

    const result = await readAttachmentFiles(input, MAX_20MB, STORE_DIR);

    expect(result).toHaveLength(1);
    expect(result[0]!).toMatchObject({
      filename: 'report.pdf',
      contentType: 'application/pdf',
      content: buf,
    });
    expect(mockReadFile).toHaveBeenCalledWith('/tmp/abc123.pdf');
  });

  it('reads multiple files', async () => {
    const buf1 = Buffer.from('file one');
    const buf2 = Buffer.from('file two');
    mockReadFile
      .mockResolvedValueOnce(buf1)
      .mockResolvedValueOnce(buf2);

    const input: OutboundAttachmentInput[] = [
      { fileUrl: 'file:///tmp/a.pdf', filename: 'a.pdf', contentType: 'application/pdf' },
      { fileUrl: 'file:///tmp/b.png', filename: 'b.png', contentType: 'image/png' },
    ];

    const result = await readAttachmentFiles(input, MAX_20MB, STORE_DIR);

    expect(result).toHaveLength(2);
    expect(result[0]!.filename).toBe('a.pdf');
    expect(result[1]!.filename).toBe('b.png');
  });

  it('throws when file_url does not start with file://', async () => {
    const input: OutboundAttachmentInput[] = [
      { fileUrl: '/tmp/secret.pdf', filename: 'secret.pdf', contentType: 'application/pdf' },
    ];

    await expect(readAttachmentFiles(input, MAX_20MB, STORE_DIR)).rejects.toThrow('must start with file://');
  });

  it('throws on path traversal in file_url', async () => {
    const input: OutboundAttachmentInput[] = [
      { fileUrl: 'file:///tmp/../etc/passwd', filename: 'passwd', contentType: 'text/plain' },
    ];

    await expect(readAttachmentFiles(input, MAX_20MB, STORE_DIR)).rejects.toThrow('path traversal not allowed');
  });

  it('throws when path is outside the allowed store directory', async () => {
    // This simulates a prompt-injection attack: the LLM supplies a file:// URL
    // pointing at an arbitrary file (e.g. /etc/passwd) that has no .. segments
    // and would bypass only the literal-dot check. The storeDir boundary must catch it.
    const input: OutboundAttachmentInput[] = [
      { fileUrl: 'file:///etc/passwd', filename: 'passwd', contentType: 'text/plain' },
    ];

    await expect(readAttachmentFiles(input, MAX_20MB, STORE_DIR)).rejects.toThrow('outside the allowed temp store directory');
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it('throws when total size exceeds limit', async () => {
    const bigBuf = Buffer.alloc(15 * 1024 * 1024); // 15 MB
    mockReadFile.mockResolvedValue(bigBuf);

    const input: OutboundAttachmentInput[] = [
      { fileUrl: 'file:///tmp/a.pdf', filename: 'a.pdf', contentType: 'application/pdf' },
      { fileUrl: 'file:///tmp/b.pdf', filename: 'b.pdf', contentType: 'application/pdf' },
    ];

    // 15 MB + 15 MB = 30 MB > 20 MB limit
    await expect(readAttachmentFiles(input, MAX_20MB, STORE_DIR)).rejects.toThrow('20 MB');
  });

  it('throws when more than 10 attachments are provided', async () => {
    const input: OutboundAttachmentInput[] = Array.from({ length: 11 }, (_, i) => ({
      fileUrl: `file:///tmp/file${i}.pdf`,
      filename: `file${i}.pdf`,
      contentType: 'application/pdf',
    }));

    await expect(readAttachmentFiles(input, MAX_20MB, STORE_DIR)).rejects.toThrow('Too many attachments');
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it('throws when readFile fails', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT: no such file'));

    const input: OutboundAttachmentInput[] = [
      { fileUrl: 'file:///tmp/missing.pdf', filename: 'missing.pdf', contentType: 'application/pdf' },
    ];

    await expect(readAttachmentFiles(input, MAX_20MB, STORE_DIR)).rejects.toThrow('Failed to read attachment');
  });
});
