// handler-e2e.ts — runs the real doc-publish-google handler against live Drive (#2758).
//
//   pnpm exec tsx --env-file=<env with the three Google settings> scripts/spikes/gdoc-publish/handler-e2e.ts
//
// An in-memory document store stands in for Postgres; everything else is production code and
// Curia's own Google identity. Steps: publish the fixture (create), publish again unchanged,
// share the Doc and publish again, edit the Doc as the principal would and publish (refused),
// publish with the refusal's doc_version (goes through). The Doc is deleted at the end.
import fs from 'node:fs';
import path from 'node:path';
import { google } from 'googleapis';
import { getDriveClient } from '../../../src/google/drive-auth.js';
import { createSilentLogger } from '../../../src/logger.js';
import type { ToolContext, ToolResult } from '../../../src/skills/types.js';
import type { UpdateWorkingDocParams, WorkingDocRow, WorkingDocWriteResult } from '../../../src/db/working-docs-repo.js';
import { DocPublishGoogleHandler } from '../../../skills/doc-publish-google/handler.js';

const PATH = '/projects/spike-2758/review.md';
let doc: WorkingDocRow = {
  id: '00000000-0000-4000-8000-000000002758', path: PATH, type: 'note',
  frontmatter: { title: 'curia #2758 handler e2e (safe to delete)' },
  body: fs.readFileSync(path.join(import.meta.dirname, 'fixture.md'), 'utf-8'),
  version: 1, sectionVersions: {}, byteSize: 0, taskId: null, conversationId: null, agentId: null,
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), archivedAt: null,
};
const workingDocs = {
  read: async (p: string) => (p === PATH ? doc : null),
  update: async (_p: string, params: UpdateWorkingDocParams): Promise<WorkingDocWriteResult> => {
    if (params.expectedVersion !== doc.version) return { ok: false, conflict: true, document: doc };
    doc = { ...doc, frontmatter: params.frontmatter ?? doc.frontmatter, body: params.body ?? doc.body, version: doc.version + 1 };
    return { ok: true, document: doc };
  },
};
const env: Record<string, string | undefined> = {
  google_oauth_client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
  google_oauth_client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  curia_google_email: process.env.CURIA_GOOGLE_EMAIL,
};
const publish = (input: Record<string, unknown>): Promise<ToolResult> =>
  new DocPublishGoogleHandler().execute({
    input: { path: PATH, ...input },
    secret: (name: string) => env[name] ?? '',
    log: createSilentLogger(),
    workingDocs,
    agentId: 'coordinator',
  } as unknown as ToolContext);
const show = (label: string, r: ToolResult) =>
  process.stdout.write(`\n=== ${label}\n${JSON.stringify(r.success ? r.data : { error: r.error }, null, 2)}\n`);

const auth = await getDriveClient();
const drive = google.drive({ version: 'v3', auth });
const docs = google.docs({ version: 'v1', auth });
let fileId: string | undefined;
try {
  const created = await publish({});
  show('1. first publish', created);
  if (!created.success) throw new Error('create failed');
  fileId = (created.data as { document_id: string }).document_id;

  show('2. publish again, Doc unchanged (expect updated)', await publish({}));

  const permission = await drive.permissions.create({ fileId, requestBody: { type: 'anyone', role: 'reader' }, fields: 'id' });
  await drive.permissions.delete({ fileId, permissionId: permission.data.id! });
  show('3. publish after a share and unshare (expect updated)', await publish({}));

  await docs.documents.batchUpdate({ documentId: fileId, requestBody: { requests: [{ insertText: { location: { index: 1 }, text: 'Principal edit. ' } }] } });
  const refused = await publish({});
  show('4. publish after a principal edit (expect refused, naming doc_version)', refused);
  const version = !refused.success ? /doc_version: "([0-9a-f]+)"/.exec(refused.error)?.[1] : undefined;

  doc = { ...doc, body: `Principal edit. ${doc.body}`, version: doc.version + 1 };
  show('5. publish with that doc_version after folding the edit in (expect updated)', await publish({ doc_version: version }));
} finally {
  if (fileId) {
    await drive.files.delete({ fileId });
    process.stdout.write('\n=== cleanup\ndeleted the e2e Doc\n');
  }
}
