// run.ts — live check of the Drive behaviour doc-publish-google relies on (#2758).
//
//   pnpm exec tsx --env-file=.env scripts/spikes/gdoc-publish/run.ts
//
// Signs in as Curia's Google identity exactly as the tool does (getDriveClient: the
// workspace-mcp token file for CURIA_GOOGLE_EMAIL and the OAuth client in the env), then on
// one throwaway Doc in Curia's Drive:
//   1. checks Drive lists text/markdown → Google Docs among its import formats;
//   2. creates a Doc from fixture.md the way the tool does, and reports its structure (named
//      styles, list nesting, tables, bold/italic/strikethrough/links) so the conversion's
//      losses are visible;
//   3. exports it as text/markdown and prints a line diff against the fixture (the read-back);
//   4. records modifiedTime after a Drive comment, a share and an unshare (the republish guard
//      must not mistake these for edits), and after a Docs API text edit (it must catch that);
//   5. republishes with files.update and reports what happened to the open comment.
// The Doc is deleted at the end, also on failure. Nothing is shared outside the run: step 4's
// share is link-only "anyone with the link can view" and is removed at once.
//
// Results go to stdout as plain text; paste them into the PR.
import fs from 'node:fs';
import path from 'node:path';
import { google, type docs_v1 } from 'googleapis';
import { getDriveClient } from '../../../src/google/drive-auth.js';

const FIXTURE = fs.readFileSync(path.join(import.meta.dirname, 'fixture.md'), 'utf-8');
const GOOGLE_DOC_MIME = 'application/vnd.google-apps.document';

function out(label: string, value: unknown): void {
  process.stdout.write(`\n=== ${label}\n${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);
}

function lineDiff(expected: string, actual: string): string {
  const a = expected.trimEnd().split('\n');
  const b = actual.trimEnd().split('\n');
  const lines: string[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === b[i]) continue;
    if (a[i] !== undefined) lines.push(`- ${a[i]}`);
    if (b[i] !== undefined) lines.push(`+ ${b[i]}`);
  }
  return lines.length ? lines.join('\n') : '(identical)';
}

function describeStructure(doc: docs_v1.Schema$Document): string {
  const rows: string[] = [];
  for (const el of doc.body?.content ?? []) {
    if (el.table) {
      rows.push(`TABLE ${el.table.rows}x${el.table.columns}`);
      continue;
    }
    const p = el.paragraph;
    if (!p) continue;
    const text = (p.elements ?? []).map((e) => e.textRun?.content ?? '').join('').replace(/\n$/, '');
    const marks = (p.elements ?? []).map((e) => {
      const s = e.textRun?.textStyle ?? {};
      const flags = [s.bold && 'B', s.italic && 'I', s.strikethrough && 'S', s.link && 'L',
        s.weightedFontFamily?.fontFamily && `F=${s.weightedFontFamily.fontFamily}`].filter(Boolean).join('');
      return flags ? `[${flags}:${(e.textRun?.content ?? '').trim()}]` : '';
    }).join('');
    const bullet = p.bullet ? ` bullet(level ${p.bullet.nestingLevel ?? 0})` : '';
    rows.push(`${p.paragraphStyle?.namedStyleType ?? '?'}${bullet} | ${text} ${marks}`.trimEnd());
  }
  return rows.join('\n');
}

const auth = await getDriveClient();
const drive = google.drive({ version: 'v3', auth });
const docs = google.docs({ version: 'v1', auth });
const modifiedTime = async (fileId: string): Promise<string> =>
  (await drive.files.get({ fileId, fields: 'modifiedTime' })).data.modifiedTime ?? '(none)';
const exportMarkdown = async (fileId: string): Promise<string> =>
  String((await drive.files.export({ fileId, mimeType: 'text/markdown' }, { responseType: 'text' })).data);

const about = await drive.about.get({ fields: 'importFormats' });
out('1. import formats for text/markdown', about.data.importFormats?.['text/markdown'] ?? 'NOT LISTED');

let fileId: string | undefined;
try {
  const created = await drive.files.create({
    requestBody: { name: 'curia #2758 spike (safe to delete)', mimeType: GOOGLE_DOC_MIME, appProperties: { curiaDocumentId: 'spike' } },
    media: { mimeType: 'text/markdown', body: FIXTURE },
    fields: 'id,mimeType,modifiedTime',
  });
  fileId = created.data.id ?? undefined;
  if (!fileId) throw new Error('Drive returned no file id');
  const id = fileId;
  out('2. created', { mimeType: created.data.mimeType, modifiedTime: created.data.modifiedTime });
  out('2. modifiedTime read back right after create', await modifiedTime(id));
  out('2. structure', describeStructure((await docs.documents.get({ documentId: id })).data));

  out('3. export text/markdown vs fixture (- fixture, + export)', lineDiff(FIXTURE, await exportMarkdown(id)));

  const steps: Record<string, string> = { before: await modifiedTime(id) };
  const comment = await drive.comments.create({ fileId: id, fields: 'id', requestBody: { content: 'spike comment' } });
  steps.after_comment = await modifiedTime(id);
  const permission = await drive.permissions.create({ fileId: id, requestBody: { type: 'anyone', role: 'reader' }, fields: 'id' });
  steps.after_share = await modifiedTime(id);
  await drive.permissions.delete({ fileId: id, permissionId: permission.data.id! });
  steps.after_unshare = await modifiedTime(id);
  out('4. modifiedTime across non-edits (should all match "before")', steps);

  const republished = await drive.files.update({
    fileId: id,
    media: { mimeType: 'text/markdown', body: FIXTURE.replace('Quarterly operating review', 'Quarterly operating review (v2)') },
    fields: 'mimeType,modifiedTime',
  });
  out('5. republish', republished.data);
  out('5. first exported line after republish', (await exportMarkdown(id)).split('\n')[0]);
  const comments = await drive.comments.list({ fileId: id, includeDeleted: true, fields: 'comments(id,deleted,resolved,anchor)' });
  out('5. the open comment after republish', (comments.data.comments ?? []).filter((c) => c.id === comment.data.id));

  const beforeEdit = await modifiedTime(id);
  await docs.documents.batchUpdate({ documentId: id, requestBody: { requests: [{ insertText: { location: { index: 1 }, text: 'Edited. ' } }] } });
  out('4. modifiedTime after a text edit (must differ)', { before: beforeEdit, after: await modifiedTime(id) });
} finally {
  if (fileId) {
    await drive.files.delete({ fileId });
    out('cleanup', 'deleted the spike Doc');
  }
}
