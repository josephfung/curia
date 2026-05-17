// temp-file-store.ts — Secure temporary file storage for binary content.
//
// Writes buffers to a noexec tmpfs mount and returns file:// URLs that MCP
// tools (e.g. create_drive_file) can read directly. Files are cleaned up via
// TTL sweep and startup purge.
//
// Security: see docs/specs/2026-05-16-temp-attachment-store-design.md

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Centralized per-file size limit. Exported so upstream skills can reference it
 * for pre-download validation rather than re-declaring their own constants.
 */
export const MAX_TEMP_FILE_BYTES = 10 * 1024 * 1024; // 10 MB

export interface TempFileStoreOptions {
  /** Directory for temp files. Defaults to CURIA_TEMPFILE_DIR env or /run/curia-tempfiles. */
  dir?: string;
  /** Max file size in bytes. Defaults to CURIA_TEMPFILE_MAX_BYTES env or MAX_TEMP_FILE_BYTES. */
  maxBytes?: number;
  /** TTL in ms before sweep removes files. Defaults to CURIA_TEMPFILE_TTL_MS env or 300000. */
  ttlMs?: number;
  /** Sweep interval in ms. 0 disables auto-sweep (for tests). Defaults to 60000. */
  sweepIntervalMs?: number;
}

export class TempFileStore {
  readonly dir: string;
  private readonly maxBytes: number;
  private readonly ttlMs: number;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private logger?: { warn(obj: Record<string, unknown>, msg: string): void };

  constructor(options?: TempFileStoreOptions) {
    this.dir = options?.dir
      ?? process.env.CURIA_TEMPFILE_DIR
      ?? '/run/curia-tempfiles';
    this.maxBytes = options?.maxBytes
      ?? (process.env.CURIA_TEMPFILE_MAX_BYTES ? parseInt(process.env.CURIA_TEMPFILE_MAX_BYTES, 10) : MAX_TEMP_FILE_BYTES);
    this.ttlMs = options?.ttlMs
      ?? (process.env.CURIA_TEMPFILE_TTL_MS ? parseInt(process.env.CURIA_TEMPFILE_TTL_MS, 10) : 300_000);

    const sweepIntervalMs = options?.sweepIntervalMs ?? 60_000;
    if (sweepIntervalMs > 0) {
      this.sweepTimer = setInterval(() => { void this.sweep(this.ttlMs); }, sweepIntervalMs);
      // Allow the process to exit without waiting for the timer
      this.sweepTimer.unref();
    }
  }

  /**
   * Initialize the store directory. Call once at startup.
   * Creates the directory if it doesn't exist (local dev fallback)
   * and purges any stale files from a previous run.
   */
  async init(logger?: { warn(obj: Record<string, unknown>, msg: string): void }): Promise<void> {
    this.logger = logger;
    // Check if the directory already exists (pre-mounted tmpfs in production)
    let preExists = true;
    try {
      await fs.access(this.dir);
    } catch {
      preExists = false;
    }

    if (!preExists) {
      // Local dev or misconfigured deploy — create as regular directory.
      // Warn that this lacks tmpfs security properties (noexec, RAM-only).
      logger?.warn(
        { dir: this.dir },
        'TempFileStore: directory does not exist as a pre-mounted tmpfs — creating as regular directory. ' +
        'In production, mount a tmpfs at this path (see docker-compose.yml).',
      );
      await fs.mkdir(this.dir, { mode: 0o700, recursive: true });
    }

    // Startup purge — clean slate after unclean shutdown
    await this.purgeAll(logger);
  }

  /** Write binary content. Returns a file:// URL. Throws if size exceeds limit. */
  async write(buffer: Buffer, originalFilename: string): Promise<string> {
    if (buffer.length > this.maxBytes) {
      const sizeMB = (buffer.length / (1024 * 1024)).toFixed(1);
      const limitMB = (this.maxBytes / (1024 * 1024)).toFixed(0);
      throw new Error(
        `Temp file size ${sizeMB} MB exceeds the ${limitMB} MB limit`,
      );
    }

    const ext = this.sanitizeExtension(originalFilename);
    const filename = `${crypto.randomUUID()}${ext}`;
    const filePath = path.join(this.dir, filename);

    await fs.writeFile(filePath, buffer, { mode: 0o600 });
    return `file://${filePath}`;
  }

  /** Delete a previously written file by its URL. Idempotent. */
  async delete(fileUrl: string): Promise<void> {
    const filePath = fileUrl.replace('file://', '');
    const resolved = path.resolve(filePath);
    // Refuse to delete files outside the store directory — prevents path traversal.
    if (!resolved.startsWith(this.dir + path.sep) && resolved !== this.dir) {
      throw new Error(`Refusing to delete file outside temp store: ${resolved}`);
    }
    try {
      await fs.unlink(resolved);
    } catch (err) {
      // Idempotent — already deleted or never existed
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  /** Remove all files older than maxAgeMs. Returns count of removed files. */
  async sweep(maxAgeMs: number): Promise<number> {
    const cutoff = Date.now() - maxAgeMs;
    let removed = 0;

    let entries: string[];
    try {
      entries = await fs.readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0; // Not initialized yet
      // Any other error (EACCES, EIO, ENOTDIR) means cleanup is broken — log it.
      this.logger?.warn({ err, dir: this.dir }, 'TempFileStore.sweep: readdir failed — sweep skipped, files may accumulate');
      return 0;
    }

    for (const entry of entries) {
      const filePath = path.join(this.dir, entry);
      try {
        const stat = await fs.stat(filePath);
        if (stat.mtimeMs < cutoff) {
          await fs.unlink(filePath);
          removed++;
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          // ENOENT = benign race (file deleted between readdir and stat). Anything else is unexpected.
          this.logger?.warn({ err, filePath }, 'TempFileStore.sweep: could not stat/unlink file');
        }
      }
    }
    return removed;
  }

  /** Shut down: clear all files, stop sweep timer. */
  async shutdown(): Promise<void> {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    await this.purgeAll(this.logger);
  }

  /** Remove all files in the store directory. */
  private async purgeAll(logger?: { warn(obj: Record<string, unknown>, msg: string): void }): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger?.warn({ err, dir: this.dir }, 'TempFileStore.purgeAll: readdir failed — purge skipped, stale files may persist');
      }
      return; // ENOENT = directory doesn't exist, nothing to purge
    }
    for (const entry of entries) {
      try {
        await fs.unlink(path.join(this.dir, entry));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          // ENOENT = already gone, truly benign. Anything else is worth surfacing.
          logger?.warn({ err, entry, dir: this.dir }, 'TempFileStore.purgeAll: could not unlink — file may persist');
        }
      }
    }
  }

  /**
   * Extract and sanitize the file extension from an original filename.
   * Strips path separators, null bytes, limits length. Falls back to '.bin'.
   */
  private sanitizeExtension(originalFilename: string): string {
    // Strip path components — only the basename matters
    const basename = path.basename(originalFilename);
    // Remove null bytes
    const clean = basename.replace(/\0/g, '');
    // Extract extension
    let ext = path.extname(clean).toLowerCase();

    if (!ext || ext === '.') {
      return '.bin';
    }

    // Keep only alphanumeric chars and dot in the extension
    ext = ext.replace(/[^a-z0-9.]/g, '');

    // Limit to dot + 10 chars
    if (ext.length > 11) {
      ext = ext.slice(0, 11);
    }

    return ext;
  }
}
