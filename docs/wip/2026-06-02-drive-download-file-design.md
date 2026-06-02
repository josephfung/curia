# Design: `drive-download-file` skill

**Date:** 2026-06-02
**Issue:** #857
**Branch:** `feat/drive-download-file`

---

## Problem

PR #855 added file attachment support to all outbound email skills. Attachments are passed as `file://` URLs pointing to `/run/curia-tempfiles/`. The only skill that currently produces those URLs is `email-download-attachment`, which sources bytes from inbound email attachments.

No equivalent bridge exists for Google Drive. When asked to attach a Drive file to an email, the agent correctly identifies the gap and falls back to sending a shareable link. Root cause: getting binary bytes from Drive requires an authenticated `drive.files.get?alt=media` API call, and no existing tool exposes that.

---

## Solution

A new local Curia skill `drive-download-file` that:
1. Accepts a Drive file ID or URL
2. Fetches the file bytes via the Google Drive API
3. Writes bytes to TempFileStore
4. Returns a `file://` URL ready for use with any outbound email skill

This mirrors `email-download-attachment` exactly — same output shape, same size limits, same TempFileStore integration.

---

## Skill Interface

### Input

| Field | Type | Required | Description |
|---|---|---|---|
| `file_id_or_url` | string | yes | Drive file ID (`1BxiM...`) or full Drive URL (`https://drive.google.com/file/d/<id>/view`) |
| `filename` | string | no | Filename hint for the output. Falls back to the name from Drive metadata. |
| `export_mime_type` | string | no | For Google-native formats only (Docs/Sheets/Slides). Defaults to `application/pdf`. |

**URL parsing:** Extract the file ID from URLs matching:
- `https://drive.google.com/file/d/<id>/...`
- `https://drive.google.com/open?id=<id>`
- `https://drive.google.com/uc?id=<id>` (direct download links)
- `https://docs.google.com/document/d/<id>/...`
- `https://docs.google.com/spreadsheets/d/<id>/...`
- `https://docs.google.com/presentation/d/<id>/...`

Strings that don't match any URL pattern are treated as raw file IDs.

### Output

```ts
{
  temp_file_url: string;   // file:///run/curia-tempfiles/<uuid>-<filename>
  filename: string;
  content_type: string;
  size: number;            // bytes
}
```

Same shape as `email-download-attachment` — the agent can pass `temp_file_url` directly to `email-send` / `email-reply` without any transformation.

### Errors

All errors return `{ success: false, error: string }`:

| Condition | Error message |
|---|---|
| File not found | `"Drive file <id> not found or not shared with Curia"` |
| Access denied (403) | `"Curia does not have access to Drive file <id>. Share it with Curia's Gmail address."` |
| File exceeds 10 MB | `"Drive file \"<name>\" is <N> MB — exceeds the 10 MB download limit"` |
| Token cache missing | `"Google OAuth token cache not found at <path>. Complete the Drive auth setup (docs/dev/google-drive.md)."` |
| Token cache malformed | `"Google OAuth token cache at <path> is missing refresh_token. Re-run the OAuth flow."` |
| Google-native format, unsupported export type | `"Cannot export Google <type> to <mime_type>. Use application/pdf or a supported Office format."` |

### Skill manifest

```json
{
  "name": "drive-download-file",
  "description": "Download a file from Google Drive to temporary storage. Returns a file:// URL for use with email-send or email-reply attachments.",
  "action_risk": "none",
  "version": "0.1.0"
}
```

---

## Authentication

The skill reuses the OAuth credentials already established for workspace-mcp — no new setup required.

**Token loading (lazy, cached per process):**

1. Read `${HOME}/.google_workspace_mcp/credentials/${CURIA_GOOGLE_EMAIL}.json`
2. Extract `refresh_token` from the JSON
3. Construct a `googleapis` `OAuth2Client` with:
   - `client_id`: `GOOGLE_OAUTH_CLIENT_ID` (env var, already in `.env`)
   - `client_secret`: `GOOGLE_OAUTH_CLIENT_SECRET` (env var, already in `.env`)
   - `refresh_token`: from the token cache file
4. The googleapis library auto-refreshes the access token as needed

The skill never writes back to the token cache, so there is no race condition with the workspace-mcp subprocess.

**Shared module:** `src/google/drive-auth.ts` — a small module (~30 lines) that handles token loading and `OAuth2Client` construction. Extracted so future Drive skills can reuse it.

---

## Download Logic

A metadata call (`drive.files.get({ fileId, fields: 'name,mimeType,size' })`) determines which path to take:

### Native binary files

Any file whose MIME type does not start with `application/vnd.google-apps.`:

```
drive.files.get({ fileId, alt: 'media' })
```

Returns raw bytes. Content-Type is the file's native MIME type.

### Google-native formats

Files with `application/vnd.google-apps.*` MIME types:

```
drive.files.export({ fileId, mimeType: export_mime_type })
```

Default export targets:

| Google format | Default export MIME type |
|---|---|
| `application/vnd.google-apps.document` | `application/pdf` |
| `application/vnd.google-apps.spreadsheet` | `application/pdf` |
| `application/vnd.google-apps.presentation` | `application/pdf` |
| Any other `vnd.google-apps.*` | `application/pdf` |

The agent can override via `export_mime_type` (e.g. `application/vnd.openxmlformats-officedocument.wordprocessingml.document` for DOCX from a Google Doc).

### Size enforcement

1. **Pre-download check:** If `Content-Length` is present in the response headers, reject immediately if it exceeds `MAX_TEMP_FILE_BYTES` (10 MB). Note: Google Drive export responses often omit `Content-Length`, so this check is opportunistic.
2. **Streaming guard:** Accumulate the response stream into a buffer and abort if the buffer exceeds 10 MB before the stream completes. Return an error — do not write a partial file.
3. **Post-download check:** Hard check on the final buffer size before calling `writeTempFile`.

---

## File & Folder Layout

```
skills/drive-download-file/
  skill.json          — manifest
  handler.ts          — skill handler
  handler.test.ts     — unit tests

src/google/
  drive-auth.ts       — shared OAuth2Client construction (new)
  drive-auth.test.ts  — unit tests for token loading
```

No changes to existing skill files. `src/google/` is a new directory.

---

## Coordinator Wiring

### `agents/coordinator.yaml` — pinned skills

Add `drive-download-file` to the `pinned_skills` list alongside the other Drive tools.

### `agents/coordinator.yaml` — system prompt

Add a workflow note in the Drive section (near the existing `create_drive_file` guidance):

> **Attaching a Drive file to an email**
>
> 1. If you have the file name but not the ID, call `search_drive_files` first.
> 2. Call `drive-download-file` with the file ID or Drive URL. It returns a `temp_file_url`.
> 3. Pass `temp_file_url` in the `attachments` array of `email-send` or `email-reply`.
>
> Do not use `get_drive_file_content` for this — it returns text only and cannot produce attachments.

---

## Testing

Unit tests in `handler.test.ts` cover:

| Case | What's verified |
|---|---|
| Native PDF download | Returns `temp_file_url`, correct `content_type`, correct `size` |
| Google Doc export (default PDF) | Calls `files.export` with `application/pdf`; returns `temp_file_url` |
| Google Doc export (custom DOCX) | Calls `files.export` with `application/vnd.openxmlformats-...`; returns `temp_file_url` |
| File exceeds 10 MB (Content-Length) | Returns `{ success: false, error: "... exceeds the 10 MB ..." }` |
| File exceeds 10 MB (streaming) | Returns `{ success: false, error: "..." }`, no partial file written |
| File not found (404) | Returns `{ success: false, error: "... not found or not shared ..." }` |
| Access denied (403) | Returns `{ success: false, error: "... does not have access ..." }` |
| Drive URL input | File ID correctly extracted; download succeeds |
| Token cache missing | Returns `{ success: false, error: "... token cache not found ..." }` |
| Token cache missing refresh_token | Returns `{ success: false, error: "... missing refresh_token ..." }` |

Tests mock `googleapis` and `ctx.writeTempFile`. Token loading is tested in `src/google/drive-auth.test.ts`.

---

## Out of Scope

- Folder downloads (zip an entire Drive folder) — not needed for issue #857
- Uploading files to Drive — already handled by `create_drive_file` MCP tool
- Listing folder contents — already handled by `list_drive_items` MCP tool
