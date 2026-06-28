// Shared helpers for doc-* skills (#1209).

import type { SkillContext, SkillResult } from '../../src/skills/types.js';
import type { WorkingDocRow, WorkingDocWriteResult } from '../../src/db/working-docs-repo.js';
import { toLocalIso, formatDisplayTimezone } from '../../src/time/timestamp.js';
import {
  buildIndexProjection,
  extractSectionContent,
  formatLogEntry,
  grepDocuments,
  indexPathForDirectory,
  logPathForDocument,
  normalizeDirectoryPrefix,
  RESERVED_LEAF_NAMES,
  LOG_FILENAME,
} from '../../src/agents/document-workspace.js';
import { normalizeDocPath } from '../../src/memory/okf.js';

export function requireWorkingDocs(ctx: SkillContext): SkillResult | null {
  if (!ctx.workingDocs) {
    ctx.log.error('doc-*: workingDocs not available');
    return { success: false, error: 'Document workspace not available — database not configured' };
  }
  return null;
}

export function mapDocumentRow(doc: WorkingDocRow, timezone: string) {
  const updatedUnix = Math.floor(new Date(doc.updatedAt).getTime() / 1000);
  const createdUnix = Math.floor(new Date(doc.createdAt).getTime() / 1000);
  return {
    path: doc.path,
    type: doc.type,
    frontmatter: doc.frontmatter,
    body: doc.body,
    version: doc.version,
    section_versions: doc.sectionVersions,
    byte_size: doc.byteSize,
    task_id: doc.taskId,
    conversation_id: doc.conversationId,
    agent_id: doc.agentId,
    created_at: toLocalIso(createdUnix, timezone),
    updated_at: toLocalIso(updatedUnix, timezone),
    displayTimezone: formatDisplayTimezone(timezone, new Date()),
  };
}

export function mapWriteConflict(result: WorkingDocWriteResult, timezone: string) {
  if (result.ok) return null;
  const updatedUnix = Math.floor(new Date(result.document.updatedAt).getTime() / 1000);
  return {
    conflict: true,
    path: result.document.path,
    version: result.document.version,
    section_versions: result.document.sectionVersions,
    updated_at: toLocalIso(updatedUnix, timezone),
    displayTimezone: formatDisplayTimezone(timezone, new Date()),
  };
}

export async function appendDirectoryLog(
  ctx: SkillContext,
  documentPath: string,
  operation: string,
  summary: string,
): Promise<void> {
  const repo = ctx.workingDocs!;
  const logPath = logPathForDocument(documentPath);
  const iso = new Date().toISOString();
  const entry = formatLogEntry(iso, operation, summary);

  try {
    const maxAttempts = 3;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const existing = await repo.read(logPath);
      if (!existing) {
        try {
          await repo.create({
            path: logPath,
            type: 'log',
            body: entry,
            conversationId: ctx.conversationId ?? undefined,
            agentId: ctx.agentId ?? undefined,
          });
          return;
        } catch (err) {
          // Another writer may have created log.md between read and create — retry.
          if (attempt === maxAttempts - 1) throw err;
          continue;
        }
      }
      const result = await repo.append(logPath, {
        content: entry.trimEnd(),
        expectedVersion: existing.version,
      });
      if (result.ok) return;
      if (attempt === maxAttempts - 1) {
        ctx.log.warn(
          { path: logPath, version: existing.version },
          'doc-write: log.md append conflict after retries — change record may be missing for this write',
        );
      }
    }
  } catch (err) {
    ctx.log.warn(
      { err, path: logPath },
      'doc-write: log.md append failed — document write succeeded; audit entry may be missing',
    );
  }
}

export async function listDirectoryProjection(
  ctx: SkillContext,
  prefix: string,
): Promise<{ directory: string; index_path: string; manifest: string; documents: WorkingDocRow[] }> {
  const repo = ctx.workingDocs!;
  const directory = normalizeDirectoryPrefix(prefix);
  const documents = await repo.listByPrefix(directory);
  const manifest = buildIndexProjection(directory, documents);
  return {
    directory,
    index_path: indexPathForDirectory(directory),
    manifest,
    documents,
  };
}

export async function readDocument(
  ctx: SkillContext,
  path: string,
  section?: string,
): Promise<SkillResult> {
  const guard = requireWorkingDocs(ctx);
  if (guard) return guard;

  const normalized = normalizeDocPath(path);
  const doc = await ctx.workingDocs!.read(normalized);
  if (!doc) {
    return { success: true, data: { found: false, path: normalized } };
  }

  const timezone = ctx.timezone ?? 'UTC';
  const sectionResult = extractSectionContent(doc.body, section);
  const displayTimezone = timezone === 'UTC' ? 'UTC' : formatDisplayTimezone(timezone, new Date());
  const updatedUnix = Math.floor(new Date(doc.updatedAt).getTime() / 1000);
  const data: Record<string, unknown> = {
    found: true,
    path: doc.path,
    type: doc.type,
    frontmatter: doc.frontmatter,
    version: doc.version,
    section_versions: doc.sectionVersions,
    updated_at: toLocalIso(updatedUnix, timezone),
    displayTimezone,
  };
  if (section && section.trim()) {
    data.section = sectionResult.section ?? section.trim();
    data.content = sectionResult.content;
    data.section_found = sectionResult.found === true;
  } else {
    data.body = doc.body;
    data.okf = ctx.workingDocs!.toOkf(doc);
  }
  return { success: true, data };
}

export async function searchDocuments(
  ctx: SkillContext,
  query: string,
  pathPrefix?: string,
): Promise<SkillResult> {
  const guard = requireWorkingDocs(ctx);
  if (guard) return guard;

  const prefix = pathPrefix ? normalizeDirectoryPrefix(pathPrefix) : '/';
  const documents = await ctx.workingDocs!.listByPrefix(prefix);
  const matches = grepDocuments(documents, query);
  const timezone = ctx.timezone ?? 'UTC';
  const displayTimezone = timezone === 'UTC' ? 'UTC' : formatDisplayTimezone(timezone, new Date());
  return {
    success: true,
    data: {
      query,
      path_prefix: prefix,
      match_count: matches.length,
      matches: matches.map(m => ({
        path: m.path,
        line_number: m.lineNumber,
        line: m.line,
      })),
      displayTimezone,
    },
  };
}

export function validateWritePath(path: string, _mode: string): string | null {
  const normalized = normalizeDocPath(path);
  const leaf = normalized.split('/').pop() ?? '';
  if (!RESERVED_LEAF_NAMES.has(leaf)) return null;
  if (leaf === LOG_FILENAME) {
    return `Cannot write to reserved file ${leaf} — log entries are appended automatically by doc-write`;
  }
  return `Cannot write to reserved file ${leaf} — use doc-list for the index projection`;
}
