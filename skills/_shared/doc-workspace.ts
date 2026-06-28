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
  const existing = await repo.read(logPath);
  if (!existing) {
    await repo.create({
      path: logPath,
      type: 'log',
      body: entry,
      conversationId: ctx.conversationId ?? undefined,
      agentId: ctx.agentId ?? undefined,
    });
    return;
  }
  const result = await repo.append(logPath, { content: entry.trimEnd(), expectedVersion: existing.version });
  if (!result.ok) {
    ctx.log.warn(
      { path: logPath, version: existing.version },
      'doc-write: log.md append conflict — change record may be missing for this write',
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
  const { content, section: resolvedSection } = extractSectionContent(doc.body, section);
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
    data.section = resolvedSection ?? section.trim();
    data.content = content;
    data.section_found = resolvedSection !== undefined && content.length > 0;
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

export function validateWritePath(path: string, mode: string): string | null {
  const normalized = normalizeDocPath(path);
  const leaf = normalized.split('/').pop() ?? '';
  if (mode === 'create' && RESERVED_LEAF_NAMES.has(leaf)) {
    return `Cannot create reserved file ${leaf} directly — use doc-list for index projection and let doc-write append log.md automatically`;
  }
  return null;
}
