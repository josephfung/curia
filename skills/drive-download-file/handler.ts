import { Readable } from 'node:stream';
import { google } from 'googleapis';
import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { MAX_TEMP_FILE_BYTES } from '../../src/skills/temp-file-store.js';
import { getDriveClient } from '../../src/google/drive-auth.js';

const GOOGLE_APPS_PREFIX = 'application/vnd.google-apps.';
const DEFAULT_EXPORT_MIME = 'application/pdf';

// Maps export MIME types to filename extensions for Google-native files.
// Used to append a meaningful extension (e.g. .pdf) when Drive metadata
// has no extension (Google Docs are typically named without one).
const EXPORT_EXTENSIONS: Record<string, string> = {
  'application/pdf': '.pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'text/plain': '.txt',
  'text/csv': '.csv',
};

function extractFileId(fileIdOrUrl: string): string {
  const trimmed = fileIdOrUrl.trim();
  const pathMatch = /\/d\/([a-zA-Z0-9_-]+)/.exec(trimmed);
  if (pathMatch) return pathMatch[1]!;
  const queryMatch = /[?&]id=([a-zA-Z0-9_-]+)/.exec(trimmed);
  if (queryMatch) return queryMatch[1]!;
  return trimmed;
}

function resolveOutputFilename(
  driveName: string,
  hint: string | undefined,
  isGoogleNative: boolean,
  exportMime: string,
): string {
  if (hint) return hint;
  if (!isGoogleNative) return driveName;
  const ext = EXPORT_EXTENSIONS[exportMime] ?? '.pdf';
  if (driveName.toLowerCase().endsWith(ext)) return driveName;
  return driveName + ext;
}

async function streamToBuffer(stream: Readable, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let destroyed = false;
    let settled = false;

    const settle = (fn: () => void) => {
      if (!settled) {
        settled = true;
        fn();
      }
    };

    stream.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        destroyed = true;
        stream.destroy(new Error('SIZE_EXCEEDED'));
        return;
      }
      chunks.push(chunk);
    });

    stream.on('end', () => {
      if (destroyed) return;
      settle(() => resolve(Buffer.concat(chunks)));
    });
    stream.on('error', (err) => { settle(() => reject(err)); });
    // Some stream implementations (Axios/http) emit 'close' instead of 'error'
    // after destroy() — ensure the promise always settles.
    stream.on('close', () => {
      if (destroyed) settle(() => reject(new Error('SIZE_EXCEEDED')));
    });
  });
}

export class DriveDownloadFileHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    if (!ctx.writeTempFile) {
      return { success: false, error: 'drive-download-file requires tempFileStore capability' };
    }

    const input =
      ctx.input && typeof ctx.input === 'object' ? (ctx.input as Record<string, unknown>) : {};
    const { file_id_or_url: rawIdOrUrl, filename: rawFilename, export_mime_type: rawExportMime } =
      input as { file_id_or_url?: string; filename?: string; export_mime_type?: string };

    const rawInput = typeof rawIdOrUrl === 'string' ? rawIdOrUrl.trim() : '';
    if (!rawInput) {
      return { success: false, error: 'Missing required input: file_id_or_url' };
    }

    const fileId = extractFileId(rawInput);
    const exportMime =
      typeof rawExportMime === 'string' && rawExportMime.trim()
        ? rawExportMime.trim()
        : DEFAULT_EXPORT_MIME;
    const filenameHint =
      typeof rawFilename === 'string' && rawFilename.trim() ? rawFilename.trim() : undefined;

    // Auth
    let auth: Awaited<ReturnType<typeof getDriveClient>>;
    try {
      auth = await getDriveClient();
    } catch (err) {
      ctx.log.error({ err }, 'drive-download-file: getDriveClient failed');
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }

    const drive = google.drive({ version: 'v3', auth });

    // Metadata
    let driveName: string;
    let driveMimeType: string;
    let declaredSize: number | null;
    try {
      const res = await drive.files.get({ fileId, fields: 'name,mimeType,size' });
      driveName = res.data.name ?? fileId;
      driveMimeType = res.data.mimeType ?? 'application/octet-stream';
      declaredSize =
        typeof res.data.size === 'string' ? parseInt(res.data.size, 10) : null;
    } catch (err) {
      const status = (err as { response?: { status?: number } }).response?.status;
      if (status === 404) {
        return {
          success: false,
          error: `Drive file ${fileId} not found or not shared with Curia`,
        };
      }
      if (status === 403) {
        return {
          success: false,
          error: `Curia does not have access to Drive file ${fileId}. Share it with Curia's Gmail address.`,
        };
      }
      const detail = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, fileId }, 'drive-download-file: metadata fetch failed');
      return {
        success: false,
        error: `Failed to fetch Drive file metadata for ${fileId}: ${detail}`,
      };
    }

    const isGoogleNative = driveMimeType.startsWith(GOOGLE_APPS_PREFIX);
    const outputFilename = resolveOutputFilename(driveName, filenameHint, isGoogleNative, exportMime);

    // Pre-download size check for native binary files where metadata includes size
    if (!isGoogleNative && declaredSize !== null && !Number.isNaN(declaredSize)) {
      if (declaredSize > MAX_TEMP_FILE_BYTES) {
        const sizeMB = (declaredSize / (1024 * 1024)).toFixed(1);
        return {
          success: false,
          error: `Drive file "${driveName}" is ${sizeMB} MB — exceeds the 10 MB download limit`,
        };
      }
    }

    ctx.log.info(
      { fileId, filename: outputFilename, mimeType: driveMimeType, isGoogleNative },
      'drive-download-file: downloading',
    );

    // Download
    let buffer: Buffer;
    let contentType: string;
    try {
      if (isGoogleNative) {
        const res = await drive.files.export(
          { fileId, mimeType: exportMime },
          { responseType: 'stream' },
        );
        buffer = await streamToBuffer(res.data as unknown as Readable, MAX_TEMP_FILE_BYTES);
        contentType = exportMime;
      } else {
        const res = await drive.files.get(
          { fileId, alt: 'media' },
          { responseType: 'stream' },
        );
        buffer = await streamToBuffer(res.data as unknown as Readable, MAX_TEMP_FILE_BYTES);
        contentType = driveMimeType;
      }
    } catch (err) {
      if (err instanceof Error && err.message === 'SIZE_EXCEEDED') {
        return {
          success: false,
          error: `Drive file "${driveName}" exceeds the 10 MB download limit`,
        };
      }
      const status = (err as { response?: { status?: number } }).response?.status;
      if (status === 403) {
        return {
          success: false,
          error: `Curia does not have access to Drive file ${fileId}. Share it with Curia's Gmail address.`,
        };
      }
      const detail = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, fileId, filename: outputFilename }, 'drive-download-file: download failed');
      return { success: false, error: `Failed to download Drive file "${driveName}": ${detail}` };
    }

    // TempFileStore write
    let tempFileUrl: string;
    try {
      tempFileUrl = await ctx.writeTempFile(buffer, outputFilename);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, filename: outputFilename }, 'drive-download-file: writeTempFile failed');
      return { success: false, error: `Failed to write Drive file to temp storage: ${detail}` };
    }

    return {
      success: true,
      data: {
        temp_file_url: tempFileUrl,
        filename: outputFilename,
        content_type: contentType,
        size: buffer.length,
      },
    };
  }
}
