// handler.ts — doc-write skill (#1209 / #1819).

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import { normalizeDocPath } from '../../../../src/memory/okf.js';
import {
  isLegacyUuidProjectDir,
  projectSlugFromPath,
  validateProjectsWritePath,
} from '../../../../src/agents/document-placement.js';
import { boundTaskFromMetadata } from '../../../../src/agents/resumable-task.js';
import {
  isUnresolvedPlaceholder,
  unresolvedPlaceholderError,
} from '../../../../src/skills/_shared/placeholder-guard.js';
import {
  appendDirectoryLog,
  mapDocumentRow,
  mapWriteConflict,
  requireWorkingDocs,
  ttlDaysFrontmatterWarning,
  validateWritePath,
} from '../../../_shared/doc-workspace.js';

const VALID_MODES = new Set(['create', 'append', 'replace', 'section-edit']);
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Ownership stamp for archival / prefix resolution is the *project root* task id
 * (#1819 review). Bound wake ids may be subtasks.
 *
 * Returns `{ ok: true, taskId }` or `{ ok: false, error }` — never throws. Callers
 * must validate model-supplied `task_id` before any uuid-column lookup.
 */
async function resolveAssociatedRootTaskId(
  ctx: ToolContext,
  inputTaskId?: string,
): Promise<{ ok: true; taskId: string | undefined } | { ok: false; error: string }> {
  let candidate: string | undefined;
  if (typeof inputTaskId === 'string' && inputTaskId.trim()) {
    candidate = inputTaskId.trim();
    if (isUnresolvedPlaceholder(candidate)) {
      return { ok: false, error: unresolvedPlaceholderError('task_id', candidate) };
    }
    if (!UUID_RE.test(candidate)) {
      return { ok: false, error: 'task_id must be a task UUID' };
    }
  } else {
    const bound = boundTaskFromMetadata(ctx.taskMetadata as Record<string, unknown> | undefined);
    candidate = bound?.taskId;
  }
  if (!candidate) return { ok: true, taskId: undefined };
  // Bound metadata should already be a UUID; still guard before the uuid column.
  if (!UUID_RE.test(candidate)) {
    return { ok: false, error: 'task_id must be a task UUID' };
  }
  if (!ctx.taskRepo) return { ok: true, taskId: candidate };
  const root = await ctx.taskRepo.resolveProjectRootTaskId(candidate);
  return { ok: true, taskId: root ?? candidate };
}

export class DocWriteHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const input = ctx.input as {
      path?: string;
      mode?: string;
      type?: string;
      body?: string;
      content?: string;
      frontmatter?: Record<string, unknown>;
      section?: string;
      expected_version?: number;
      expected_section_version?: number;
      summary?: string;
      task_id?: string;
      conversation_id?: string;
    };

    if (!input.path || typeof input.path !== 'string' || !input.path.trim()) {
      return { success: false, error: 'Missing required input: path (string)' };
    }
    if (!input.mode || !VALID_MODES.has(input.mode)) {
      return {
        success: false,
        error: "Missing or invalid mode — must be 'create', 'append', 'replace', or 'section-edit'",
      };
    }

    const guard = requireWorkingDocs(ctx);
    if (guard) return guard;

    const reservedError = validateWritePath(input.path, input.mode);
    if (reservedError) {
      return { success: false, error: reservedError };
    }

    const timezone = ctx.timezone ?? 'UTC';
    const normalized = normalizeDocPath(input.path);
    const summary = typeof input.summary === 'string' ? input.summary : `${input.mode} ${normalized}`;
    const ttlWarning = ttlDaysFrontmatterWarning(normalized, input.frontmatter);

    try {
      // Root / legacy occupancy lookups live inside try so bad task_id or transient
      // DB errors return { success: false } instead of throwing (#1819 review).
      const associated = await resolveAssociatedRootTaskId(ctx, input.task_id);
      if (!associated.ok) {
        return { success: false, error: associated.error };
      }
      const associatedTaskId = associated.taskId;

      if (input.mode === 'create') {
        const segment = projectSlugFromPath(input.path);
        let legacyFolderOccupied = false;
        if (segment && isLegacyUuidProjectDir(segment)) {
          legacyFolderOccupied = await ctx.workingDocs!.projectPrefixHasLiveDocs(segment);
        }
        const projectsError = validateProjectsWritePath(input.path, {
          boundRootTaskId: associatedTaskId,
          legacyFolderOccupied,
        });
        if (projectsError) {
          return { success: false, error: projectsError };
        }
      }

      const repo = ctx.workingDocs!;
      let result;

      switch (input.mode) {
        case 'create': {
          if (!input.type || typeof input.type !== 'string' || !input.type.trim()) {
            return { success: false, error: 'create mode requires type (string)' };
          }
          const existing = await repo.read(normalized);
          if (existing) {
            return { success: false, error: `Document already exists at ${normalized} — use append, replace, or section-edit` };
          }
          const created = await repo.create({
            path: normalized,
            type: input.type.trim(),
            frontmatter: input.frontmatter,
            body: input.body ?? '',
            taskId: associatedTaskId,
            conversationId: input.conversation_id ?? ctx.conversationId ?? undefined,
            agentId: ctx.agentId ?? undefined,
          });
          await appendDirectoryLog(ctx, normalized, 'create', summary, associatedTaskId);
          return {
            success: true,
            data: {
              action: 'created',
              document: mapDocumentRow(created, timezone),
              ...(ttlWarning ? { retention_warning: ttlWarning } : {}),
            },
          };
        }
        case 'append': {
          if (input.content === undefined || typeof input.content !== 'string') {
            return { success: false, error: 'append mode requires content (string)' };
          }
          if (input.expected_version === undefined || typeof input.expected_version !== 'number') {
            return { success: false, error: 'append mode requires expected_version (number)' };
          }
          const current = await repo.read(normalized);
          if (!current) {
            return { success: false, error: `Document not found at ${normalized} — use create mode first` };
          }
          result = await repo.append(normalized, {
            content: input.content,
            expectedVersion: input.expected_version,
          });
          if (!result.ok) {
            return { success: true, data: mapWriteConflict(result, timezone) };
          }
          await appendDirectoryLog(ctx, normalized, 'append', summary, associatedTaskId);
          return {
            success: true,
            data: { action: 'appended', document: mapDocumentRow(result.document, timezone) },
          };
        }
        case 'replace': {
          if (input.body === undefined || typeof input.body !== 'string') {
            return { success: false, error: 'replace mode requires body (string)' };
          }
          if (input.expected_version === undefined || typeof input.expected_version !== 'number') {
            return { success: false, error: 'replace mode requires expected_version (number)' };
          }
          const current = await repo.read(normalized);
          if (!current) {
            return { success: false, error: `Document not found at ${normalized} — use create mode first` };
          }
          result = await repo.update(normalized, {
            type: input.type,
            frontmatter: input.frontmatter,
            body: input.body,
            expectedVersion: input.expected_version,
            ...(current.taskId == null && associatedTaskId ? { taskId: associatedTaskId } : {}),
          });
          if (!result.ok) {
            return { success: true, data: mapWriteConflict(result, timezone) };
          }
          await appendDirectoryLog(ctx, normalized, 'replace', summary, associatedTaskId);
          return {
            success: true,
            data: {
              action: 'replaced',
              document: mapDocumentRow(result.document, timezone),
              ...(ttlWarning ? { retention_warning: ttlWarning } : {}),
            },
          };
        }
        case 'section-edit': {
          if (!input.section || typeof input.section !== 'string' || !input.section.trim()) {
            return { success: false, error: 'section-edit mode requires section (string)' };
          }
          if (input.content === undefined || typeof input.content !== 'string') {
            return { success: false, error: 'section-edit mode requires content (string)' };
          }
          const current = await repo.read(normalized);
          if (!current) {
            return { success: false, error: `Document not found at ${normalized} — use create mode first` };
          }
          result = await repo.editSection(normalized, {
            section: input.section.trim(),
            content: input.content,
            mode: 'replace',
            expectedSectionVersion: input.expected_section_version,
          });
          if (!result.ok) {
            return { success: true, data: mapWriteConflict(result, timezone) };
          }
          await appendDirectoryLog(
            ctx,
            normalized,
            'section-edit',
            `${summary} (${input.section.trim()})`,
            associatedTaskId,
          );
          return {
            success: true,
            data: { action: 'section-edited', document: mapDocumentRow(result.document, timezone) },
          };
        }
        default:
          return { success: false, error: `Unhandled mode: ${input.mode}` };
      }
    } catch (err) {
      ctx.log.error({ err, path: input.path, mode: input.mode }, 'doc-write: unexpected error');
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
