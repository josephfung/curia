// handler.ts — doc-publish-google (#2758).
//
// Publishes an OKF document as a formatted Google Doc. The Markdown body is uploaded to Drive
// with the Google Docs mimeType, so Google's own Markdown import does the formatting (the same
// converter its Markdown export reverses). The document stays the source of truth; the Doc is
// a formatted copy, recorded in the document's `google_doc` frontmatter so a later publish
// updates the same Doc.
//
// New Docs go to Curia's own My Drive and are shared with no one. There is deliberately no
// folder input: a folder someone else owns (or a shared drive) would hand them the Doc on
// creation, outside the sharing tools (#2758 security review). Moving it is the Drive tools' job.
//
// Two guards protect a Doc on republish, because a converting update replaces its whole content:
//   - it must be the Doc this tool created for this document (Drive appProperties), so a
//     hand-edited `google_doc` record cannot point a republish at some other Doc;
//   - it must be unchanged since the last publish and have no comments opened since then.
//     After a refusal the caller reads the Doc back, folds the changes into the document and
//     publishes with the `doc_version` the refusal named: that goes through only while the Doc
//     is still at that version. `overwrite` skips the check altogether.

import { google, type drive_v3 } from 'googleapis';
import type { ToolHandler, ToolContext, ToolResult } from '../../src/skills/types.js';
import type { WorkingDocRow } from '../../src/db/working-docs-repo.js';
import { getDriveClient } from '../../src/google/drive-auth.js';
import {
  GOOGLE_DOC_KEY,
  UNKNOWN_MODIFIED_TIME,
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
/** Comment pages read before giving up on the new-comments check (100 per page). */
const MAX_COMMENT_PAGES = 10;
/** Drive 403 reasons that are quota or rate limits, not missing access. */
const QUOTA_REASONS = new Set(['storageQuotaExceeded', 'userRateLimitExceeded', 'rateLimitExceeded', 'dailyLimitExceeded']);

type Drive = drive_v3.Drive;

const UNKNOWN_TIME_NOTE = 'Drive did not report when the Doc was last changed, so the next publish will ask you to read it back first.';

interface PublishInput {
  path: string;
  title?: string;
  docVersion?: string;
  overwrite: boolean;
}

function parseInput(raw: unknown): PublishInput | string {
  const input = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const { path, title, doc_version: docVersion, overwrite } = input;
  if (typeof path !== 'string' || !path.trim()) return 'Missing required input: path (string)';
  if (title !== undefined && (typeof title !== 'string' || !title.trim())) return 'title must be a non-empty string when provided';
  if (docVersion !== undefined && (typeof docVersion !== 'string' || !docVersion.trim())) return 'doc_version must be the non-empty string a refusal named';
  if (overwrite !== undefined && typeof overwrite !== 'boolean') return 'overwrite must be a boolean when provided';
  return {
    path: path.trim(),
    ...(typeof title === 'string' ? { title: title.trim() } : {}),
    ...(typeof docVersion === 'string' ? { docVersion: docVersion.trim() } : {}),
    overwrite: overwrite === true,
  };
}

/** HTTP status of a googleapis error, when it has one. */
function httpStatus(err: unknown): number | undefined {
  const e = err as { code?: unknown; response?: { status?: unknown } };
  if (typeof e.response?.status === 'number') return e.response.status;
  return typeof e.code === 'number' ? e.code : undefined;
}

/** Drive's machine-readable reason (`storageQuotaExceeded`, `notFound`, …), when it gives one. */
function driveReason(err: unknown): string | undefined {
  const e = err as {
    errors?: Array<{ reason?: unknown }>;
    response?: { data?: { error?: { errors?: Array<{ reason?: unknown }> } } };
  };
  const reason = e.errors?.[0]?.reason ?? e.response?.data?.error?.errors?.[0]?.reason;
  return typeof reason === 'string' ? reason : undefined;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A Drive failure as the agent should read it: quota and rate limits named as such. */
function describeDriveError(err: unknown): string {
  const reason = driveReason(err);
  if (reason && QUOTA_REASONS.has(reason)) {
    return `Google Drive is out of storage or rate-limited (${reason}); try again later. ${errorText(err)}`;
  }
  return errorText(err);
}

/** Frontmatter title, else the file name without `.md`. */
function defaultTitle(doc: WorkingDocRow): string {
  const fmTitle = doc.frontmatter.title;
  if (typeof fmTitle === 'string' && fmTitle.trim()) return fmTitle.trim();
  const leaf = doc.path.split('/').pop() ?? doc.path;
  return leaf.replace(/\.md$/i, '') || leaf;
}

/**
 * True when the Doc has a comment opened or answered since `since` that is neither resolved
 * nor deleted. Comments already open at the last publish were there to be read back then, so
 * they do not block every later publish.
 */
async function hasNewOpenComments(drive: Drive, fileId: string, since: string): Promise<boolean> {
  const sinceMs = Date.parse(since);
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_COMMENT_PAGES; page++) {
    const res = await drive.comments.list({
      fileId,
      fields: 'nextPageToken,comments(resolved,deleted,modifiedTime)',
      pageSize: 100,
      ...(pageToken ? { pageToken } : {}),
    });
    const isNew = (c: drive_v3.Schema$Comment) => {
      const at = c.modifiedTime ? Date.parse(c.modifiedTime) : NaN;
      // No usable time on either side: count it (fail closed).
      return Number.isNaN(at) || Number.isNaN(sinceMs) || at > sinceMs;
    };
    if ((res.data.comments ?? []).some((c) => !c.resolved && !c.deleted && isNew(c))) return true;
    pageToken = res.data.nextPageToken ?? undefined;
    if (!pageToken) return false;
  }
  // More pages than we read, none blocking so far: the unread pages could hold one (fail closed).
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
      // The detail can quote the token file (a JSON parse error) or its path: log it, don't
      // hand it to the model.
      ctx.log.error({ err }, `${TOOL}: Google sign-in unavailable`);
      return { success: false, error: 'Google Workspace is not signed in, or its saved sign-in cannot be read. The operator can sign Curia in again from Setup; details are in the logs.' };
    }

    const title = parsed.title ?? defaultTitle(doc);
    if (existing.record) {
      return this.republish(ctx, drive, doc, existing.record, parsed, title);
    }
    return this.create(ctx, drive, doc, title);
  }

  private async create(ctx: ToolContext, drive: Drive, doc: WorkingDocRow, title: string): Promise<ToolResult> {
    let file: drive_v3.Schema$File;
    try {
      const res = await drive.files.create({
        requestBody: {
          name: title,
          mimeType: GOOGLE_DOC_MIME,
          appProperties: { [APP_PROPERTY_DOC_ID]: doc.id },
        },
        media: { mimeType: MARKDOWN_MIME, body: doc.body },
        fields: 'id,webViewLink,mimeType,modifiedTime',
      });
      file = res.data;
    } catch (err) {
      ctx.log.error({ err, path: doc.path, status: httpStatus(err), reason: driveReason(err) }, `${TOOL}: Doc create failed`);
      return { success: false, error: `Google Drive refused to create the Doc: ${describeDriveError(err)}` };
    }

    if (!file.id) {
      ctx.log.error({ path: doc.path }, `${TOOL}: Drive returned no file id`);
      return { success: false, error: 'Google Drive returned no file ID for the new Doc; nothing was recorded.' };
    }
    if (file.mimeType !== GOOGLE_DOC_MIME) {
      // Drive stored the Markdown as a plain file instead of converting it. Remove it, so no
      // unformatted copy is left in Curia's Drive, and report the failure either way.
      ctx.log.error({ path: doc.path, mimeType: file.mimeType }, `${TOOL}: Drive did not convert the upload`);
      let leftover = '';
      try {
        await drive.files.delete({ fileId: file.id });
      } catch (err) {
        ctx.log.error({ err, fileId: file.id }, `${TOOL}: could not delete the unconverted upload`);
        leftover = ` An unconverted copy (file ID ${file.id}) is still in Curia's Drive and should be deleted.`;
      }
      return {
        success: false,
        error: `Google Drive did not convert the Markdown into a Google Doc (got ${file.mimeType ?? 'no type'}); nothing was recorded.${leftover}`,
      };
    }

    const url = file.webViewLink ?? `https://docs.google.com/document/d/${file.id}/edit`;
    const modifiedTime = await this.settledModifiedTime(ctx, drive, file.id, file.modifiedTime);
    const recorded = await this.record(ctx, doc, {
      id: file.id,
      url,
      published_at: new Date().toISOString(),
      modified_time: modifiedTime ?? UNKNOWN_MODIFIED_TIME,
    });
    if (!recorded.ok) {
      return {
        success: false,
        error: `The Doc was created (${url}) but could not be recorded on ${doc.path}: ${recorded.error} ` +
          'Give the principal this link; publishing again would create a second Doc.',
      };
    }
    ctx.log.info({ path: doc.path, fileId: file.id }, `${TOOL}: created Doc`);
    const note = [recorded.note, modifiedTime ? null : UNKNOWN_TIME_NOTE].filter((n): n is string => n !== null).join(' ');
    return {
      success: true,
      data: { action: 'created', document_id: file.id, url, path: doc.path, ...(note ? { note } : {}) },
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
      const reason = driveReason(err);
      ctx.log.error({ err, status, reason, fileId: record.id }, `${TOOL}: Doc lookup failed`);
      if (status === 404 || (status === 403 && !(reason && QUOTA_REASONS.has(reason)))) {
        // Drive answers 404 for a deleted file and for one Curia can no longer see (the
        // principal took ownership and removed Curia). Never start a second Doc on a guess.
        return {
          success: false,
          error: `The Doc recorded on ${doc.path} (${record.url}) was deleted, or Curia can no longer open it. ` +
            'Ask the principal: they can share it back with Curia as an editor, or, to publish a new Doc instead, ' +
            `set the \`${GOOGLE_DOC_KEY}\` frontmatter key to null with a doc-write replace.`,
        };
      }
      return { success: false, error: `Could not read the Doc recorded on ${doc.path}: ${describeDriveError(err)}` };
    }

    if (current.trashed) {
      ctx.log.info({ path: doc.path, fileId: record.id }, `${TOOL}: refused, Doc is in the trash`);
      return { success: false, error: `The Doc recorded on ${doc.path} (${record.url}) is in the trash. Ask the principal whether to restore it; to publish a new Doc instead, first set the \`${GOOGLE_DOC_KEY}\` frontmatter key to null with a doc-write replace.` };
    }
    // Fail closed: only a Doc this tool created for this document is ever overwritten.
    if (current.mimeType !== GOOGLE_DOC_MIME || current.appProperties?.[APP_PROPERTY_DOC_ID] !== doc.id) {
      ctx.log.warn({ path: doc.path, fileId: record.id }, `${TOOL}: recorded Doc was not published from this document; refusing to overwrite`);
      return { success: false, error: `The Doc recorded on ${doc.path} (${record.url}) was not published from this document, so it will not be overwritten. To publish to a new Doc, set the \`${GOOGLE_DOC_KEY}\` frontmatter key to null with a doc-write replace.` };
    }

    const refusal = input.overwrite ? null : await this.changeCheck(ctx, drive, doc, record, current, input.docVersion);
    if (refusal) return refusal;

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
      ctx.log.error({ err, fileId: record.id, reason: driveReason(err) }, `${TOOL}: Doc update failed`);
      return { success: false, error: `Google Drive refused to update the Doc (${record.url}): ${describeDriveError(err)}` };
    }
    if (updated.mimeType !== GOOGLE_DOC_MIME) {
      ctx.log.error({ fileId: record.id, mimeType: updated.mimeType }, `${TOOL}: Doc type not confirmed after update`);
      return { success: false, error: `Google Drive did not confirm the Doc is still a Google Doc after the update (got ${updated.mimeType ?? 'no type'}); check ${record.url} before publishing again. The record was not updated.` };
    }

    const url = updated.webViewLink ?? record.url;
    const modifiedTime = await this.settledModifiedTime(ctx, drive, record.id, updated.modifiedTime);
    const recorded = await this.record(ctx, doc, {
      id: record.id,
      url,
      published_at: new Date().toISOString(),
      modified_time: modifiedTime ?? UNKNOWN_MODIFIED_TIME,
    });
    if (!recorded.ok) {
      return {
        success: false,
        error: `The Doc was updated (${url}) but the publish could not be recorded on ${doc.path}: ${recorded.error} ` +
          'The next publish will report the Doc as edited because of this. Compare it with the document (get_doc_as_markdown) before publishing it again with the doc_version that refusal names.',
      };
    }
    ctx.log.info({ path: doc.path, fileId: record.id }, `${TOOL}: updated Doc`);
    const note = [recorded.note, modifiedTime ? null : UNKNOWN_TIME_NOTE].filter((n): n is string => n !== null).join(' ');
    return {
      success: true,
      data: { action: 'updated', document_id: record.id, url, path: doc.path, ...(note ? { note } : {}) },
    };
  }

  /**
   * The refusal for a Doc changed since the last publish, or null to go ahead. With
   * `docVersion` (from an earlier refusal, after the caller read the Doc back and folded its
   * changes in) the Doc only has to still be at that version.
   */
  private async changeCheck(
    ctx: ToolContext,
    drive: Drive,
    doc: WorkingDocRow,
    record: PublishedDocRecord,
    current: drive_v3.Schema$File,
    docVersion: string | undefined,
  ): Promise<ToolResult | null> {
    const now = current.modifiedTime ?? null;
    if (docVersion !== undefined) {
      if (now !== null && now === docVersion) return null;
      ctx.log.info({ path: doc.path, fileId: record.id, docVersion, now }, `${TOOL}: refused, Doc changed after read-back`);
      return {
        success: false,
        error: `Not published: the Doc changed again after it was read back (${record.url}). Read it back again with get_doc_as_markdown, fold the new changes into the document, then publish with doc_version: "${now ?? 'unknown'}".`,
      };
    }

    const changes: string[] = [];
    if (record.modified_time === UNKNOWN_MODIFIED_TIME) changes.push('Curia could not tell whether it was edited');
    else if (now !== record.modified_time) changes.push('it was edited');
    try {
      if (await hasNewOpenComments(drive, record.id, record.published_at)) changes.push('it has new open comments');
    } catch (err) {
      ctx.log.error({ err, fileId: record.id }, `${TOOL}: comment check failed`);
      return { success: false, error: `Could not check the Doc's comments before overwriting it: ${describeDriveError(err)}` };
    }
    if (changes.length === 0) return null;
    ctx.log.info({ path: doc.path, fileId: record.id, changes }, `${TOOL}: refused, Doc changed since last publish`);
    return {
      success: false,
      error: `Not published: since the last publish ${changes.join(' and ')} (${record.url}), and publishing replaces the whole Doc. ` +
        'Read it back with get_doc_as_markdown (it shows the comments), fold the changes into the document with doc-write, ' +
        `then publish again with doc_version: "${now ?? 'unknown'}". Publishing with overwrite: true discards the changes instead; ask the principal first.`,
    };
  }

  /** Drive's modifiedTime after a write: the response's, else read back once; null if neither has it. */
  private async settledModifiedTime(ctx: ToolContext, drive: Drive, fileId: string, fromWrite: string | null | undefined): Promise<string | null> {
    if (fromWrite) return fromWrite;
    try {
      const res = await drive.files.get({ fileId, fields: 'modifiedTime', supportsAllDrives: true });
      if (res.data.modifiedTime) return res.data.modifiedTime;
    } catch (err) {
      ctx.log.warn({ err, fileId }, `${TOOL}: could not read modifiedTime after the write`);
    }
    ctx.log.warn({ fileId }, `${TOOL}: Drive reported no modifiedTime; the next publish will ask for doc_version`);
    return null;
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

