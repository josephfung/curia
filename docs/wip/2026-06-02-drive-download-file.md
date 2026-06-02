# drive-download-file Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `drive-download-file` skill that downloads a Google Drive file to TempFileStore and returns a `file://` URL, enabling the coordinator to attach Drive files to outbound emails.

**Architecture:** New local skill `drive-download-file` mirrors `email-download-attachment`. A shared `src/google/drive-auth.ts` module loads the OAuth credentials from the workspace-mcp token cache and constructs a `googleapis` `OAuth2Client` cached per process. The handler calls `drive.files.get` (native binary) or `drive.files.export` (Google-native formats), streams bytes into a buffer with a 10 MB hard limit, writes to TempFileStore, and returns the `file://` URL.

**Tech Stack:** Node 22, TypeScript ESM, `googleapis` npm package, `SkillContext.writeTempFile`, Vitest

**Worktree:** `/Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-drive-download-file`

---

## File Map

| Action | Path | Purpose |
|---|---|---|
| Create | `src/google/drive-auth.ts` | Load workspace-mcp token cache → `OAuth2Client` |
| Create | `src/google/drive-auth.test.ts` | Unit tests for token loading |
| Create | `skills/drive-download-file/skill.json` | Skill manifest |
| Create | `skills/drive-download-file/handler.ts` | Skill handler |
| Create | `skills/drive-download-file/handler.test.ts` | Unit tests for handler |
| Modify | `package.json` | Add `googleapis` dependency |
| Modify | `agents/coordinator.yaml` | Pin skill + add Drive→email workflow note |
| Modify | `CHANGELOG.md` | Entry under `[Unreleased]` |

---

## Task 1: Install dependencies and set up worktree

**Files:** `package.json`

- [ ] **Step 1: Install node_modules in the worktree**

```bash
pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-drive-download-file install
```

- [ ] **Step 2: Add googleapis**

```bash
pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-drive-download-file add googleapis
```

- [ ] **Step 3: Verify typecheck still passes**

```bash
pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-drive-download-file run typecheck
```

Expected: no errors

- [ ] **Step 4: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-drive-download-file add package.json pnpm-lock.yaml
git -C /Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-drive-download-file commit -m "chore: add googleapis dependency"
```

---

## Task 2: `src/google/drive-auth.ts` — token loading module

**Files:**
- Create: `src/google/drive-auth.ts`
- Create: `src/google/drive-auth.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/google/drive-auth.test.ts`:

```typescript
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { getDriveClient, clearDriveClientCache } from './drive-auth.js';

// Prevent real OAuth2 construction — we only test token loading logic.
vi.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: vi.fn().mockImplementation((clientId: string, clientSecret: string) => ({
        clientId,
        clientSecret,
        setCredentials: vi.fn(),
      })),
    },
  },
}));

let tmpDir: string;
let tokenCachePath: string;

const validTokenJson = JSON.stringify({
  refresh_token: 'test-refresh-token',
  token: 'test-access-token',
  token_uri: 'https://oauth2.googleapis.com/token',
});

beforeEach(async () => {
  clearDriveClientCache();
  process.env.GOOGLE_OAUTH_CLIENT_ID = 'test-client-id';
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'test-client-secret';
  process.env.CURIA_GOOGLE_EMAIL = 'curia@test.com';
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drive-auth-test-'));
  tokenCachePath = path.join(tmpDir, 'tokens.json');
});

afterEach(async () => {
  clearDriveClientCache();
  await fs.rm(tmpDir, { recursive: true, force: true });
  delete process.env.GOOGLE_OAUTH_CLIENT_ID;
  delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  delete process.env.CURIA_GOOGLE_EMAIL;
});

describe('getDriveClient — env var validation', () => {
  it('throws when GOOGLE_OAUTH_CLIENT_ID is missing', async () => {
    delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    await expect(getDriveClient({ tokenCachePath })).rejects.toThrow('GOOGLE_OAUTH_CLIENT_ID');
  });

  it('throws when GOOGLE_OAUTH_CLIENT_SECRET is missing', async () => {
    delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    await expect(getDriveClient({ tokenCachePath })).rejects.toThrow('GOOGLE_OAUTH_CLIENT_SECRET');
  });

  it('throws when CURIA_GOOGLE_EMAIL is missing', async () => {
    delete process.env.CURIA_GOOGLE_EMAIL;
    await expect(getDriveClient({ tokenCachePath })).rejects.toThrow('CURIA_GOOGLE_EMAIL');
  });
});

describe('getDriveClient — token cache', () => {
  it('throws with setup instructions when cache file is missing', async () => {
    const err = await getDriveClient({ tokenCachePath: '/nonexistent/path.json' }).catch(e => e as Error);
    expect(err.message).toContain('token cache not found');
    expect(err.message).toContain('docs/dev/google-drive.md');
  });

  it('throws when refresh_token is absent from cache', async () => {
    await fs.writeFile(tokenCachePath, JSON.stringify({ token: 'access-only' }));
    await expect(getDriveClient({ tokenCachePath })).rejects.toThrow('missing refresh_token');
  });

  it('returns an OAuth2Client with setCredentials called on success', async () => {
    await fs.writeFile(tokenCachePath, validTokenJson);
    const client = await getDriveClient({ tokenCachePath });
    expect(client).toBeDefined();
    expect((client as unknown as { setCredentials: ReturnType<typeof vi.fn> }).setCredentials)
      .toHaveBeenCalledWith({ refresh_token: 'test-refresh-token' });
  });

  it('returns cached client on subsequent calls (reads file only once)', async () => {
    await fs.writeFile(tokenCachePath, validTokenJson);
    const a = await getDriveClient({ tokenCachePath });
    const b = await getDriveClient({ tokenCachePath });
    expect(a).toBe(b);
  });
});
```

- [ ] **Step 2: Run tests — expect all to fail**

```bash
pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-drive-download-file run test src/google/drive-auth.test.ts
```

Expected: failures because `drive-auth.ts` does not exist yet.

- [ ] **Step 3: Implement `src/google/drive-auth.ts`**

```typescript
import fs from 'node:fs/promises';
import path from 'node:path';
import { google } from 'googleapis';

// Cached per process — googleapis auto-refreshes the access token using the
// long-lived refresh_token, so we only need to load from disk once.
let cachedClient: InstanceType<typeof google.auth.OAuth2> | null = null;

export interface DriveAuthOptions {
  tokenCachePath?: string;
  clientId?: string;
  clientSecret?: string;
  email?: string;
}

export async function getDriveClient(
  options?: DriveAuthOptions,
): Promise<InstanceType<typeof google.auth.OAuth2>> {
  if (cachedClient) return cachedClient;

  const clientId = options?.clientId ?? process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = options?.clientSecret ?? process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const email = options?.email ?? process.env.CURIA_GOOGLE_EMAIL;

  if (!clientId) throw new Error('GOOGLE_OAUTH_CLIENT_ID is not set');
  if (!clientSecret) throw new Error('GOOGLE_OAUTH_CLIENT_SECRET is not set');
  if (!email) throw new Error('CURIA_GOOGLE_EMAIL is not set');

  const tokenCachePath =
    options?.tokenCachePath ??
    path.join(
      process.env.HOME ?? '/root',
      '.google_workspace_mcp',
      'credentials',
      `${email}.json`,
    );

  let tokenData: Record<string, unknown>;
  try {
    const raw = await fs.readFile(tokenCachePath, 'utf-8');
    tokenData = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `Google OAuth token cache not found at ${tokenCachePath}. ` +
          `Complete the Drive auth setup (docs/dev/google-drive.md).`,
      );
    }
    throw new Error(
      `Failed to read Google OAuth token cache at ${tokenCachePath}: ${String(err)}`,
    );
  }

  const refreshToken =
    typeof tokenData['refresh_token'] === 'string' ? tokenData['refresh_token'] : undefined;
  if (!refreshToken) {
    throw new Error(
      `Google OAuth token cache at ${tokenCachePath} is missing refresh_token. Re-run the OAuth flow.`,
    );
  }

  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: refreshToken });
  cachedClient = auth;
  return auth;
}

/** Reset the cached client. For tests only. */
export function clearDriveClientCache(): void {
  cachedClient = null;
}
```

- [ ] **Step 4: Run tests — expect all to pass**

```bash
pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-drive-download-file run test src/google/drive-auth.test.ts
```

Expected: all pass.

- [ ] **Step 5: Typecheck**

```bash
pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-drive-download-file run typecheck
```

- [ ] **Step 6: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-drive-download-file add src/google/drive-auth.ts src/google/drive-auth.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-drive-download-file commit -m "feat: drive-auth module for loading workspace-mcp OAuth token cache"
```

---

## Task 3: Skill manifest

**Files:**
- Create: `skills/drive-download-file/skill.json`

- [ ] **Step 1: Create the manifest**

```json
{
  "name": "drive-download-file",
  "description": "Download a file from Google Drive to temporary storage and return a file:// URL for use with email-send or email-reply attachments. Accepts a Drive file ID or any drive.google.com / docs.google.com URL. Google Docs/Sheets/Slides are exported to PDF by default; pass export_mime_type to override. Pass the returned temp_file_url in the attachments array of email-send or email-reply.",
  "version": "0.1.0",
  "sensitivity": "normal",
  "action_risk": "none",
  "inputs": {
    "file_id_or_url": "string (Google Drive file ID or full Drive URL — drive.google.com/file/d/<id>/..., drive.google.com/open?id=<id>, drive.google.com/uc?id=<id>, docs.google.com/document/d/<id>/..., docs.google.com/spreadsheets/d/<id>/..., docs.google.com/presentation/d/<id>/...)",
    "filename": "string? (filename hint for the output. Falls back to the name from Drive metadata.)",
    "export_mime_type": "string? (for Google-native formats — Docs/Sheets/Slides — the MIME type to export to. Defaults to application/pdf. Use application/vnd.openxmlformats-officedocument.wordprocessingml.document for DOCX from a Google Doc.)"
  },
  "outputs": {
    "temp_file_url": "string (file:// URL of the downloaded bytes on disk — pass this as file_url in the attachments array of email-send or email-reply)",
    "filename": "string (filename of the downloaded file, with appropriate extension)",
    "content_type": "string (MIME type of the downloaded/exported content)",
    "size": "number (byte count after download)"
  },
  "permissions": [],
  "secrets": [],
  "timeout": 60000,
  "capabilities": ["tempFileStore"]
}
```

- [ ] **Step 2: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-drive-download-file add skills/drive-download-file/skill.json
git -C /Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-drive-download-file commit -m "feat: drive-download-file skill manifest"
```

---

## Task 4: Handler — input validation and URL extraction

**Files:**
- Create: `skills/drive-download-file/handler.ts` (partial — validation + extraction only)
- Create: `skills/drive-download-file/handler.test.ts` (validation + extraction tests)

- [ ] **Step 1: Write failing tests for input validation and URL extraction**

Create `skills/drive-download-file/handler.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run tests — expect failures**

```bash
pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-drive-download-file run test skills/drive-download-file/handler.test.ts
```

Expected: module not found error (handler.ts doesn't exist yet).

- [ ] **Step 3: Create `skills/drive-download-file/handler.ts` skeleton with validation + extraction**

```typescript
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

    stream.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        stream.destroy(new Error('SIZE_EXCEEDED'));
        return;
      }
      chunks.push(chunk);
    });

    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
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
```

- [ ] **Step 4: Run the validation + URL extraction tests — expect pass**

```bash
pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-drive-download-file run test skills/drive-download-file/handler.test.ts
```

Expected: the 6 tests in `input validation` and `URL extraction` groups pass.

- [ ] **Step 5: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-drive-download-file add skills/drive-download-file/handler.ts skills/drive-download-file/handler.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-drive-download-file commit -m "feat: drive-download-file handler skeleton with input validation"
```

---

## Task 5: Handler tests — metadata, download, export, errors

These tests cover the rest of the handler behavior. The handler is already fully implemented from Task 4 Step 3, so these tests should pass immediately. Add them to `handler.test.ts` after the existing tests.

- [ ] **Step 1: Add remaining tests to `skills/drive-download-file/handler.test.ts`**

Append these `describe` blocks after the existing ones:

```typescript
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
    // Drive download should NOT have been called
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
```

- [ ] **Step 2: Run all handler tests — expect all to pass**

```bash
pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-drive-download-file run test skills/drive-download-file/handler.test.ts
```

Expected: all tests pass (handler was fully implemented in Task 4).

- [ ] **Step 3: Typecheck**

```bash
pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-drive-download-file run typecheck
```

- [ ] **Step 4: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-drive-download-file add skills/drive-download-file/handler.test.ts skills/drive-download-file/handler.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-drive-download-file commit -m "feat: drive-download-file handler with full test coverage"
```

---

## Task 6: Wire coordinator

**Files:**
- Modify: `agents/coordinator.yaml`

The coordinator's Drive section currently ends at line ~477 (after the `create_drive_file` guidance). The `pinned_skills` Drive block starts around line 580.

- [ ] **Step 1: Add workflow note to the `## Google Workspace` section**

In `agents/coordinator.yaml`, after the paragraph ending with `Do NOT claim success.` (the `create_drive_file` failure paragraph, around line 477), add a new paragraph:

```yaml
  **Attaching a Drive file to an email:** When the CEO asks you to send an email
  with a Drive file attached, use this sequence:
  1. If you only have a file name (not an ID or URL), call search_drive_files first.
  2. Call drive-download-file with the file ID or Drive URL. It returns a temp_file_url.
  3. Pass temp_file_url in the attachments array of email-send or email-reply,
     using the returned filename and content_type fields.

  Do NOT use get_drive_file_content for attachments — it returns text only and
  cannot produce binary-safe attachments.
```

- [ ] **Step 2: Pin the skill**

In `agents/coordinator.yaml`, in the `pinned_skills` section after `get_drive_shareable_link` (around line 590), add:

```yaml
  - drive-download-file
```

- [ ] **Step 3: Bump coordinator version**

The coordinator YAML has a `version` field. Bump the minor version (new pinned skill = new capability per CLAUDE.md versioning rules). Find the current version with:

```bash
grep "^version:" /Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-drive-download-file/agents/coordinator.yaml
```

Then edit the `version:` line to the next minor version (e.g. `0.14.0` → `0.15.0`).

- [ ] **Step 4: Run full test suite to verify no regressions**

```bash
pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-drive-download-file run test
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-drive-download-file add agents/coordinator.yaml
git -C /Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-drive-download-file commit -m "feat: pin drive-download-file to coordinator and add Drive-to-email workflow note"
```

---

## Task 7: CHANGELOG

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add entry under `## [Unreleased]`**

Open `CHANGELOG.md` and add under the `## [Unreleased]` heading:

```markdown
### Added
- **`drive-download-file`** — new skill that downloads a Google Drive file (native or Google-native export) to TempFileStore and returns a `file://` URL, enabling Drive files to be attached to outbound emails. Closes #857.
```

- [ ] **Step 2: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-drive-download-file add CHANGELOG.md
git -C /Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-drive-download-file commit -m "chore: changelog entry for drive-download-file"
```
