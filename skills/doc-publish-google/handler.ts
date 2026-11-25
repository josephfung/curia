// handler.ts — doc-publish-google (#2758).
//
// Publishes an OKF document as a formatted Google Doc. The Markdown body is uploaded to Drive
// with the Google Docs mimeType, so Google's own Markdown import does the formatting (the same
// converter its Markdown export reverses). The document stays the source of truth; the Doc is
// a formatted copy, recorded in the document's `google_doc` frontmatter so a later publish
// updates the same Doc.
//
// Two guards protect a Doc on republish:
//   - it must be the Doc this tool created for this document (Drive appProperties), so a
//     hand-edited `google_doc` record cannot point a republish at some other Doc;
//   - it must be unchanged since the last publish and have no open comments, unless the caller
//     passes `overwrite`, because a converting update replaces the Doc's whole content.

import { google, type drive_v3 } from 'googleapis';
import type { ToolHandler, ToolContext, ToolResult } from '../../src/skills/types.js';
import type { WorkingDocRow } from '../../src/db/working-docs-repo.js';
import { getDriveClient } from '../../src/google/drive-auth.js';
import {
  GOOGLE_DOC_KEY,
  readPublishedDocRecord,
  type PublishedDocRecord,
} from '../../src/google/published-doc.js';
import { normalizeDocPath } from '../../src/memory/okf.js';
import { requireWorkingDocs } from '../_shared/doc-workspace.js';
import {
  consoleOnlyWriteError,
  sendLedgerPathWriteError,
  sharedPathWriteError,
} from '../_shared/doc-write-guards.js';

const TOOL = 'doc-publish-google';
const GOOGLE_DOC_MIME = 'application/vnd.google-apps.document';
const MARKDOWN_MIME = 'text/markdown';
/** appProperties key binding a Doc to the store document it was published from. */
const APP_PROPERTY_DOC_ID = 'curiaDocumentId';
/** Comment pages read before giving up on the open-comments check (100 per page). */
const MAX_COMMENT_PAGES = 10;

type Drive = drive_v3.Drive;

interface PublishInput {
  path: string;
  title?: string;
  folderId?: string;
  overwrite: boolean;
}

function parseInput(raw: unknown): PublishInput | string {
  const input = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const { path, title, folder_id: folderId, overwrite } = input;
  if (typeof path !== 'string' || !path.trim()) return 'Missing required input: path (string)';
  if (title !== undefined && (typeof title !== 'string' || !title.trim())) return 'title must be a non-empty string when provided';
  if (folderId !== undefined && (typeof folderId !== 'string' || !folderId.trim())) return 'folder_id must be a non-empty string when provided';
  if (overwrite !== undefined && typeof overwrite !== 'boolean') return 'overwrite must be a boolean when provided';
  return {
    path: path.trim(),
    ...(typeof title === 'string' ? { title: title.trim() } : {}),
    ...(typeof folderId === 'string' ? { folderId: folderId.trim() } : {}),
    overwrite: overwrite === true,
  };
}

/** HTTP status of a googleapis error, when it has one. */
function httpStatus(err: unknown): number | undefined {
  const e = err as { code?: unknown; response?: { status?: unknown } };
  if (typeof e.response?.status === 'number') return e.response.status;
  return typeof e.code === 'number' ? e.code : undefined;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Frontmatter title, else the file name without `.md`. */
function defaultTitle(doc: WorkingDocRow): string {
  const fmTitle = doc.frontmatter.title;
  if (typeof fmTitle === 'string' && fmTitle.trim()) return fmTitle.trim();
  const leaf = doc.path.split('/').pop() ?? doc.path;
  return leaf.replace(/\.md$/i, '') || leaf;
}

/** True when the Doc has at least one comment that is neither resolved nor deleted. */
async function hasOpenComments(drive: Drive, fileId: string): Promise<boolean> {
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_COMMENT_PAGES; page++) {
    const res = await drive.comments.list({
      fileId,
      fields: 'nextPageToken,comments(resolved,deleted)',
      pageSize: 100,
      ...(pageToken ? { pageToken } : {}),
    });
    if ((res.data.comments ?? []).some((c) => !c.resolved && !c.deleted)) return true;
    pageToken = res.data.nextPageToken ?? undefined;
    if (!pageToken) return false;
  }
  // More than MAX_COMMENT_PAGES pages, all resolved: treat as open (fail closed), since the
  // unread pages could hold an open one.
  return true;
}

export class DocPublishGoogleHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const parsed = parseInput(ctx.input);
    if (typeof parsed === 'string') return { success: false, error: parsed };

    const guard = requireWorkingDocs(ctx);
    if (guard) return guard;
    const repo = ctx.workingDocs!;
    const path = normalizeDocPath(parsed.path);

    let doc: WorkingDocRow | null;
    try {
      doc = await repo.read(path);
    } catch (err) {
      ctx.log.error({ err, path }, `${TOOL}: document read failed`);
      return { success: false, error: `Could not read ${path}: ${errorText(err)}` };
    }
    if (!doc) return { success: false, error: `No document at ${path}. Check the path with doc-list.` };
    if (!doc.body.trim()) return { success: false, error: `${path} has no body to publish.` };

    // Publishing records the Doc in the document's frontmatter, so it is a write to the
    // document and passes doc-write's guards (fail closed).
    const writeError = sendLedgerPathWriteError(ctx, path, TOOL)
      ?? sharedPathWriteError(ctx, path, TOOL)
      ?? consoleOnlyWriteError(ctx, path, doc, undefined, TOOL);
    if (writeError) return { success: false, error: writeError };

    const existing = readPublishedDocRecord(doc.frontmatter);
    if ('invalid' in existing) {
      return {
        success: false,
        error: `${path} has a malformed \`${GOOGLE_DOC_KEY}\` frontmatter value, so its Doc can't be identified. ` +
          `Restore it as doc-publish-google wrote it (id, url, published_at, modified_time), or set it to null with a doc-write replace to publish to a new Doc.`,
      };
    }

    let drive: Drive;
    try {
      const auth = await getDriveClient({
        clientId: ctx.secret('google_oauth_client_id'),
        clientSecret: ctx.secret('google_oauth_client_secret'),
        email: ctx.secret('curia_google_email'),
      });
      drive = google.drive({ version: 'v3', auth });
    } catch (err) {
      ctx.log.error({ err }, `${TOOL}: Google sign-in unavailable`);
      return { success: false, error: `Google Workspace is not signed in or its credentials are unreadable: ${errorText(err)}` };
    }

    const title = parsed.title ?? defaultTitle(doc);
    if (existing.record) {
      return this.republish(ctx, drive, doc, existing.record, parsed, title);
    }
    return this.create(ctx, drive, doc, parsed, title, null);
  }

  private async create(
    ctx: ToolContext,
    drive: Drive,
    doc: WorkingDocRow,
    input: PublishInput,
    title: string,
    replacedUrl: string | null,
  ): Promise<ToolResult> {
    let file: drive_v3.Schema$File;
    try {
      const res = await drive.files.create({
        requestBody: {
          name: title,
          mimeType: GOOGLE_DOC_MIME,
          appProperties: { [APP_PROPERTY_DOC_ID]: doc.id },
          ...(input.folderId ? { parents: [input.folderId] } : {}),
        },
        media: { mimeType: MARKDOWN_MIME, body: doc.body },
        fields: 'id,webViewLink,mimeType,modifiedTime',
        supportsAllDrives: true,
      });
      file = res.data;
    } catch (err) {
      const status = httpStatus(err);
      ctx.log.error({ err, path: doc.path, status }, `${TOOL}: Doc create failed`);
      if (input.folderId && (status === 404 || status === 403)) {
        return { success: false, error: `Drive folder ${input.folderId} was not found or Curia cannot write to it.` };
      }
      return { success: false, error: `Google Drive refused to create the Doc: ${errorText(err)}` };
    }

    if (!file.id) {
      ctx.log.error({ path: doc.path }, `${TOOL}: Drive returned no file id`);
      return { success: false, error: 'Google Drive returned no file ID for the new Doc; nothing was recorded.' };
    }
    if (file.mimeType !== GOOGLE_DOC_MIME) {
      // Drive stored the Markdown as a plain file instead of converting it. Remove it, so no
      // unformatted copy is left in Curia's Drive, and report the failure.
      ctx.log.error({ path: doc.path, mimeType: file.mimeType }, `${TOOL}: Drive did not convert the upload`);
      try {
        await drive.files.delete({ fileId: file.id, supportsAllDrives: true });
      } catch (err) {
        ctx.log.error({ err, fileId: file.id }, `${TOOL}: could not delete the unconverted upload`);
      }
      return { success: false, error: `Google Drive did not convert the Markdown into a Google Doc (got ${file.mimeType ?? 'no type'}); nothing was recorded.` };
    }

    const url = file.webViewLink ?? `https://docs.google.com/document/d/${file.id}/edit`;
    const recorded = await this.record(ctx, doc, {
      id: file.id,
      url,
      published_at: new Date().toISOString(),
      modified_time: file.modifiedTime ?? new Date().toISOString(),
    });
    if (!recorded.ok) {
      return {
        success: false,
        error: `The Doc was created (${url}) but could not be recorded on ${doc.path}: ${recorded.error} ` +
          `Give the principal this link; publishing again would create a second Doc.`,
      };
    }
    const notes = [
      replacedUrl ? `The previously recorded Doc (${replacedUrl}) no longer exists, so a new one was created.` : null,
      recorded.note,
    ].filter((n): n is string => n !== null);
    ctx.log.info({ path: doc.path, fileId: file.id }, `${TOOL}: created Doc`);
    return {
      success: true,
      data: {
        action: 'created',
        document_id: file.id,
        url,
        path: doc.path,
        ...(notes.length ? { note: notes.join(' ') } : {}),
      },
    };
  }

  private async republish(
    ctx: ToolContext,
    drive: Drive,
    doc: WorkingDocRow,
    record: PublishedDocRecord,
    input: PublishInput,
    title: string,
  ): Promise<ToolResult> {
    let current: drive_v3.Schema$File;
    try {
      const res = await drive.files.get({
        fileId: record.id,
        fields: 'id,mimeType,trashed,modifiedTime,appProperties,webViewLink',
        supportsAllDrives: true,
      });
      current = res.data;
    } catch (err) {
      const status = httpStatus(err);
      if (status === 404) {
        // Deleted for good: publishing again means a new Doc.
        return this.create(ctx, drive, doc, input, title, record.url);
      }
      ctx.log.error({ err, status, fileId: record.id }, `${TOOL}: Doc lookup failed`);
      if (status === 403) {
        return { success: false, error: `Curia no longer has access to the Doc recorded on ${doc.path} (${record.url}). Ask the principal to share it back with Curia as an editor.` };
      }
      return { success: false, error: `Could not read the Doc recorded on ${doc.path}: ${errorText(err)}` };
    }

    if (current.trashed) {
      return { success: false, error: `The Doc recorded on ${doc.path} (${record.url}) is in the trash. Ask the principal whether to restore it; to publish a new Doc instead, first set the \`${GOOGLE_DOC_KEY}\` frontmatter key to null with a doc-write replace.` };
    }
    // Fail closed: only a Doc this tool created for this document is ever overwritten.
    if (current.mimeType !== GOOGLE_DOC_MIME || current.appProperties?.[APP_PROPERTY_DOC_ID] !== doc.id) {
      ctx.log.warn({ path: doc.path, fileId: record.id }, `${TOOL}: recorded Doc was not published from this document; refusing to overwrite`);
      return { success: false, error: `The Doc recorded on ${doc.path} (${record.url}) was not published from this document, so it will not be overwritten. To publish to a new Doc, set the \`${GOOGLE_DOC_KEY}\` frontmatter key to null with a doc-write replace.` };
    }

    if (!input.overwrite) {
      const changes: string[] = [];
      if (current.modifiedTime !== record.modified_time) changes.push('it was edited');
      try {
        if (await hasOpenComments(drive, record.id)) changes.push('it has open comments');
      } catch (err) {
        ctx.log.error({ err, fileId: record.id }, `${TOOL}: comment check failed`);
        return { success: false, error: `Could not check the Doc's comments before overwriting it: ${errorText(err)}` };
      }
      if (changes.length > 0) {
        return {
          success: false,
          error: `Not published: since the last publish ${changes.join(' and ')} (${record.url}), and publishing replaces the whole Doc. ` +
            'Read it back with get_doc_as_markdown, fold the changes into the document with doc-write and publish again, ' +
            'or ask the principal before publishing with overwrite: true, which discards them.',
        };
      }
    }

    let updated: drive_v3.Schema$File;
    try {
      const res = await drive.files.update({
        fileId: record.id,
        ...(input.title ? { requestBody: { name: title } } : {}),
        media: { mimeType: MARKDOWN_MIME, body: doc.body },
        fields: 'id,webViewLink,mimeType,modifiedTime',
        supportsAllDrives: true,
      });
      updated = res.data;
    } catch (err) {
      ctx.log.error({ err, fileId: record.id }, `${TOOL}: Doc update failed`);
      return { success: false, error: `Google Drive refused to update the Doc (${record.url}): ${errorText(err)}` };
    }
    if (updated.mimeType && updated.mimeType !== GOOGLE_DOC_MIME) {
      ctx.log.error({ fileId: record.id, mimeType: updated.mimeType }, `${TOOL}: Doc changed type on update`);
      return { success: false, error: `Google Drive changed the Doc's type to ${updated.mimeType} during the update (${record.url}). Check it before publishing again.` };
    }

    const url = updated.webViewLink ?? record.url;
    const recorded = await this.record(ctx, doc, {
      id: record.id,
      url,
      published_at: new Date().toISOString(),
      modified_time: updated.modifiedTime ?? new Date().toISOString(),
    });
    if (!recorded.ok) {
      return {
        success: false,
        error: `The Doc was updated (${url}) but the publish could not be recorded on ${doc.path}: ${recorded.error} ` +
          'The next publish will see the Doc as edited; pass overwrite: true then.',
      };
    }
    ctx.log.info({ path: doc.path, fileId: record.id }, `${TOOL}: updated Doc`);
    return {
      success: true,
      data: {
        action: 'updated',
        document_id: record.id,
        url,
        path: doc.path,
        ...(recorded.note ? { note: recorded.note } : {}),
      },
    };
  }

  /**
   * Write the record into the document's frontmatter, leaving the body alone. A concurrent
   * write between our read and this one is a version conflict: retry once on the latest
   * version, and say so if the body changed, since the Doc then shows the earlier text.
   */
  private async record(
    ctx: ToolContext,
    published: WorkingDocRow,
    record: PublishedDocRecord,
  ): Promise<{ ok: true; note: string | null } | { ok: false; error: string }> {
    const repo = ctx.workingDocs!;
    let target = published;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await repo.update(target.path, {
          frontmatter: { ...target.frontmatter, [GOOGLE_DOC_KEY]: record },
          expectedVersion: target.version,
          expectedId: target.id,
        });
        if (result.ok) {
          const note = result.document.body !== published.body
            ? `${published.path} changed while it was being published, so the Doc shows the earlier text. Publish again to update it.`
            : null;
          return { ok: true, note };
        }
        if (result.document.id !== published.id) {
          return { ok: false, error: 'the document was replaced by a new one at the same path while publishing.' };
        }
        target = result.document;
      }
      return { ok: false, error: 'the document kept changing while publishing.' };
    } catch (err) {
      ctx.log.error({ err, path: published.path }, `${TOOL}: recording the Doc failed`);
      return { ok: false, error: errorText(err) };
    }
  }
}
