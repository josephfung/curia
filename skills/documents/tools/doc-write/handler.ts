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
import { isUuid } from '../../../../src/util/uuid.js';
import { isDurableDocPath, isSharedDocPath } from '../../../../src/memory/durable-doc-prefixes.js';
import { PRINCIPAL_SEND_LEDGER_PREFIX } from '../../../../src/skills/principal-send/send-ledger.js';
import type { WorkingDocRow } from '../../../../src/db/working-docs-repo.js';
import { EDITABLE_BY_KEY, editableBy } from '../../../../src/memory/console-only-docs.js';

const VALID_MODES = new Set(['create', 'append', 'replace', 'section-edit', 'section-delete']);

/**
 * `/shared/` write guard (#2338): declaring a path in `pinned_context` is the
 * permission to write it. Every declaring agent may write; nobody else may, and a
 * call with no agent (or no roster to check) is refused. Two writers bypass it:
 * the console, which does not go through doc-write, and a principal-approved
 * re-execution (ADR-018), which carries no agentId and is the principal's own
 * decision. Returns an error, or null to allow.
 */
function sharedPathWriteError(ctx: ToolContext, normalizedPath: string): string | null {
  if (!isSharedDocPath(normalizedPath)) return null;
  if (ctx.humanApproved) return null;
  const declared = ctx.agentId ? ctx.agentRegistry?.get(ctx.agentId)?.pinnedDocPaths : undefined;
  if (declared?.includes(normalizedPath)) return null;
  ctx.log.warn(
    { path: normalizedPath, agentId: ctx.agentId ?? null },
    'doc-write: refused /shared/ write from an agent that does not declare the path',
  );
  return `${normalizedPath} is a shared document, and only an agent that declares it in pinned_context can write it. Leave it unchanged; the principal can edit it in the console.`;
}

/**
 * Principal-mailbox send ledger guard (#2474 final fixes B1, security review M1). The ledger is
 * the autonomous send cooldown and daily cap: an agent that rewrote or forged an entry could
 * lift them. Only PrincipalSendLedger writes there, through WorkingDocsRepo directly, never this
 * tool. Every mode and every caller is refused, a principal-approved replay included. Compared
 * case-insensitively, after normalization (fail closed).
 * Returns an error, or null to allow.
 */
function sendLedgerPathWriteError(ctx: ToolContext, normalizedPath: string): string | null {
  const path = normalizedPath.toLowerCase();
  const prefix = PRINCIPAL_SEND_LEDGER_PREFIX.toLowerCase();
  if (path !== prefix && !path.startsWith(`${prefix}/`)) return null;
  ctx.log.warn({ path: normalizedPath, agentId: ctx.agentId ?? null }, 'doc-write: refused a write to the principal-mailbox send ledger');
  return `${PRINCIPAL_SEND_LEDGER_PREFIX}/ holds Curia's record of sends from the principal's mailbox, which only the send path writes. Leave it unchanged.`;
}

/**
 * Console-only documents (#2360): a document whose frontmatter carries `editable_by` is edited in
 * the console (the documents API, which does not use this tool), never by an agent. `console` is
 * the only value; any other value is treated the same (fail closed). So:
 *  - every mode on such a document is refused unless the write is a principal-approved
 *    re-execution (`humanApproved`, the principal's own decision);
 *  - no write here may add, change or remove the key, whoever calls (in create or replace, the
 *    frontmatter given replaces the stored one, so leaving the key out removes it).
 * Read from the live document, so an archived one no longer guards its path.
 * Returns an error, or null to allow.
 */
function consoleOnlyWriteError(
  ctx: ToolContext,
  normalizedPath: string,
  existing: WorkingDocRow | null,
  frontmatter: Record<string, unknown> | undefined,
): string | null {
  const stored = editableBy(existing?.frontmatter);
  if (frontmatter !== undefined && JSON.stringify(editableBy(frontmatter)) !== JSON.stringify(stored)) {
    ctx.log.warn({ path: normalizedPath, agentId: ctx.agentId ?? null }, `doc-write: refused a write that sets, changes or removes ${EDITABLE_BY_KEY}`);
    return stored === undefined
      ? `doc-write cannot set ${EDITABLE_BY_KEY}: only the console marks a document console-only. Leave the key out.`
      : `${normalizedPath} is console-only (${EDITABLE_BY_KEY}), and doc-write cannot change or remove that key. Leave it unchanged.`;
  }
  if (stored === undefined || ctx.humanApproved) return null;
  ctx.log.warn({ path: normalizedPath, agentId: ctx.agentId ?? null }, 'doc-write: refused a write to a console-only document');
  return `${normalizedPath} is edited only in the console (${EDITABLE_BY_KEY}: console). Leave it unchanged; the principal or operator can edit it there.`;
}

/**
 * Ownership stamp for archival / prefix resolution is the *project root* task id
 * (#1819 review). Bound wake ids may be subtasks.
 *
 * Returns `{ ok: true, taskId }` or `{ ok: false, error }` — never throws. Callers
 * must validate model-supplied `task_id` before any uuid-column lookup.
 */
async function resolveAssociatedRootTaskId(
  ctx: ToolContext,
  inputTaskId: string | undefined,
  docPath: string,
): Promise<{ ok: true; taskId: string | null | undefined } | { ok: false; error: string }> {
  // #2322 / #2338: durable prefixes are never task-owned.
  if (isDurableDocPath(docPath)) return { ok: true, taskId: null };
  let candidate: string | undefined;
  if (typeof inputTaskId === 'string' && inputTaskId.trim()) {
    candidate = inputTaskId.trim();
    if (isUnresolvedPlaceholder(candidate)) {
      return { ok: false, error: unresolvedPlaceholderError('task_id', candidate) };
    }
    if (!isUuid(candidate)) {
      return { ok: false, error: 'task_id must be a task UUID' };
    }
  } else {
    const bound = boundTaskFromMetadata(ctx.taskMetadata as Record<string, unknown> | undefined);
    candidate = bound?.taskId;
  }
  if (!candidate) return { ok: true, taskId: undefined };
  // Bound metadata should already be a UUID; still guard before the uuid column.
  if (!isUuid(candidate)) {
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
        error: "Missing or invalid mode — must be 'create', 'append', 'replace', 'section-edit', or 'section-delete'",
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
    const ledgerError = sendLedgerPathWriteError(ctx, normalized);
    if (ledgerError) {
      return { success: false, error: ledgerError };
    }
    const sharedError = sharedPathWriteError(ctx, normalized);
    if (sharedError) {
      return { success: false, error: sharedError };
    }
    const summary = typeof input.summary === 'string' ? input.summary : `${input.mode} ${normalized}`;
    const ttlWarning = ttlDaysFrontmatterWarning(normalized, input.frontmatter);

    try {
      // Root / legacy occupancy lookups live inside try so bad task_id or transient
      // DB errors return { success: false } instead of throwing (#1819 review).
      const associated = await resolveAssociatedRootTaskId(ctx, input.task_id, normalized);
      if (!associated.ok) {
        return { success: false, error: associated.error };
      }
      const associatedTaskId = associated.taskId;
      // Helpers take `string | undefined`. Durable paths use explicit null on create.
      const logTaskId = associatedTaskId ?? undefined;

      if (input.mode === 'create') {
        const segment = projectSlugFromPath(input.path);
        let legacyFolderOccupied = false;
        if (segment && isLegacyUuidProjectDir(segment)) {
          legacyFolderOccupied = await ctx.workingDocs!.projectPrefixHasLiveDocs(segment);
        }
        const projectsError = validateProjectsWritePath(input.path, {
          boundRootTaskId: logTaskId,
          legacyFolderOccupied,
        });
        if (projectsError) {
          return { success: false, error: projectsError };
        }
      }

      const repo = ctx.workingDocs!;
      // Read once: the console-only check and every mode below use it.
      const existing = await repo.read(normalized);
      const consoleOnlyError = consoleOnlyWriteError(
        ctx,
        normalized,
        existing,
        input.mode === 'create' || input.mode === 'replace' ? input.frontmatter : undefined,
      );
      if (consoleOnlyError) {
        return { success: false, error: consoleOnlyError };
      }
      // Every write below is bound to `existing`, the document and version the check above
      // passed (#2360): a document the console marked in between, or archived and re-created at
      // this path (a new id, back at version 1), is a conflict, never a write. So append and
      // replace refuse an expected_version other than the one read here, and every mode passes
      // the read's id (and, for the section modes, its version) to the repo, which checks them
      // in the write.
      const staleExpected = existing !== null && typeof input.expected_version === 'number'
        && (input.mode === 'append' || input.mode === 'replace')
        && input.expected_version !== existing.version;
      if (staleExpected) {
        return { success: true, data: mapWriteConflict({ ok: false, conflict: true, document: existing }, timezone) };
      }
      let result;

      switch (input.mode) {
        case 'create': {
          if (!input.type || typeof input.type !== 'string' || !input.type.trim()) {
            return { success: false, error: 'create mode requires type (string)' };
          }
          if (existing) {
            return { success: false, error: `Document already exists at ${normalized} — use append, replace, or section-edit` };
          }
          // read() skips archived rows, and the live-path index is partial, so a create
          // here would put a new live row over an archived /shared/ document and block
          // the principal's restore (path_in_use). Same rule as /meetings/ (#2322).
          if (isSharedDocPath(normalized) && await repo.existsAtPath(normalized)) {
            return {
              success: false,
              error: `${normalized} was archived by the principal. Do not recreate it; the principal can restore it in the console.`,
            };
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
          await appendDirectoryLog(ctx, normalized, 'create', summary, logTaskId);
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
          if (!existing) {
            return { success: false, error: `Document not found at ${normalized} — use create mode first` };
          }
          result = await repo.append(normalized, {
            content: input.content,
            expectedVersion: input.expected_version,
            expectedId: existing.id,
            ...(associatedTaskId ? { taskId: associatedTaskId } : {}),
          });
          if (!result.ok) {
            return { success: true, data: mapWriteConflict(result, timezone) };
          }
          await appendDirectoryLog(ctx, normalized, 'append', summary, logTaskId);
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
          if (!existing) {
            return { success: false, error: `Document not found at ${normalized} — use create mode first` };
          }
          result = await repo.update(normalized, {
            type: input.type,
            frontmatter: input.frontmatter,
            body: input.body,
            expectedVersion: input.expected_version,
            expectedId: existing.id,
            ...(associatedTaskId ? { taskId: associatedTaskId } : {}),
          });
          if (!result.ok) {
            return { success: true, data: mapWriteConflict(result, timezone) };
          }
          await appendDirectoryLog(ctx, normalized, 'replace', summary, logTaskId);
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
          if (!existing) {
            return { success: false, error: `Document not found at ${normalized} — use create mode first` };
          }
          result = await repo.editSection(normalized, {
            section: input.section.trim(),
            content: input.content,
            mode: 'replace',
            expectedSectionVersion: input.expected_section_version,
            expectedVersion: existing.version,
            expectedId: existing.id,
            ...(associatedTaskId ? { taskId: associatedTaskId } : {}),
          });
          if (!result.ok) {
            return { success: true, data: mapWriteConflict(result, timezone) };
          }
          await appendDirectoryLog(
            ctx,
            normalized,
            'section-edit',
            `${summary} (${input.section.trim()})`,
            logTaskId,
          );
          return {
            success: true,
            data: { action: 'section-edited', document: mapDocumentRow(result.document, timezone) },
          };
        }
        case 'section-delete': {
          if (!input.section || typeof input.section !== 'string' || !input.section.trim()) {
            return { success: false, error: 'section-delete mode requires section (string)' };
          }
          if (!existing) {
            return { success: false, error: `Document not found at ${normalized}` };
          }
          const deleted = await repo.deleteSection(normalized, {
            section: input.section.trim(),
            expectedSectionVersion: input.expected_section_version,
            expectedVersion: existing.version,
            expectedId: existing.id,
          });
          if ('missingSection' in deleted) {
            // An error, not a no-op success: the agent must not confirm a removal that
            // did not happen (#2339).
            return {
              success: false,
              error: `No section '${input.section.trim()}' in ${normalized}; nothing was deleted. Check the heading against the document.`,
            };
          }
          if (!deleted.ok) {
            return { success: true, data: mapWriteConflict(deleted, timezone) };
          }
          await appendDirectoryLog(
            ctx,
            normalized,
            'section-delete',
            `${summary} (${input.section.trim()})`,
            logTaskId,
          );
          return {
            success: true,
            data: { action: 'section-deleted', document: mapDocumentRow(deleted.document, timezone) },
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
