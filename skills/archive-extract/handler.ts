// handler.ts — archive-extract skill.
//
// Opens a zip or gzip attachment into temp-store files for file-parse.
// Archives are untrusted: entry names are display labels only, inflated bytes
// are counted (archive headers are not), and nothing is written until the
// whole archive is within the caps. A failure leaves no extracted files.

import fs from 'node:fs/promises';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import { createRequire } from 'node:module';
import type { ToolHandler, ToolContext, ToolResult } from '../../src/skills/types.js';
import { MAX_TEMP_FILE_BYTES } from '../../src/skills/temp-file-store.js';
import { mimeTypeFromFilename } from '../_shared/document-types.js';
import { resolveTempFileUrl } from '../_shared/temp-file-url.js';

const require = createRequire(import.meta.url);
const yauzl = require('yauzl') as YauzlModule;

/** Per-entry uncompressed cap. Same ceiling the temp store enforces on a write. */
const MAX_ENTRY_BYTES = MAX_TEMP_FILE_BYTES;
/** Uncompressed bytes, summed across every entry of one archive. */
const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;
/** Uncompressed / compressed. Checked against bytes actually inflated. */
const MAX_COMPRESSION_RATIO = 100;
const MAX_ENTRIES = 20;

const ZIP_MIME_TYPES = new Set(['application/zip', 'application/x-zip-compressed']);
const GZIP_MIME_TYPES = new Set(['application/gzip', 'application/x-gzip']);

class ArchiveExtractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveExtractError';
  }
}

interface ExtractedFile {
  filename: string;
  data: Buffer;
}

interface SkippedEntry {
  filename: string;
  reason: string;
}

type ArchiveFormat = 'zip' | 'gzip';

interface YauzlExtraField {
  id: number;
  data: Buffer;
}

interface YauzlEntry {
  fileNameRaw: Buffer;
  extraFields: YauzlExtraField[];
  generalPurposeBitFlag: number;
  compressionMethod: number;
  versionMadeBy: number;
  externalFileAttributes: number;
  isEncrypted(): boolean;
  canDecodeFileData(): boolean;
}

interface YauzlZipFile {
  entryCount: number;
  eachEntry(): AsyncIterable<YauzlEntry>;
  openReadStreamPromise(entry: YauzlEntry, options: { decodeFileData: false }): Promise<Readable>;
  close(): void;
}

interface YauzlModule {
  fromBufferPromise(buffer: Buffer, options: {
    decodeStrings: false;
    validateEntrySizes: false;
  }): Promise<YauzlZipFile>;
  getFileNameLowLevel(
    generalPurposeBitFlag: number,
    fileNameBuffer: Buffer,
    extraFields: YauzlExtraField[],
    strictFileNames: false,
  ): string;
}

export class ArchiveExtractHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.writeTempFile) {
      ctx.log.error('archive-extract: tempFileStore capability missing — execution layer misconfigured');
      return { success: false, error: 'archive-extract requires tempFileStore capability' };
    }
    const writeTempFile = ctx.writeTempFile;

    const tempFileUrl = typeof ctx.input.temp_file_url === 'string' ? ctx.input.temp_file_url.trim() : '';
    const mimeType = typeof ctx.input.mime_type === 'string'
      ? ctx.input.mime_type.trim().toLowerCase().split(';')[0]?.trim() ?? ''
      : '';
    const filename = typeof ctx.input.filename === 'string' ? ctx.input.filename.trim() : '';

    if (!tempFileUrl) {
      return { success: false, error: 'Missing required input: temp_file_url' };
    }

    const resolved = await resolveTempFileUrl(tempFileUrl);
    if (!resolved) {
      ctx.log.warn({ tempFileUrl }, 'archive-extract: rejected temp_file_url — must be file:// under allowed prefix');
      return { success: false, error: 'Invalid temp_file_url: must be a file:// URL under the temp store directory' };
    }

    let archive: Buffer;
    try {
      archive = await fs.readFile(resolved);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      ctx.log.error({ err, tempFileUrl, errCode: code }, 'archive-extract: failed to read temp file');
      if (code === 'ENOENT') {
        return { success: false, error: 'Failed to read file from temp_file_url — temp file has expired or been cleaned up. Re-download the attachment to get a fresh temp_file_url.' };
      }
      return { success: false, error: `Failed to read file from temp_file_url — filesystem error (${code ?? 'unknown'})` };
    }
    if (archive.length === 0) {
      return { success: false, error: 'Temp file at temp_file_url is empty (0 bytes) — file may have been corrupted or partially written' };
    }
    if (archive.length > MAX_TEMP_FILE_BYTES) {
      return { success: false, error: 'archive exceeds the 10 MB input limit' };
    }

    const decision = detectFormat(mimeType, filename, archive);
    if (!decision.ok) {
      ctx.log.warn({ mimeType, filename }, 'archive-extract: unsupported format');
      return { success: false, error: decision.error };
    }

    try {
      const extracted = decision.format === 'zip'
        ? await extractZip(archive)
        : await extractGzip(archive, filename);
      const entries = await storeEntries(writeTempFile, extracted.entries);
      ctx.log.info(
        { format: decision.format, entries: entries.length, skipped: extracted.skipped.length },
        'archive-extract: extracted',
      );
      return { success: true, data: { entries, skipped: extracted.skipped } };
    } catch (err) {
      if (err instanceof ArchiveExtractError) {
        ctx.log.warn({ err: err.message, format: decision.format }, 'archive-extract: rejected archive');
        return { success: false, error: err.message };
      }
      ctx.log.error({ err, format: decision.format }, 'archive-extract: unexpected error');
      return { success: false, error: 'archive-extract failed unexpectedly' };
    }
  }
}

function detectFormat(
  mimeType: string,
  filename: string,
  bytes: Buffer,
): { ok: true; format: ArchiveFormat } | { ok: false; error: string } {
  const lowerName = filename.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? '';
  const ext = extensionOf(lowerName);
  if (lowerName.endsWith('.tar.gz') || lowerName.endsWith('.tgz') || ext === '.tar') {
    return { ok: false, error: 'tar archives are not supported' };
  }
  if (ext === '.7z' || ext === '.rar') {
    return { ok: false, error: '7z and rar archives are not supported' };
  }
  if (ZIP_MIME_TYPES.has(mimeType)) return { ok: true, format: 'zip' };
  if (GZIP_MIME_TYPES.has(mimeType)) return { ok: true, format: 'gzip' };

  const generic = mimeType === '' || mimeType === 'application/octet-stream';
  if (generic && ext === '.zip') return { ok: true, format: 'zip' };
  if (generic && ext === '.gz') return { ok: true, format: 'gzip' };
  if (generic && ext === '') {
    if (looksLikeZip(bytes)) return { ok: true, format: 'zip' };
    if (looksLikeGzip(bytes)) return { ok: true, format: 'gzip' };
  }
  const shownMime = mimeType || '(none)';
  const shownExt = ext || '(none)';
  return {
    ok: false,
    error: `Unsupported archive: mime_type ${shownMime} (filename extension: ${shownExt}). Supported: .zip and .gz`,
  };
}

function looksLikeZip(bytes: Buffer): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b
    && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07);
}

function looksLikeGzip(bytes: Buffer): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

function extensionOf(basename: string): string {
  const dot = basename.lastIndexOf('.');
  if (dot <= 0) return '';
  return basename.slice(dot);
}

async function extractZip(archive: Buffer): Promise<{ entries: ExtractedFile[]; skipped: SkippedEntry[] }> {
  let zipfile: YauzlZipFile;
  try {
    // decodeStrings off: yauzl would otherwise reject `../` and absolute names
    // before we can reduce them to a display basename. validateEntrySizes off:
    // the uncompressed size in the header is not a limit we trust.
    // fromBuffer forces autoClose false, so openReadStream after the entry
    // loop below stays defined. Inflate only once every entry is classified,
    // so an encrypted or over-cap archive never writes the earlier files.
    zipfile = await yauzl.fromBufferPromise(archive, {
      decodeStrings: false,
      validateEntrySizes: false,
    });
  } catch (err) {
    throw zipFailure(err);
  }

  try {
    if (zipfile.entryCount > MAX_ENTRIES) {
      throw new ArchiveExtractError(`archive has more than ${MAX_ENTRIES} entries`);
    }

    const skipped: SkippedEntry[] = [];
    const files: Array<{ entry: YauzlEntry; filename: string }> = [];
    try {
      for await (const entry of zipfile.eachEntry()) {
        const rawName = yauzl.getFileNameLowLevel(
          entry.generalPurposeBitFlag,
          entry.fileNameRaw,
          entry.extraFields,
          false,
        );
        const displayName = sanitizeDisplayName(rawName);
        if (entry.isEncrypted() || (entry.generalPurposeBitFlag & 0x40) !== 0) {
          throw new ArchiveExtractError(`entry "${displayName}" is encrypted`);
        }
        const kind = classifyEntry(entry, rawName);
        if (kind !== 'file') {
          skipped.push({ filename: displayName, reason: kind });
          continue;
        }
        if (!entry.canDecodeFileData()) {
          throw new ArchiveExtractError(`entry "${displayName}" uses an unsupported compression method`);
        }
        files.push({ entry, filename: displayName });
      }
    } catch (err) {
      if (err instanceof ArchiveExtractError) throw err;
      throw zipFailure(err);
    }

    const entries: ExtractedFile[] = [];
    let total = 0;
    for (const file of files) {
      const data = await inflateZipEntry(zipfile, file.entry, file.filename, MAX_ARCHIVE_BYTES - total);
      total += data.length;
      // A nested archive is just another file. Opening it is a separate call.
      entries.push({ filename: file.filename, data });
    }
    return { entries, skipped };
  } finally {
    zipfile.close();
  }
}

function zipFailure(err: unknown): ArchiveExtractError {
  if (err instanceof ArchiveExtractError) return err;
  const message = err instanceof Error ? err.message : String(err);
  if (/encrypt/i.test(message)) return new ArchiveExtractError('archive contains an encrypted entry');
  return new ArchiveExtractError(`archive is not a valid zip file: ${message}`);
}

function classifyEntry(entry: YauzlEntry, rawName: string): 'file' | 'directory' | 'symlink' | 'not a regular file' {
  if (rawName.endsWith('/') || rawName.endsWith('\\')) return 'directory';
  const host = entry.versionMadeBy >>> 8;
  if (host === 3) {
    const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
    const type = mode & 0o170000;
    if (type === 0o040000) return 'directory';
    if (type === 0o120000) return 'symlink';
    if (type !== 0 && type !== 0o100000) return 'not a regular file';
    return 'file';
  }
  // DOS / Windows directory attribute.
  if ((entry.externalFileAttributes & 0x10) !== 0) return 'directory';
  return 'file';
}

async function inflateZipEntry(
  zipfile: YauzlZipFile,
  entry: YauzlEntry,
  filename: string,
  totalRemaining: number,
): Promise<Buffer> {
  let compressed: Buffer;
  try {
    const stream = await zipfile.openReadStreamPromise(entry, { decodeFileData: false });
    compressed = await readEntireStream(stream);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ArchiveExtractError(`entry "${filename}" could not be read: ${message}`);
  }
  if (entry.compressionMethod === 0) return acceptPlain(compressed, filename, totalRemaining);
  if (entry.compressionMethod === 8) return inflateRawCapped(compressed, filename, totalRemaining);
  throw new ArchiveExtractError(`entry "${filename}" uses an unsupported compression method`);
}

async function extractGzip(
  archive: Buffer,
  filename: string,
): Promise<{ entries: ExtractedFile[]; skipped: SkippedEntry[] }> {
  const header = parseGzipHeader(archive);
  const memberName = gzipMemberName(filename, header.headerName);
  const payload = archive.subarray(header.dataStart);
  const output = inflateRawCapped(payload, memberName, MAX_ARCHIVE_BYTES, archive.length);
  const consumed = await deflateBytesConsumed(payload);
  const trailerAt = header.dataStart + consumed;
  if (archive.length < trailerAt + 8) {
    throw new ArchiveExtractError('gzip archive is truncated');
  }
  if (archive.length > trailerAt + 8) {
    throw new ArchiveExtractError('gzip archive has multiple members; only a single member is supported');
  }
  const expectedCrc = archive.readUInt32LE(trailerAt);
  const actualCrc = zlib.crc32(output) >>> 0;
  if (expectedCrc !== actualCrc) {
    throw new ArchiveExtractError('gzip archive is corrupt');
  }
  // ISIZE (the last four bytes) is the size the header claims. The bytes above
  // are what actually inflated, already checked against the caps.
  return {
    entries: [{ filename: memberName, data: output }],
    skipped: [],
  };
}

function parseGzipHeader(buf: Buffer): { dataStart: number; headerName: string | null } {
  if (buf.length < 10 || buf[0] !== 0x1f || buf[1] !== 0x8b) {
    throw new ArchiveExtractError('archive is not a valid gzip file');
  }
  if (buf[2] !== 8) throw new ArchiveExtractError('gzip compression method is not supported');
  const flags = buf[3] ?? 0;
  if ((flags & 0xe0) !== 0) throw new ArchiveExtractError('gzip header has unsupported flags');
  let offset = 10;
  if (flags & 0x04) {
    if (offset + 2 > buf.length) throw new ArchiveExtractError('gzip archive is truncated');
    const extraLength = buf.readUInt16LE(offset);
    offset += 2 + extraLength;
  }
  let headerName: string | null = null;
  if (flags & 0x08) {
    const end = buf.indexOf(0, offset);
    if (end === -1) throw new ArchiveExtractError('gzip archive is truncated');
    headerName = buf.subarray(offset, end).toString('utf8');
    offset = end + 1;
  }
  if (flags & 0x10) {
    const end = buf.indexOf(0, offset);
    if (end === -1) throw new ArchiveExtractError('gzip archive is truncated');
    offset = end + 1;
  }
  if (flags & 0x02) offset += 2;
  if (offset > buf.length) throw new ArchiveExtractError('gzip archive is truncated');
  return { dataStart: offset, headerName };
}

/**
 * How many compressed bytes the first deflate member consumed.
 * Node's InflateRaw `bytesWritten` counts bytes written *to* the engine (the
 * compressed input), despite the name. Only call this after a capped inflate
 * has already succeeded, so this second pass cannot expand a bomb.
 */
function deflateBytesConsumed(payload: Buffer): Promise<number> {
  const inflator = zlib.createInflateRaw();
  return new Promise((resolve, reject) => {
    inflator.on('data', (chunk: Buffer) => {
      // Drain. This pass only measures where the member ends; the bytes were
      // already inflated under the cap.
      void chunk;
    });
    inflator.on('error', () => reject(new ArchiveExtractError('gzip archive is corrupt')));
    inflator.on('end', () => resolve(inflator.bytesWritten));
    inflator.end(payload);
  });
}

function gzipMemberName(filename: string, headerName: string | null): string {
  const fromArg = sanitizeDisplayName(filename).replace(/\.gz$/i, '');
  if (fromArg !== '' && fromArg !== 'unnamed') return sanitizeDisplayName(fromArg);
  if (headerName) {
    const fromHeader = sanitizeDisplayName(headerName);
    if (fromHeader !== 'unnamed') return fromHeader;
  }
  return 'unnamed';
}

type LimitKind = 'entry' | 'total' | 'ratio';

function bindingLimit(compressedLength: number, totalRemaining: number): { kind: LimitKind; bytes: number } {
  const ratioBytes = Math.max(1, compressedLength) * MAX_COMPRESSION_RATIO;
  const candidates: Array<{ kind: LimitKind; bytes: number }> = [
    { kind: 'entry', bytes: MAX_ENTRY_BYTES },
    { kind: 'total', bytes: Math.max(0, totalRemaining) },
    { kind: 'ratio', bytes: ratioBytes },
  ];
  return candidates.reduce((smallest, candidate) => candidate.bytes < smallest.bytes ? candidate : smallest);
}

function limitMessage(kind: LimitKind, filename: string): string {
  if (kind === 'entry') return `entry "${filename}" exceeds 10 MB uncompressed`;
  if (kind === 'total') return 'archive exceeds 25 MB uncompressed';
  return `entry "${filename}" compression ratio exceeds 100:1`;
}

function inflateRawCapped(
  compressed: Buffer,
  filename: string,
  totalRemaining: number,
  ratioDenominator?: number,
): Buffer {
  const limit = bindingLimit(ratioDenominator ?? compressed.length, totalRemaining);
  if (limit.bytes <= 0) throw new ArchiveExtractError(limitMessage(limit.kind, filename));
  try {
    const output = zlib.inflateRawSync(compressed, { maxOutputLength: limit.bytes });
    if (output.length > limit.bytes) throw new ArchiveExtractError(limitMessage(limit.kind, filename));
    return output;
  } catch (err) {
    if (err instanceof ArchiveExtractError) throw err;
    if (isOutputCap(err)) throw new ArchiveExtractError(limitMessage(limit.kind, filename));
    throw new ArchiveExtractError(`entry "${filename}" is corrupt or not a deflate stream`);
  }
}

function acceptPlain(data: Buffer, filename: string, totalRemaining: number): Buffer {
  if (data.length > MAX_ENTRY_BYTES) {
    throw new ArchiveExtractError(`entry "${filename}" exceeds 10 MB uncompressed`);
  }
  if (data.length > totalRemaining) {
    throw new ArchiveExtractError('archive exceeds 25 MB uncompressed');
  }
  return data;
}

function isOutputCap(err: unknown): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE';
}

async function readEntireStream(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer | string | Uint8Array>) {
    if (typeof chunk === 'string') chunks.push(Buffer.from(chunk));
    else chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Basename only, control characters removed. Never used as a filesystem path;
 * the temp store generates its own filename and this string is the label.
 */
function sanitizeDisplayName(raw: string): string {
  const withoutTrail = raw.replace(/[\\/]+$/, '');
  const base = withoutTrail.replace(/\\/g, '/').split('/').pop() ?? '';
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') return 'unnamed';
  return cleaned.slice(0, 200);
}

async function storeEntries(
  writeTempFile: (buffer: Buffer, filename: string) => Promise<string>,
  files: ExtractedFile[],
): Promise<Array<{ filename: string; mime_type: string; size_bytes: number; temp_file_url: string }>> {
  const entries: Array<{ filename: string; mime_type: string; size_bytes: number; temp_file_url: string }> = [];
  const written: string[] = [];
  try {
    for (const file of files) {
      const tempFileUrl = await writeTempFile(file.data, file.filename);
      written.push(tempFileUrl);
      entries.push({
        filename: file.filename,
        mime_type: mimeTypeFromFilename(file.filename) ?? 'application/octet-stream',
        size_bytes: file.data.length,
        temp_file_url: tempFileUrl,
      });
    }
    return entries;
  } catch (err) {
    const leftover = await discardTempFiles(written);
    const detail = err instanceof Error ? err.message : String(err);
    const disclosure = leftover.length > 0
      ? ` Partial files could not be removed (${leftover.length}).`
      : ' No extracted files were kept.';
    throw new ArchiveExtractError(`failed to store extracted file: ${detail}.${disclosure}`);
  }
}

async function discardTempFiles(urls: string[]): Promise<string[]> {
  const failed: string[] = [];
  for (const url of urls) {
    const resolved = await resolveTempFileUrl(url);
    if (!resolved) {
      failed.push(url);
      continue;
    }
    try {
      await fs.unlink(resolved);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') failed.push(resolved);
    }
  }
  return failed;
}
